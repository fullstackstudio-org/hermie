// Every value type in this target that can hold a credential describes itself
// without it: `description`, `debugDescription` and the mirror `dump` reads all
// say which fields are present and never what they hold. The types themselves
// live in other files (some shared with other work); the conformances are kept
// here, together, so a new field is easy to check against the list.

/// What a description may say about a secret: whether there is one.
enum Redacted {
  static func presence(_ value: String) -> String {
    value.isEmpty ? "<empty>" : "<redacted>"
  }

  static func presence(_ value: String?) -> String {
    value.map(presence) ?? "nil"
  }
}

/// A protocol for the three conformances together, written once.
protocol RedactedDescription: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {}

extension RedactedDescription {
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }
}

/// A dial plan carries a credential in two places: the ticket subprotocol and a
/// session token's `?token=`.
extension DialPlan: RedactedDescription {
  public var description: String {
    let protocols = protocols.map { name in
      JSText.hasPrefix(name, GatewayCredentials.webSocketTicketPrefix)
        ? GatewayCredentials.webSocketTicketPrefix + "<redacted>" : name
    }

    return "DialPlan(url: \(Self.redactQuery(url)), protocols: \(protocols), headers: \(FrontDoor.redact(headers)))"
  }

  /// The URL with its whole query replaced: a query on a dial URL is a credential.
  private static func redactQuery(_ url: String) -> String {
    guard let question = url.unicodeScalars.firstIndex(of: "?") else {
      return url
    }

    return String(url.unicodeScalars[..<question]) + "?<redacted>"
  }
}

extension FrontDoor: RedactedDescription {
  public var description: String {
    switch self {
    case .none: "FrontDoor.none"
    case .cloudflareAccess(let access): "FrontDoor.cloudflareAccess(\(access))"
    }
  }
}

extension FrontDoor.CloudflareAccess: RedactedDescription {
  public var description: String {
    "CloudflareAccess(clientID: \(Redacted.presence(clientID)), clientSecret: \(Redacted.presence(clientSecret)), "
      + "origin: \(origin))"
  }
}

/// Header values and the body are left out; header names, the method and the
/// policies are not secrets.
extension JSONRequest: RedactedDescription {
  public var description: String {
    "JSONRequest(method: \(method), headers: \(FrontDoor.redact(headers)), "
      + "body: \(body == nil ? "nil" : "<redacted>"), timeoutMs: \(timeoutMs.map(String.init) ?? "nil"), "
      + "redirects: \(redirects))"
  }
}

extension AuthHeaderOptions: RedactedDescription {
  public var description: String {
    "AuthHeaderOptions(forceRefresh: \(forceRefresh), rejectedAccessToken: \(Redacted.presence(rejectedAccessToken)))"
  }
}

extension AccessTokenOptions: RedactedDescription {
  public var description: String {
    "AccessTokenOptions(forceRefresh: \(forceRefresh), rejectedAccessToken: \(Redacted.presence(rejectedAccessToken)))"
  }
}

/// The verifier is the secret half of PKCE; the state is left out too, since
/// it is what ties a callback to this attempt.
extension PKCE: RedactedDescription {
  public var description: String {
    "PKCE(verifier: \(Redacted.presence(verifier)), challenge: \(challenge), state: \(Redacted.presence(state)))"
  }
}

/// A one-time code is a credential until it is redeemed.
extension LoopbackRedirect: RedactedDescription {
  public var description: String {
    switch self {
    case .code(let code, let state):
      "LoopbackRedirect.code(code: \(Redacted.presence(code)), state: \(Redacted.presence(state)))"
    case .error(let error, let description):
      "LoopbackRedirect.error(error: \(error), description: \(description))"
    }
  }
}
