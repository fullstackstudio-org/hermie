import Foundation
import HermieStore
import Observation

/**
 The decision log (NX-18): every decision the person made on a request, kept on this device and nowhere else.

 - **Where.** The `decisions` table of `hermie.sqlite`, one row per entry, scoped to its gateway by `ns` like
   the chat cache. The database is outside the App Group and excluded from iCloud and device backups
   (`SQLiteDatabase.excludeFromBackup`), and nothing here reaches the keychain's synced set, so the log
   never travels to another device. Removing a gateway purges its rows in the same transaction that
   removes it (`GatewayRegistryStore.purge`); signing out purges them too (`GatewayAccounts.signOut`).
 - **How much.** `DecisionLimits.standard`: at most 5,000 entries, none older than 90 days, whichever limit
   is hit first. Every write prunes in its own transaction, and `prune()` runs at launch for a log nobody
   wrote to for a while.
 - **What.** Entries and nothing else: see `DecisionEntry`. A write that fails is dropped: the person's
   answer has gone out, and a log that cannot be written must never turn into a failed answer.
 */
@MainActor
@Observable
public final class DecisionLog {
  public let limits: DecisionLimits
  /// Moves whenever the log changed, so a screen reads it again.
  public private(set) var revision = 0

  @ObservationIgnored private let store: SQLiteStore
  @ObservationIgnored private let now: @Sendable () -> Date

  public init(store: SQLiteStore, limits: DecisionLimits = .standard, now: @escaping @Sendable () -> Date = { Date() }) {
    self.store = store
    self.limits = limits
    self.now = now
  }

  // MARK: Writing

  /// Keep one decision, and drop what the limits no longer allow.
  public func record(_ entry: DecisionEntry) async {
    guard let json = Self.encode(entry) else {
      return
    }

    let cutoff = Self.milliseconds(now().addingTimeInterval(-limits.maxAge))
    let keep = max(0, limits.maxEntries)
    let id = entry.id
    let ns = entry.gatewayID
    let bot = entry.bot
    let at = Self.milliseconds(entry.at)

    do {
      try await store.write { database in
        try database.execute(
          "INSERT OR REPLACE INTO decisions (id, ns, bot, at, json) VALUES (?, ?, ?, ?, ?)",
          [.text(id), .text(ns), .text(bot), .integer(at), .text(json)]
        )
        _ = try Self.prune(database, cutoff: cutoff, keep: keep)
      }
      revision += 1
    } catch {
      // Dropped on purpose: see the type's notes.
    }
  }

  /// Drop what is older than the age limit or beyond the count limit.
  public func prune() async {
    let cutoff = Self.milliseconds(now().addingTimeInterval(-limits.maxAge))
    let keep = max(0, limits.maxEntries)

    do {
      let removed = try await store.write { database in
        try Self.prune(database, cutoff: cutoff, keep: keep)
      }

      if removed > 0 {
        revision += 1
      }
    } catch {
      // Tried again by the next write.
    }
  }

  /// A gateway was signed out of or removed: its entries go.
  public func purge(gatewayID: String) async {
    do {
      try await store.write { database in
        try database.execute("DELETE FROM decisions WHERE ns = ?", [.text(gatewayID)])
      }
    } catch {
      return
    }

    revision += 1
  }

  /// Every entry of every gateway goes.
  public func clear() async {
    do {
      try await store.write { database in
        try database.execute("DELETE FROM decisions", [])
      }
    } catch {
      return
    }

    revision += 1
  }

  /// Answers how many rows went.
  nonisolated private static func prune(_ database: SQLiteDatabase, cutoff: Int64, keep: Int) throws -> Int {
    try database.execute("DELETE FROM decisions WHERE at < ?", [.integer(cutoff)])
    var removed = database.changes
    try database.execute(
      """
      DELETE FROM decisions WHERE id IN (
        SELECT id FROM decisions ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?
      )
      """,
      [.integer(Int64(keep))]
    )

    removed += database.changes

    return removed
  }

  // MARK: Reading

  /// The entries, newest first: every one, or those of one gateway, or of one bot of one gateway. A row this
  /// build cannot read (written by a newer one) is left out.
  public func entries(gatewayID: String? = nil, bot: String? = nil) async -> [DecisionEntry] {
    let (clause, arguments) = Self.scope(gatewayID: gatewayID, bot: bot)
    let rows =
      (try? await store.read { database in
        try database.query("SELECT json FROM decisions\(clause) ORDER BY at DESC, rowid DESC", arguments)
          .compactMap { $0["json"].text }
      }) ?? []

    return rows.compactMap(Self.decode)
  }

  /// How many entries are kept, in the same scope.
  public func count(gatewayID: String? = nil, bot: String? = nil) async -> Int {
    let (clause, arguments) = Self.scope(gatewayID: gatewayID, bot: bot)

    return (try? await store.read { database in
      Int(try database.query("SELECT count(*) AS n FROM decisions\(clause)", arguments).first?["n"].integer ?? 0)
    }) ?? 0
  }

  nonisolated private static func scope(gatewayID: String?, bot: String?) -> (String, [SQLiteValue]) {
    var conditions: [String] = []
    var arguments: [SQLiteValue] = []

    if let gatewayID {
      conditions.append("ns = ?")
      arguments.append(.text(gatewayID))
    }

    if let bot {
      conditions.append("bot = ?")
      arguments.append(.text(bot))
    }

    return (conditions.isEmpty ? "" : " WHERE " + conditions.joined(separator: " AND "), arguments)
  }

  /// Every column of every row as one text, for a test that looks for a value that must not be anywhere in it.
  func dump() async -> String {
    let rows =
      (try? await store.read { database in
        try database.query("SELECT id, ns, bot, at, json FROM decisions").map { row in
          row.values.map { value in
            switch value {
            case .text(let text): text
            case .integer(let number): String(number)
            default: ""
            }
          }.joined(separator: "|")
        }
      }) ?? []

    return rows.joined(separator: "\n")
  }

  // MARK: Coding

  nonisolated static func encode(_ entry: DecisionEntry) -> String? {
    let encoder = JSONEncoder()

    encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]

    return (try? encoder.encode(entry)).map { String(decoding: $0, as: UTF8.self) }
  }

  nonisolated static func decode(_ json: String) -> DecisionEntry? {
    try? JSONDecoder().decode(DecisionEntry.self, from: Data(json.utf8))
  }

  nonisolated private static func milliseconds(_ date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1000).rounded())
  }
}
