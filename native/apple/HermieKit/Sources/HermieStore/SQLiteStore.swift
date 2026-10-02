import Foundation
import Synchronization

/**
 The schema of `hermie.sqlite`, one `PRAGMA user_version` step at a time.

 A step is only ever appended. Version 1 is the three tables the plan names: `kv` for settings,
 and `bots` and `transcripts` for the chat cache, both keyed by the gateway they came from (`ns`
 is the gateway id) so that removing a gateway is one `DELETE ... WHERE ns = ?` per table.
 */
public enum SQLiteSchema {
  public static let migrations: [SQLiteMigration] = [
    SQLiteMigration(
      version: 1,
      sql: """
        CREATE TABLE kv (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE bots (
          ns TEXT NOT NULL,
          name TEXT NOT NULL,
          json TEXT NOT NULL,
          avatar_rev INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (ns, name)
        );
        CREATE TABLE transcripts (
          ns TEXT NOT NULL,
          bot TEXT NOT NULL,
          items_json TEXT NOT NULL,
          last_row_id INTEGER,
          last_seq INTEGER,
          epoch TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (ns, bot)
        );
        """
    )
  ]

  /**
   The cache tables in their CURRENT shape, for `checkCacheIntegrity` to recreate them empty.

   Version 1 spells the same thing out on its own, because a migration is history and must not
   change; a later migration that changes `bots` or `transcripts` updates this as well.
   */
  public static let cacheTables = """
    CREATE TABLE IF NOT EXISTS bots (
      ns TEXT NOT NULL,
      name TEXT NOT NULL,
      json TEXT NOT NULL,
      avatar_rev INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ns, name)
    );
    CREATE TABLE IF NOT EXISTS transcripts (
      ns TEXT NOT NULL,
      bot TEXT NOT NULL,
      items_json TEXT NOT NULL,
      last_row_id INTEGER,
      last_seq INTEGER,
      epoch TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ns, bot)
    );
    """

  /// The version this build writes.
  public static var latestVersion: Int {
    migrations.map(\.version).max() ?? 0
  }

  /// The file name, inside Application Support. Never inside the App Group container.
  public static let fileName = "hermie.sqlite"
}

/**
 The one owner of the database connection.

 Everything that touches `hermie.sqlite` after launch goes through here — the key-value store,
 the gateway registry and the chat cache are thin views onto this actor — so the connection is
 never used from two threads and a multi-table change (removing a gateway) is one transaction.
 */
public actor SQLiteStore {
  private let database: SQLiteDatabase

  /// What opening the file found.
  public nonisolated let openReport: SQLiteOpenReport

  /// Where key-value changes are announced; readable without awaiting.
  public nonisolated let observers: KeyValueObservers

  /// Open, migrate and own a database.
  public init(
    _ location: SQLiteLocation,
    migrations: [SQLiteMigration] = SQLiteSchema.migrations
  ) throws {
    let (database, report) = try SQLiteDatabase.open(location, migrations: migrations)

    self.init(database: database, openReport: report)
  }

  /// Take over a database the launch already opened (and imported into) synchronously.
  public init(database: sending SQLiteDatabase, openReport: SQLiteOpenReport) {
    self.observers = database.observers
    self.database = database
    self.openReport = openReport
  }

  /// A read. Not wrapped in a transaction; a single statement is atomic on its own.
  public func read<T: Sendable>(_ body: @Sendable (SQLiteDatabase) throws -> T) throws -> T {
    try body(database)
  }

  /// A write, as one transaction: everything in `body` lands, or nothing does.
  public func write<T: Sendable>(_ body: @Sendable (SQLiteDatabase) throws -> T) throws -> T {
    try database.transaction {
      try body(database)
    }
  }

  /// The full integrity check, off the launch path: run it from a background task after launch.
  /// A failure rebuilds the chat cache only; see `SQLiteDatabase.checkCacheIntegrity`.
  public func checkCacheIntegrity() -> CacheIntegrityReport {
    database.checkCacheIntegrity()
  }
}

/**
 Change notification for key-value keys, as one `AsyncStream` per subscriber per key.

 Fed by `SQLiteDatabase` after a transaction commits, never before, so a subscriber cannot see a
 value that was rolled back. Each stream yields the new raw value, or nil when the key was removed,
 and keeps only the newest unread value: an observer of a setting wants where it ended up, not
 every step on the way.
 */
public final class KeyValueObservers: Sendable {
  private struct State {
    var next: UInt64 = 0
    var streams: [String: [UInt64: AsyncStream<String?>.Continuation]] = [:]
  }

  private let state = Mutex(State())

  public init() {}

  /// A stream of the changes to one key, starting now. It ends when the consumer stops iterating.
  public func stream(forKey key: String) -> AsyncStream<String?> {
    let (stream, continuation) = AsyncStream.makeStream(of: String?.self, bufferingPolicy: .bufferingNewest(1))
    let id = state.withLock { state -> UInt64 in
      let id = state.next

      state.next += 1
      state.streams[key, default: [:]][id] = continuation

      return id
    }

    continuation.onTermination = { [weak self] _ in
      self?.state.withLock { state in
        state.streams[key]?[id] = nil

        if state.streams[key]?.isEmpty == true {
          state.streams[key] = nil
        }
      }
    }

    return stream
  }

  /// How many streams are open for a key. For tests.
  public func subscriberCount(forKey key: String) -> Int {
    state.withLock { $0.streams[key]?.count ?? 0 }
  }

  func publish(_ changes: [String: String?]) {
    let targets = state.withLock { state in
      changes.compactMap { key, value in
        state.streams[key].map { (Array($0.values), value) }
      }
    }

    for (continuations, value) in targets {
      for continuation in continuations {
        continuation.yield(value)
      }
    }
  }
}
