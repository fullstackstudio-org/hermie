import Foundation
import HermieStore

/**
 What this device remembers about its relay registration for one gateway, apart from the two
 secrets (those are in the keychain).

 Nothing here is a credential: the handle is a public id, and the token is kept only as a
 fingerprint, enough to notice that APNs handed out a new one.
 */
public struct PushRegistration: Sendable, Equatable, Codable {
  public var gatewayId: String
  public var handle: String
  /// The relay origin it was made at.
  public var relay: String
  /// The bundle id it was made for (the APNs topic).
  public var topic: String
  public var environment: APNsEnvironment
  /// `APNsDeviceToken.fingerprint` of the token the relay holds for it.
  public var tokenFingerprint: String
  /// The last successful register or `PUT`, in Unix seconds.
  public var refreshedAt: Double

  public init(
    gatewayId: String,
    handle: String,
    relay: String,
    topic: String,
    environment: APNsEnvironment,
    tokenFingerprint: String,
    refreshedAt: Double
  ) {
    self.gatewayId = gatewayId
    self.handle = handle
    self.relay = relay
    self.topic = topic
    self.environment = environment
    self.tokenFingerprint = tokenFingerprint
    self.refreshedAt = refreshedAt
  }
}

extension PushRegistration: CustomStringConvertible {
  public var description: String {
    "PushRegistration(gatewayId: \(gatewayId), handle: \(PushRelay.handlePrefix(handle))…, relay: \(relay), "
      + "environment: \(environment.rawValue), refreshedAt: \(refreshedAt))"
  }
}

/// The two relay secrets of one registration, each as the keychain holds it. Described without either.
public struct PushRegistrationSecrets: Sendable, Equatable {
  /// nil when the keychain holds none.
  public var sendSecret: String?
  /// nil when the keychain holds none: then the registration cannot be refreshed or revoked from here.
  public var manageSecret: String?

  public init(sendSecret: String?, manageSecret: String?) {
    self.sendSecret = sendSecret
    self.manageSecret = manageSecret
  }

  /// Both are there.
  public var complete: Bool {
    sendSecret != nil && manageSecret != nil
  }
}

extension PushRegistrationSecrets: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "PushRegistrationSecrets(sendSecret: \(sendSecret == nil ? "nil" : "<redacted>"), "
      + "manageSecret: \(manageSecret == nil ? "nil" : "<redacted>"))"
  }

  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }
}

/// Why the registration store could not answer. Never carries a value.
public enum PushRegistrationStoreError: Error, Sendable, Equatable {
  /// The stored map is not one this build can read. Unknown, which is never the same as empty.
  case unreadable
}

/// Where registrations are kept. `PushRegistrationStore` is the app's; tests use it over an
/// in-memory database and an in-memory secret store.
public protocol PushRegistrationStoring: Sendable {
  /// Every stored registration, sorted by gateway id. Throws when the map cannot be read; an entry
  /// that does not decode is left out (the planner registers that gateway afresh).
  func registrations() async throws -> [PushRegistration]
  /// The secrets of one gateway's registration. Throws when the keychain cannot be read right now.
  func secrets(gatewayId: String) async throws -> PushRegistrationSecrets
  /// Store a registration and, when given, its two secrets.
  func save(_ registration: PushRegistration, secrets: PushCapability?) async throws
  /// Forget a registration and its secrets. Nothing is sent anywhere.
  func remove(gatewayId: String) async throws
}

/**
 Registrations in ONE device-wide key-value entry (`StoreKeys.pushRegistrations`), their secrets in
 the keychain (`SecretKeys.Gateway.push`).

 Neither is in the gateway's own namespace or among the gateway's own secrets, on purpose: a
 gateway can disappear in more than one way (Settings, a sign-out, a removal synced from another
 device), and each of them purges what belongs to the gateway. The registration has to survive
 that, so the next pass still finds it, revokes it at the relay, and only then forgets it. The push
 registrar is the only owner of both.

 The keychain items have the shape every Hermie secret has (D12), which is this-device-only: never
 in a backup, never synced. A backup restored onto another device brings the record back without
 its secrets, which the planner reads as "register again".
 */
public struct PushRegistrationStore: PushRegistrationStoring {
  public let keyValues: KeyValueStore
  public let secretStore: any SecretStore

  public init(keyValues: KeyValueStore, secrets: any SecretStore) {
    self.keyValues = keyValues
    self.secretStore = secrets
  }

  public func registrations() async throws -> [PushRegistration] {
    try Self.decode(try await keyValues.string(forKey: StoreKeys.pushRegistrations))
      .values.sorted { $0.gatewayId < $1.gatewayId }
  }

  public func secrets(gatewayId: String) async throws -> PushRegistrationSecrets {
    let keys = try SecretKeys.gateway(gatewayId)
    let manage = try secretStore.get(keys.pushManage)
    let send = try secretStore.get(keys.pushSend)

    return PushRegistrationSecrets(
      sendSecret: send.flatMap { $0.isEmpty ? nil : $0 },
      manageSecret: manage.flatMap { $0.isEmpty ? nil : $0 }
    )
  }

  public func save(_ registration: PushRegistration, secrets: PushCapability?) async throws {
    let keys = try SecretKeys.gateway(registration.gatewayId)

    // Secrets first: a record whose secrets were never written would be one this device can
    // neither refresh nor revoke.
    if let secrets {
      try secretStore.set(keys.pushManage, secrets.manageSecret)
      try secretStore.set(keys.pushSend, secrets.sendSecret)
    }

    let text = try JSONEncoder.sorted.encode(registration)
    let gatewayId = registration.gatewayId

    try await keyValues.store.write { database in
      var map = try Self.raw(try database.kvValue(forKey: StoreKeys.pushRegistrations))
      map[gatewayId] = text
      try database.kvSet(try Self.encode(map), forKey: StoreKeys.pushRegistrations, now: Date())
    }
  }

  public func remove(gatewayId: String) async throws {
    let keys = try SecretKeys.gateway(gatewayId)

    try await keyValues.store.write { database in
      var map = try Self.raw(try database.kvValue(forKey: StoreKeys.pushRegistrations))

      guard map.removeValue(forKey: gatewayId) != nil else {
        return
      }

      if map.isEmpty {
        try database.kvRemove(StoreKeys.pushRegistrations)
      } else {
        try database.kvSet(try Self.encode(map), forKey: StoreKeys.pushRegistrations, now: Date())
      }
    }

    try secretStore.delete(keys.pushManage)
    try secretStore.delete(keys.pushSend)
  }

  // MARK: Coding

  /// The stored map with each entry still as JSON bytes, so one unreadable entry is carried, not lost.
  private static func raw(_ text: String?) throws -> [String: Data] {
    guard let text else {
      return [:]
    }

    guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
      throw PushRegistrationStoreError.unreadable
    }

    var map: [String: Data] = [:]

    for (id, value) in object {
      if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        map[id] = data
      }
    }

    return map
  }

  private static func encode(_ map: [String: Data]) throws -> String {
    var object: [String: Any] = [:]

    for (id, data) in map {
      object[id] = try JSONSerialization.jsonObject(with: data)
    }

    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
  }

  static func decode(_ text: String?) throws -> [String: PushRegistration] {
    var registrations: [String: PushRegistration] = [:]

    for (id, data) in try raw(text) {
      if let registration = try? JSONDecoder().decode(PushRegistration.self, from: data), registration.gatewayId == id {
        registrations[id] = registration
      }
    }

    return registrations
  }
}

extension JSONEncoder {
  fileprivate static var sorted: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }
}
