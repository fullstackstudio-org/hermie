import Foundation
@_spi(GatewaySync) import HermieGateway
@_spi(GatewaySync) import HermieStore
import Synchronization

/**
 The gateways whose credentials are still bound to an origin the gateway has left: its address
 moved and the old origin's credentials are not yet gone (a crash or a failure between the
 address commit and the deletion). While a gateway is in here, the loaders below give it no stored
 credential at all, so nothing of origin A is ever sent to origin B (I13).
 */
final class CredentialQuarantine: Sendable {
  private let ids = Mutex<Set<String>>([])

  func contains(_ id: String) -> Bool { ids.withLock { $0.contains(id) } }
  func insert(_ id: String) { _ = ids.withLock { $0.insert(id) } }
  func remove(_ id: String) { _ = ids.withLock { $0.remove(id) } }
  func replace(with set: Set<String>) { ids.withLock { $0 = set } }
}

/// A shareable credential the person entered for a gateway.
public enum EnteredCredential: Sendable {
  /// The Cloudflare Access service token pair (stored for the gateway's origin).
  case frontDoor(clientID: String, clientSecret: String)
  /// The headers as typed under Custom headers; empty removes them here (without a clear elsewhere).
  case headers([String: String])
  /// A session token; storing one is signing in on this device.
  case sessionToken(String)

  public var field: SyncField {
    switch self {
    case .frontDoor: .frontDoor
    case .headers: .headers
    case .sessionToken: .sessionToken
    }
  }
}

extension EnteredCredential: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "EnteredCredential(\(field.rawValue))" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["field": field.rawValue]) }
}

/// A token store that hands out nothing for a gateway in quarantine and takes nothing for it.
struct GatedTokenStore: TokenStore {
  let inner: SecretTokenStore
  let gatewayId: String
  let quarantine: CredentialQuarantine

  func load() throws -> TokenSet? {
    quarantine.contains(gatewayId) ? nil : try inner.load()
  }

  func save(_ tokens: TokenSet) throws {
    guard !quarantine.contains(gatewayId) else {
      throw SyncEngineError.credentialsQuarantined
    }

    try inner.save(tokens)
  }

  func clear() throws {
    try inner.clear()
  }
}

/**
 Credentials in and out of the device-only keychain. These are the ONLY entries for that:

 - writing: `storeCredential(_:of:)` (front door, headers, session token), `storeTokens(_:of:)`
   (a native PKCE sign-in), and `signedIn(id:)` before a sign-in flow saves through `tokenStore`;
 - reading, for a connection: `storedCredentials(of:)` (headers, front door, session token) and
   `tokenStore(of:)` (the PKCE token store the token coordinator refreshes through).

 Each write first finishes an address move that was cut short (the old origin's credentials go
 and the binding moves), then takes the field off any pending deletion and any clear not yet
 published, and only then stores. Each read gives nothing for a gateway whose credentials are
 still bound to an origin it has left.
 */
extension GatewaySyncEngine {
  // MARK: Writing

  public func storeCredential(_ credential: EnteredCredential, of id: String) async throws {
    beginIntent()
    defer { endIntent() }

    try await finishMove(of: id)
    let record = try await gateway(id)
    let keys = try SecretKeys.gateway(id)
    let origin = GatewayAddress.origin(of: record.address)
    let field = credential.field
    let item = SyncMaterializer.Slot(field)!.key(keys)

    // What goes in, decided before anything is committed.
    let value: String?
    switch credential {
    case let .frontDoor(clientID, clientSecret):
      guard let encoded = SyncMaterializer.encodeFrontDoor(
        SyncFrontDoor(origin: origin, clientId: clientID, clientSecret: clientSecret), address: record.address)
      else {
        throw SyncEngineError.invalidArgument
      }
      value = encoded
    case let .headers(headers):
      guard SyncMaterializer.validHeaders(headers) else { throw SyncEngineError.invalidArgument }
      value = headers.isEmpty ? nil : GatewaySecrets.encodeExtraHeaders(headers)
    case let .sessionToken(token):
      guard !token.isEmpty else { throw SyncEngineError.invalidArgument }
      value = token
    }

    try await commitIntent(keepingForeignState: true) { db, state, journal in
      try Self.requireGateway(id, in: db)
      journal.keys[item] = nil
      guard state.unsupportedVersion == nil else { return }
      state.entries[id]?.clearing.remove(field)
      if field == .sessionToken {
        state.setSignedOut(false, gatewayId: id, key: GatewayKey.of(record.address))
      }
    }

    do {
      if let value {
        try secrets.set(item, value)
      } else {
        try secrets.delete(item)
      }
    } catch {
      throw fail(error, "store the credential").error
    }

    changedCredentials.insert(id)
    await flushCredentialChanges()
    trigger(.localChange)
    await refreshStatus()
  }

  /// A native PKCE sign-in: signed in here (pending deletions of the sign-in items dropped), then
  /// the tokens stored. Never synced (I6).
  public func storeTokens(_ tokens: TokenSet, of id: String) async throws {
    try await signedIn(id: id)

    do {
      try SecretTokenStore(storage: SecretStorageAdapter(store: secrets), keys: try GatewaySecretKeys(gatewayID: id))
        .save(tokens)
    } catch {
      throw fail(error, "store the tokens").error
    }

    changedCredentials.insert(id)
    await flushCredentialChanges()
  }

  // MARK: Reading

  /**
   The headers, front door and session token a connection to this gateway may use, as
   `GatewaySecrets.load` reads them, or nothing at all while the gateway's credentials are still
   bound to an origin it has left (the move is then finished first, when the keychain allows).
   */
  public func storedCredentials(of id: String) async throws -> StoredGatewaySecrets {
    let record = try await gateway(id)
    let mode = GatewayAuthMode(rawValue: record.authKind.rawValue) ?? .nativePKCE
    let keys = try GatewaySecretKeys(gatewayID: id)

    if try await isQuarantined(id) {
      try? await finishMove(of: id)
    }

    let storage: any GatewaySecretStorage =
      quarantine.contains(id) ? InMemorySecretStorage() : SecretStorageAdapter(store: secrets)

    do {
      return try GatewaySecrets.load(storage: storage, keys: keys, baseURL: record.address, mode: mode)
    } catch {
      throw fail(error, "read the credentials").error
    }
  }

  /// The PKCE token store of a gateway, for the token coordinator. It loads nothing and saves
  /// nothing while the gateway's credentials are bound to an origin it has left.
  public nonisolated func tokenStore(of id: String) throws -> any TokenStore {
    GatedTokenStore(
      inner: SecretTokenStore(storage: SecretStorageAdapter(store: secrets), keys: try GatewaySecretKeys(gatewayID: id)),
      gatewayId: id,
      quarantine: quarantine)
  }

  /**
   Read which gateways' credentials are bound to an origin they left, before anything loads a
   credential (the launch calls it once the gateway list is read). Reconciles keep it current.
   */
  public func prepare() async {
    guard let (registry, origins) = try? await readOrigins() else { return }
    quarantine.replace(with: Self.movedAway(registry, origins))
  }

  // MARK: Moves

  /// Whether the stored binding of a gateway's credentials names another origin than its address.
  func isQuarantined(_ id: String) async throws -> Bool {
    let (registry, origins) = try await readOrigins()
    let moved = Self.movedAway(registry, origins).contains(id)
    if moved { quarantine.insert(id) } else { quarantine.remove(id) }
    return moved
  }

  func readOrigins() async throws -> (GatewayRegistry, [String: String]) {
    try await database.read { db in
      let registry = try Self.checkedRegistry(try db.kvValue(forKey: StoreKeys.gateways))
      var origins: [String: String] = [:]
      for gateway in registry.gateways {
        origins[gateway.id] = try db.kvValue(forKey: SyncMaterializer.credentialOriginKey(gateway.id))
      }
      return (registry, origins)
    }
  }

  static func movedAway(_ registry: GatewayRegistry, _ origins: [String: String]) -> Set<String> {
    Set(
      registry.gateways.filter { gateway in
        origins[gateway.id].map { $0 != GatewayAddress.origin(of: gateway.address) } ?? false
      }.map(\.id))
  }

  /**
   Finish a move to another origin that was cut short: the old origin's credentials go (a front
   door stored for the new origin stays), then the binding moves to the new origin. A gateway
   seen for the first time is bound to its origin now.
   */
  func finishMove(of id: String) async throws {
    let (registry, origins) = try await readOrigins()

    guard let row = registry.gateway(id: id) else {
      throw SyncEngineError.unknownGateway
    }

    let origin = GatewayAddress.origin(of: row.address)

    if origins[id] != origin {
      if origins[id] != nil {
        quarantine.insert(id)
        do {
          if try deleteOldOriginCredentials(of: id, newOrigin: origin) {
            changedCredentials.insert(id)
          }
        } catch {
          throw fail(error, "delete the old origin's credentials").error
        }
      }

      try await database.write { db in
        guard let now = try Self.registry(in: db).gateway(id: id), GatewayAddress.origin(of: now.address) == origin else {
          throw StalePlan()
        }
        try db.kvSet(origin, forKey: SyncMaterializer.credentialOriginKey(id))
      }
    }

    quarantine.remove(id)
  }
}
