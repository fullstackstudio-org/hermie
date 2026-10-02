import Foundation

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
 binaries declare — `keychain-access-groups` in `app.config.ts` for the app, and
 this extension's own entitlements. The container carries what a bot is called;
 the keychain carries what lets you speak to one.

 ## The item's shape is expo-secure-store's, and that is load-bearing

 The app writes through `expo-secure-store`, which stores a generic password
 whose service is `app:no-auth` and whose ACCOUNT is the key's UTF-8 bytes rather
 than a string. Both of those have to be spelled exactly here or the lookup
 quietly finds nothing — the same failure mode as a mismatched App Group, and
 just as silent. The three services are tried in the order that library tries
 them, so an item written by a build that used a different one is still found.

 No access group is named in the query. A keychain read searches every group the
 binary declares, so leaving it out is what makes this find an item the app wrote
 into ITS first group; naming one would be this extension asserting which of the
 two wrote it, which is not a thing it can know.
 */
struct HermieShareCredential {
  /** `gatewayKeyOf` the address. Matched against `share-targets.json`. */
  let gatewayKey: String
  let baseUrl: String
  /** `session_token` or `native_pkce`. The record carries nothing else. */
  let authMode: String
  /** `authorization` or `x-hermes-session-token`, as the app resolved it. */
  let authHeader: String
  let token: String
  /** Unix seconds, or 0 for a credential with no deadline of its own. */
  let expiresAt: Int
  /** Custom headers and the front door's pair, exactly as the app sends them. */
  let headers: [String: String]

  /**
   Whether this is already past its deadline.

   Checked before anything goes out, with a minute of slack: a token that expires
   during the round trip is a 401 the person reads as a share that did not send,
   and one minute is longer than any of this takes. There is nothing to refresh
   with — see the module comment — so the only answer is to queue.
   */
  var isExpired: Bool {
    expiresAt > 0 && Date().timeIntervalSince1970 + 60 >= Double(expiresAt)
  }

  /** True for a gateway whose WebSocket wants a minted ticket rather than a query. */
  var needsTicket: Bool {
    authMode == "native_pkce"
  }

  /**
   The base with its trailing slashes gone, so paths join predictably.

   The same normalisation `normalizeBaseUrl` does on the app side, cut down to
   what this needs: an address the app has already probed, so it is known to be a
   URL and known to answer.
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

   Both halves match `wsUrlFor` and `SessionTokenCredentials.dialPlan` on the app
   side. A gated gateway gets no query at all: its credential is the single-use
   ticket in the subprotocol list, because a browser cannot set headers on an
   upgrade and the gateway therefore made the ticket the only WS credential it
   accepts.
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
    var all = headers
    all[authHeader] = authHeader == "authorization" ? "Bearer \(token)" : token

    return all
  }
}

enum HermieShareKeychain {
  /** The unnamespaced account `src/features/share/delivery-credential.ts` writes. */
  private static let account = "hermie.share.delivery"

  /** `SHARE_DELIVERY_RECORD_VERSION`. A record from a newer build is ignored. */
  private static let supportedVersion = 1

  /**
   The services `expo-secure-store` uses, in the order it reads them.

   `app` is the service name when no `keychainService` is passed, and the suffix
   records whether the item was written behind a biometric prompt. The app writes
   `no-auth`; the other two are read anyway so that an item written by a build
   with different options is still found rather than silently missed.
   */
  private static let services = ["app:no-auth", "app:auth", "app"]

  /** The published record, or nil. Every failure is a nil, and nil means "queue it". */
  static func deliveryCredential() -> HermieShareCredential? {
    guard let data = read(), let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      (root["version"] as? Int) == supportedVersion else {
      return nil
    }

    guard let baseUrl = root["baseUrl"] as? String, !baseUrl.isEmpty,
      let token = root["token"] as? String, !token.isEmpty,
      let authMode = root["authMode"] as? String,
      authMode == "session_token" || authMode == "native_pkce" else {
      return nil
    }

    var headers: [String: String] = [:]

    for (name, value) in (root["headers"] as? [String: Any]) ?? [:] {
      if let text = value as? String {
        headers[name] = text
      }
    }

    return HermieShareCredential(
      gatewayKey: (root["gatewayKey"] as? String) ?? "",
      baseUrl: baseUrl,
      authMode: authMode,
      authHeader: (root["authHeader"] as? String) == "x-hermes-session-token"
        ? "x-hermes-session-token"
        : "authorization",
      token: token,
      expiresAt: (root["expiresAt"] as? Int) ?? 0,
      headers: headers
    )
  }

  private static func read() -> Data? {
    // The account is DATA and not a string: that is how `expo-secure-store`
    // writes it, and a query that spells it as a string matches nothing.
    let encodedAccount = Data(account.utf8)

    for service in services {
      var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: encodedAccount,
        kSecMatchLimit as String: kSecMatchLimitOne
      ]
      query[kSecReturnData as String] = kCFBooleanTrue

      var item: CFTypeRef?

      if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data {
        return data
      }
    }

    return nil
  }
}
