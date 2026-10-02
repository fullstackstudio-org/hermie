/// Header-based front doors: a proxy in front of the gateway that wants a
/// credential of its own (ADR-0021; the port of `front-door.ts`).
///
/// Two rules are enforced here rather than left to a caller: the headers are
/// **withheld on a cleartext gateway** (a service token is a long-lived bearer
/// credential and ADR-0014 allows plain http on a tailnet), and **the secret is
/// never printed** — `redact(_:)` and `describe(_:)` are the whole of what
/// anything that shows headers may say.
public enum FrontDoor: Sendable, Equatable {
  case none
  case cloudflareAccess(CloudflareAccess)

  /// Cloudflare's own spelling.
  public static let clientIDHeader = "CF-Access-Client-Id"
  public static let clientSecretHeader = "CF-Access-Client-Secret"
  /// How the auth timeline says a front door is configured, and all it may say.
  public static let presentDescription = "cf-access: present"
  /// Said when one of the pair is set and the other is not.
  public static let incompleteDescription = "cf-access: incomplete"
  /// What a redacted header value is replaced with. Never the value, never its length.
  public static let redacted = "present"

  public struct CloudflareAccess: Sendable, Equatable {
    public var clientID: String
    public var clientSecret: String
    /// `https://host[:port]` of the gateway this was entered for; a stored token
    /// whose origin no longer matches is dropped at load time.
    public var origin: String

    public init(clientID: String, clientSecret: String, origin: String) {
      self.clientID = clientID
      self.clientSecret = clientSecret
      self.origin = origin
    }
  }

  /// Both halves or neither: the id must be non-blank, the secret non-empty (it is not trimmed).
  public var isComplete: Bool { completeAccess != nil }

  private var completeAccess: CloudflareAccess? {
    guard case .cloudflareAccess(let access) = self, !JSText.trim(access.clientID).isEmpty,
      !access.clientSecret.isEmpty
    else {
      return nil
    }

    return access
  }

  /// Read off the string, not parsed: only an explicit `https://` or `wss://` counts.
  private static func isSecure(_ address: String) -> Bool {
    let lowered = JSText.trim(address).lowercased()
    return JSText.hasPrefix(lowered, "https://") || JSText.hasPrefix(lowered, "wss://")
  }

  /// The headers this front door adds for a gateway at `baseURL`; empty for a cleartext one.
  public func headers(for baseURL: String) -> [String: String] {
    guard let access = completeAccess, Self.isSecure(baseURL) else {
      return [:]
    }

    return [Self.clientIDHeader: JSText.trim(access.clientID), Self.clientSecretHeader: access.clientSecret]
  }

  /// True when a configured front door is being withheld because the gateway is cleartext.
  public func isWithheld(for baseURL: String) -> Bool {
    isComplete && !Self.isSecure(baseURL)
  }

  /// The one sentence the auth timeline may print about a front door: presence, never values.
  ///
  /// Names match case-insensitively. Where two spellings of one name are both
  /// present, the reference reads the first in insertion order; a dictionary has
  /// none, so the first in sorted order is read.
  public static func describe(_ headers: [String: String]) -> String {
    func value(_ name: String) -> String {
      let wanted = name.lowercased()
      return headers.keys.sorted().first { $0.lowercased() == wanted }.flatMap { headers[$0] } ?? ""
    }

    let id = !value(clientIDHeader).isEmpty
    let secret = !value(clientSecretHeader).isEmpty

    if id && secret {
      return presentDescription
    }

    return id || secret ? incompleteDescription : ""
  }

  /// Every header value replaced by the fact that there is one; an empty value stays empty.
  public static func redact(_ headers: [String: String]) -> [String: String] {
    headers.mapValues { $0.isEmpty ? "" : redacted }
  }

  /// The document-start script that puts the Access headers on the sign-in
  /// page's own `fetch` and `XMLHttpRequest` calls, scoped to the gateway's
  /// origin; `""` when there is nothing to inject. Every value is embedded as a
  /// `JSON.stringify` string literal, so a pasted secret cannot close it.
  public func accessUserScript(for baseURL: String) -> String {
    let headers = headers(for: baseURL)
    let origin = GatewayAddress.origin(of: baseURL)

    guard let id = headers[Self.clientIDHeader], let secret = headers[Self.clientSecretHeader], !origin.isEmpty
    else {
      return ""
    }

    let literal = JSText.jsonStringLiteral

    return """
      (function () {
        var origin = \(literal(origin));
        var name1 = \(literal(Self.clientIDHeader));
        var name2 = \(literal(Self.clientSecretHeader));
        var value1 = \(literal(id));
        var value2 = \(literal(secret));
        function mine(input) {
          try {
            var url = input;
            if (url && typeof url === 'object' && typeof url.url === 'string') { url = url.url; }
            if (typeof url !== 'string') { return false; }
            return window.location.origin === origin && new URL(url, window.location.href).origin === origin;
          } catch (error) {
            return false;
          }
        }
        var fetchBefore = window.fetch;
        if (fetchBefore) {
          window.fetch = function (input, init) {
            if (mine(input)) {
              var options = init || {};
              var source = options.headers;
              if (source === undefined && input && typeof input === 'object' && input.headers) { source = input.headers; }
              var headers = new Headers(source || undefined);
              headers.set(name1, value1);
              headers.set(name2, value2);
              options.headers = headers;
              return fetchBefore.call(this, input, options);
            }
            return fetchBefore.call(this, input, init);
          };
        }
        var openBefore = XMLHttpRequest.prototype.open;
        var sendBefore = XMLHttpRequest.prototype.send;
        var eligible = new WeakMap();
        XMLHttpRequest.prototype.open = function (method, url) {
          eligible.set(this, mine(url));
          return openBefore.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
          if (eligible.get(this) === true) {
            this.setRequestHeader(name1, value1);
            this.setRequestHeader(name2, value2);
          }
          return sendBefore.apply(this, arguments);
        };
        true;
      })();
      """
  }
}
