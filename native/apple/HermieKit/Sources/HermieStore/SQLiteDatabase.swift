import Foundation
import SQLite3

/// One value going into or coming out of SQLite.
public enum SQLiteValue: Sendable, Hashable {
  case null
  case integer(Int64)
  case real(Double)
  case text(String)
  case blob(Data)

  public var integer: Int64? {
    switch self {
    case let .integer(value): value
    case let .real(value): Int64(exactly: value)
    default: nil
    }
  }

  public var text: String? {
    if case let .text(value) = self {
      return value
    }

    return nil
  }

  public var isNull: Bool {
    self == .null
  }
}

extension SQLiteValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByNilLiteral {
  public init(stringLiteral value: String) {
    self = .text(value)
  }

  public init(integerLiteral value: Int64) {
    self = .integer(value)
  }

  public init(nilLiteral: ()) {
    self = .null
  }

  /// Text, or `.null` for nil.
  public static func text(_ value: String?) -> SQLiteValue {
    value.map(SQLiteValue.text) ?? .null
  }

  /// An integer, or `.null` for nil.
  public static func integer(_ value: Int64?) -> SQLiteValue {
    value.map(SQLiteValue.integer) ?? .null
  }
}

/// One result row, by column name.
public struct SQLiteRow: Sendable {
  public let columns: [String]
  public let values: [SQLiteValue]

  public subscript(_ column: String) -> SQLiteValue {
    guard let index = columns.firstIndex(of: column) else {
      return .null
    }

    return values[index]
  }
}

/// A failure from SQLite, with the primary result code kept so corruption can be told apart.
public struct SQLiteError: Error, Sendable, Equatable, CustomStringConvertible {
  public let code: Int32
  public let message: String

  /// `SQLITE_CORRUPT` or `SQLITE_NOTADB`: the file is not a database we can trust.
  public var isCorruption: Bool {
    code == SQLITE_CORRUPT || code == SQLITE_NOTADB
  }

  public var description: String {
    "SQLite error \(code): \(message)"
  }
}

/// Where the database lives.
public enum SQLiteLocation: Sendable, Equatable {
  /// A file. The directory is created when missing.
  case file(URL)
  /// A private in-memory database, for tests and previews.
  case inMemory
}

/// One schema step: run when `PRAGMA user_version` is below `version`, inside a transaction.
public struct SQLiteMigration: Sendable {
  public let version: Int
  public let apply: @Sendable (SQLiteDatabase) throws -> Void

  public init(version: Int, apply: @escaping @Sendable (SQLiteDatabase) throws -> Void) {
    self.version = version
    self.apply = apply
  }

  /// A step that is one SQL script.
  public init(version: Int, sql: String) {
    self.init(version: version) { database in
      try database.executeScript(sql)
    }
  }
}

/// What opening the database found, for the launch report.
public struct SQLiteOpenReport: Sendable, Equatable {
  /// `user_version` before migrations ran. Zero for a new file.
  public var versionBefore: Int = 0
  /// `user_version` after migrations ran.
  public var versionAfter: Int = 0
  /// Set when a newer build wrote the file. It is used as it is; nothing is migrated down.
  public var newerThanThisBuild = false
  /// Set when the file was corrupt and a new one was created in its place.
  public var corruption: Corruption?

  public struct Corruption: Sendable, Equatable {
    /// What SQLite said about the old file.
    public let reason: String
    /// What could be read back out of the old file's `kv` table.
    public let rescue: KeyValueRescue
    /// The old file, when it was kept for diagnosis because the rescue was incomplete. Its `-wal`
    /// and `-shm` sit beside it; all three are excluded from backup and replaced by the next one.
    public let keptCopy: URL?
  }
}

/// The `kv` rows copied out of a corrupt database file into its replacement.
public struct KeyValueRescue: Sendable, Equatable {
  /// The keys that were copied.
  public var keys: [String] = []
  /// True when the whole table was read without an error, so `keys` is everything there was.
  public var complete = false
}

/// What the background integrity check found and did.
public enum CacheIntegrityReport: Sendable, Equatable {
  case ok
  /// The check failed; `bots` and `transcripts` were dropped and recreated empty, and the database
  /// passed the check afterwards. The chats are rebuilt from the gateway.
  case rebuiltCache(reason: String)
  /// The check still fails with the cache rebuilt: the damage is in `kv`, which is never dropped
  /// here. The next launch that trips over it moves the file aside and rescues what it can.
  case keyValueDamaged(reason: String)
  /// The cache tables could not be rebuilt.
  case repairFailed(reason: String)
}

/**
 One connection to SQLite through the system library.

 Not `Sendable` and not thread-safe on purpose: it is owned by exactly one `SQLiteStore` actor,
 which serialises every use. It is a class of its own, rather than the actor's private state,
 because the launch needs it synchronously: the database is opened, recovered if it has to be, and
 checked for the lock setting before the first frame, and only then handed to the actor.

 Statements are prepared once per SQL string and reused. Transactions nest through savepoints, and
 key-value changes made inside one are announced only after the outermost commit, so an observer
 never sees a value that was then rolled back.
 */
public final class SQLiteDatabase {
  private var handle: OpaquePointer?
  private var statements: [String: OpaquePointer] = [:]
  private var transactionDepth = 0
  private var pendingChanges: [String: String?] = [:]
  private var mirrors: [String: (String?) -> Void] = [:]
  /// Set when SQLite rolled the outer transaction back on its own inside a savepoint; nothing more
  /// runs until the outermost `transaction` call unwinds.
  private var transactionLost = false

  /// Where key-value changes are announced. Shared with the actor that ends up owning this.
  public let observers: KeyValueObservers

  /// The file, or nil in memory.
  public let fileURL: URL?

  private init(handle: OpaquePointer, fileURL: URL?, observers: KeyValueObservers) {
    self.handle = handle
    self.fileURL = fileURL
    self.observers = observers
  }

  deinit {
    close()
  }

  /// Finalise every statement and close. Safe to call twice.
  public func close() {
    for statement in statements.values {
      sqlite3_finalize(statement)
    }

    statements.removeAll()

    if let handle {
      sqlite3_close_v2(handle)
    }

    handle = nil
  }

  // MARK: Opening

  /**
   Open (creating when needed), switch on WAL and migrate.

   There is no integrity check here: a full check reads the whole file, and this runs before the
   first frame. Corruption shows itself instead in the first real statements — the header read by
   `journal_mode`, the schema read by the migration, and a count over `kv` — as `SQLITE_NOTADB` or
   `SQLITE_CORRUPT`. Damage further in, in the chat cache, is the business of `checkCacheIntegrity`,
   which the app runs in the background.

   A file that fails that way is moved aside with its `-wal` and `-shm`, and a fresh one is created.
   Then every `kv` row that can still be read from the old file is copied across: settings and the
   gateway list survive whatever part of the file is intact. The cached chats are not rescued; they
   come back from the gateway. When the rescue read the whole table the old file is deleted;
   otherwise one copy is kept for diagnosis (see `SQLiteOpenReport.Corruption.keptCopy`).

   Any other failure (a file that cannot be opened before the first unlock, a full disk) throws.
   */
  public static func open(
    _ location: SQLiteLocation,
    migrations: [SQLiteMigration] = SQLiteSchema.migrations
  ) throws -> (database: SQLiteDatabase, report: SQLiteOpenReport) {
    try open(location, migrations: migrations, probe: launchProbe)
  }

  /// The statements that surface corruption at launch: the schema, then every `kv` page.
  static func launchProbe(_ database: SQLiteDatabase) throws {
    _ = try database.query("SELECT count(*) FROM sqlite_master")
    _ = try database.query("SELECT count(*) FROM kv")
  }

  /// `open`, with the corruption probe replaceable for tests.
  static func open(
    _ location: SQLiteLocation,
    migrations: [SQLiteMigration],
    probe: @Sendable (SQLiteDatabase) throws -> Void
  ) throws -> (database: SQLiteDatabase, report: SQLiteOpenReport) {
    do {
      return try attemptOpen(location, migrations: migrations, probe: probe)
    } catch let error as SQLiteError where error.isCorruption {
      guard case let .file(url) = location else {
        throw error
      }

      let moved = try moveAside(url)
      var (database, report) = try attemptOpen(location, migrations: migrations, probe: probe)
      let rescue = database.rescueKeyValues(from: moved)

      if rescue.complete {
        removeFileSet(moved)
      } else {
        excludeFromBackup(moved)
      }

      report.corruption = .init(reason: error.message, rescue: rescue, keptCopy: rescue.complete ? nil : moved)

      return (database, report)
    }
  }

  private static func attemptOpen(
    _ location: SQLiteLocation,
    migrations: [SQLiteMigration],
    probe: @Sendable (SQLiteDatabase) throws -> Void
  ) throws -> (database: SQLiteDatabase, report: SQLiteOpenReport) {
    let path: String
    var fileURL: URL?

    switch location {
    case let .file(url):
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      path = url.path
      fileURL = url
    case .inMemory:
      path = ":memory:"
    }

    let raw = try openHandle(path)
    let database = SQLiteDatabase(handle: raw, fileURL: fileURL, observers: KeyValueObservers())

    do {
      sqlite3_busy_timeout(raw, 2_000)

      if fileURL != nil {
        _ = try database.query("PRAGMA journal_mode = WAL")
        try database.execute("PRAGMA synchronous = NORMAL")
      }

      let report = try database.migrate(migrations)

      try probe(database)

      return (database, report)
    } catch {
      database.close()

      throw error
    }
  }

  /// One read-write connection, creating the file when needed.
  private static func openHandle(_ path: String) throws -> OpaquePointer {
    var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX

    #if os(iOS)
      // Readable after the first unlock since boot, so a launch in the background (a push, a
      // widget refresh) can still read settings. The flag also covers the -wal and -shm files.
      if path != ":memory:" {
        flags |= SQLITE_OPEN_FILEPROTECTION_COMPLETEUNTILFIRSTUSERAUTHENTICATION
      }
    #endif

    var raw: OpaquePointer?
    let status = sqlite3_open_v2(path, &raw, flags, nil)

    guard status == SQLITE_OK, let raw else {
      let message = raw.map { String(cString: sqlite3_errmsg($0)) } ?? "cannot open"

      sqlite3_close_v2(raw)

      throw SQLiteError(code: status & 0xFF, message: message)
    }

    return raw
  }

  /// The companions SQLite keeps beside a database file.
  static let companionSuffixes = ["-wal", "-shm"]

  /// Rename the file to `<name>.corrupt`, its `-wal` and `-shm` first, replacing an older copy.
  ///
  /// Companions before the main file: a crash between the renames then leaves at worst a database
  /// without its log, never a log beside a different database that SQLite would try to replay.
  private static func moveAside(_ url: URL) throws -> URL {
    let manager = FileManager.default
    let target = url.appendingPathExtension("corrupt")

    removeFileSet(target)

    for suffix in companionSuffixes + [""] {
      let source = URL(fileURLWithPath: url.path + suffix)
      let destination = URL(fileURLWithPath: target.path + suffix)

      if manager.fileExists(atPath: source.path) {
        try manager.moveItem(at: source, to: destination)
      }
    }

    return target
  }

  /// Delete a database file and its companions; missing files are fine.
  static func removeFileSet(_ url: URL) {
    for suffix in companionSuffixes + [""] {
      try? FileManager.default.removeItem(at: URL(fileURLWithPath: url.path + suffix))
    }
  }

  /**
   Keep a database file and its companions out of iCloud and device backups.

   The gateway list in `kv` is useless without the keychain items it points at, and those are
   this-device-only: a backup restored to another phone would bring gateways it cannot sign in to.
   React Native excluded its AsyncStorage directory for the same reason. SQLite deletes and
   recreates `-wal` and `-shm` as connections come and go, so this runs on every launch.
   */
  public static func excludeFromBackup(_ url: URL) {
    for suffix in [""] + companionSuffixes {
      var file = URL(fileURLWithPath: url.path + suffix)
      var values = URLResourceValues()

      values.isExcludedFromBackup = true

      if FileManager.default.fileExists(atPath: file.path) {
        try? file.setResourceValues(values)
      }
    }
  }

  // MARK: Rescue

  /**
   Copy every `kv` row that can still be read from `source` into this database.

   Read-only, row by row, stopping at the first error, so the rows before a damaged page are kept.
   A row already here is replaced: the rescued value is the person's, a fresh database has nothing
   of its own yet.
   */
  func rescueKeyValues(from source: URL) -> KeyValueRescue {
    var rescue = KeyValueRescue()
    var rows: [(String, String, Int64)] = []

    for options in ["mode=ro", "immutable=1"] {
      rows = []
      rescue.complete = Self.readKeyValues(source, options: options) { rows.append(($0, $1, $2)) }

      if rescue.complete || !rows.isEmpty {
        break
      }
    }

    do {
      try transaction {
        for (key, value, updatedAt) in rows {
          try execute(
            "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)",
            [.text(key), .text(value), .integer(updatedAt)]
          )
          rescue.keys.append(key)
        }
      }
    } catch {
      rescue = KeyValueRescue()
    }

    return rescue
  }

  /// Read `kv` from a file read-only; answers whether the whole table was read.
  private static func readKeyValues(
    _ source: URL,
    options: String,
    row: (String, String, Int64) -> Void
  ) -> Bool {
    var raw: OpaquePointer?
    let uri = source.standardizedFileURL.absoluteString + "?" + options

    defer { sqlite3_close_v2(raw) }

    guard sqlite3_open_v2(uri, &raw, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK, let raw else {
      return false
    }

    var statement: OpaquePointer?

    defer { sqlite3_finalize(statement) }

    guard sqlite3_prepare_v2(raw, "SELECT key, value, updated_at FROM kv", -1, &statement, nil) == SQLITE_OK,
      let statement else {
      return false
    }

    while true {
      switch sqlite3_step(statement) {
      case SQLITE_ROW:
        if sqlite3_column_type(statement, 0) == SQLITE_TEXT, sqlite3_column_type(statement, 1) == SQLITE_TEXT {
          row(columnText(statement, 0), columnText(statement, 1), sqlite3_column_int64(statement, 2))
        }
      case SQLITE_DONE:
        return true
      default:
        return false
      }
    }
  }

  // MARK: Integrity

  /**
   The full check, for the background: `PRAGMA quick_check`, and when it fails, the chat cache
   dropped and recreated empty. `kv` is never dropped.

   When a damaged cache table cannot even be dropped (dropping walks its pages), the file is
   rebuilt instead: a new one holding only `kv` is written beside it and swapped in.
   */
  public func checkCacheIntegrity() -> CacheIntegrityReport {
    let first: String

    do {
      first = try quickCheck()
    } catch {
      first = String(describing: error)
    }

    guard first != "ok" else {
      return .ok
    }

    do {
      do {
        try transaction {
          try executeScript("DROP TABLE IF EXISTS bots; DROP TABLE IF EXISTS transcripts;")
          try executeScript(SQLiteSchema.cacheTables)
        }
      } catch {
        try rebuildKeepingKeyValues()
      }
    } catch {
      return .repairFailed(reason: String(describing: error))
    }

    let second = (try? quickCheck()) ?? "no answer"

    return second == "ok" ? .rebuiltCache(reason: first) : .keyValueDamaged(reason: second)
  }

  /**
   The fallback when a damaged cache table cannot even be dropped (dropping walks its pages): a new
   file holding only `kv`, swapped in under this connection.

   The rows are read first, so a `kv` that cannot be read fails here with the old file untouched.
   The new file is written completely beside the old one before anything is renamed.
   */
  private func rebuildKeepingKeyValues() throws {
    guard let fileURL else {
      throw SQLiteError(code: SQLITE_MISUSE, message: "an in-memory database is not rebuilt")
    }

    let rows = try query("SELECT key, value, updated_at FROM kv")
    let target = URL(fileURLWithPath: fileURL.path + ".rebuild")

    Self.removeFileSet(target)

    do {
      let (fresh, _) = try Self.attemptOpen(.file(target), migrations: SQLiteSchema.migrations, probe: Self.launchProbe)

      try fresh.transaction {
        for row in rows {
          try fresh.execute(
            "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)",
            [row["key"], row["value"], row["updated_at"]]
          )
        }
      }

      try fresh.execute("PRAGMA wal_checkpoint(TRUNCATE)")
      fresh.close()
    } catch {
      Self.removeFileSet(target)

      throw error
    }

    close()
    Self.removeFileSet(fileURL)

    for suffix in Self.companionSuffixes + [""] {
      let source = URL(fileURLWithPath: target.path + suffix)

      if FileManager.default.fileExists(atPath: source.path) {
        try FileManager.default.moveItem(at: source, to: URL(fileURLWithPath: fileURL.path + suffix))
      }
    }

    handle = try Self.openHandle(fileURL.path)
    sqlite3_busy_timeout(handle, 2_000)
    _ = try query("PRAGMA journal_mode = WAL")
    Self.excludeFromBackup(fileURL)
  }

  private func quickCheck() throws -> String {
    try query("PRAGMA quick_check").map { $0.values.first?.text ?? "" }.joined(separator: "; ")
  }

  // MARK: Migrations

  public var userVersion: Int {
    get throws {
      Int(try query("PRAGMA user_version").first?.values.first?.integer ?? 0)
    }
  }

  private func migrate(_ migrations: [SQLiteMigration]) throws -> SQLiteOpenReport {
    var report = SQLiteOpenReport()
    let current = try userVersion
    let latest = migrations.map(\.version).max() ?? 0

    report.versionBefore = current
    report.versionAfter = current

    if current > latest {
      // A newer build wrote this file and the person went back. Every change a newer schema makes
      // is additive by rule, so it is used as it is rather than thrown away.
      report.newerThanThisBuild = true

      return report
    }

    for migration in migrations.sorted(by: { $0.version < $1.version }) where migration.version > current {
      try transaction {
        try migration.apply(self)
        // PRAGMA does not take bound parameters; the version is an Int we own.
        try execute("PRAGMA user_version = \(migration.version)")
      }

      report.versionAfter = migration.version
    }

    return report
  }

  // MARK: Statements

  /// Run a script of one or more statements with no parameters (schema changes).
  public func executeScript(_ sql: String) throws {
    try refuseIfTransactionLost()

    var error: UnsafeMutablePointer<CChar>?
    let status = sqlite3_exec(try connection(), sql, nil, nil, &error)

    if status != SQLITE_OK {
      let message = error.map { String(cString: $0) } ?? lastMessage

      sqlite3_free(error)
      noteFailure()

      throw SQLiteError(code: status & 0xFF, message: message)
    }
  }

  /// Run one statement to completion.
  public func execute(_ sql: String, _ arguments: [SQLiteValue] = []) throws {
    _ = try run(sql, arguments, collect: false)
  }

  /// Run one statement and return its rows.
  public func query(_ sql: String, _ arguments: [SQLiteValue] = []) throws -> [SQLiteRow] {
    try run(sql, arguments, collect: true)
  }

  /// Rows changed by the last statement.
  public var changes: Int {
    handle.map { Int(sqlite3_changes($0)) } ?? 0
  }

  private func connection() throws -> OpaquePointer {
    guard let handle else {
      throw SQLiteError(code: SQLITE_MISUSE, message: "the database is closed")
    }

    return handle
  }

  private var lastMessage: String {
    handle.map { String(cString: sqlite3_errmsg($0)) } ?? "the database is closed"
  }

  private func error(_ status: Int32) -> SQLiteError {
    noteFailure()

    return SQLiteError(code: status & 0xFF, message: lastMessage)
  }

  /// After a failed statement: did SQLite roll the whole transaction back on its own?
  private func noteFailure() {
    if transactionDepth > 0, let handle, sqlite3_get_autocommit(handle) != 0 {
      transactionLost = true
    }
  }

  private func refuseIfTransactionLost() throws {
    if transactionLost {
      throw SQLiteError(
        code: SQLITE_ABORT,
        message: "the enclosing transaction was rolled back; nothing runs until it unwinds"
      )
    }
  }

  private func prepared(_ sql: String) throws -> OpaquePointer {
    if let statement = statements[sql] {
      return statement
    }

    var statement: OpaquePointer?
    let status = sqlite3_prepare_v3(try connection(), sql, -1, UInt32(SQLITE_PREPARE_PERSISTENT), &statement, nil)

    guard status == SQLITE_OK, let statement else {
      throw error(status)
    }

    statements[sql] = statement

    return statement
  }

  private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  private func run(_ sql: String, _ arguments: [SQLiteValue], collect: Bool) throws -> [SQLiteRow] {
    try refuseIfTransactionLost()

    let statement = try prepared(sql)

    defer {
      sqlite3_reset(statement)
      sqlite3_clear_bindings(statement)
    }

    for (offset, argument) in arguments.enumerated() {
      let index = Int32(offset + 1)
      let status: Int32

      switch argument {
      case .null:
        status = sqlite3_bind_null(statement, index)
      case let .integer(value):
        status = sqlite3_bind_int64(statement, index, value)
      case let .real(value):
        status = sqlite3_bind_double(statement, index, value)
      case let .text(value):
        // With the byte count, so a NUL inside the string is stored rather than ending it.
        // `utf8CString` is never empty (it carries a terminator), so the pointer is never nil.
        let bytes = value.utf8CString

        status = bytes.withUnsafeBufferPointer { buffer in
          sqlite3_bind_text64(
            statement, index, buffer.baseAddress, sqlite3_uint64(buffer.count - 1), Self.transient,
            UInt8(SQLITE_UTF8)
          )
        }
      case let .blob(value):
        status = value.withUnsafeBytes { bytes in
          sqlite3_bind_blob64(statement, index, bytes.baseAddress, sqlite3_uint64(value.count), Self.transient)
        }
      }

      guard status == SQLITE_OK else {
        throw error(status)
      }
    }

    var rows: [SQLiteRow] = []
    var columns: [String]?

    while true {
      let status = sqlite3_step(statement)

      if status == SQLITE_DONE {
        break
      }

      guard status == SQLITE_ROW else {
        throw error(status)
      }

      guard collect else {
        continue
      }

      let count = sqlite3_column_count(statement)
      let names = columns ?? (0..<count).map { String(cString: sqlite3_column_name(statement, $0)) }

      columns = names
      rows.append(SQLiteRow(columns: names, values: (0..<count).map { column(statement, $0) }))
    }

    return rows
  }

  private func column(_ statement: OpaquePointer, _ index: Int32) -> SQLiteValue {
    switch sqlite3_column_type(statement, index) {
    case SQLITE_INTEGER:
      return .integer(sqlite3_column_int64(statement, index))
    case SQLITE_FLOAT:
      return .real(sqlite3_column_double(statement, index))
    case SQLITE_TEXT:
      return .text(Self.columnText(statement, index))
    case SQLITE_BLOB:
      let count = Int(sqlite3_column_bytes(statement, index))

      guard count > 0, let bytes = sqlite3_column_blob(statement, index) else {
        return .blob(Data())
      }

      return .blob(Data(bytes: bytes, count: count))
    default:
      return .null
    }
  }

  /// Text by its byte count rather than up to the first NUL.
  private static func columnText(_ statement: OpaquePointer, _ index: Int32) -> String {
    guard let text = sqlite3_column_text(statement, index) else {
      return ""
    }

    let count = Int(sqlite3_column_bytes(statement, index))

    return String(decoding: UnsafeBufferPointer(start: text, count: count), as: UTF8.self)
  }

  // MARK: Transactions

  /**
   Run `body` atomically. Nested calls become savepoints inside the outer transaction.

   `BEGIN IMMEDIATE` takes the write lock up front, so a transaction never fails halfway with a
   busy error after doing work. Key-value changes recorded inside are announced after the outermost
   commit, and dropped on rollback.

   Some failures (a full disk, an I/O error) make SQLite roll the WHOLE transaction back, not just
   the statement. Inside a savepoint that would otherwise go unnoticed: the savepoint's rollback
   fails quietly and later statements run in autocommit mode, outside any transaction. So after a
   failure the connection is checked, and when the outer transaction is gone every further
   statement is refused until the outermost call unwinds and reports the failure.
   */
  public func transaction<T>(_ body: () throws -> T) throws -> T {
    let depth = transactionDepth
    let savepoint = "hermie_\(depth)"

    try execute(depth == 0 ? "BEGIN IMMEDIATE" : "SAVEPOINT \(savepoint)")
    transactionDepth += 1

    let snapshot = pendingChanges

    do {
      let result = try body()

      try refuseIfTransactionLost()
      transactionDepth -= 1
      try execute(depth == 0 ? "COMMIT" : "RELEASE \(savepoint)")

      if depth == 0 {
        publishPending()
      }

      return result
    } catch {
      transactionDepth = depth

      if depth == 0 {
        transactionLost = false
        pendingChanges = [:]

        if let handle, sqlite3_get_autocommit(handle) == 0 {
          try? execute("ROLLBACK")
        }
      } else if let handle, sqlite3_get_autocommit(handle) != 0 {
        transactionLost = true
      } else if !transactionLost {
        try? execute("ROLLBACK TO \(savepoint)")
        try? execute("RELEASE \(savepoint)")
        pendingChanges = snapshot
      }

      throw error
    }
  }

  /// True inside `transaction`.
  public var isInTransaction: Bool {
    transactionDepth > 0
  }

  /// Call `write` with a key's new value (nil when removed) after every commit that changes it.
  ///
  /// Synchronous and before the observers, so a copy kept outside the database (the lock mirror)
  /// is never behind a change somebody has already seen.
  public func mirror(key: String, to write: @escaping (String?) -> Void) {
    mirrors[key] = write
  }

  /// Record a key-value change, announced at commit (or now, outside a transaction).
  func noteChange(key: String, value: String?) {
    pendingChanges[key] = .some(value)

    if transactionDepth == 0 {
      publishPending()
    }
  }

  private func publishPending() {
    let changes = pendingChanges

    pendingChanges = [:]

    for (key, value) in changes {
      mirrors[key]?(value)
    }

    if !changes.isEmpty {
      observers.publish(changes)
    }
  }
}
