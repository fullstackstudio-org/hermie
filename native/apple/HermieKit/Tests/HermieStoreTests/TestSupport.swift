import Foundation

@testable import HermieStore

/// A fresh directory under the system temporary directory, removed by `cleanUp()`.
struct TemporaryDirectory {
  let url: URL

  init() throws {
    url = FileManager.default.temporaryDirectory
      .appendingPathComponent("hermie-store-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  }

  func cleanUp() {
    try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    try? FileManager.default.removeItem(at: url)
  }
}

func memoryDatabase() throws -> SQLiteDatabase {
  try SQLiteDatabase.open(.inMemory).database
}

/// A database file holding `rows` in `kv`, closed and checkpointed.
func makeDatabaseFile(at url: URL, rows: [String: String]) throws {
  let (database, _) = try SQLiteDatabase.open(.file(url))

  try database.transaction {
    for (key, value) in rows {
      try database.kvSet(value, forKey: key)
    }
  }

  try database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
  database.close()
}

/// A probe that reports corruption the first time it runs and passes after that, so a test can
/// send a perfectly readable file down the recovery path.
final class CorruptOnce: @unchecked Sendable {
  private var fired = false

  func probe(_ database: SQLiteDatabase) throws {
    if !fired {
      fired = true
      throw SQLiteError(code: 11, message: "database disk image is malformed (test)")
    }

    try SQLiteDatabase.launchProbe(database)
  }
}

func isExcludedFromBackup(_ url: URL) -> Bool {
  (try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup == true
}
