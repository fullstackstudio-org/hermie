import HermieProtocol

/// The pure half of `fetch-json.ts`: the two TLS predicates, the two body
/// parsers and the default window for one call. The round trip itself is
/// `HTTPTransport`.
public enum FetchJSON {
  /// Default window for a single HTTP call to a gateway (`DEFAULT_HTTP_TIMEOUT_MS`).
  public static let defaultTimeoutMs = 10_000

  /// Did the secure channel fail, whatever the reason? (`looksLikeTlsFailure`)
  ///
  /// Plain substring tests on the lowercased message: `ssl`, `certificate`,
  /// `tls` or `-1200`. The transport also reads `URLError` codes, which a
  /// JavaScript `fetch` never sees; this predicate is what it applies to text.
  public static func looksLikeTLSFailure(_ message: String) -> Bool {
    let lowered = message.lowercased()

    return contains(lowered, "ssl") || contains(lowered, "certificate") || contains(lowered, "tls")
      || contains(lowered, "-1200")
  }

  /// Did the secure channel fail because of the CERTIFICATE, rather than
  /// because there was no TLS there at all? (`looksLikeCertificateFailure`)
  ///
  /// The difference decides whether an address typed without a scheme may be
  /// retried in the clear: a rejected certificate means there IS an https
  /// server on that port.
  public static func looksLikeCertificateFailure(_ message: String) -> Bool {
    let lowered = message.lowercased()

    return contains(lowered, "certificate") || contains(lowered, "untrusted") || contains(lowered, "self signed")
      || contains(lowered, "self-signed") || hasCertificateErrorCode(lowered)
  }

  /// Parse a response body that must be JSON, object or array (`parseJsonBody`).
  ///
  /// The grammar is `JSON.parse`'s: surrounding JSON whitespace is skipped, a
  /// byte order mark is not whitespace, a repeated key keeps the last value.
  public static func parseJSONBody(_ text: String, url: String, kind: GatewayErrorKind) throws(GatewayError) -> JSONValue {
    do {
      return try JSONValue(parsing: text)
    } catch {
      throw GatewayError(kind, "\(url) answered with something that is not JSON.")
    }
  }

  /// Parse a response body that must be a JSON object (`parseJsonObject`): the
  /// status probe, the credential exchange and the token endpoints.
  public static func parseJSONObject(_ text: String, url: String, kind: GatewayErrorKind) throws(GatewayError)
    -> JSONObject
  {
    guard case .object(let object) = try parseJSONBody(text, url: url, kind: kind) else {
      throw GatewayError(kind, "\(url) answered with JSON that is not an object.")
    }

    return object
  }

  // MARK: - Redirects

  /// Where the Android build's redirect guard puts a `Location` it refused to
  /// follow (`REFUSED_LOCATION_HEADER`). Read by `redirectSeen` for parity; the
  /// Apple transport refuses in its own delegate and never sees it.
  public static let refusedLocationHeader = "x-hermie-refused-location"

  /// The statuses that send a client somewhere else. 304 is a 3xx and is not one.
  static let redirectStatuses: Set<Int> = [301, 302, 303, 307, 308]

  /// The parts of a response `redirectSeen` reads.
  public struct ResponseShape: Sendable, Equatable {
    public var status: Int
    /// `"opaqueredirect"` for a browser's manual redirect.
    public var type: String?
    public var url: String?
    /// Read case-insensitively, as `Headers.get` reads them.
    public var headers: [String: String]?

    public init(status: Int, type: String? = nil, url: String? = nil, headers: [String: String]? = nil) {
      self.status = status
      self.type = type
      self.url = url
      self.headers = headers
    }

    func header(_ name: String) -> String? {
      headers?.first { $0.key.lowercased() == name }?.value
    }
  }

  /// Did this answer come from a redirect, followed or not? (`redirectSeen`)
  ///
  /// The target, resolved against the requested URL (`""` when hidden or
  /// unparseable), or `nil` for an ordinary answer. Checked in order: an opaque
  /// redirect, then a 301/302/303/307/308 (its `Location`, else the refused
  /// location header), then an answer from another origin than was asked.
  public static func redirectSeen(_ response: ResponseShape, requestedURL: String) -> String? {
    if response.type == "opaqueredirect" {
      return ""
    }

    if redirectStatuses.contains(response.status) {
      guard let location = response.header("location") ?? response.header(refusedLocationHeader), !location.isEmpty
      else {
        return ""
      }

      return resolve(location, against: requestedURL) ?? ""
    }

    let landed = response.url ?? ""
    let asked = origin(of: requestedURL)

    guard !landed.isEmpty, !asked.isEmpty else {
      return nil
    }

    let landedOrigin = origin(of: landed)

    // A reported URL nobody can read is not proof of the same origin: it fails closed, naming nothing.
    return landedOrigin == asked ? nil : (landedOrigin.isEmpty ? "" : landed)
  }

  /// The `redirect` failure for a request that was sent somewhere else
  /// (`redirectError`). The sentence names what changed: no readable target,
  /// another host, https to http on one host, or another scheme or port.
  public static func redirectError(requestedURL: String, target: String, status: Int?) -> GatewayError {
    let askedOrigin = origin(of: requestedURL)
    let landedOrigin = origin(of: target)
    let askedHost = hostname(ofOrigin: askedOrigin)
    let landedHost = hostname(ofOrigin: landedOrigin)
    let advice = "Nothing was read from it. Change the gateway address to the one you meant."
    let message: String

    if landedOrigin.isEmpty {
      message = "\(requestedURL) answered with a redirect that was not followed. \(advice)"
    } else if landedHost != askedHost {
      message = "\(askedHost) redirected to \(landedHost), which is a different host. \(advice)"
    } else if JSText.hasPrefix(askedOrigin, "https:"), JSText.hasPrefix(landedOrigin, "http:") {
      message = "\(askedOrigin) redirected to \(landedOrigin), which is not https. \(advice)"
    } else if landedOrigin != askedOrigin {
      message = "\(askedOrigin) redirected to \(landedOrigin), which is a different address. \(advice)"
    } else {
      message = "\(requestedURL) redirected to \(target), which was not followed. \(advice)"
    }

    return GatewayError(
      .redirect,
      message,
      status: status.flatMap { $0 == 0 ? nil : $0 },
      redirectedTo: landedHost.isEmpty ? nil : landedHost,
      redirectedOrigin: landedOrigin.isEmpty ? nil : landedOrigin
    )
  }

  /// `new URL(url).origin`, `""` when it throws or the origin is opaque.
  static func origin(of url: String) -> String {
    guard let origin = WHATWGURL.parse(url)?.origin, origin != "null" else {
      return ""
    }

    return origin
  }

  /// `new URL(origin).hostname` without IPv6 brackets; `""` for no origin.
  private static func hostname(ofOrigin origin: String) -> String {
    guard !origin.isEmpty, let host = WHATWGURL.parse(origin)?.host else {
      return ""
    }

    return JSText.hasPrefix(host, "[") ? String(host.dropFirst().dropLast()) : host
  }

  /// `new URL(location, base).toString()` for a special base, `nil` where it
  /// throws. A fragment is not kept (`WHATWGURL` stores none), and neither is
  /// userinfo; nothing reads either.
  static func resolve(_ location: String, against base: String) -> String? {
    guard let baseURL = WHATWGURL.parse(base), baseURL.isSpecial, baseURL.host != nil else {
      return WHATWGURL.parse(location).map(href)
    }

    let trimmed = JSText.strip(location) { $0.value <= 0x20 }
    let scalars = Array(trimmed.unicodeScalars.filter { $0 != "\t" && $0 != "\n" && $0 != "\r" })
    let text = JSText.string(scalars)
    let root = "\(baseURL.protocolString)//\(baseURL.hostWithPort)"
    let isSlash = { (scalar: Unicode.Scalar) in scalar == "/" || scalar == "\\" }

    if hasScheme(scalars) {
      return WHATWGURL.parse(text).map(href)
    }

    let absolute: String

    if scalars.count >= 2, isSlash(scalars[0]), isSlash(scalars[1]) {
      absolute = baseURL.protocolString + text
    } else if let first = scalars.first, isSlash(first) {
      absolute = root + text
    } else if scalars.first == "?" {
      absolute = root + baseURL.pathname + text
    } else if scalars.isEmpty || scalars.first == "#" {
      absolute = root + baseURL.pathname + (baseURL.query.map { "?" + $0 } ?? "")
    } else {
      let path = Array(baseURL.pathname.unicodeScalars)
      let directory = path.lastIndex(of: "/").map { JSText.string(path[...$0]) } ?? "/"
      absolute = root + directory + text
    }

    return WHATWGURL.parse(absolute).map(href)
  }

  /// `/^[a-z][a-z0-9+.-]*:/i`
  private static func hasScheme(_ scalars: [Unicode.Scalar]) -> Bool {
    guard let first = scalars.first, JSText.isASCIIAlpha(first) else {
      return false
    }

    for scalar in scalars.dropFirst() {
      if scalar == ":" {
        return true
      }

      guard JSText.isASCIIAlpha(scalar) || JSText.isASCIIDigit(scalar) || "+.-".unicodeScalars.contains(scalar) else {
        return false
      }
    }

    return false
  }

  /// `url.href` without fragment or userinfo.
  private static func href(_ url: WHATWGURL) -> String {
    let authority = url.host == nil ? "" : "//\(url.hostWithPort)"
    return "\(url.protocolString)\(authority)\(url.pathname)\(url.query.map { "?" + $0 } ?? "")"
  }

  /// `String.prototype.includes`, code point for code point.
  static func contains(_ haystack: String, _ needle: String) -> Bool {
    let scalars = Array(haystack.unicodeScalars)
    let wanted = Array(needle.unicodeScalars)

    guard !wanted.isEmpty, scalars.count >= wanted.count else {
      return wanted.isEmpty
    }

    return (0...(scalars.count - wanted.count)).contains { start in
      scalars[start..<(start + wanted.count)].elementsEqual(wanted)
    }
  }

  /// `/-120[2-6]\b/`: the NSURLErrorServerCertificate… family, followed by a
  /// word boundary (end of text or anything outside `[A-Za-z0-9_]`).
  private static func hasCertificateErrorCode(_ lowered: String) -> Bool {
    let scalars = Array(lowered.unicodeScalars)
    let prefix = Array("-120".unicodeScalars)

    guard scalars.count >= prefix.count + 1 else {
      return false
    }

    for start in 0...(scalars.count - prefix.count - 1) {
      guard scalars[start..<(start + prefix.count)].elementsEqual(prefix) else {
        continue
      }

      let digit = scalars[start + prefix.count]

      guard ("2"..."6").contains(digit) else {
        continue
      }

      let next = start + prefix.count + 1

      if next == scalars.count || !isWordCharacter(scalars[next]) {
        return true
      }
    }

    return false
  }

  private static func isWordCharacter(_ scalar: Unicode.Scalar) -> Bool {
    JSText.isASCIIAlpha(scalar) || JSText.isASCIIDigit(scalar) || scalar == "_"
  }
}
