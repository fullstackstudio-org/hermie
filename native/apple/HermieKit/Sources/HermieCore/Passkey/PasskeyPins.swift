import Foundation
import HermieStore

/// What this device remembers about one stored gateway's passkeys (plan "Data / Schema Changes",
/// contract §10): the `gateway_id` it pinned on its first successful enrolment there, and the
/// credential ids it has seen, so it notices a reset store or a credential it did not add. Local,
/// not synced, not secret.
public struct PasskeyPinRecord: Codable, Sendable, Equatable {
  /// base64url; `nil` until this device enrolled a passkey on the gateway.
  public var gatewayID: String?
  /// The signed-in user's credential ids this device has seen on the gateway, for every RP.
  public var knownCredentialIDs: [String]
  /// The subset for this build's RP: whether `passkey` can be advertised before the list is read.
  public var appCredentialIDs: [String]
  /// Unix seconds of the last change; 0 while the list was never read.
  public var seenAt: Double
  /// Other stored gateways the person said are this same gateway (one gateway stored twice, a LAN
  /// address and a public one): sharing a `gateway_id` with them is no conflict.
  public var linkedGatewayIDs: [String]

  public init(
    gatewayID: String? = nil,
    knownCredentialIDs: [String] = [],
    appCredentialIDs: [String] = [],
    seenAt: Double = 0,
    linkedGatewayIDs: [String] = []
  ) {
    self.gatewayID = gatewayID
    self.knownCredentialIDs = knownCredentialIDs
    self.appCredentialIDs = appCredentialIDs
    self.seenAt = seenAt
    self.linkedGatewayIDs = linkedGatewayIDs
  }

  enum CodingKeys: String, CodingKey {
    case gatewayID = "gateway_id"
    case knownCredentialIDs = "known_credential_ids"
    case appCredentialIDs = "app_credential_ids"
    case seenAt = "seen_at"
    case linkedGatewayIDs = "linked_gateway_ids"
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    gatewayID = try container.decodeIfPresent(String.self, forKey: .gatewayID)
    knownCredentialIDs = try container.decodeIfPresent([String].self, forKey: .knownCredentialIDs) ?? []
    appCredentialIDs = try container.decodeIfPresent([String].self, forKey: .appCredentialIDs) ?? []
    seenAt = try container.decodeIfPresent(Double.self, forKey: .seenAt) ?? 0
    linkedGatewayIDs = try container.decodeIfPresent([String].self, forKey: .linkedGatewayIDs) ?? []
  }
}

/// One stored gateway's pins as read.
public enum PasskeyPinRead: Sendable, Equatable {
  /// What is stored, or an empty record when nothing is.
  case record(PasskeyPinRecord)
  /// Something is stored that is not a record. It is reported and never written over.
  case unreadable
}

/// Another stored gateway's pins, as one session sees them.
public struct PasskeyOtherPin: Sendable, Equatable {
  /// The registry's id of that gateway.
  public var storedGatewayID: String
  /// Its name in the gateway list; `nil` when the list does not hold it (a pin that outlived its
  /// gateway), which is not a gateway this app has stored.
  public var name: String?
  /// `nil` when what is stored there is not a record.
  public var record: PasskeyPinRecord?

  public init(storedGatewayID: String, name: String?, record: PasskeyPinRecord?) {
    self.storedGatewayID = storedGatewayID
    self.name = name
    self.record = record
  }
}

/// Where the pins live, one record per stored gateway (the registry's id, not the gateway's own).
public protocol PasskeyPinStore: Sendable {
  /// One stored gateway's record.
  func read(_ storedGatewayID: String) async -> PasskeyPinRead
  /// Every OTHER gateway's record, with its name in the gateway list.
  func others(except storedGatewayID: String) async -> [PasskeyOtherPin]
  /// Replace one stored gateway's record; `nil` forgets it. Never touches another gateway's.
  func save(_ record: PasskeyPinRecord?, for storedGatewayID: String) async
}

extension PasskeyPinStore {
  /// The record, or an empty one when nothing readable is stored.
  func record(for storedGatewayID: String) async -> PasskeyPinRecord {
    guard case .record(let record) = await read(storedGatewayID) else {
      return PasskeyPinRecord()
    }

    return record
  }
}

/// The app's pins: one key per stored gateway, `hermie.passkey.pins@<id>` (ADR-0024), so no write
/// reads another gateway's record and removing the gateway purges its pins with its namespace.
public struct KeyValuePasskeyPins: PasskeyPinStore {
  public static let base = StoreKeys.passkeyPins
  let store: KeyValueStore

  public init(store: KeyValueStore) {
    self.store = store
  }

  public static func key(for storedGatewayID: String) -> String {
    GatewayNamespace(storedGatewayID).key(base)
  }

  public func read(_ storedGatewayID: String) async -> PasskeyPinRead {
    do {
      let stored = try await store.value(PasskeyPinRecord.self, forKey: Self.key(for: storedGatewayID))
      return .record(stored ?? PasskeyPinRecord())
    } catch {
      // Not a record, or the read failed: either way nothing here may be written over it.
      return .unreadable
    }
  }

  public func others(except storedGatewayID: String) async -> [PasskeyOtherPin] {
    let keys = (try? await store.keys()) ?? []
    let ids = keys.compactMap(GatewayNamespace.split).filter { $0.base == Self.base && $0.id != storedGatewayID }.map(\.id)

    guard !ids.isEmpty else {
      return []
    }

    // An unreadable or newer list names nobody: every other pin then counts as not stored.
    let listed = (try? await store.string(forKey: StoreKeys.gateways)) ?? nil
    let registry = GatewayRegistry.decode(listed)
    var others: [PasskeyOtherPin] = []

    for id in ids {
      let read = await read(id)
      let record: PasskeyPinRecord? = if case .record(let value) = read { value } else { nil }
      others.append(PasskeyOtherPin(storedGatewayID: id, name: registry.gateway(id: id)?.label, record: record))
    }

    return others
  }

  public func save(_ record: PasskeyPinRecord?, for storedGatewayID: String) async {
    let key = Self.key(for: storedGatewayID)

    guard let record else {
      try? await store.removeValue(forKey: key)
      return
    }

    try? await store.set(record, forKey: key)
  }
}

/// Pins held in memory, for tests and previews. `names` plays the gateway list: an id without a
/// name is a pin for no stored gateway.
public actor InMemoryPasskeyPins: PasskeyPinStore {
  private var held: [String: PasskeyPinRecord]
  private var unreadable: Set<String>
  private let names: [String: String]

  public init(_ records: [String: PasskeyPinRecord] = [:], names: [String: String] = [:], unreadable: Set<String> = []) {
    held = records
    self.names = names
    self.unreadable = unreadable
  }

  /// Every readable record.
  public func records() -> [String: PasskeyPinRecord] {
    held
  }

  public func read(_ storedGatewayID: String) async -> PasskeyPinRead {
    unreadable.contains(storedGatewayID) ? .unreadable : .record(held[storedGatewayID] ?? PasskeyPinRecord())
  }

  public func others(except storedGatewayID: String) async -> [PasskeyOtherPin] {
    let ids = Set(held.keys).union(unreadable).subtracting([storedGatewayID]).sorted()

    return ids.map { id in
      PasskeyOtherPin(storedGatewayID: id, name: names[id], record: unreadable.contains(id) ? nil : held[id])
    }
  }

  public func save(_ record: PasskeyPinRecord?, for storedGatewayID: String) async {
    unreadable.remove(storedGatewayID)
    held[storedGatewayID] = record
  }
}
