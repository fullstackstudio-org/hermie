import Foundation

/// How a gateway signs people in. Unknown values from a newer build are kept as they are.
public enum GatewayAuthKind: Sendable, Hashable {
  case nativePKCE
  case sessionToken
  case cookie
  case other(String)

  public init(rawValue: String) {
    switch rawValue {
    case "native_pkce": self = .nativePKCE
    case "session_token": self = .sessionToken
    case "cookie": self = .cookie
    default: self = .other(rawValue)
    }
  }

  public var rawValue: String {
    switch self {
    case .nativePKCE: "native_pkce"
    case .sessionToken: "session_token"
    case .cookie: "cookie"
    case let .other(value): value
    }
  }
}

/**
 One gateway this device knows about: `{ id, name, address, authKind, signedInUser?, addedAt }`.

 The shape of `GatewayRecord` in `expo/hermie/src/gateway/registry.ts` (ADR-0024). The id is random
 and is what every namespaced key and cache row is keyed by; the address is something the reader
 edits. Fields this build does not know are carried through a read-modify-write untouched.
 */
public struct GatewayRecord: Sendable, Equatable {
  public var id: String
  public var name: String
  public var address: String
  public var authKind: GatewayAuthKind
  public var signedInUser: String?
  /// Epoch milliseconds. Only orders the list.
  public var addedAt: Double

  /// Fields from a newer build, kept so writing this record back does not drop them.
  var extra: [String: StoredJSON] = [:]

  public init(
    id: String,
    name: String,
    address: String,
    authKind: GatewayAuthKind,
    signedInUser: String? = nil,
    addedAt: Double
  ) {
    self.id = id
    self.name = name
    self.address = address
    self.authKind = authKind
    self.signedInUser = signedInUser
    self.addedAt = addedAt
  }

  /// The stored name, or the host when the name is empty.
  public var label: String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)

    return trimmed.isEmpty ? GatewayRegistry.defaultName(for: address) : trimmed
  }
}

/**
 The gateway list and which one is live, as stored under `hermie.gateways`.

 `{ v: 1, gateways: [...], activeGatewayId }`. Per device and never synced. The operations are the
 pure functions of `registry.ts`, with the same rules: the first gateway added becomes active and a
 later one does not; removing the active one moves the pointer to the first that is left.

 Decoding is as tolerant as `asRegistry`: a row without a valid id or address is dropped, a missing
 name becomes the host, an unknown auth kind is kept. A registry written with a version this build
 does not know decodes as empty and is marked, and the store refuses to write over it.
 */
public struct GatewayRegistry: Sendable, Equatable {
  public static let version = 1

  public var gateways: [GatewayRecord]
  public var activeGatewayId: String?

  /// The stored `v`, when it was not one this build understands.
  public private(set) var unsupportedVersion: StoredVersion?

  var extra: [String: StoredJSON] = [:]

  public struct StoredVersion: Sendable, Equatable {
    public let description: String
  }

  public static let empty = GatewayRegistry(gateways: [], activeGatewayId: nil)

  public init(gateways: [GatewayRecord], activeGatewayId: String?) {
    self.gateways = gateways
    self.activeGatewayId = activeGatewayId
  }

  // MARK: Ids and names

  /// `g` and sixteen hex digits: hex so the `@` split stays unambiguous.
  public static func newGatewayId() -> String {
    var generator = SystemRandomNumberGenerator()

    return "g" + (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
  }

  /// `^g[0-9a-f]{2,64}$`, as `isGatewayId`.
  public static func isGatewayId(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)

    guard scalars.first == "g", (3...65).contains(scalars.count) else {
      return false
    }

    return scalars.dropFirst().allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
  }

  /// The host of an address, or the trimmed address when it does not parse.
  public static func defaultName(for address: String) -> String {
    let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)

    guard let host = URLComponents(string: trimmed)?.host, !host.isEmpty, URL(string: trimmed)?.scheme != nil else {
      return trimmed
    }

    return host
  }

  // MARK: Reading

  public var active: GatewayRecord? {
    gateways.first { $0.id == activeGatewayId }
  }

  public func gateway(id: String?) -> GatewayRecord? {
    guard let id else {
      return nil
    }

    return gateways.first { $0.id == id }
  }

  /// Oldest first, so rows do not move.
  public var inOrder: [GatewayRecord] {
    gateways.sorted { left, right in
      left.addedAt != right.addedAt ? left.addedAt < right.addedAt : left.id < right.id
    }
  }

  // MARK: Changing

  /// Add (or replace by id). The first entry becomes active; a later one does not.
  public func adding(_ record: GatewayRecord) -> GatewayRegistry {
    var next = self

    next.gateways = gateways.filter { $0.id != record.id } + [record]
    next.activeGatewayId = activeGatewayId ?? record.id

    return next
  }

  /// Remove one; when it was active, the first remaining entry becomes active.
  public func removing(id: String) -> GatewayRegistry {
    var next = self

    next.gateways = gateways.filter { $0.id != id }

    if activeGatewayId == id {
      next.activeGatewayId = next.gateways.first?.id
    }

    return next
  }

  /// Point at another entry. An id not in the list changes nothing.
  public func activating(id: String) -> GatewayRegistry {
    guard gateways.contains(where: { $0.id == id }) else {
      return self
    }

    var next = self

    next.activeGatewayId = id

    return next
  }

  /// Rename; an empty name falls back to the host.
  public func renaming(id: String, to name: String) -> GatewayRegistry {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)

    return updating(id: id) { record in
      record.name = trimmed.isEmpty ? Self.defaultName(for: record.address) : trimmed
    }
  }

  /// Change one entry's fields in place.
  public func updating(id: String, _ change: (inout GatewayRecord) -> Void) -> GatewayRegistry {
    var next = self

    next.gateways = gateways.map { record in
      guard record.id == id else {
        return record
      }

      var copy = record

      change(&copy)
      copy.id = record.id

      return copy
    }

    return next
  }

  // MARK: Coding

  /// Read the stored text. Anything that is not a registry reads as empty.
  public static func decode(_ text: String?) -> GatewayRegistry {
    guard let text, let root = StoredJSON.parse(text)?.object else {
      return .empty
    }

    guard root["v"]?.number == Double(version) else {
      var foreign = GatewayRegistry.empty
      let stored = root["v"].map { (try? $0.serialized()) ?? "?" } ?? "missing"

      foreign.unsupportedVersion = StoredVersion(description: stored)

      return foreign
    }

    let gateways = (root["gateways"]?.array ?? []).compactMap(record(from:))
    let storedActive = root["activeGatewayId"]?.string
    let active = gateways.contains { $0.id == storedActive } ? storedActive : gateways.first?.id

    var registry = GatewayRegistry(gateways: gateways, activeGatewayId: active)

    registry.extra = root.filter { !["v", "gateways", "activeGatewayId"].contains($0.key) }

    return registry
  }

  private static func record(from value: StoredJSON) -> GatewayRecord? {
    guard let raw = value.object,
      let id = raw["id"]?.string, isGatewayId(id),
      let address = raw["address"]?.string, !address.isEmpty else {
      return nil
    }

    let name = raw["name"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? defaultName(for: address)
    let signedIn = raw["signedInUser"]?.string.flatMap { $0.isEmpty ? nil : $0 }
    let addedAt = raw["addedAt"]?.number.flatMap { $0.isFinite ? $0 : nil } ?? 0

    var record = GatewayRecord(
      id: id,
      name: name,
      address: address,
      authKind: raw["authKind"]?.string.map(GatewayAuthKind.init(rawValue:)) ?? .nativePKCE,
      signedInUser: signedIn,
      addedAt: addedAt
    )

    record.extra = raw.filter { !["id", "name", "address", "authKind", "signedInUser", "addedAt"].contains($0.key) }

    return record
  }

  /// The stored text: the v1 shape plus every field kept from the read.
  public func encoded() throws -> String {
    var root = extra

    root["v"] = .number(Double(Self.version))
    root["gateways"] = .array(
      gateways.map { record in
        var row = record.extra

        row["id"] = .string(record.id)
        row["name"] = .string(record.name)
        row["address"] = .string(record.address)
        row["authKind"] = .string(record.authKind.rawValue)
        row["signedInUser"] = record.signedInUser.map(StoredJSON.string)
        row["addedAt"] = .number(record.addedAt)

        return .object(row)
      }
    )
    root["activeGatewayId"] = activeGatewayId.map(StoredJSON.string) ?? .null

    return try StoredJSON.object(root).serialized()
  }
}

public enum GatewayRegistryError: Error, Sendable, Equatable {
  /// The stored list was written by a build that knows a newer shape; it is left alone.
  case unsupportedVersion(String)
}

/**
 The gateway list on disk, and the one destructive act on it.

 Every change is a read-modify-write inside one transaction. Removing a gateway also purges what
 the device kept for it (ADR-0024), in the same transaction: every key-value key suffixed with
 `@<id>`, its entry in the shared chat arrangement, and its cached roster and transcripts. The
 credentials are in the keychain and are not this store's to remove; the caller removes those too.
 */
public struct GatewayRegistryStore: Sendable {
  public let store: SQLiteStore

  public init(store: SQLiteStore) {
    self.store = store
  }

  public func load() async throws -> GatewayRegistry {
    try await store.read { GatewayRegistry.decode(try $0.kvValue(forKey: StoreKeys.gateways)) }
  }

  /// Apply a change and save it, atomically.
  @discardableResult
  public func update(
    _ change: @escaping @Sendable (GatewayRegistry) -> GatewayRegistry
  ) async throws -> GatewayRegistry {
    try await store.write { database in
      try Self.update(database, change)
    }
  }

  @discardableResult
  public func add(_ record: GatewayRecord) async throws -> GatewayRegistry {
    try await update { $0.adding(record) }
  }

  @discardableResult
  public func activate(id: String) async throws -> GatewayRegistry {
    try await update { $0.activating(id: id) }
  }

  @discardableResult
  public func rename(id: String, to name: String) async throws -> GatewayRegistry {
    try await update { $0.renaming(id: id, to: name) }
  }

  /// Remove a gateway and everything this database kept for it.
  @discardableResult
  public func remove(id: String) async throws -> GatewayRegistry {
    try await store.write { database in
      let registry = try Self.update(database) { $0.removing(id: id) }

      try Self.purge(gatewayId: id, in: database)

      return registry
    }
  }

  static func update(
    _ database: SQLiteDatabase,
    _ change: (GatewayRegistry) -> GatewayRegistry
  ) throws -> GatewayRegistry {
    let current = GatewayRegistry.decode(try database.kvValue(forKey: StoreKeys.gateways))

    if let foreign = current.unsupportedVersion {
      throw GatewayRegistryError.unsupportedVersion(foreign.description)
    }

    let next = change(current)

    try database.kvSet(try next.encoded(), forKey: StoreKeys.gateways)

    return next
  }

  /**
   Everything this database holds for one gateway, removed.

   Wider than the TypeScript `purgeGatewayStorage`, which names its keys one by one: here every key
   whose namespace is exactly this id goes, because a namespaced key is by definition this
   gateway's and one nobody remembered to list would otherwise outlive it for ever.
   */
  public static func purge(gatewayId id: String, in database: SQLiteDatabase) throws {
    guard GatewayRegistry.isGatewayId(id) else {
      return
    }

    for key in try database.kvKeys() where GatewayNamespace.split(key)?.id == id {
      try database.kvRemove(key)
    }

    if let text = try database.kvValue(forKey: StoreKeys.chatsLayout),
      case var .object(layout)? = StoredJSON.parse(text),
      layout[id] != nil {
      layout[id] = nil
      try database.kvSet(try StoredJSON.object(layout).serialized(), forKey: StoreKeys.chatsLayout)
    }

    try database.execute("DELETE FROM bots WHERE ns = ?", [.text(id)])
    try database.execute("DELETE FROM transcripts WHERE ns = ?", [.text(id)])
  }
}
