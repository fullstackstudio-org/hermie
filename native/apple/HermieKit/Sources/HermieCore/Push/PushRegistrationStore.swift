import Foundation
import HermieProtocol
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

/**
 A manage secret as the keychain holds it: with the handle and the relay it manages, so the secret
 alone is enough to revoke the registration, whatever happened to the record. Read back from an
 item a build before this one wrote as a bare secret, `handle` and `relay` are nil.
 */
public struct PushHeldCapability: Sendable, Equatable {
  public var gatewayId: String
  public var handle: String?
  public var relay: String?
  public var manageSecret: String
  /// Kept under the "pending revoke" key: a registration replaced before it could be revoked.
  /// Never the gateway's current one, so always revoked when found.
  public var pendingRevoke: Bool

  public init(gatewayId: String, handle: String?, relay: String?, manageSecret: String, pendingRevoke: Bool = false) {
    self.gatewayId = gatewayId
    self.handle = handle
    self.relay = relay
    self.manageSecret = manageSecret
    self.pendingRevoke = pendingRevoke
  }

  /// The keychain item's value: JSON, so it can never be mistaken for a bare secret.
  var stored: String {
    var object: JSONObject = ["v": 1, "secret": .string(manageSecret)]
    object["handle"] = handle.map(JSONValue.string)
    object["relay"] = relay.map(JSONValue.string)
    return (try? JSONValue.object(object).canonicalString()) ?? manageSecret
  }

  /// Read an item's value: the JSON this build writes, or a bare secret from an older one.
  init?(gatewayId: String, stored: String, pendingRevoke: Bool = false) {
    guard !stored.isEmpty else {
      return nil
    }

    guard stored.hasPrefix("{") else {
      self.init(gatewayId: gatewayId, handle: nil, relay: nil, manageSecret: stored, pendingRevoke: pendingRevoke)
      return
    }

    guard case .object(let object)? = try? JSONValue(parsing: stored), case .string(let secret)? = object["secret"],
      !secret.isEmpty
    else {
      return nil
    }

    self.init(
      gatewayId: gatewayId,
      handle: object["handle"]?.stringValue,
      relay: object["relay"]?.stringValue,
      manageSecret: secret,
      pendingRevoke: pendingRevoke
    )
  }
}

extension PushHeldCapability: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "PushHeldCapability(gatewayId: \(gatewayId), handle: \(handle.map { PushRelay.handlePrefix($0) + "…" } ?? "nil"), "
      + "relay: \(relay ?? "nil"), manageSecret: <redacted>)"
  }

  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }
}

/// Why the registration store could not answer. Never carries a value.
public enum PushRegistrationStoreError: Error, Sendable, Equatable {
  /// The stored map is not one this build can read. Unknown, which is never the same as empty.
  case unreadable
  /// Two registrations of one gateway are already waiting to be revoked; a third is not made.
  case unrevokedCapability
}

/// Where registrations are kept. `PushRegistrationStore` is the app's; tests use it over an
/// in-memory database and an in-memory secret store.
public protocol PushRegistrationStoring: Sendable {
  /// Every stored registration, sorted by gateway id. Throws when the map cannot be read.
  func registrations() async throws -> [PushRegistration]
  /// Gateways whose entry is in the map but does not decode. Kept, never written over.
  func undecodable() async throws -> [String]
  /// The secrets of one gateway's registration. Throws when the keychain cannot be read right now.
  func secrets(gatewayId: String) async throws -> PushRegistrationSecrets
  /// Every manage secret in the keychain, with what it manages, record or not. Empty when the
  /// keychain cannot list.
  func heldCapabilities() async throws -> [PushHeldCapability]
  /// Store a registration and, when given, its two secrets.
  func save(_ registration: PushRegistration, secrets: PushCapability?) async throws
  /// Forget a registration and its secrets. Nothing is sent anywhere.
  func remove(gatewayId: String) async throws
  /// Delete one gateway's secrets only (an orphan whose record is gone).
  func removeSecrets(gatewayId: String) async throws
  /// Delete the item one held capability came from: the gateway's secrets, or its pending-revoke item.
  func removeHeld(_ capability: PushHeldCapability) async throws
  /// Drop the whole map, readable or not. The secrets stay, for `heldCapabilities`.
  func clearRecords() async throws
}

/**
 Registrations in ONE device-wide key-value entry (`StoreKeys.pushRegistrations`), their secrets in
 the keychain (`SecretKeys.Gateway.push`).

 Neither is in the gateway's own namespace or among the gateway's own secrets, on purpose: a
 gateway can disappear in more than one way (Settings, a sign-out, a removal synced from another
 device), and each of them purges what belongs to the gateway. The registration has to survive
 that, so the next pass still finds it, revokes it at the relay, and only then forgets it. The push
 registrar is the only owner of both.

 The manage secret's item also names its handle and relay (`PushHeldCapability`): a reinstall
 loses the database but usually not the keychain, and the relay never expires a registration a
 gateway keeps sending to, so a secret without its record must still be revocable.

 The keychain items have the shape every Hermie secret has (D12), which is this-device-only: never
 in a backup, never synced.
 */
public struct PushRegistrationStore: PushRegistrationStoring {
  public let keyValues: KeyValueStore
  public let secretStore: any SecretStore

  /// The keychain prefix every push secret is under.
  static let secretPrefix = "hermie.push."
  static let managePrefix = "hermie.push.manage" + SecretKeys.gatewaySeparator
  /// A manage secret whose registration was replaced before it could be revoked.
  static let revokePrefix = "hermie.push.revoke" + SecretKeys.gatewaySeparator

  static func revokeKey(_ gatewayId: String) throws -> String {
    let key = revokePrefix + gatewayId

    guard SecretKeys.isValidKey(key) else {
      throw SecretStoreError.invalidGatewayId
    }

    return key
  }

  public init(keyValues: KeyValueStore, secrets: any SecretStore) {
    self.keyValues = keyValues
    self.secretStore = secrets
  }

  public func registrations() async throws -> [PushRegistration] {
    try Self.decode(try await keyValues.string(forKey: StoreKeys.pushRegistrations))
      .values.sorted { $0.gatewayId < $1.gatewayId }
  }

  public func undecodable() async throws -> [String] {
    let raw = try Self.raw(try await keyValues.string(forKey: StoreKeys.pushRegistrations))
    let decoded = try Self.decode(try await keyValues.string(forKey: StoreKeys.pushRegistrations))
    return raw.keys.filter { decoded[$0] == nil }.sorted()
  }

  public func secrets(gatewayId: String) async throws -> PushRegistrationSecrets {
    let keys = try SecretKeys.gateway(gatewayId)
    let manage = try secretStore.get(keys.pushManage).flatMap { PushHeldCapability(gatewayId: gatewayId, stored: $0) }
    let send = try secretStore.get(keys.pushSend)

    return PushRegistrationSecrets(
      sendSecret: send.flatMap { $0.isEmpty ? nil : $0 },
      manageSecret: manage?.manageSecret
    )
  }

  public func heldCapabilities() async throws -> [PushHeldCapability] {
    guard let listable = secretStore as? any ListableSecretStore else {
      return []
    }

    var held: [PushHeldCapability] = []

    for key in try listable.keys(prefix: Self.secretPrefix) {
      let pending = key.hasPrefix(Self.revokePrefix)

      guard pending || key.hasPrefix(Self.managePrefix) else {
        continue
      }

      let gatewayId = String(key.dropFirst(pending ? Self.revokePrefix.count : Self.managePrefix.count))

      if let value = try secretStore.get(key),
        let capability = PushHeldCapability(gatewayId: gatewayId, stored: value, pendingRevoke: pending)
      {
        held.append(capability)
      }
    }

    return held
  }

  public func save(_ registration: PushRegistration, secrets: PushCapability?) async throws {
    let keys = try SecretKeys.gateway(registration.gatewayId)

    // Secrets first: a record whose secrets were never written would be one this device can
    // neither refresh nor revoke. A secret whose record is never written is still revocable.
    if let secrets {
      // A manage secret already here that names another registration has not been revoked (the
      // record was lost, its DELETE did not get through): it is kept under the pending-revoke key
      // until it is, never overwritten. A second one with no room is a refusal to register.
      if let current = try secretStore.get(keys.pushManage),
        let old = PushHeldCapability(gatewayId: registration.gatewayId, stored: current), old.handle != nil,
        old.handle != registration.handle
      {
        let revokeKey = try Self.revokeKey(registration.gatewayId)

        guard try secretStore.get(revokeKey) == nil else {
          throw PushRegistrationStoreError.unrevokedCapability
        }

        try secretStore.set(revokeKey, current)
      }

      let held = PushHeldCapability(
        gatewayId: registration.gatewayId,
        handle: registration.handle,
        relay: registration.relay,
        manageSecret: secrets.manageSecret
      )

      try secretStore.set(keys.pushManage, held.stored)
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

    try await removeSecrets(gatewayId: gatewayId)
  }

  public func removeSecrets(gatewayId: String) async throws {
    let keys = try SecretKeys.gateway(gatewayId)

    try secretStore.delete(keys.pushManage)
    try secretStore.delete(keys.pushSend)
  }

  public func removeHeld(_ capability: PushHeldCapability) async throws {
    if capability.pendingRevoke {
      try secretStore.delete(try Self.revokeKey(capability.gatewayId))
    } else {
      try await removeSecrets(gatewayId: capability.gatewayId)
    }
  }

  public func clearRecords() async throws {
    try await keyValues.removeValue(forKey: StoreKeys.pushRegistrations)
  }

  // MARK: Coding

  /// The stored map with each entry still as JSON bytes, so an entry this build cannot read is
  /// carried through every write, never lost.
  private static func raw(_ text: String?) throws -> [String: Data] {
    guard let text else {
      return [:]
    }

    guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
      throw PushRegistrationStoreError.unreadable
    }

    var map: [String: Data] = [:]

    for (id, value) in object {
      if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]) {
        map[id] = data
      }
    }

    return map
  }

  private static func encode(_ map: [String: Data]) throws -> String {
    var object: [String: Any] = [:]

    for (id, data) in map {
      object[id] = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
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
