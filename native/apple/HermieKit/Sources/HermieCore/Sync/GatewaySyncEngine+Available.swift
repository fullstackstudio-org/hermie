import Foundation
import HermieGateway
@_spi(GatewaySync) import HermieStore

/**
 Read-only accessors for Settings → iCloud Sync. Nothing here writes: adding one of these gateways
 back goes through `addGateway(_:)`, which clears the key from `hidden` (rule 6 of the merge) and
 meets the live record on first attach, so the shareable credentials come down from iCloud.
 */
extension GatewaySyncEngine {
  /// Live records in iCloud Keychain for gateways the person removed from this device only
  /// ("Remove from This Device" hid their key here): what Settings offers to add back. Records
  /// whose origin is configured here are left out. Allowed before the disclosure; reads only.
  public func removedHereAvailable() async throws -> [AdoptableGateway] {
    guard synced.availability() == .available else {
      throw SyncEngineError.storeUnavailable
    }

    let items: [SyncedItem]

    do {
      items = try synced.all()
    } catch {
      throw SyncEngineError.wrap(error, synced: true)
    }

    guard synced.availability() == .available else {
      throw SyncEngineError.storeUnavailable
    }

    let (registry, stateText) = try await database.read { db in
      (GatewayRegistry.decode(try db.kvValue(forKey: StoreKeys.gateways)), try db.kvValue(forKey: SyncState.storageKey))
    }
    let localKeys = Set(registry.gateways.map { GatewayKey.of($0.address) })
    let hidden = SyncState.decode(stateText)?.hidden ?? []
    let records = items.compactMap { SyncedGatewayRecord.decode(account: $0.account, value: $0.value) }

    return GatewaySync.adoptable(records)
      .filter { !localKeys.contains($0.key) && hidden.contains($0.key) }
      .compactMap { record in
        guard let address = record.address else { return nil }
        return AdoptableGateway(
          key: record.key,
          name: record.name ?? GatewayRegistry.defaultName(for: address),
          address: address,
          authKind: record.authKind ?? GatewayAuthMode.nativePKCE.rawValue,
          providerLabel: record.provider.map { $0.label ?? $0.name },
          hasSessionToken: record.sessionToken != nil,
          hasFrontDoor: record.frontDoor != nil,
          hasHeaders: record.headers != nil,
          addedAt: record.addedAt
        )
      }
  }
}
