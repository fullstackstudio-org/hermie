import Foundation
import Testing

@testable import HermieStore

@Suite("SQLite store")
struct SQLiteStoreTests {
  @Test("a fresh file is created at the latest version, in WAL mode, with its tables")
  func freshFile() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("nested/hermie.sqlite")
    let (database, report) = try SQLiteDatabase.open(.file(url))

    #expect(report.versionBefore == 0)
    #expect(report.versionAfter == SQLiteSchema.latestVersion)
    #expect(report.corruption == nil)
    #expect(try database.userVersion == SQLiteSchema.latestVersion)
    #expect(try database.query("PRAGMA journal_mode").first?.values.first?.text == "wal")

    let tables = try database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .compactMap { $0["name"].text }

    #expect(tables == ["bots", "decisions", "kv", "transcripts"])
    #expect(FileManager.default.fileExists(atPath: url.path))
  }

  @Test("reopening keeps the data and runs no migration")
  func reopen() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("hermie.sqlite")

    do {
      let (database, _) = try SQLiteDatabase.open(.file(url))

      try database.kvSet("1", forKey: "hermie.test")
      database.close()
    }

    let (database, report) = try SQLiteDatabase.open(.file(url))

    #expect(report.versionBefore == SQLiteSchema.latestVersion)
    #expect(report.versionAfter == SQLiteSchema.latestVersion)
    #expect(try database.kvValue(forKey: "hermie.test") == "1")
  }

  @Test("an upgrade runs only the newer steps and keeps the data")
  func upgradePath() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("hermie.sqlite")

    do {
      let (database, _) = try SQLiteDatabase.open(.file(url))

      try database.kvSet("kept", forKey: "hermie.test")
    }

    let stub = SQLiteSchema.migrations + [
      SQLiteMigration(version: SQLiteSchema.latestVersion + 1, sql: "ALTER TABLE bots ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;")
    ]
    let (database, report) = try SQLiteDatabase.open(.file(url), migrations: stub)

    #expect(report.versionBefore == SQLiteSchema.latestVersion)
    #expect(report.versionAfter == SQLiteSchema.latestVersion + 1)
    #expect(try database.kvValue(forKey: "hermie.test") == "kept")

    let columns = try database.query("PRAGMA table_info(bots)").compactMap { $0["name"].text }

    #expect(columns.contains("pinned"))
  }

  @Test("a failing migration step rolls back and leaves the version where it was")
  func failingMigration() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("hermie.sqlite")

    _ = try SQLiteDatabase.open(.file(url))

    let broken = SQLiteSchema.migrations + [
      SQLiteMigration(version: SQLiteSchema.latestVersion + 1, sql: "CREATE TABLE extra (x INTEGER); THIS IS NOT SQL;")
    ]

    #expect(throws: SQLiteError.self) {
      _ = try SQLiteDatabase.open(.file(url), migrations: broken)
    }

    let (database, _) = try SQLiteDatabase.open(.file(url))

    #expect(try database.userVersion == SQLiteSchema.latestVersion)
    #expect(try database.query("SELECT name FROM sqlite_master WHERE name = 'extra'").isEmpty)
  }

  @Test("a file from a newer build is used as it is")
  func newerFile() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("hermie.sqlite")

    do {
      let (database, _) = try SQLiteDatabase.open(.file(url))

      try database.execute("PRAGMA user_version = 7")
      try database.kvSet("still here", forKey: "hermie.test")
    }

    let (database, report) = try SQLiteDatabase.open(.file(url))

    #expect(report.newerThanThisBuild)
    #expect(report.versionAfter == 7)
    #expect(try database.kvValue(forKey: "hermie.test") == "still here")
  }

  @Test("a file that is not a database is replaced; with nothing to rescue, one copy is kept, out of backup")
  func corruptFile() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("hermie.sqlite")
    let garbage = Data(repeating: 0x5A, count: 8_192)

    try garbage.write(to: url)
    try Data("stale wal".utf8).write(to: URL(fileURLWithPath: url.path + "-wal"))

    let (database, report) = try SQLiteDatabase.open(.file(url))
    let corruption = try #require(report.corruption)
    let kept = try #require(corruption.keptCopy)

    #expect(kept.lastPathComponent == "hermie.sqlite.corrupt")
    #expect(try Data(contentsOf: kept) == garbage)
    #expect(FileManager.default.fileExists(atPath: kept.path + "-wal"))
    #expect(isExcludedFromBackup(kept))
    #expect(isExcludedFromBackup(URL(fileURLWithPath: kept.path + "-wal")))
    #expect(!corruption.rescue.complete)
    #expect(corruption.rescue.keys.isEmpty)
    #expect(report.versionAfter == SQLiteSchema.latestVersion)
    #expect(try database.kvKeys().isEmpty)

    try database.kvSet("works", forKey: "hermie.test")
    #expect(try database.kvValue(forKey: "hermie.test") == "works")
  }

  @Test("a readable kv table is rescued into the new file, and the old copy is deleted")
  func rescueComplete() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("hermie.sqlite")
    let rows = [StoreKeys.lock: #"{"threshold":"5m"}"#, StoreKeys.gateways: #"{"v":1}"#, "hermie.nul": "a\u{0}b"]

    try makeDatabaseFile(at: url, rows: rows)

    let corruptOnce = CorruptOnce()
    let (database, report) = try SQLiteDatabase.open(
      .file(url),
      migrations: SQLiteSchema.migrations,
      probe: corruptOnce.probe
    )
    let corruption = try #require(report.corruption)

    #expect(corruption.rescue.complete)
    #expect(Set(corruption.rescue.keys) == Set(rows.keys))
    #expect(corruption.keptCopy == nil)
    #expect(!FileManager.default.fileExists(atPath: url.path + ".corrupt"))

    for (key, value) in rows {
      #expect(try database.kvValue(forKey: key) == value)
    }
  }

  @Test("damaged pages are caught by the first real statements, without an integrity check")
  func damagedPages() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("hermie.sqlite")

    try makeDatabaseFile(
      at: url,
      rows: Dictionary(uniqueKeysWithValues: (0..<400).map { ("hermie.k\($0)", String(repeating: "x", count: 200)) })
    )

    // Keep the header (first page) intact and overwrite pages further in.
    let handle = try FileHandle(forWritingTo: url)

    try handle.seek(toOffset: 8_192)
    handle.write(Data(repeating: 0xFF, count: 16_384))
    try handle.close()

    let (database, report) = try SQLiteDatabase.open(.file(url))
    let corruption = try #require(report.corruption)

    // Which pages the damage hit decides how much comes back: an index alone loses nothing, a
    // table page loses the rows on it. Either way the copy is kept exactly when rows were lost.
    #expect(try database.kvKeys().count == corruption.rescue.keys.count)
    #expect(corruption.rescue.complete == (corruption.keptCopy == nil))
    #expect(corruption.rescue.complete == (corruption.rescue.keys.count == 400))
  }

  @Test("the background check rebuilds a damaged cache and never touches kv")
  func cacheIntegrity() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("hermie.sqlite")
    var pageSize: Int64 = 4_096
    var botsRoot: Int64 = 0

    do {
      let (database, _) = try SQLiteDatabase.open(.file(url))

      #expect(database.checkCacheIntegrity() == .ok)

      try database.transaction {
        try database.kvSet(#"{"threshold":"1m"}"#, forKey: StoreKeys.lock)

        for index in 0..<300 {
          try database.execute(
            "INSERT INTO bots (ns, name, json, avatar_rev, updated_at) VALUES ('g01', ?, ?, 0, 0)",
            [.text("bot\(index)"), .text(String(repeating: "j", count: 300))]
          )
        }
      }

      pageSize = try database.query("PRAGMA page_size").first?.values.first?.integer ?? 4_096
      botsRoot =
        try database.query("SELECT rootpage FROM sqlite_master WHERE name = 'bots'").first?["rootpage"].integer ?? 0
      try database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
      database.close()
    }

    // Wreck the bots table's root page; the launch path does not look at it.
    let handle = try FileHandle(forWritingTo: url)

    try handle.seek(toOffset: UInt64((botsRoot - 1) * pageSize))
    handle.write(Data(repeating: 0xFF, count: Int(pageSize)))
    try handle.close()

    let (database, report) = try SQLiteDatabase.open(.file(url))

    #expect(report.corruption == nil)

    let result = database.checkCacheIntegrity()

    guard case .rebuiltCache = result else {
      Issue.record("expected the cache to be rebuilt, got \(result)")
      return
    }

    #expect(try database.kvValue(forKey: StoreKeys.lock) == #"{"threshold":"1m"}"#)
    #expect(try database.query("SELECT count(*) AS n FROM bots").first?["n"].integer == 0)
    #expect(database.checkCacheIntegrity() == .ok)

    try database.execute("INSERT INTO bots (ns, name, json, updated_at) VALUES ('g01', 'again', '{}', 0)")
  }

  @Test("the database file and its companions are excluded from backup")
  func backupExclusion() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("hermie.sqlite")
    let (database, _) = try SQLiteDatabase.open(.file(url))

    try database.kvSet("1", forKey: "hermie.a")
    SQLiteDatabase.excludeFromBackup(url)

    #expect(isExcludedFromBackup(url))
    #expect(isExcludedFromBackup(URL(fileURLWithPath: url.path + "-wal")))
  }

  @Test("text with a NUL inside is stored and read back whole")
  func embeddedNul() throws {
    let database = try memoryDatabase()
    let value = "before\u{0}after ✓"

    try database.kvSet(value, forKey: "hermie.nul")
    try database.kvSet("", forKey: "hermie.empty")

    #expect(try database.kvValue(forKey: "hermie.nul") == value)
    #expect(try database.kvValue(forKey: "hermie.empty") == "")
    let stored = try database.query("SELECT length(CAST(value AS BLOB)) AS n FROM kv WHERE key = 'hermie.nul'")

    #expect(stored.first?["n"].integer == 16)
  }

  @Test("when the outer transaction disappears inside a savepoint, nothing more runs outside it")
  func lostOuterTransaction() throws {
    let database = try memoryDatabase()

    #expect(throws: SQLiteError.self) {
      try database.transaction {
        try database.kvSet("before", forKey: "hermie.before")

        _ = try? database.transaction {
          // What SQLite does on its own after some I/O and full-disk errors.
          try database.execute("ROLLBACK")
          throw CancellationError()
        }

        // Without the check this would run in autocommit mode and stick.
        try database.kvSet("after", forKey: "hermie.after")
      }
    }

    #expect(try database.kvValue(forKey: "hermie.before") == nil)
    #expect(try database.kvValue(forKey: "hermie.after") == nil)
    #expect(!database.isInTransaction)

    // And the connection is usable again once the outer call has unwound.
    try database.transaction { try database.kvSet("ok", forKey: "hermie.ok") }
    #expect(try database.kvValue(forKey: "hermie.ok") == "ok")
  }


  @Test("a transaction that throws leaves nothing behind; a nested one rolls back alone")
  func transactions() throws {
    let database = try memoryDatabase()

    #expect(throws: CancellationError.self) {
      try database.transaction {
        try database.kvSet("a", forKey: "hermie.a")
        throw CancellationError()
      }
    }

    #expect(try database.kvValue(forKey: "hermie.a") == nil)

    try database.transaction {
      try database.kvSet("outer", forKey: "hermie.outer")

      _ = try? database.transaction {
        try database.kvSet("inner", forKey: "hermie.inner")
        throw CancellationError()
      }
    }

    #expect(try database.kvValue(forKey: "hermie.outer") == "outer")
    #expect(try database.kvValue(forKey: "hermie.inner") == nil)
    #expect(!database.isInTransaction)
  }

  @Test("values of every type round trip through prepared statements")
  func valueTypes() throws {
    let database = try memoryDatabase()

    try database.execute("CREATE TABLE t (a, b, c, d, e)")

    let blob = Data([0, 1, 2, 255])

    for _ in 0..<3 {
      try database.execute(
        "INSERT INTO t VALUES (?, ?, ?, ?, ?)",
        [.integer(Int64.max), .real(1.5), .text("café ✓"), .blob(blob), .null]
      )
    }

    let rows = try database.query("SELECT * FROM t")

    #expect(rows.count == 3)
    #expect(rows[0]["a"] == .integer(Int64.max))
    #expect(rows[0]["b"] == .real(1.5))
    #expect(rows[0]["c"] == .text("café ✓"))
    #expect(rows[0]["d"] == .blob(blob))
    #expect(rows[0]["e"] == .null)
  }

  @Test("the actor serialises reads and writes")
  func actor() async throws {
    let store = try SQLiteStore(.inMemory)

    try await withThrowingTaskGroup(of: Void.self) { group in
      for index in 0..<50 {
        group.addTask {
          try await store.write { try $0.kvSet("\(index)", forKey: "hermie.k\(index)") }
        }
      }

      try await group.waitForAll()
    }

    #expect(try await store.read { try $0.kvKeys().count } == 50)
    #expect(store.openReport.versionAfter == SQLiteSchema.latestVersion)
  }
}
