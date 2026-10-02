/// A dial plan carries a credential in two places: the ticket subprotocol and a
/// session token's `?token=`. Its description says only that they are there.
extension DialPlan: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    let protocols = protocols.map { name in
      JSText.hasPrefix(name, GatewayCredentials.webSocketTicketPrefix)
        ? GatewayCredentials.webSocketTicketPrefix + "<redacted>" : name
    }

    return "DialPlan(url: \(Self.redactQuery(url)), protocols: \(protocols), headers: \(FrontDoor.redact(headers)))"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(self, children: ["description": description])
  }

  /// The URL with its whole query replaced: a query on a dial URL is a credential.
  private static func redactQuery(_ url: String) -> String {
    guard let question = url.unicodeScalars.firstIndex(of: "?") else {
      return url
    }

    return String(url.unicodeScalars[..<question]) + "?<redacted>"
  }
}
