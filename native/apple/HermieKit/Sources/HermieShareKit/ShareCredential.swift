import Foundation
import HermieShared

/**
 The share extension's one credential, ready to use: where the gateway is, and what every request
 to it carries.

 ADR-0026 lets the extension hold ONE item, written by the app, that it cannot refresh. There is no
 sign-in here, no refresh, no sign-out and no provider discovery. Reading the item out of the
 keychain is the extension's (it is the only part that needs `HermieStore`); this is what it does
 with it.
 */
public struct ShareCredential: Sendable, Equatable {
  public let record: ShareDeliveryRecord

  /// Nil for a record the extension cannot use: no address or no token.
  public init?(_ record: ShareDeliveryRecord?) {
    guard let record, record.isDeliverable else {
      return nil
    }

    self.record = record
  }

  /// `gatewayKeyOf` the address. Matched against `share-targets.json` and the entry.
  public var gatewayKey: String { record.gatewayKey }

  /// True for a gateway whose WebSocket wants a minted ticket rather than a query.
  public var needsTicket: Bool { record.authMode == .nativePKCE }

  /// The base with its trailing slashes gone, so paths join predictably.
  private var trimmedBase: String {
    var value = record.baseUrl

    while value.hasSuffix("/") {
      value.removeLast()
    }

    return value
  }

  /// One REST route on this gateway.
  public func apiURL(_ path: String) -> URL? {
    URL(string: trimmedBase + (path.hasPrefix("/") ? path : "/" + path))
  }

  /**
   `/api/ws`, with the scheme swapped and — for a session-token gateway — the token in the query.

   Both halves match how the app dials. A gated gateway gets no query at all: its credential is the
   single-use ticket in the subprotocol list.
   */
  public func websocketURL() -> URL? {
    guard var components = URLComponents(string: trimmedBase), let scheme = components.scheme?.lowercased(),
      scheme == "https" || scheme == "http" else {
      return nil
    }

    components.scheme = scheme == "https" ? "wss" : "ws"
    components.path = (components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path) + "/api/ws"

    if !needsTicket {
      components.queryItems = [URLQueryItem(name: "token", value: record.token)]
    }

    return components.url
  }

  /// Every header one request carries: the gateway's extras, then the credential.
  public func requestHeaders() -> [String: String] {
    var all = record.headers

    all[record.authHeader.rawValue] =
      record.authHeader == .authorization ? "Bearer \(record.token)" : record.token

    return all
  }
}
