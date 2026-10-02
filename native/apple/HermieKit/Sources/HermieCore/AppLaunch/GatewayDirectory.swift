import Foundation
import HermieGateway
import HermieStore
import Observation

/**
 The configured gateways as the views read them: the `hermie.gateways` registry, kept current from
 the store's change stream, plus the few operations Settings offers on it.

 It does not dial anything. Which gateway is live is the registry's `activeGatewayId`; the session
 (another task) follows that value, and so does the router.
 */
@MainActor
@Observable
public final class GatewayDirectory {
  /// One configured gateway.
  public struct Entry: Sendable, Hashable, Identifiable {
    public let id: String
    /// The stored name, or the host when the name is empty.
    public let name: String
    public let address: String
    /// `GatewayKey.of(address)`: what a `hermie://chat/…?gateway=` link names it by. May be `""`.
    public let key: String
    public let signedInUser: String?

    public init(id: String, name: String, address: String, key: String, signedInUser: String?) {
      self.id = id
      self.name = name
      self.address = address
      self.key = key
      self.signedInUser = signedInUser
    }

    init(_ record: GatewayRecord) {
      self.init(
        id: record.id,
        name: record.label,
        address: record.address,
        key: GatewayKey.of(record.address),
        signedInUser: record.signedInUser
      )
    }
  }

  /// Oldest first, so rows do not move.
  public private(set) var entries: [Entry] = []
  public private(set) var activeId: String?
  /// False until the registry has been read once.
  public private(set) var loaded = false
  /// The stored list is from a newer build; it is shown read-only and never written over.
  public private(set) var unsupportedVersion: String?
  /**
   The list could not be read (a database error) or is not a list at all. `entries` is then empty,
   which is NOT the same as "no gateways": whatever acts on a gateway having gone (push revoking
   its registration) waits until a read succeeds.
   */
  public private(set) var loadFailed = false

  /**
   Called after a gateway was removed. Its registry entry, cached state and device-only
   credentials are already gone (the sync engine removed them); this is for whatever else holds
   on to it.
   */
  public var onRemoved: (@MainActor (String) async -> Void)?

  /// Reads the list and changes the active pointer and names. Adding, moving and removing a
  /// gateway go through `remover` (the sync engine), whether sync is on or off.
  public let store: GatewayRegistryStore
  private let remover: any GatewayListSync
  private let changes: KeyValueStore
  private var watching = false

  public init(store: GatewayRegistryStore, changes: KeyValueStore, remover: any GatewayListSync) {
    self.store = store
    self.changes = changes
    self.remover = remover
  }

  public var active: Entry? {
    entries.first { $0.id == activeId }
  }

  public var isEmpty: Bool {
    entries.isEmpty
  }

  public func entry(id: String?) -> Entry? {
    entries.first { $0.id == id }
  }

  /// The configured gateway a link key names, or nil (`gatewayForKey`).
  public func entry(forKey key: String) -> Entry? {
    guard !key.isEmpty else {
      return nil
    }

    return entries.first { $0.key == key }
  }

  /// Read the registry once, then follow every committed change to it. Idempotent.
  public func load() async {
    if !watching {
      watching = true

      let stream = changes.changes(forKey: StoreKeys.gateways)

      Task { [weak self] in
        for await text in stream {
          self?.apply(GatewayRegistry.decode(text))
        }
      }
    }

    do {
      apply(try await store.load())
    } catch {
      apply(.empty)
      loadFailed = true
    }
  }

  func apply(_ registry: GatewayRegistry) {
    let next = registry.inOrder.map(Entry.init)

    if next != entries {
      entries = next
    }

    if registry.activeGatewayId != activeId {
      activeId = registry.activeGatewayId
    }

    unsupportedVersion = registry.unsupportedVersion?.description
    loadFailed = registry.unreadable
    loaded = true
  }

  // MARK: Changing

  public func activate(id: String) async throws {
    apply(try await store.activate(id: id))
  }

  public func rename(id: String, to name: String) async throws {
    apply(try await store.rename(id: id, to: name))
  }

  /// Settings → Gateways was opened: a reconcile (I11).
  public func settingsOpened() async {
    await remover.trigger(.settingsOpened)
  }

  /// Remove a gateway and everything this device kept for it, through the sync engine, so the
  /// removal is recorded for sync (`.thisDevice` hides it here; `.allDevices` reaches every device
  /// of a synced gateway), then tell `onRemoved`.
  public func remove(id: String, scope: RemovalScope = .thisDevice) async throws {
    try await remover.removeGateway(id: id, scope: scope)
    apply(try await store.load())
    await onRemoved?(id)
  }
}
