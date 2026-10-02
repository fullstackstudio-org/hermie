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
   Called after a gateway was removed from the registry and its cached state purged. The sign-in
   task sets this to delete the gateway's credentials from the keychain, which the registry store
   deliberately does not own.
   */
  public var onRemoved: (@MainActor (String) async -> Void)?

  public let store: GatewayRegistryStore
  private let changes: KeyValueStore
  private var watching = false

  public init(store: GatewayRegistryStore, changes: KeyValueStore) {
    self.store = store
    self.changes = changes
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
    loaded = true
  }

  // MARK: Changing

  public func activate(id: String) async throws {
    apply(try await store.activate(id: id))
  }

  public func rename(id: String, to name: String) async throws {
    apply(try await store.rename(id: id, to: name))
  }

  /// Remove a gateway and everything this device kept for it, then let `onRemoved` clear the rest.
  public func remove(id: String) async throws {
    apply(try await store.remove(id: id))
    await onRemoved?(id)
  }
}
