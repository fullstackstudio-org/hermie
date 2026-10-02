import Foundation
import HermieGateway
import HermieProtocol
import HermieStore

/**
 The bridge between the merge's `LocalGateway` and what this device stores for a gateway: the
 registry row (`hermie.gateways`), the per-gateway config (`hermie.gateway.config@<id>`) and the
 device-only credentials in the Expo item shapes (`SecretKeys.Gateway`). Pure: the engine reads
 and writes, this only converts and checks.

 The rules a record must pass before anything of it is written here (I13, A3, and the wizard's own
 checks):

 - a credential is written only for the origin it was stored for, which must be the origin of the
   gateway's address now;
 - a front door never on `http://`, and only of a kind this build knows (`cloudflare-access`, stored
   as `cloudflare_access`), with a non-blank id and a non-empty secret;
 - headers only as the wizard accepts them (`GatewayAddress.normalizeHeader`, unchanged by it);
 - while signed out here, neither the session token nor the user is written;
 - the auth kind and the provider go to the registry and the config together, in one transaction
   (the engine's).

 A local credential item this build cannot read (a front door of another kind, headers that are
 not a map of strings) is never overwritten or deleted by a sync: it may be a newer build's.
 */
enum SyncMaterializer {
  /// The device-only credentials sync shares (I6). PKCE tokens are never among them.
  enum Slot: CaseIterable, Sendable {
    case frontDoor
    case headers
    case sessionToken

    var field: SyncField {
      switch self {
      case .frontDoor: .frontDoor
      case .headers: .headers
      case .sessionToken: .sessionToken
      }
    }

    init?(_ field: SyncField) {
      switch field {
      case .frontDoor: self = .frontDoor
      case .headers: self = .headers
      case .sessionToken: self = .sessionToken
      default: return nil
      }
    }

    func key(_ keys: SecretKeys.Gateway) -> String {
      switch self {
      case .frontDoor: keys.frontDoor
      case .headers: keys.extraHeaders
      case .sessionToken: keys.sessionToken
      }
    }
  }

  /// The config fields sync owns; every other field of the config is carried through a write.
  enum ConfigKey {
    static let baseURL = "baseUrl"
    static let authMode = "authMode"
    static let provider = "provider"
    static let providerLabel = "providerDisplayName"
  }

  /// `kv` base key of the origin the session token and headers of a gateway were stored for. Those
  /// two items carry no origin of their own (the Expo shapes), so the engine keeps it beside them,
  /// namespaced, so the ADR-0024 purge removes it with the gateway.
  static let credentialOriginKey = "hermie.sync.credential_origin"

  static func credentialOriginKey(_ gatewayId: String) -> String {
    GatewayNamespace(gatewayId).key(credentialOriginKey)
  }

  static func configKey(_ gatewayId: String) -> String {
    GatewayNamespace(gatewayId).key(StoreKeys.gatewayConfig)
  }

  // MARK: Reading

  /// The config object, `nil` when there is none. Text that is not a JSON object throws: a
  /// config this build cannot read must not be read as "no provider", which would be published.
  static func config(_ text: String?) throws(SyncEngineError) -> JSONObject? {
    guard let text else {
      return nil
    }

    guard let object = (try? JSONValue(parsing: text))?.objectValue else {
      throw .unreadableConfig
    }

    return object
  }

  static func provider(from config: JSONObject?) -> SyncProvider? {
    guard let name = config?[ConfigKey.provider]?.stringValue, !name.isEmpty else {
      return nil
    }

    let label = config?[ConfigKey.providerLabel]?.stringValue
    return SyncProvider(name: name, label: label?.isEmpty == true ? nil : label)
  }

  /// The front door as stored, with the origin it was stored for. `nil` for none, and for an item
  /// that is not a complete front door of a known kind (see `isUnreadable`).
  static func frontDoor(_ raw: String?) -> SyncFrontDoor? {
    guard let raw, !raw.isEmpty, let object = (try? JSONValue(parsing: raw))?.objectValue,
      object["kind"]?.stringValue == "cloudflare_access",
      let clientId = object["clientId"]?.stringValue,
      !clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let clientSecret = object["clientSecret"]?.stringValue, !clientSecret.isEmpty,
      let origin = object["origin"]?.stringValue
    else {
      return nil
    }

    return SyncFrontDoor(
      origin: origin.lowercased(), kind: SyncFrontDoor.cloudflareAccess, clientId: clientId, clientSecret: clientSecret)
  }

  static func headers(_ raw: String?, origin: String) -> SyncHeaders? {
    let decoded = GatewaySecrets.decodeExtraHeaders(raw)
    return decoded.isEmpty ? nil : SyncHeaders(origin: origin, headers: decoded)
  }

  static func sessionToken(_ raw: String?, origin: String) -> SyncSessionToken? {
    guard let raw, !raw.isEmpty else {
      return nil
    }

    return SyncSessionToken(origin: origin, token: raw)
  }

  /// An item is there but this build cannot read it: sync leaves it alone.
  static func isUnreadable(_ slot: Slot, raw: String?) -> Bool {
    guard let raw, !raw.isEmpty else {
      return false
    }

    switch slot {
    case .frontDoor: return frontDoor(raw) == nil
    case .headers: return GatewaySecrets.decodeExtraHeaders(raw).isEmpty && raw != "{}"
    case .sessionToken: return false
    }
  }

  /// One gateway as the merge sees it. The front door carries the origin it was stored for; the
  /// session token and headers carry `credentialOrigin` (the engine has already deleted those of a
  /// previous origin, I13).
  static func localGateway(
    record: GatewayRecord,
    config: JSONObject?,
    credentialOrigin: String,
    frontDoorRaw: String?,
    headersRaw: String?,
    sessionTokenRaw: String?
  ) -> LocalGateway {
    LocalGateway(
      id: record.id,
      name: record.name,
      address: record.address,
      authKind: record.authKind.rawValue,
      provider: provider(from: config),
      user: record.signedInUser,
      addedAt: record.addedAt,
      frontDoor: frontDoor(frontDoorRaw),
      headers: headers(headersRaw, origin: credentialOrigin),
      sessionToken: sessionToken(sessionTokenRaw, origin: credentialOrigin)
    )
  }

  /// The non-secret part of a gateway as stored now, for "unchanged since the snapshot".
  static func storedGateway(record: GatewayRecord, config: JSONObject?) -> LocalGateway {
    LocalGateway(
      id: record.id, name: record.name, address: record.address, authKind: record.authKind.rawValue,
      provider: provider(from: config), user: record.signedInUser, addedAt: record.addedAt)
  }

  /// Whether a non-secret field has the same value in both.
  static func same(_ field: SyncField, _ left: LocalGateway, _ right: LocalGateway) -> Bool {
    switch field {
    case .address: left.address == right.address
    case .name: left.name == right.name
    case .authKind: left.authKind == right.authKind
    case .provider: left.provider == right.provider
    case .user: left.user == right.user
    case .addedAt: left.addedAt == right.addedAt
    case .frontDoor, .headers, .sessionToken, .signIn: true
    }
  }

  // MARK: Writing the registry and the config

  /// The registry row for a gateway adopted from iCloud.
  static func newRecord(_ gateway: LocalGateway) -> GatewayRecord {
    GatewayRecord(
      id: gateway.id,
      name: gateway.name,
      address: gateway.address,
      authKind: GatewayAuthKind(rawValue: gateway.authKind),
      signedInUser: gateway.user,
      addedAt: gateway.addedAt
    )
  }

  /// Write the listed non-secret fields into a registry row.
  static func apply(_ gateway: LocalGateway, fields: Set<SyncField>, signedOut: Bool, to record: inout GatewayRecord) {
    for field in fields {
      switch field {
      case .address: record.address = gateway.address
      case .name: record.name = gateway.name
      case .authKind: record.authKind = GatewayAuthKind(rawValue: gateway.authKind)
      case .user where !signedOut: record.signedInUser = gateway.user
      case .addedAt: record.addedAt = gateway.addedAt
      default: break
      }
    }
  }

  /// The config after writing the listed fields (all of sync's for a new gateway); every field
  /// sync does not own is kept.
  static func config(_ current: JSONObject?, writing gateway: LocalGateway, fields: Set<SyncField>) -> JSONObject {
    var config = current ?? [:]

    if current == nil || fields.contains(.address) || config[ConfigKey.baseURL] == nil {
      config[ConfigKey.baseURL] = .string(gateway.address)
    }

    if current == nil || fields.contains(.authKind) || config[ConfigKey.authMode] == nil {
      config[ConfigKey.authMode] = .string(gateway.authKind)
    }

    if current == nil || fields.contains(.provider) {
      config[ConfigKey.provider] = gateway.provider.map { .string($0.name) }
      config[ConfigKey.providerLabel] = gateway.provider?.label.map(JSONValue.string)
    }

    return config
  }

  static func configText(_ config: JSONObject) throws(SyncEngineError) -> String {
    do {
      return try JSONValue.object(config).canonicalString()
    } catch {
      throw .unreadableConfig
    }
  }

  // MARK: Writing credentials

  /// What to do with one device-only item.
  enum SecretWrite: Sendable, Equatable {
    case set(String)
    case delete
    /// Leave the item as it is (the reason is for the log, and holds no value).
    case keep(String)
  }

  /// The write for one credential of a gateway, after every rule above.
  static func write(_ slot: Slot, of gateway: LocalGateway, signedOut: Bool, currentRaw: String?) -> SecretWrite {
    if isUnreadable(slot, raw: currentRaw) {
      return .keep("an item this build cannot read is left alone")
    }

    let origin = GatewayAddress.origin(of: gateway.address)

    switch slot {
    case .frontDoor:
      guard let door = gateway.frontDoor else { return .delete }
      return encodeFrontDoor(door, address: gateway.address).map(SecretWrite.set)
        ?? .keep("front door refused for this address")
    case .headers:
      guard let headers = gateway.headers else { return .delete }
      guard headers.origin == origin else { return .keep("headers bound to another origin") }
      guard !headers.headers.isEmpty else { return .delete }
      guard validHeaders(headers.headers) else { return .keep("headers the wizard would refuse") }
      return .set(GatewaySecrets.encodeExtraHeaders(headers.headers))
    case .sessionToken:
      if signedOut { return .keep("signed out on this device") }
      guard let token = gateway.sessionToken else { return .delete }
      guard token.origin == origin, !token.token.isEmpty else { return .keep("token bound to another origin") }
      return .set(token.token)
    }
  }

  /// The stored front door for an address, or `nil` when it must not be written there: an
  /// unknown kind, another origin, a cleartext address, or an incomplete pair.
  static func encodeFrontDoor(_ door: SyncFrontDoor, address: String) -> String? {
    let origin = GatewayAddress.origin(of: address)

    guard SyncFrontDoor.knownKinds.contains(door.kind), door.kind == SyncFrontDoor.cloudflareAccess,
      door.origin == origin, origin.hasPrefix("https://"),
      !door.clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !door.clientSecret.isEmpty
    else {
      return nil
    }

    let access = FrontDoor.cloudflareAccess(
      .init(clientID: door.clientId, clientSecret: door.clientSecret, origin: origin))
    return GatewaySecrets.encodeFrontDoor(access, baseURL: address)
  }

  /// The wizard's header rule: every name and value is accepted and left as it is.
  static func validHeaders(_ headers: [String: String]) -> Bool {
    headers.allSatisfy { name, value in
      guard let normalized = try? GatewayAddress.normalizeHeader(name: name, value: value) else { return false }
      return normalized.name == name && normalized.value == value
    }
  }
}

/// `SecretStore` (HermieStore) as `GatewaySecretStorage` (HermieGateway), for the Expo-format
/// helpers in `GatewaySecrets`. The two protocols have the same three methods.
struct SecretStorageAdapter: GatewaySecretStorage {
  let store: any SecretStore

  func get(_ key: String) throws -> String? { try store.get(key) }
  func set(_ key: String, _ value: String) throws { try store.set(key, value) }
  func delete(_ key: String) throws { try store.delete(key) }
}
