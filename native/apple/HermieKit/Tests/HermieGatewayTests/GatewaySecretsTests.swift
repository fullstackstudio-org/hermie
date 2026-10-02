import Foundation
import Synchronization
import Testing

@testable import HermieGateway

/// A secret store that logs every operation and can refuse one key.
final class RecordingSecretStorage: GatewaySecretStorage {
  struct Refused: Error {}

  private let state: Mutex<(values: [String: String], log: [String], refuse: String?)>

  init(_ initial: [String: String] = [:], refuse: String? = nil) {
    state = Mutex((initial, [], refuse))
  }

  func get(_ key: String) throws -> String? {
    state.withLock { $0.values[key] }
  }

  func set(_ key: String, _ value: String) throws {
    try state.withLock { state in
      state.log.append("set \(key)")

      if state.refuse == key {
        throw Refused()
      }

      state.values[key] = value
    }
  }

  func delete(_ key: String) throws {
    state.withLock { state in
      state.log.append("delete \(key)")
      state.values.removeValue(forKey: key)
    }
  }

  var values: [String: String] { state.withLock { $0.values } }
  var log: [String] { state.withLock { $0.log } }
}

/// The stored formats, checked against what the Expo app writes
/// (`expo/hermie/src/gateway/config.ts`, `client.ts`, `namespace.ts`). The
/// literal JSON below is `JSON.stringify`'s own output for the same values.
@Suite struct GatewaySecretsTests {
  static let id = "g1a2b3c4d"
  static let keys = GatewaySecretKeys(gatewayID: id)
  static let base = "https://gateway.example.com"

  @Test("names the six items exactly as the Expo app does, suffixed with '-' and the gateway id")
  func keyNames() {
    #expect(
      Self.keys.all == [
        "hermie.auth.access_token-g1a2b3c4d",
        "hermie.auth.refresh_token-g1a2b3c4d",
        "hermie.auth.token_meta-g1a2b3c4d",
        "hermie.auth.session_token-g1a2b3c4d",
        "hermie.auth.extra_headers-g1a2b3c4d",
        "hermie.auth.front_door-g1a2b3c4d"
      ]
    )
  }

  @Test("reads a token set exactly as the Expo app wrote it")
  func readsExpoTokens() throws {
    let storage = InMemorySecretStorage([
      Self.keys.accessToken: "at-expo",
      Self.keys.refreshToken: "rt-expo",
      Self.keys.tokenMeta: #"{"expiresAt":1767225600,"provider":"self-hosted","userId":"self-hosted:sam"}"#
    ])

    let loaded = try SecretTokenStore(storage: storage, keys: Self.keys).load()

    #expect(
      loaded
        == TokenSet(accessToken: "at-expo", refreshToken: "rt-expo", expiresAt: 1_767_225_600, provider: "self-hosted", userID: "self-hosted:sam")
    )
  }

  @Test("writes token_meta byte for byte as JSON.stringify does")
  func writesTokenMeta() throws {
    #expect(
      GatewaySecrets.encodeTokenMeta(tokens(expiresAt: 1_767_225_600, provider: "self-hosted", userID: "self-hosted:sam"))
        == #"{"expiresAt":1767225600,"provider":"self-hosted","userId":"self-hosted:sam"}"#
    )
    #expect(
      GatewaySecrets.encodeTokenMeta(tokens(expiresAt: 1_767_225_600.5, provider: "p\"q", userID: "é/\u{2028}"))
        == "{\"expiresAt\":1767225600.5,\"provider\":\"p\\\"q\",\"userId\":\"é/\u{2028}\"}"
    )
  }

  @Test("a token set written here reads back, and the tokens are stored raw")
  func roundTrip() throws {
    let storage = InMemorySecretStorage()
    let store = SecretTokenStore(storage: storage, keys: Self.keys)
    let set = tokens(accessToken: "at-9", refreshToken: "rt-9", expiresAt: 42, provider: "p", userID: "u")

    try store.save(set)

    #expect(storage.get(Self.keys.accessToken) == "at-9")
    #expect(storage.get(Self.keys.refreshToken) == "rt-9")
    #expect(try store.load() == set)
  }

  @Test("missing pieces read the way the Expo app reads them")
  func partialSets() throws {
    let noAccess = InMemorySecretStorage([Self.keys.refreshToken: "rt"])
    let noRefresh = InMemorySecretStorage([Self.keys.accessToken: "at"])
    let corruptMeta = InMemorySecretStorage([Self.keys.accessToken: "at", Self.keys.tokenMeta: "{not json"])
    let wrongTypes = InMemorySecretStorage([Self.keys.accessToken: "at", Self.keys.tokenMeta: #"{"expiresAt":"5","provider":7}"#])

    #expect(try SecretTokenStore(storage: noAccess, keys: Self.keys).load() == nil)
    #expect(try SecretTokenStore(storage: noRefresh, keys: Self.keys).load()?.refreshToken == "")
    #expect(try SecretTokenStore(storage: corruptMeta, keys: Self.keys).load() == tokens(accessToken: "at", refreshToken: "", expiresAt: 0, provider: "", userID: ""))
    #expect(try SecretTokenStore(storage: wrongTypes, keys: Self.keys).load()?.expiresAt == 0)
  }

  @Test("a rotation writes the refresh token first and alone, and nothing else if it did not land")
  func rotationOrder() throws {
    let storage = RecordingSecretStorage()
    try SecretTokenStore(storage: storage, keys: Self.keys).save(tokens())

    #expect(storage.log == ["set \(Self.keys.refreshToken)", "set \(Self.keys.accessToken)", "set \(Self.keys.tokenMeta)"])

    let refusing = RecordingSecretStorage([Self.keys.accessToken: "at-old"], refuse: Self.keys.refreshToken)
    #expect(throws: RecordingSecretStorage.Refused.self) { try SecretTokenStore(storage: refusing, keys: Self.keys).save(tokens(accessToken: "at-new")) }
    #expect(refusing.values[Self.keys.accessToken] == "at-old")
  }

  @Test("clearing the token set deletes its three items and nothing else")
  func clearTokens() throws {
    let storage = InMemorySecretStorage(Dictionary(uniqueKeysWithValues: Self.keys.all.map { ($0, "v") }))

    try SecretTokenStore(storage: storage, keys: Self.keys).clear()

    #expect(storage.keys == [Self.keys.sessionToken, Self.keys.extraHeaders, Self.keys.frontDoor])
  }

  @Test("reads a front door exactly as the Expo app wrote it, bound to its origin")
  func readsFrontDoor() {
    let raw = #"{"kind":"cloudflare_access","clientId":"abc123.access","clientSecret":"s\"ecret","origin":"https://gateway.example.com"}"#

    #expect(
      GatewaySecrets.decodeFrontDoor(raw, baseURL: Self.base)
        == .cloudflareAccess(.init(clientID: "abc123.access", clientSecret: "s\"ecret", origin: "https://gateway.example.com"))
    )
    #expect(GatewaySecrets.encodeFrontDoor(GatewaySecrets.decodeFrontDoor(raw, baseURL: Self.base), baseURL: Self.base) == raw)
  }

  @Test("writes the front door byte for byte, with the origin of the address being saved")
  func writesFrontDoor() {
    let door = FrontDoor.cloudflareAccess(.init(clientID: "abc123.access", clientSecret: "s\"ecret", origin: "https://old.example"))

    #expect(
      GatewaySecrets.encodeFrontDoor(door, baseURL: Self.base)
        == #"{"kind":"cloudflare_access","clientId":"abc123.access","clientSecret":"s\"ecret","origin":"https://gateway.example.com"}"#
    )
    #expect(GatewaySecrets.encodeFrontDoor(.none, baseURL: Self.base) == nil)
  }

  @Test("refuses a front door entered for another gateway, or one with no origin at all")
  func refusesForeignFrontDoor() {
    let other = #"{"kind":"cloudflare_access","clientId":"a","clientSecret":"b","origin":"https://other.example.com"}"#
    let missing = #"{"kind":"cloudflare_access","clientId":"a","clientSecret":"b"}"#
    let shouting = #"{"kind":"cloudflare_access","clientId":"a","clientSecret":"b","origin":"HTTPS://GATEWAY.EXAMPLE.COM"}"#

    #expect(GatewaySecrets.decodeFrontDoor(other, baseURL: Self.base) == .none)
    #expect(GatewaySecrets.decodeFrontDoor(missing, baseURL: Self.base) == .none)
    #expect(GatewaySecrets.decodeFrontDoor("garbage", baseURL: Self.base) == .none)
    #expect(
      GatewaySecrets.decodeFrontDoor(shouting, baseURL: Self.base)
        == .cloudflareAccess(.init(clientID: "a", clientSecret: "b", origin: "https://gateway.example.com"))
    )
  }

  @Test("reads and writes the custom headers as the Expo app does")
  func customHeaders() {
    #expect(GatewaySecrets.encodeExtraHeaders(["X-Custom": "a b", "CF-Access-Client-Id": "x"]) == #"{"CF-Access-Client-Id":"x","X-Custom":"a b"}"#)
    #expect(GatewaySecrets.decodeExtraHeaders(#"{"CF-Access-Client-Id":"x","X-Custom":"a b"}"#) == ["CF-Access-Client-Id": "x", "X-Custom": "a b"])
    #expect(GatewaySecrets.decodeExtraHeaders(#"{"X-A":"1","X-B":2}"#) == [:])
    #expect(GatewaySecrets.decodeExtraHeaders("[]") == [:])
    #expect(GatewaySecrets.decodeExtraHeaders(nil) == [:])
  }

  @Test("loads a gateway the Expo app set up: wire headers with the front door on top, withheld in the clear")
  func loadsSetup() throws {
    let storage = InMemorySecretStorage([
      Self.keys.extraHeaders: #"{"X-Custom":"a","CF-Access-Client-Secret":"typed"}"#,
      Self.keys.frontDoor: #"{"kind":"cloudflare_access","clientId":"id","clientSecret":"preset","origin":"https://gateway.example.com"}"#,
      Self.keys.accessToken: "at",
      Self.keys.refreshToken: "rt"
    ])

    let secure = try GatewaySecrets.load(storage: storage, keys: Self.keys, baseURL: Self.base, mode: .nativePKCE)

    #expect(secure.extraHeaders == ["X-Custom": "a", "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "preset"])
    #expect(secure.customHeaders == ["X-Custom": "a", "CF-Access-Client-Secret": "typed"])
    #expect(secure.hasCredentials)
    #expect(secure.canRefresh)

    let cleartext = try GatewaySecrets.load(storage: storage, keys: Self.keys, baseURL: "http://gateway.example.com", mode: .nativePKCE)
    #expect(cleartext.frontDoor == .none)
    #expect(cleartext.extraHeaders == ["X-Custom": "a", "CF-Access-Client-Secret": "typed"])
  }

  @Test("a stored cookie gateway has no credential the native app can use")
  func cookieSetup() throws {
    let storage = InMemorySecretStorage([Self.keys.sessionToken: "st"])

    let cookie = try GatewaySecrets.load(storage: storage, keys: Self.keys, baseURL: Self.base, mode: .cookie)
    let session = try GatewaySecrets.load(storage: storage, keys: Self.keys, baseURL: Self.base, mode: .sessionToken)

    #expect(!cookie.hasCredentials)
    #expect(session.hasCredentials)
    #expect(session.sessionToken == "st")
  }

  @Test("a setup that cannot be written in full leaves nothing behind")
  func saveRollsBack() {
    let storage = RecordingSecretStorage(refuse: Self.keys.sessionToken)

    #expect(throws: RecordingSecretStorage.Refused.self) {
      try GatewaySecrets.save(
        storage: storage,
        keys: Self.keys,
        baseURL: Self.base,
        customHeaders: ["X-A": "1"],
        frontDoor: .cloudflareAccess(.init(clientID: "a", clientSecret: "b", origin: "")),
        tokens: tokens(),
        sessionToken: "st"
      )
    }
    #expect(storage.values.isEmpty)
  }

  @Test("signing out deletes all six items")
  func clearCredentials() throws {
    let storage = InMemorySecretStorage(Dictionary(uniqueKeysWithValues: Self.keys.all.map { ($0, "v") } + [("other", "kept")]))

    try GatewaySecrets.clearCredentials(storage: storage, keys: Self.keys)

    #expect(storage.keys == ["other"])
  }
}
