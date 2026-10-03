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

  public init(gatewayID: String? = nil, knownCredentialIDs: [String] = [], appCredentialIDs: [String] = [], seenAt: Double = 0) {
    self.gatewayID = gatewayID
    self.knownCredentialIDs = knownCredentialIDs
    self.appCredentialIDs = appCredentialIDs
    self.seenAt = seenAt
  }

  enum CodingKeys: String, CodingKey {
    case gatewayID = "gateway_id"
    case knownCredentialIDs = "known_credential_ids"
    case appCredentialIDs = "app_credential_ids"
    case seenAt = "seen_at"
  }
}

/// Where the pins live, keyed by the stored gateway's id (the registry's, not the gateway's own).
public protocol PasskeyPinStore: Sendable {
  /// Every stored gateway's record.
  func records() async -> [String: PasskeyPinRecord]
  /// Replace one stored gateway's record; `nil` forgets it (the gateway was removed).
  func save(_ record: PasskeyPinRecord?, for storedGatewayID: String) async
}

extension PasskeyPinStore {
  func record(for storedGatewayID: String) async -> PasskeyPinRecord {
    await records()[storedGatewayID] ?? PasskeyPinRecord()
  }

  /// The `gateway_id`s pinned for every OTHER stored gateway.
  func foreignGatewayIDs(except storedGatewayID: String) async -> Set<String> {
    Set(await records().filter { $0.key != storedGatewayID }.compactMap(\.value.gatewayID))
  }
}

/// The app's pins: one JSON map under one key of the launch's key-value store.
public struct KeyValuePasskeyPins: PasskeyPinStore {
  public static let key = "hermie.passkey.pins"
  let store: KeyValueStore

  public init(store: KeyValueStore) {
    self.store = store
  }

  public func records() async -> [String: PasskeyPinRecord] {
    (try? await store.value([String: PasskeyPinRecord].self, forKey: Self.key)) ?? [:]
  }

  public func save(_ record: PasskeyPinRecord?, for storedGatewayID: String) async {
    var all = await records()
    all[storedGatewayID] = record
    try? await store.set(all, forKey: Self.key)
  }
}

/// Pins held in memory, for tests and previews.
public actor InMemoryPasskeyPins: PasskeyPinStore {
  private var held: [String: PasskeyPinRecord]

  public init(_ records: [String: PasskeyPinRecord] = [:]) {
    held = records
  }

  public func records() async -> [String: PasskeyPinRecord] {
    held
  }

  public func save(_ record: PasskeyPinRecord?, for storedGatewayID: String) async {
    held[storedGatewayID] = record
  }
}
