import Foundation

/**
 One bot's cached transcript: the last items as opaque JSON, and where the stream had got to.

 The item format belongs to the transcript engine, which also cuts the list to `ChatCacheLimits
 .items` before writing; this store keeps the text it is given and hands it back unread, so a format
 change there invalidates a snapshot without this file knowing why. Mirrors `CachedTranscriptRow`
 in `expo/hermie/src/platform/chat-cache-core.ts`.
 */
public struct CachedTranscript: Sendable, Equatable {
  public var bot: String
  public var itemsJSON: String
  public var lastRowId: Int64?
  public var lastSeq: Int64?
  public var epoch: String?
  /// Epoch milliseconds.
  public var updatedAt: Int64

  public init(bot: String, itemsJSON: String, lastRowId: Int64?, lastSeq: Int64?, epoch: String?, updatedAt: Int64) {
    self.bot = bot
    self.itemsJSON = itemsJSON
    self.lastRowId = lastRowId
    self.lastSeq = lastSeq
    self.epoch = epoch
    self.updatedAt = updatedAt
  }
}

/// One roster row: the bot as the gateway described it (opaque JSON) and its avatar revision.
public struct CachedBot: Sendable, Equatable {
  public var name: String
  public var json: String
  public var avatarRevision: Int64
  /// Epoch milliseconds.
  public var updatedAt: Int64

  public init(name: String, json: String, avatarRevision: Int64, updatedAt: Int64) {
    self.name = name
    self.json = json
    self.avatarRevision = avatarRevision
    self.updatedAt = updatedAt
  }
}

public enum ChatCacheLimits {
  /// How many transcript items a snapshot keeps (`CACHE_ITEM_LIMIT`); the writer cuts, not the store.
  public static let items = 200
}

/// The chat cache contract of `chat-cache-core.ts`, for one gateway.
public protocol ChatCaching: Sendable {
  func read(bot: String) async throws -> CachedTranscript?
  func write(_ snapshot: CachedTranscript) async throws
  func forget(bot: String) async throws
  func readBots() async throws -> [CachedBot]
  /// Replace this gateway's roster wholesale: a bot no longer listed disappears.
  func writeBots(_ rows: [CachedBot]) async throws
  /// Everything cached for this gateway.
  func clear() async throws
}

/// The cache in `hermie.sqlite`, scoped to one gateway by `ns`.
public struct SQLiteChatCache: ChatCaching {
  public let store: SQLiteStore
  /// The gateway id.
  public let namespace: String

  public init(store: SQLiteStore, gatewayId: String) {
    self.store = store
    self.namespace = gatewayId
  }

  public func read(bot: String) async throws -> CachedTranscript? {
    let ns = namespace

    return try await store.read { database in
      try database.query("SELECT * FROM transcripts WHERE ns = ? AND bot = ?", [.text(ns), .text(bot)])
        .first
        .map { row in
          CachedTranscript(
            bot: row["bot"].text ?? bot,
            itemsJSON: row["items_json"].text ?? "[]",
            lastRowId: row["last_row_id"].integer,
            lastSeq: row["last_seq"].integer,
            epoch: row["epoch"].text,
            updatedAt: row["updated_at"].integer ?? 0
          )
        }
    }
  }

  public func write(_ snapshot: CachedTranscript) async throws {
    let ns = namespace

    try await store.write { database in
      try database.execute(
        """
        INSERT INTO transcripts (ns, bot, items_json, last_row_id, last_seq, epoch, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ns, bot) DO UPDATE SET
          items_json = excluded.items_json,
          last_row_id = excluded.last_row_id,
          last_seq = excluded.last_seq,
          epoch = excluded.epoch,
          updated_at = excluded.updated_at
        """,
        [
          .text(ns), .text(snapshot.bot), .text(snapshot.itemsJSON), .integer(snapshot.lastRowId),
          .integer(snapshot.lastSeq), .text(snapshot.epoch), .integer(snapshot.updatedAt)
        ]
      )
    }
  }

  public func forget(bot: String) async throws {
    let ns = namespace

    try await store.write { database in
      try database.execute("DELETE FROM transcripts WHERE ns = ? AND bot = ?", [.text(ns), .text(bot)])
    }
  }

  public func readBots() async throws -> [CachedBot] {
    let ns = namespace

    return try await store.read { database in
      try database.query("SELECT * FROM bots WHERE ns = ? ORDER BY name", [.text(ns)]).map { row in
        CachedBot(
          name: row["name"].text ?? "",
          json: row["json"].text ?? "{}",
          avatarRevision: row["avatar_rev"].integer ?? 0,
          updatedAt: row["updated_at"].integer ?? 0
        )
      }
    }
  }

  public func writeBots(_ rows: [CachedBot]) async throws {
    let ns = namespace

    try await store.write { database in
      try database.execute("DELETE FROM bots WHERE ns = ?", [.text(ns)])

      for row in rows {
        try database.execute(
          "INSERT OR REPLACE INTO bots (ns, name, json, avatar_rev, updated_at) VALUES (?, ?, ?, ?, ?)",
          [.text(ns), .text(row.name), .text(row.json), .integer(row.avatarRevision), .integer(row.updatedAt)]
        )
      }
    }
  }

  public func clear() async throws {
    let ns = namespace

    try await store.write { database in
      try database.execute("DELETE FROM transcripts WHERE ns = ?", [.text(ns)])
      try database.execute("DELETE FROM bots WHERE ns = ?", [.text(ns)])
    }
  }
}

/// A cache that forgets between launches. Satisfies the contract without a database.
public actor MemoryChatCache: ChatCaching {
  private var transcripts: [String: CachedTranscript] = [:]
  private var bots: [CachedBot] = []

  public init() {}

  public func read(bot: String) -> CachedTranscript? {
    transcripts[bot]
  }

  public func write(_ snapshot: CachedTranscript) {
    transcripts[snapshot.bot] = snapshot
  }

  public func forget(bot: String) {
    transcripts[bot] = nil
  }

  public func readBots() -> [CachedBot] {
    bots
  }

  public func writeBots(_ rows: [CachedBot]) {
    bots = rows
  }

  public func clear() {
    transcripts.removeAll()
    bots.removeAll()
  }
}

/**
 A cache that starts on the database and gives up on it for good the first time it throws.

 The app is not allowed to lose a chat over a cache: a full disk or a database that went bad
 mid-session downgrades this instance to memory, and the chat carries on with a cache that simply
 forgets between launches. As `FallbackChatCache` in `chat-cache-core.ts`.
 */
public actor FallbackChatCache: ChatCaching {
  private var primary: (any ChatCaching)?
  private let fallback = MemoryChatCache()

  public init(primary: any ChatCaching) {
    self.primary = primary
  }

  /// True once the primary has failed and this instance runs in memory.
  public var degraded: Bool {
    primary == nil
  }

  private func run<T: Sendable>(_ action: @Sendable (any ChatCaching) async throws -> T) async throws -> T {
    guard let primary else {
      return try await action(fallback)
    }

    do {
      return try await action(primary)
    } catch {
      self.primary = nil

      return try await action(fallback)
    }
  }

  public func read(bot: String) async throws -> CachedTranscript? {
    try await run { try await $0.read(bot: bot) }
  }

  public func write(_ snapshot: CachedTranscript) async throws {
    try await run { try await $0.write(snapshot) }
  }

  public func forget(bot: String) async throws {
    try await run { try await $0.forget(bot: bot) }
  }

  public func readBots() async throws -> [CachedBot] {
    try await run { try await $0.readBots() }
  }

  public func writeBots(_ rows: [CachedBot]) async throws {
    try await run { try await $0.writeBots(rows) }
  }

  public func clear() async throws {
    try await run { try await $0.clear() }
  }
}
