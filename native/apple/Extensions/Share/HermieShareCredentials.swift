import Foundation
import HermieShared
import HermieStore

/**
 The one credential this process is allowed to hold, read out of the keychain.

 ADR-0023 said an extension may not hold a credential at all, and ADR-0026 is the
 successor that narrows rather than reverses that: this reads ONE item, it is
 written by the app, it cannot be refreshed here, and everything it opens is the
 gateway the app is already signed in to. What is still refused is a second copy
 of the sign-in ladder — there is no PKCE flow, no refresh, no sign-out and no
 provider discovery in this binary.

 ## Why the keychain and not the container

 The App Group container is a plain directory that every binary in the group can
 read. A bearer token belongs in the keychain, under the access group both
 binaries declare — the app's entitlements and this extension's own. The
 container carries what a bot is called; the keychain carries what lets you speak
 to one.

 ## The item's shape is expo-secure-store's, and that is load-bearing

 `HermieStore.KeychainStore` reads the item in the shape the Expo build wrote it
 and the native app writes it (a generic password, service `app:no-auth`, the key's
 UTF-8 bytes as the account), so either build's record is found. No access group is
 named in the query: a read searches every group the binary declares, and this one
 declares only the app's.

 The record's format is `ShareDeliveryRecord` in `HermieShared`, the type the app
 writes it with.
 */
struct HermieShareCredential: Sendable {
  let record: ShareDeliveryRecord

  /** `gatewayKeyOf` the address. Matched against `share-targets.json`. */
  var gatewayKey: String { record.gatewayKey }
  var baseUrl: String { record.baseUrl }
  var token: String { record.token }

  /**
   Whether this is already past its deadline.

   Checked before anything goes out, with a minute of slack: a token that expires
   during the round trip is a 401 the person reads as a share that did not send,
   and one minute is longer than any of this takes. There is nothing to refresh
   with — see the type comment — so the only answer is to queue.
   */
  var isExpired: Bool {
    record.isExpired(now: Date())
  }

  /** True for a gateway whose WebSocket wants a minted ticket rather than a query. */
  var needsTicket: Bool {
    record.authMode == .nativePKCE
  }

  /**
   The base with its trailing slashes gone, so paths join predictably.

   An address the app has already probed, so it is known to be a URL and known to
   answer.
   */
  private var trimmedBase: String {
    var value = baseUrl

    while value.hasSuffix("/") {
      value.removeLast()
    }

    return value
  }

  /** One REST route on this gateway. */
  func apiURL(_ path: String) -> URL? {
    URL(string: trimmedBase + (path.hasPrefix("/") ? path : "/" + path))
  }

  /**
   `/api/ws`, with the scheme swapped and — for a session-token gateway — the
   token in the query.

   Both halves match how the app dials. A gated gateway gets no query at all: its
   credential is the single-use ticket in the subprotocol list, because a browser
   cannot set headers on an upgrade and the gateway therefore made the ticket the
   only WS credential it accepts.
   */
  func websocketURL() -> URL? {
    guard var components = URLComponents(string: trimmedBase) else {
      return nil
    }

    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.path = (components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path) + "/api/ws"

    if !needsTicket {
      components.queryItems = [URLQueryItem(name: "token", value: token)]
    }

    return components.url
  }

  /** Every header one request carries: the gateway's extras, then the credential. */
  func requestHeaders() -> [String: String] {
    var all = record.headers
    let header = record.authHeader.rawValue

    all[header] = record.authHeader == .authorization ? "Bearer \(token)" : token

    return all
  }
}

enum HermieShareKeychain {
  /** The published record, or nil. Every failure is a nil, and nil means "queue it". */
  static func deliveryCredential() -> HermieShareCredential? {
    let text = (try? KeychainStore().get(SecretKeys.shareDelivery)) ?? nil

    guard let record = ShareDeliveryRecord.parse(text), record.isDeliverable else {
      return nil
    }

    return HermieShareCredential(record: record)
  }
}
