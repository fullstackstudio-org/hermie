import HermieProtocol
import Synchronization

/// Where a gateway's secrets live. On device this is `KeychainStore` in
/// `HermieStore`, whose `SecretStore` protocol has these three methods with
/// the same signatures, so the app conforms it with an empty extension; this
/// target never imports it.
public protocol GatewaySecretStorage: Sendable {
  func get(_ key: String) throws -> String?
  func set(_ key: String, _ value: String) throws
  func delete(_ key: String) throws
}

/// A secret store call this target refused before it reached a store.
public enum GatewaySecretError: Error, Sendable, Equatable, CustomStringConvertible {
  /// The key is empty or has a character outside `[A-Za-z0-9_.-]`.
  case invalidKey
  /// The gateway id is empty or has a character outside `[A-Za-z0-9_]`.
  case invalidGatewayID

  public var description: String {
    switch self {
    case .invalidKey: "Invalid secret key: keys are non-empty and use only letters, digits, '_', '.' and '-'."
    case .invalidGatewayID: "Invalid gateway id for a secret key: it must be non-empty and use only letters, digits and '_'."
    }
  }
}

/// The key rules `expo-secure-store` enforces, and `SecretKeys` in
/// `HermieStore/SecretStore.swift` with it.
enum SecretKeyRule {
  /// `[A-Za-z0-9_]`, ASCII only: `\w` without the `u` flag.
  static func isWord(_ scalar: Unicode.Scalar) -> Bool {
    JSText.isASCIIAlpha(scalar) || JSText.isASCIIDigit(scalar) || scalar == "_"
  }

  /// `^[\w.-]+$`
  static func isValidKey(_ key: String) -> Bool {
    !key.isEmpty && key.unicodeScalars.allSatisfy { isWord($0) || $0 == "." || $0 == "-" }
  }
}

/// A secret store in memory, for tests and for anything that must not persist.
/// It refuses a key the keychain store would refuse, so a test cannot pass on
/// a key the device would reject.
public final class InMemorySecretStorage: GatewaySecretStorage {
  private let values: Mutex<[String: String]>

  public init(_ initial: [String: String] = [:]) {
    values = Mutex(initial)
  }

  public func get(_ key: String) throws(GatewaySecretError) -> String? {
    try Self.check(key)
    return values.withLock { $0[key] }
  }

  public func set(_ key: String, _ value: String) throws(GatewaySecretError) {
    try Self.check(key)
    values.withLock { $0[key] = value }
  }

  public func delete(_ key: String) throws(GatewaySecretError) {
    try Self.check(key)
    _ = values.withLock { $0.removeValue(forKey: key) }
  }

  /// Every key currently held.
  public var keys: Set<String> {
    values.withLock { Set($0.keys) }
  }

  private static func check(_ key: String) throws(GatewaySecretError) {
    guard SecretKeyRule.isValidKey(key) else {
      throw .invalidKey
    }
  }
}

/// The six keychain items of one gateway, named exactly as the Expo app names
/// them (`secretKeysFor` in `expo/hermie/src/gateway/config.ts`), so a native
/// build finds what an Expo build stored and the other way round.
///
/// KEEP IN STEP with `SecretKeys.Gateway` in
/// `native/apple/HermieKit/Sources/HermieStore/SecretStore.swift`: the same
/// six names, the same `-` separator, the same id rule. This target cannot
/// import `HermieStore`, so `GatewaySecretsTests.keyNames` pins the literal
/// strings that file uses.
public struct GatewaySecretKeys: Sendable, Equatable {
  public static let separator = "-"

  public let gatewayID: String
  public let accessToken: String
  public let refreshToken: String
  /// JSON `{"expiresAt":<number>,"provider":<string>,"userId":<string>}`.
  public let tokenMeta: String
  public let sessionToken: String
  /// JSON object of the headers as typed under Custom headers (strings only).
  public let extraHeaders: String
  /// JSON `{"kind":"cloudflare_access","clientId":…,"clientSecret":…,"origin":…}`.
  public let frontDoor: String

  /// Throws for an id that would make an invalid key or an ambiguous split:
  /// empty, or anything outside `[A-Za-z0-9_]` (so no `-` or `.`).
  public init(gatewayID: String) throws(GatewaySecretError) {
    guard !gatewayID.isEmpty, gatewayID.unicodeScalars.allSatisfy(SecretKeyRule.isWord) else {
      throw .invalidGatewayID
    }

    func key(_ base: String) -> String { base + Self.separator + gatewayID }

    self.gatewayID = gatewayID
    accessToken = key("hermie.auth.access_token")
    refreshToken = key("hermie.auth.refresh_token")
    tokenMeta = key("hermie.auth.token_meta")
    sessionToken = key("hermie.auth.session_token")
    extraHeaders = key("hermie.auth.extra_headers")
    frontDoor = key("hermie.auth.front_door")
  }

  /// All six, in the order `SECRET_KEYS` lists them. Signing out deletes exactly these.
  public var all: [String] {
    [accessToken, refreshToken, tokenMeta, sessionToken, extraHeaders, frontDoor]
  }
}

/// The token set over the secret store (`createSecretTokenStore`): the two
/// tokens in their own items, the non-secret bookkeeping in `token_meta`.
///
/// Three items mean three writes, and a partial write is possible. Rotation
/// makes one partial outcome much worse than the other: a new access token
/// beside a dead refresh token works until it lapses and then cannot renew
/// (and on a provider with reuse detection, presenting the dead token revokes
/// the session). The new refresh token beside the old access token still
/// renews. So the refresh token is written first and alone, and nothing else
/// is written unless it landed.
public struct SecretTokenStore: TokenStore {
  private let storage: any GatewaySecretStorage
  private let keys: GatewaySecretKeys

  public init(storage: any GatewaySecretStorage, keys: GatewaySecretKeys) {
    self.storage = storage
    self.keys = keys
  }

  /// `nil` when there is no access token. A corrupt `token_meta` costs a
  /// proactive refresh, never the session.
  public func load() throws -> TokenSet? {
    let accessToken = try storage.get(keys.accessToken)
    let refreshToken = try storage.get(keys.refreshToken)
    let meta = GatewaySecrets.decodeTokenMeta(try storage.get(keys.tokenMeta))

    guard let accessToken, !accessToken.isEmpty else {
      return nil
    }

    return TokenSet(
      accessToken: accessToken,
      refreshToken: refreshToken ?? "",
      expiresAt: meta.expiresAt,
      provider: meta.provider,
      userID: meta.userID
    )
  }

  public func save(_ tokens: TokenSet) throws {
    try storage.set(keys.refreshToken, tokens.refreshToken)
    try storage.set(keys.accessToken, tokens.accessToken)
    try storage.set(keys.tokenMeta, GatewaySecrets.encodeTokenMeta(tokens))
  }

  public func clear() throws {
    var failure: (any Error)?

    for key in [keys.accessToken, keys.refreshToken, keys.tokenMeta] {
      do {
        try storage.delete(key)
      } catch {
        failure = failure ?? error
      }
    }

    if let failure {
      throw failure
    }
  }
}

/// What one gateway's secrets say, read back (the secret half of `GatewaySetup`).
public struct StoredGatewaySecrets: Sendable, Equatable {
  /// What goes on the wire: the custom headers with the front door's pair on top.
  public var extraHeaders: [String: String]
  /// The headers as typed, to show again after a sign-out.
  public var customHeaders: [String: String]
  /// `.none` too when the stored one was entered for another origin.
  public var frontDoor: FrontDoor
  public var sessionToken: String?
  /// Is there a credential to reconnect with? Always false for `cookie`, which
  /// the native app cannot use: that gateway goes back to sign-in.
  public var hasCredentials: Bool
  /// Whether the stored credential can outlive its access token. Only
  /// meaningful for native PKCE; true for the other modes.
  public var canRefresh: Bool
}

extension StoredGatewaySecrets: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "StoredGatewaySecrets(extraHeaders: \(FrontDoor.redact(extraHeaders)), "
      + "frontDoor: \(FrontDoor.describe(frontDoor.headers(for: frontDoorOrigin))), "
      + "sessionToken: \(Redacted.presence(sessionToken ?? "")), hasCredentials: \(hasCredentials), canRefresh: \(canRefresh))"
  }

  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }

  private var frontDoorOrigin: String {
    if case .cloudflareAccess(let access) = frontDoor { access.origin } else { "" }
  }
}

/// Reading and writing a gateway's secrets in the Expo app's formats.
public enum GatewaySecrets {
  /// What goes on the wire: the custom headers, with the front door's pair on
  /// top (so a hand-typed `CF-Access-Client-Secret` cannot shadow the
  /// preset's), withheld on a cleartext gateway.
  public static func wireHeaders(custom: [String: String], frontDoor: FrontDoor, baseURL: String) -> [String: String] {
    custom.merging(frontDoor.headers(for: baseURL)) { _, door in door }
  }

  /// Read everything `loadGatewaySetup` reads from the secret store. A store
  /// that throws is reported to the caller, which decides what to show.
  public static func load(
    storage: any GatewaySecretStorage,
    keys: GatewaySecretKeys,
    baseURL: String,
    mode: GatewayAuthMode
  ) throws -> StoredGatewaySecrets {
    let rawHeaders = try storage.get(keys.extraHeaders)
    let rawFrontDoor = try storage.get(keys.frontDoor)
    let sessionToken = try storage.get(keys.sessionToken)
    let accessToken = try storage.get(keys.accessToken)
    let refreshToken = try storage.get(keys.refreshToken)

    let custom = decodeExtraHeaders(rawHeaders)
    let frontDoor = decodeFrontDoor(rawFrontDoor, baseURL: baseURL)
    let hasCredentials: Bool =
      switch mode {
      case .cookie: false
      case .sessionToken: !(sessionToken ?? "").isEmpty
      case .nativePKCE: !(accessToken ?? "").isEmpty
      }

    return StoredGatewaySecrets(
      extraHeaders: wireHeaders(custom: custom, frontDoor: frontDoor, baseURL: baseURL),
      customHeaders: custom,
      frontDoor: frontDoor,
      sessionToken: sessionToken,
      hasCredentials: hasCredentials,
      canRefresh: mode == .nativePKCE ? !(refreshToken ?? "").isEmpty : true
    )
  }

  /// Write a gateway's secrets (`saveGatewaySetup`'s secret half). If any
  /// write fails, every one of the six is deleted again, best effort, and the
  /// failure is rethrown: a half-written gateway is worse than none.
  public static func save(
    storage: any GatewaySecretStorage,
    keys: GatewaySecretKeys,
    baseURL: String,
    customHeaders: [String: String],
    frontDoor: FrontDoor = .none,
    tokens: TokenSet? = nil,
    sessionToken: String? = nil
  ) throws {
    do {
      if customHeaders.isEmpty {
        try storage.delete(keys.extraHeaders)
      } else {
        try storage.set(keys.extraHeaders, encodeExtraHeaders(customHeaders))
      }

      if let record = encodeFrontDoor(frontDoor, baseURL: baseURL) {
        try storage.set(keys.frontDoor, record)
      } else {
        try storage.delete(keys.frontDoor)
      }

      if let tokens {
        try SecretTokenStore(storage: storage, keys: keys).save(tokens)
      }

      if let sessionToken, !sessionToken.isEmpty {
        try storage.set(keys.sessionToken, sessionToken)
      }
    } catch {
      for key in keys.all {
        try? storage.delete(key)
      }

      throw error
    }
  }

  /// Sign out of one gateway: delete all six items (`clearCredentials`). The
  /// share extension's copy is the app's to drop.
  public static func clearCredentials(storage: any GatewaySecretStorage, keys: GatewaySecretKeys) throws {
    var failure: (any Error)?

    for key in keys.all {
      do {
        try storage.delete(key)
      } catch {
        failure = failure ?? error
      }
    }

    if let failure {
      throw failure
    }
  }

  // MARK: - Value formats

  /// `JSON.stringify({expiresAt, provider, userId})`, in that key order.
  public static func encodeTokenMeta(_ tokens: TokenSet) -> String {
    "{\"expiresAt\":\(ECMAScriptNumber.string(tokens.expiresAt)),"
      + "\"provider\":\(JSText.jsonStringLiteral(tokens.provider)),"
      + "\"userId\":\(JSText.jsonStringLiteral(tokens.userID))}"
  }

  /// `token_meta` read back: a field of the wrong type, or a blob that is not
  /// a JSON object, keeps the default (0, "", "").
  public static func decodeTokenMeta(_ raw: String?) -> (expiresAt: Double, provider: String, userID: String) {
    guard let raw, !raw.isEmpty, case .object(let meta)? = try? JSONValue(parsing: raw) else {
      return (0, "", "")
    }

    return (meta["expiresAt"]?.doubleValue ?? 0, meta["provider"]?.stringValue ?? "", meta["userId"]?.stringValue ?? "")
  }

  /// `JSON.stringify` of the custom headers, names in sorted order (the
  /// wizard's `headerRecord` sorts them too).
  public static func encodeExtraHeaders(_ headers: [String: String]) -> String {
    let members = headers.keys.sorted().map { "\(JSText.jsonStringLiteral($0)):\(JSText.jsonStringLiteral(headers[$0]!))" }
    return "{" + members.joined(separator: ",") + "}"
  }

  /// The custom headers read back: a JSON object whose values are all
  /// strings, or nothing at all.
  public static func decodeExtraHeaders(_ raw: String?) -> [String: String] {
    guard let raw, !raw.isEmpty, case .object(let object)? = try? JSONValue(parsing: raw) else {
      return [:]
    }

    var headers: [String: String] = [:]

    for (name, value) in object {
      guard case .string(let text) = value else {
        return [:]
      }

      headers[name] = text
    }

    return headers
  }

  /// The stored front door, bound to the origin of the address being saved;
  /// `nil` for no front door (the item is deleted).
  public static func encodeFrontDoor(_ frontDoor: FrontDoor, baseURL: String) -> String? {
    guard case .cloudflareAccess(let access) = frontDoor else {
      return nil
    }

    return "{\"kind\":\"cloudflare_access\","
      + "\"clientId\":\(JSText.jsonStringLiteral(access.clientID)),"
      + "\"clientSecret\":\(JSText.jsonStringLiteral(access.clientSecret)),"
      + "\"origin\":\(JSText.jsonStringLiteral(GatewayAddress.origin(of: baseURL)))}"
  }

  /// The stored front door read back, refused (`.none`) when it is not a
  /// complete Cloudflare Access record or was entered for another origin. An
  /// absent origin is a mismatch, never permission.
  public static func decodeFrontDoor(_ raw: String?, baseURL: String) -> FrontDoor {
    guard let raw, !raw.isEmpty, case .object(let record)? = try? JSONValue(parsing: raw),
      record["kind"] == .string("cloudflare_access"),
      case .string(let clientID)? = record["clientId"],
      case .string(let clientSecret)? = record["clientSecret"],
      case .string(let origin)? = record["origin"]
    else {
      return .none
    }

    let lowered = origin.lowercased()

    guard lowered == GatewayAddress.origin(of: baseURL) else {
      return .none
    }

    return .cloudflareAccess(.init(clientID: clientID, clientSecret: clientSecret, origin: lowered))
  }
}
