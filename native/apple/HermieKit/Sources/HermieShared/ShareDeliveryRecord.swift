import Foundation

/**
 The one credential the share extension may hold: the keychain item `hermie.share.delivery`.

 The format of `src/features/share/delivery-credential.ts` (ADR-0026), field for field. The app
 writes it into the keychain group it shares with the share extension, never into the App Group
 container: the container carries what a bot is called, the keychain what lets you speak to one.

 What is deliberately not in it: a refresh token (an extension that could refresh could rotate the
 app's own credential out from under it) and anything about a bot (that is `share-targets.json`).
 */
public struct ShareDeliveryRecord: Codable, Sendable, Equatable {
  /// `SHARE_DELIVERY_RECORD_VERSION`. A record from a newer build is ignored.
  public static let supportedVersion = 1

  public enum AuthMode: String, Codable, Sendable {
    case sessionToken = "session_token"
    case nativePKCE = "native_pkce"
  }

  /// Which header carries the credential. Both spellings are the gateway's.
  public enum AuthHeader: String, Codable, Sendable {
    case authorization
    case sessionToken = "x-hermes-session-token"
  }

  public var version: Int
  /// The registry id, so the app can tell whether the published record is the one it wrote.
  public var gatewayId: String
  /// `gatewayKeyOf` the address: what `share-targets.json` is matched against.
  public var gatewayKey: String
  public var baseUrl: String
  public var authMode: AuthMode
  public var authHeader: AuthHeader
  /// The bearer or the session token. Never a refresh token.
  public var token: String
  /// Unix seconds, or 0 for a credential that does not expire on its own.
  public var expiresAt: Double
  /// Every extra header the app sends, the front door's pair included.
  public var headers: [String: String]

  public init(
    version: Int = ShareDeliveryRecord.supportedVersion,
    gatewayId: String,
    gatewayKey: String,
    baseUrl: String,
    authMode: AuthMode,
    authHeader: AuthHeader,
    token: String,
    expiresAt: Double,
    headers: [String: String]
  ) {
    self.version = version
    self.gatewayId = gatewayId
    self.gatewayKey = gatewayKey
    self.baseUrl = baseUrl
    self.authMode = authMode
    self.authHeader = authHeader
    self.token = token
    self.expiresAt = expiresAt
    self.headers = headers
  }

  /**
   `buildShareDeliveryRecord`: the record for one gateway, or nil when it cannot be delivered to
   from outside the app — no address, no gateway id, no credential, or an auth mode (the browser's
   cookie flow) whose credential is not a thing that can be copied.

   A session-token gateway sends its token in `x-hermes-session-token` and never expires on its own;
   a PKCE gateway sends its access token as a bearer, with the token's own deadline. Callers delete
   the published record on nil rather than leaving a stale one behind.
   */
  public static func build(
    gatewayId: String,
    gatewayKey: String,
    baseUrl: String,
    authMode: String,
    headers: [String: String],
    sessionToken: String?,
    accessToken: String?,
    expiresAt: Double
  ) -> ShareDeliveryRecord? {
    guard !baseUrl.isEmpty, !gatewayId.isEmpty, let mode = AuthMode(rawValue: authMode) else {
      return nil
    }

    switch mode {
    case .sessionToken:
      guard let token = sessionToken, !token.isEmpty else {
        return nil
      }

      return ShareDeliveryRecord(
        gatewayId: gatewayId, gatewayKey: gatewayKey, baseUrl: baseUrl, authMode: .sessionToken,
        authHeader: .sessionToken, token: token, expiresAt: 0, headers: headers
      )
    case .nativePKCE:
      guard let token = accessToken, !token.isEmpty else {
        return nil
      }

      return ShareDeliveryRecord(
        gatewayId: gatewayId, gatewayKey: gatewayKey, baseUrl: baseUrl, authMode: .nativePKCE,
        authHeader: .authorization, token: token, expiresAt: expiresAt.isFinite ? expiresAt : 0, headers: headers
      )
    }
  }

  /**
   Read a record as `parseShareDeliveryRecord` does: nil for another version or an unknown auth
   mode, every other field repaired towards a default (a header that is not a string is dropped,
   an unknown header name is `authorization`).
   */
  public static func parse(_ text: String?) -> ShareDeliveryRecord? {
    guard let text, let raw = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
      ShareJSON.number(raw["version"]) == Double(supportedVersion),
      let mode = AuthMode(rawValue: ShareJSON.string(raw["authMode"])) else {
      return nil
    }

    var headers: [String: String] = [:]

    for (name, value) in raw["headers"] as? [String: Any] ?? [:] {
      if let value = value as? String {
        headers[name] = value
      }
    }

    return ShareDeliveryRecord(
      gatewayId: ShareJSON.string(raw["gatewayId"]),
      gatewayKey: ShareJSON.string(raw["gatewayKey"]),
      baseUrl: ShareJSON.string(raw["baseUrl"]),
      authMode: mode,
      authHeader: AuthHeader(rawValue: ShareJSON.string(raw["authHeader"])) == .sessionToken
        ? .sessionToken : .authorization,
      token: ShareJSON.string(raw["token"]),
      expiresAt: ShareJSON.number(raw["expiresAt"]),
      headers: headers
    )
  }

  /// The keychain value, as `JSON.stringify(record)`: compact, keys in the TypeScript order.
  public func encodedString() -> String {
    jsonText.text
  }

  /// Whether the extension can use it at all: an address and a token.
  public var isDeliverable: Bool {
    !baseUrl.isEmpty && !token.isEmpty
  }

  /**
   Whether it is already past its deadline, with a minute of slack: a token that expires during
   the round trip is a 401 the person reads as a share that did not send.
   */
  public func isExpired(now: Date) -> Bool {
    expiresAt > 0 && now.timeIntervalSince1970 + 60 >= expiresAt
  }
}
