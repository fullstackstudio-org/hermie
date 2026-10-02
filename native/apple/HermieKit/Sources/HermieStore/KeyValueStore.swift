import Foundation

/**
 One gateway's corner of the key-value store: `<base>@<gateway id>`.

 The convention of `expo/hermie/src/gateway/namespace.ts` (ADR-0024), kept so both apps name
 things the same way. Every base key is dotted, every gateway id is `g` followed by hex, so a
 namespaced key splits one way only — at the first `@`.

 Not namespaced, as in the TypeScript: the registry itself, the app lock, the push installation id,
 the appearance and the context switches. See `StoreKeys`.
 */
public struct GatewayNamespace: Sendable, Hashable {
  /// Between the base key and the id, in the key-value store. Keychain names use `SecretKeys`,
  /// whose separator is `-` because the keychain keys allow no `@`.
  public static let separator = "@"

  public let id: String

  public init(_ gatewayId: String) {
    self.id = gatewayId
  }

  /// One key-value key, scoped to this gateway.
  public func key(_ base: String) -> String {
    "\(base)\(Self.separator)\(id)"
  }

  /// A namespaced key split back into its halves, or nil when it has no `@`.
  public static func split(_ key: String) -> (base: String, id: String)? {
    guard let at = key.range(of: separator) else {
      return nil
    }

    return (String(key[..<at.lowerBound]), String(key[at.upperBound...]))
  }
}

/// The key-value keys, spelled once. The names are the Expo app's, so both apps read alike.
public enum StoreKeys {
  /// The gateway list. Device-wide.
  public static let gateways = "hermie.gateways"
  /// `{ "threshold": "off" | "immediately" | "1m" | "5m" | "15m" }`. Device-wide.
  public static let lock = "hermie.lock"
  /// The push installation id. Device-wide.
  public static let installation = "hermie.installation"
  /// Light or dark. Device-wide.
  public static let appearance = "hermie.appearance"
  public static let language = "hermie.language"
  public static let voice = "hermie.voice"
  /// The reader's context switches. Device-wide.
  public static let context = "hermie.context"
  /// Whether the reader switched notifications on for this device: `true` or `false`. Device-wide.
  public static let pushEnabled = "hermie.push.enabled"
  /**
   This device's push relay registrations, one map keyed by gateway id: handle, environment, token
   fingerprint and last refresh. Device-wide ON PURPOSE, not namespaced: removing a gateway (here or
   through sync) purges its namespace, and the registration must outlive that until the push
   registrar has revoked it at the relay. The relay secrets are in the keychain
   (`SecretKeys.Gateway.push`), which a gateway removal does not touch either.
   */
  public static let pushRegistrations = "hermie.push.registrations"
  /// One map for every gateway's chat arrangement, keyed by gateway id. Not suffixed.
  public static let chatsLayout = "hermie.chats.layout"

  // Namespaced with `GatewayNamespace.key(_:)`.
  public static let gatewayConfig = "hermie.gateway.config"
  public static let authTimeline = "hermie.gateway.auth_timeline"
  public static let chatView = "hermie.chat.view"
  public static let push = "hermie.push"
  public static let botsLastSeen = "hermie.bots.last_seen"
  public static let botsSeenCounts = "hermie.bots.seen_counts"
  public static let botsLastOpened = "hermie.bots.last_opened"
  public static let ownAuthor = "hermie.chats.own_author"
  public static let appChosen = "hermie.app.chosen"
}

/// One write in an atomic batch.
public enum KeyValueWrite: Sendable, Equatable {
  case set(key: String, value: String)
  case remove(key: String)

  /// A Codable value, as the JSON text the store keeps.
  public static func json(_ value: some Encodable, forKey key: String) throws -> KeyValueWrite {
    .set(key: key, value: try KeyValueCoding.encode(value))
  }
}

public enum KeyValueError: Error, Sendable, Equatable {
  /// The stored text is not the JSON the caller asked for. Nothing is deleted: the caller decides.
  case undecodable(key: String, reason: String)
}

/// How values are written: compact JSON, slashes unescaped, the way `JSON.stringify` writes them.
enum KeyValueCoding {
  static func encode(_ value: some Encodable) throws -> String {
    let encoder = JSONEncoder()

    encoder.outputFormatting = [.withoutEscapingSlashes]

    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }

  static func decode<T: Decodable>(_ type: T.Type, from text: String, key: String) throws -> T {
    do {
      return try JSONDecoder().decode(type, from: Data(text.utf8))
    } catch {
      throw KeyValueError.undecodable(key: key, reason: String(describing: error))
    }
  }
}

/// The `kv` table, as synchronous helpers on a connection. Every write is announced on commit.
extension SQLiteDatabase {
  public func kvValue(forKey key: String) throws -> String? {
    try query("SELECT value FROM kv WHERE key = ?", [.text(key)]).first?["value"].text
  }

  public func kvSet(_ value: String, forKey key: String, now: Date = Date()) throws {
    try execute(
      """
      INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      """,
      [.text(key), .text(value), .integer(Self.milliseconds(now))]
    )
    noteChange(key: key, value: value)
  }

  /// Insert only when the key is absent. Answers whether it was written.
  @discardableResult
  public func kvInsertIfAbsent(_ value: String, forKey key: String, now: Date = Date()) throws -> Bool {
    try execute(
      "INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)",
      [.text(key), .text(value), .integer(Self.milliseconds(now))]
    )

    let written = changes > 0

    if written {
      noteChange(key: key, value: value)
    }

    return written
  }

  public func kvRemove(_ key: String) throws {
    try execute("DELETE FROM kv WHERE key = ?", [.text(key)])

    if changes > 0 {
      noteChange(key: key, value: nil)
    }
  }

  public func kvKeys() throws -> [String] {
    try query("SELECT key FROM kv ORDER BY key").compactMap { $0["key"].text }
  }

  static func milliseconds(_ date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1_000).rounded())
  }
}

/**
 Settings and other small state, as typed values over the `kv` table.

 The replacement for the Expo app's AsyncStorage seam (`platform/key-value-store.ts`), with three
 differences that are the reason it exists. Several keys can be written as one atomic batch. A key
 can be observed. And a value that does not decode is reported rather than deleted: the TypeScript
 `getJson` removes what it cannot parse, which for the app lock would be a lock that switches itself
 off.

 Values are JSON text, written the way `JSON.stringify` writes them.
 */
public struct KeyValueStore: Sendable {
  public let store: SQLiteStore

  public init(store: SQLiteStore) {
    self.store = store
  }

  /// The raw stored text, or nil.
  public func string(forKey key: String) async throws -> String? {
    try await store.read { try $0.kvValue(forKey: key) }
  }

  /// A Codable value, or nil when absent. Throws `KeyValueError.undecodable` for text that is not one.
  public func value<T: Decodable & Sendable>(_ type: T.Type, forKey key: String) async throws -> T? {
    guard let text = try await string(forKey: key) else {
      return nil
    }

    return try KeyValueCoding.decode(type, from: text, key: key)
  }

  public func setString(_ value: String, forKey key: String) async throws {
    try await apply([.set(key: key, value: value)])
  }

  public func set(_ value: some Encodable & Sendable, forKey key: String) async throws {
    try await apply([.json(value, forKey: key)])
  }

  public func removeValue(forKey key: String) async throws {
    try await apply([.remove(key: key)])
  }

  /// Every key held, sorted.
  public func keys() async throws -> [String] {
    try await store.read { try $0.kvKeys() }
  }

  /// Several writes as one transaction: all of them land, or none do.
  public func apply(_ writes: [KeyValueWrite]) async throws {
    guard !writes.isEmpty else {
      return
    }

    let now = Date()

    try await store.write { database in
      for write in writes {
        switch write {
        case let .set(key, value):
          try database.kvSet(value, forKey: key, now: now)
        case let .remove(key):
          try database.kvRemove(key)
        }
      }
    }
  }

  /// The changes to one key from now on: the new text, or nil when it was removed.
  public func changes(forKey key: String) -> AsyncStream<String?> {
    store.observers.stream(forKey: key)
  }

  /// The changes to one key, decoded. A value that does not decode arrives as a failure.
  public func values<T: Decodable & Sendable>(
    _ type: T.Type,
    forKey key: String
  ) -> AsyncStream<Result<T?, KeyValueError>> {
    let raw = changes(forKey: key)

    return AsyncStream { continuation in
      let task = Task {
        for await text in raw {
          guard let text else {
            continuation.yield(.success(nil))
            continue
          }

          do {
            continuation.yield(.success(try KeyValueCoding.decode(type, from: text, key: key)))
          } catch let error as KeyValueError {
            continuation.yield(.failure(error))
          } catch {
            continuation.yield(.failure(.undecodable(key: key, reason: String(describing: error))))
          }
        }

        continuation.finish()
      }

      continuation.onTermination = { _ in
        task.cancel()
      }
    }
  }
}
