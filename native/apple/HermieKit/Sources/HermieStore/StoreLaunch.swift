import Foundation

/**
 The launch step for local state: open `hermie.sqlite` (or recover it), and hand back the store and
 what the app has to know about the lock — synchronously, so it is done before the first frame.

 ## The outcomes

 - **Opened.** The store is the file. The lock mirror is brought in line with `kv`.
 - **Recovered.** The file was corrupt; it was moved aside, a new one created, and every readable
   `kv` row copied across (see `SQLiteDatabase.open`). If that did not bring the lock setting back,
   it is restored from the lock mirror (`LockMirror`). If neither could, the setting is unknown.
 - **Failed to open** for any other reason (`SQLITE_CANTOPEN` before the first unlock after a
   reboot, `SQLITE_FULL` during a migration). The report carries the error as `openFailure`, and the
   store is an empty in-memory database the app can run on for this launch only; nothing written to
   it survives. The lock setting is unknown.

 ## An unknown lock setting

 Never written: a lock nobody chose is not persisted. For this launch only, the app starts locked
 (`requiresLockThisLaunch`) — and only when the device can authenticate, which the caller answers
 through `deviceCanAuthenticate`, since this target does not link LocalAuthentication. A device that
 cannot would be stranded behind a plate it cannot open, so there the app starts unlocked and shows
 `lockSettingNotRestored` instead, so the person can switch the lock back on.

 The database must live in Application Support, never in the App Group container: `run` refuses a
 location inside `appGroupContainer`.
 */
public enum StoreLaunch {
  public struct Result: Sendable {
    public let store: SQLiteStore
    public let report: Report
  }

  /// Where the lock setting came from after a recovery.
  public enum LockRestore: Sendable, Equatable {
    /// The database opened normally; `kv` is authoritative.
    case notNeeded
    /// The rescued `kv` rows answered it (present, or a complete rescue without one: no lock).
    case rescued
    /// The lock mirror answered it.
    case mirror
    /// Nothing could: see `requiresLockThisLaunch` and `lockSettingNotRestored`.
    case unknown
  }

  public struct Report: Sendable, Equatable {
    /// What opening found; nil when the database could not be opened at all.
    public let database: SQLiteOpenReport?
    /// Why the database could not be opened. The store is in memory for this launch.
    public let openFailure: SQLiteError?
    public let lock: LockRestore
    /// Start locked for this launch, whatever `kv` says. Never persisted.
    public let requiresLockThisLaunch: Bool
    /// Tell the person the lock setting could not be restored and may need switching back on.
    public let lockSettingNotRestored: Bool

    /// The database was corrupt and was recreated.
    public var recovered: Bool {
      database?.corruption != nil
    }
  }

  public enum LaunchError: Error, Sendable, Equatable {
    case databaseInsideAppGroup
  }

  /// `<Application Support>/hermie.sqlite`.
  public static func databaseURL(applicationSupport: URL) -> URL {
    applicationSupport.appendingPathComponent(SQLiteSchema.fileName)
  }

  /// The launch with the files in their usual places in Application Support.
  public static func run(
    applicationSupport: URL,
    appGroupContainer: URL?,
    deviceCanAuthenticate: @Sendable () -> Bool
  ) throws -> Result {
    try run(
      database: .file(databaseURL(applicationSupport: applicationSupport)),
      lockMirror: LockMirror(applicationSupport: applicationSupport),
      appGroupContainer: appGroupContainer,
      deviceCanAuthenticate: deviceCanAuthenticate
    )
  }

  public static func run(
    database location: SQLiteLocation,
    lockMirror: LockMirror?,
    appGroupContainer: URL? = nil,
    deviceCanAuthenticate: @Sendable () -> Bool
  ) throws -> Result {
    try run(
      database: location,
      lockMirror: lockMirror,
      appGroupContainer: appGroupContainer,
      deviceCanAuthenticate: deviceCanAuthenticate,
      probe: SQLiteDatabase.launchProbe
    )
  }

  /// `run`, with the corruption probe replaceable for tests.
  static func run(
    database location: SQLiteLocation,
    lockMirror: LockMirror?,
    appGroupContainer: URL?,
    deviceCanAuthenticate: @Sendable () -> Bool,
    probe: @Sendable (SQLiteDatabase) throws -> Void
  ) throws -> Result {
    if case let .file(url) = location, let group = appGroupContainer {
      let groupPath = group.standardizedFileURL.resolvingSymlinksInPath().path
      let databasePath = url.standardizedFileURL.resolvingSymlinksInPath().path

      if databasePath == groupPath || databasePath.hasPrefix(groupPath + "/") {
        throw LaunchError.databaseInsideAppGroup
      }
    }

    let database: SQLiteDatabase
    let openReport: SQLiteOpenReport

    do {
      (database, openReport) = try SQLiteDatabase.open(location, migrations: SQLiteSchema.migrations, probe: probe)
    } catch {
      let failure = error as? SQLiteError ?? SQLiteError(code: -1, message: String(describing: error))
      let store = try SQLiteStore(.inMemory)

      return Result(store: store, report: unknownLock(database: nil, failure: failure, deviceCanAuthenticate))
    }

    var lock = LockRestore.notNeeded

    if let corruption = openReport.corruption {
      if corruption.rescue.complete || corruption.rescue.keys.contains(StoreKeys.lock) {
        lock = .rescued
      } else if case .some(let mirrored) = lockMirror?.read() {
        do {
          if let mirrored {
            try database.kvSet(mirrored, forKey: StoreKeys.lock)
          }

          lock = .mirror
        } catch {
          lock = .unknown
        }
      } else {
        lock = .unknown
      }
    }

    if let lockMirror {
      database.mirror(key: StoreKeys.lock) { value in
        try? lockMirror.write(value)
      }

      // Brought in line now, so a mirror exists from the first launch on. A read that fails writes
      // nothing: "no lock" is a claim, and a failed read is no evidence for it.
      do {
        try lockMirror.write(try database.kvValue(forKey: StoreKeys.lock))
      } catch {}
    }

    if let url = database.fileURL {
      SQLiteDatabase.excludeFromBackup(url)
    }

    let store = SQLiteStore(database: database, openReport: openReport)

    if lock == .unknown {
      return Result(store: store, report: unknownLock(database: openReport, failure: nil, deviceCanAuthenticate))
    }

    return Result(
      store: store,
      report: Report(
        database: openReport,
        openFailure: nil,
        lock: lock,
        requiresLockThisLaunch: false,
        lockSettingNotRestored: false
      )
    )
  }

  private static func unknownLock(
    database: SQLiteOpenReport?,
    failure: SQLiteError?,
    _ deviceCanAuthenticate: () -> Bool
  ) -> Report {
    Report(
      database: database,
      openFailure: failure,
      lock: .unknown,
      requiresLockThisLaunch: deviceCanAuthenticate(),
      lockSettingNotRestored: true
    )
  }
}
