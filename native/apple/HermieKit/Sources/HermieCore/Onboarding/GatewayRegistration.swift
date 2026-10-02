import Foundation
import HermieGateway
import HermieProtocol
import HermieStore

/**
 The one place setup and sign-in hand a gateway and its credentials to the sync engine, which is the
 only writer of the gateway list and of every credential (it binds them to their origin and records
 what the person did for the other devices).

 What the engine does not keep is who signed in (the display name, the email and the picture from
 `/api/auth/me`) and the gateway's version: those are added to the gateway's config here, merged
 into what the engine wrote, never replacing it.
 */
enum GatewayRegistration {
  /// A new gateway: the engine adds the entry, its config and its credentials, PKCE tokens included.
  static func add(_ gateway: NewGateway, through sync: GatewaySyncEngine) async throws -> String {
    try await sync.addGateway(gateway)
  }

  /**
   A gateway signed in to again with a session token: the auth kind follows what the gateway says
   now, then the token is stored (storing one is signing in here). Throws `SyncEngineError`
   `.unknownGateway`, with nothing written, when the gateway was removed meanwhile.
   */
  static func signedIn(id: String, sessionToken: String, authKind: GatewayAuthKind, currentKind: GatewayAuthKind?, through sync: GatewaySyncEngine)
    async throws
  {
    if currentKind != authKind {
      try await sync.changeAuthKind(of: id, to: authKind)
    }

    try await sync.storeCredential(.sessionToken(sessionToken), of: id)
  }

  /**
   A gateway signed in to again with native PKCE: the auth kind follows, the engine is told first
   (it drops deletions a sign-out left pending), then the tokens are saved through the gateway's one
   coordinator, whose store is the engine's. Throws `SyncEngineError.unknownGateway`, with nothing
   written, when the gateway was removed meanwhile; a removal that lands between the two steps has
   its tokens taken back out.
   */
  static func signedIn(
    id: String,
    tokens: TokenSet,
    authKind: GatewayAuthKind,
    currentKind: GatewayAuthKind?,
    coordinator: TokenCoordinator,
    through sync: GatewaySyncEngine
  ) async throws {
    if currentKind != authKind {
      try await sync.changeAuthKind(of: id, to: authKind)
    }

    try await sync.signedIn(id: id)
    try await coordinator.save(tokens)

    // Removed between the two steps: nothing may stay behind for a gateway the list does not name.
    if (try? await sync.storedCredentials(of: id)) == nil {
      try? await coordinator.clear()
      throw SyncEngineError.unknownGateway
    }
  }

  /// Who signed in, and the gateway's version, merged into the config the engine wrote.
  static func recordIdentity(
    id: String,
    version: String?,
    user: String?,
    email: String?,
    picture: String?,
    in store: SQLiteStore
  ) async throws {
    let key = StoredGatewayConfig.key(gatewayId: id)

    try await store.write { database in
      guard let text = try database.kvValue(forKey: key), case .object(var config) = try JSONValue(parsing: text) else {
        return
      }

      func set(_ field: String, _ value: String?) {
        config[field] = value.flatMap { $0.isEmpty ? nil : JSONValue.string($0) }
      }

      if let version, !version.isEmpty {
        config["version"] = .string(version)
      }

      set("userDisplayName", user)
      set("userEmail", email)
      set("userPictureUrl", picture)
      try database.kvSet(String(decoding: try JSONValue.object(config).canonicalData(), as: UTF8.self), forKey: key)
    }
  }
}
