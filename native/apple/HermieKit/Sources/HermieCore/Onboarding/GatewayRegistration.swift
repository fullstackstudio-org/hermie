import Foundation
import HermieStore

/**
 The one place setup and sign-in write the gateway list: a new gateway added (and made the live one)
 with its config, or a signed-in gateway's entry and config brought up to date.

 Each is one transaction over the registry and the config, so the list never names a gateway with
 no config, nor the other way round. When the sync engine's `addGateway` / `changeAddress` merge,
 they replace the bodies here and nothing else changes.
 */
enum GatewayRegistration {
  /// Add `record` with its config and make it the live gateway.
  static func add(_ record: GatewayRecord, config: String, in store: SQLiteStore) async throws {
    try await write(in: store, config: config, id: record.id) { $0.adding(record).activating(id: record.id) }
  }

  /// A gateway signed in again: its auth kind and who is signed in, and its config.
  static func signedIn(
    id: String,
    authKind: GatewayAuthKind,
    signedInUser: String?,
    config: String,
    in store: SQLiteStore
  ) async throws {
    try await write(in: store, config: config, id: id) { registry in
      // Removed while the sign-in ran: nothing is written, and the caller takes its secrets back out.
      guard registry.gateway(id: id) != nil else {
        throw GatewayRegistrationError.gatewayRemoved
      }

      return registry.updating(id: id) { entry in
        entry.authKind = authKind
        entry.signedInUser = signedInUser
      }
    }
  }

  /// Signed out: the entry stays, nobody is signed in on it.
  static func signedOut(id: String, in store: SQLiteStore) async throws {
    try await GatewayRegistryStore(store: store).update { registry in
      registry.updating(id: id) { $0.signedInUser = nil }
    }
  }

  private static func write(
    in store: SQLiteStore,
    config: String,
    id: String,
    _ change: @escaping @Sendable (GatewayRegistry) throws -> GatewayRegistry
  ) async throws {
    try await store.write { database in
      let current = GatewayRegistry.decode(try database.kvValue(forKey: StoreKeys.gateways))

      // A list written by a newer build is never written over.
      if let foreign = current.unsupportedVersion {
        throw GatewayRegistryError.unsupportedVersion(foreign.description)
      }

      let next = try change(current)

      try database.kvSet(try next.encoded(), forKey: StoreKeys.gateways)
      try database.kvSet(config, forKey: StoredGatewayConfig.key(gatewayId: id))
    }
  }
}

/// Why a registration was refused.
enum GatewayRegistrationError: Error, Sendable, Equatable {
  /// The gateway is no longer in the list.
  case gatewayRemoved
}
