import Foundation
import Testing

@testable import HermieStore

@Suite("SQLite store")
struct SQLiteStoreTests {
  @Test("a fresh file is created at the latest version, in WAL mode, with the three tables")
  func freshFile() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("nested/hermie.sqlite")
    let (database, report) = try SQLiteDatabase.open(.file(url))

    #expect(report.versionBefore == 0)
    #expect(report.versionAfter == SQLiteSchema.latestVersion)
    #expect(report.corruption == nil)
    #expect(try database.userVersion == 1)
    #expect(try database.query("PRAGMA journal_mode").first?.values.first?.text == "wal")

    let tables = try database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .compactMap { $0["name"].text }

    #expect(tables == ["bots", "kv", "transcripts"])
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

    #expect(report.versionBefore == 1)
    #expect(report.versionAfter == 1)
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
      SQLiteMigration(version: 2, sql: "ALTER TABLE bots ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;")
    ]
    let (database, report) = try SQLiteDatabase.open(.file(url), migrations: stub)

    #expect(report.versionBefore == 1)
    #expect(report.versionAfter == 2)
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
      SQLiteMigration(version: 2, sql: "CREATE TABLE extra (x INTEGER); THIS IS NOT SQL;")
    ]

    #expect(throws: SQLiteError.self) {
      _ = try SQLiteDatabase.open(.file(url), migrations: broken)
    }

    let (database, _) = try SQLiteDatabase.open(.file(url))

    #expect(try database.userVersion == 1)
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

  @Test("a corrupt file is moved aside with its companions and a new one is created")
  func corruptFile() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("hermie.sqlite")
    let garbage = Data(repeating: 0x5A, count: 8_192)

    try garbage.write(to: url)
    try Data("stale wal".utf8).write(to: URL(fileURLWithPath: url.path + "-wal"))

    let (database, report) = try SQLiteDatabase.open(.file(url))
    let corruption = try #require(report.corruption)

    #expect(corruption.movedTo.lastPathComponent == "hermie.sqlite.corrupt")
    #expect(try Data(contentsOf: corruption.movedTo) == garbage)
    #expect(FileManager.default.fileExists(atPath: corruption.movedTo.path + "-wal"))
    #expect(report.versionAfter == 1)
    #expect(try database.kvKeys().isEmpty)

    try database.kvSet("works", forKey: "hermie.test")
    #expect(try database.kvValue(forKey: "hermie.test") == "works")
  }

  @Test("a database whose pages are damaged is caught by the quick check")
  func damagedPages() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = temporary.url.appendingPathComponent("hermie.sqlite")

    do {
      let (database, _) = try SQLiteDatabase.open(.file(url))

      try database.transaction {
        for index in 0..<400 {
          try database.kvSet(String(repeating: "x", count: 200), forKey: "hermie.k\(index)")
        }
      }

      try database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
      try database.execute("PRAGMA journal_mode = DELETE")
      database.close()
    }

    // Keep the header (first page) intact and overwrite pages further in.
    let handle = try FileHandle(forWritingTo: url)

    try handle.seek(toOffset: 8_192)
    handle.write(Data(repeating: 0xFF, count: 16_384))
    try handle.close()

    let (_, report) = try SQLiteDatabase.open(.file(url))

    #expect(report.corruption != nil)
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
    #expect(store.openReport.versionAfter == 1)
  }
}
