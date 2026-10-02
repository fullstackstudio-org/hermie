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
public struct SQLiteError: Error, Sendable, CustomStringConvertible {
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
  /// Set when the file was corrupt: where the unreadable copy was moved, and why.
  public var corruption: Corruption?

  public struct Corruption: Sendable, Equatable {
    /// The moved-aside database file, kept for diagnosis. Its `-wal` and `-shm` sit beside it.
    public let movedTo: URL
    public let reason: String
  }
}

/**
 One connection to SQLite through the system library.

 Not `Sendable` and not thread-safe on purpose: it is owned by exactly one `SQLiteStore` actor,
 which serialises every use. It is a class of its own, rather than the actor's private state, for
 one reason — the launch needs it SYNCHRONOUSLY. The Expo import and the lock setting have to be on
 disk before the first frame is drawn, and a launch step that awaits an actor cannot promise that.
 So the launch opens a database, runs the import on it, and only then hands it to the actor.

 Statements are prepared once per SQL string and reused. Transactions nest through savepoints, and
 key-value changes made inside one are announced only after the outermost commit, so an observer
 never sees a value that was then rolled back.
 */
public final class SQLiteDatabase {
  private var handle: OpaquePointer?
  private var statements: [String: OpaquePointer] = [:]
  private var transactionDepth = 0
  private var pendingChanges: [String: String?] = [:]

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
   Open (creating when needed), switch on WAL, check the file and migrate it.

   A file SQLite calls corrupt or not a database is moved aside with its `-wal` and `-shm`, and a
   fresh one is created in its place; the report says so. What that costs is everything in it:
   every cached roster and transcript (rebuilt from the gateway) and every key-value setting,
   including the gateway list. The Expo import flag lives in the same table, so on a device that
   still has the Expo app's storage the import runs again and brings back what was there when the
   native app took over. Anything changed since is gone, which is why the launch also fails the
   app lock closed after a recovery (see `StoreLaunch`).
   */
  public static func open(
    _ location: SQLiteLocation,
    migrations: [SQLiteMigration] = SQLiteSchema.migrations
  ) throws -> (database: SQLiteDatabase, report: SQLiteOpenReport) {
    do {
      return try attemptOpen(location, migrations: migrations)
    } catch let error as SQLiteError where error.isCorruption {
      guard case let .file(url) = location else {
        throw error
      }

      let moved = try moveAside(url)
      var (database, report) = try attemptOpen(location, migrations: migrations)

      report.corruption = .init(movedTo: moved, reason: error.message)

      return (database, report)
    }
  }

  private static func attemptOpen(
    _ location: SQLiteLocation,
    migrations: [SQLiteMigration]
  ) throws -> (database: SQLiteDatabase, report: SQLiteOpenReport) {
    var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
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
      #if os(iOS)
        // Readable after the first unlock since boot, so a launch in the background (a push, a
        // widget refresh) can still read settings. The flag also covers the -wal and -shm files.
        flags |= SQLITE_OPEN_FILEPROTECTION_COMPLETEUNTILFIRSTUSERAUTHENTICATION
      #endif
    case .inMemory:
      path = ":memory:"
    }

    var raw: OpaquePointer?
    let status = sqlite3_open_v2(path, &raw, flags, nil)

    guard status == SQLITE_OK, let raw else {
      let message = raw.map { String(cString: sqlite3_errmsg($0)) } ?? "cannot open"

      sqlite3_close_v2(raw)

      throw SQLiteError(code: status & 0xFF, message: message)
    }

    let database = SQLiteDatabase(handle: raw, fileURL: fileURL, observers: KeyValueObservers())

    do {
      sqlite3_busy_timeout(raw, 2_000)
      // The first statement that reads the header: a file that is not a database fails here.
      if fileURL != nil {
        _ = try database.query("PRAGMA journal_mode = WAL")
        try database.execute("PRAGMA synchronous = NORMAL")
      }

      let check = try database.query("PRAGMA quick_check").first?.values.first?.text

      if check != "ok" {
        throw SQLiteError(code: SQLITE_CORRUPT, message: "quick_check: \(check ?? "no answer")")
      }

      let report = try database.migrate(migrations)

      return (database, report)
    } catch {
      database.close()

      throw error
    }
  }

  /// Rename the file and its companions to `<name>.corrupt`, replacing an older such copy.
  private static func moveAside(_ url: URL) throws -> URL {
    let manager = FileManager.default
    let target = url.appendingPathExtension("corrupt")

    for suffix in ["", "-wal", "-shm"] {
      let source = URL(fileURLWithPath: url.path + suffix)
      let destination = URL(fileURLWithPath: target.path + suffix)

      try? manager.removeItem(at: destination)

      if manager.fileExists(atPath: source.path) {
        try manager.moveItem(at: source, to: destination)
      }
    }

    return target
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
    var error: UnsafeMutablePointer<CChar>?
    let status = sqlite3_exec(try connection(), sql, nil, nil, &error)

    if status != SQLITE_OK {
      let message = error.map { String(cString: $0) } ?? lastMessage

      sqlite3_free(error)

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
    SQLiteError(code: status & 0xFF, message: lastMessage)
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
        status = sqlite3_bind_text(statement, index, value, -1, Self.transient)
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
      return .text(String(cString: sqlite3_column_text(statement, index)))
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

  // MARK: Transactions

  /**
   Run `body` atomically. Nested calls become savepoints inside the outer transaction.

   `BEGIN IMMEDIATE` takes the write lock up front, so a transaction never fails halfway with a
   busy error after doing work. Key-value changes recorded inside are announced after the outermost
   commit, and dropped on rollback.
   */
  public func transaction<T>(_ body: () throws -> T) throws -> T {
    let depth = transactionDepth
    let savepoint = "hermie_\(depth)"

    try execute(depth == 0 ? "BEGIN IMMEDIATE" : "SAVEPOINT \(savepoint)")
    transactionDepth += 1

    let snapshot = pendingChanges

    do {
      let result = try body()

      transactionDepth -= 1
      try execute(depth == 0 ? "COMMIT" : "RELEASE \(savepoint)")

      if depth == 0 {
        publishPending()
      }

      return result
    } catch {
      if transactionDepth > depth {
        transactionDepth = depth
      }

      if depth == 0 {
        try? execute("ROLLBACK")
        pendingChanges = [:]
      } else {
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

    if !changes.isEmpty {
      observers.publish(changes)
    }
  }
}
