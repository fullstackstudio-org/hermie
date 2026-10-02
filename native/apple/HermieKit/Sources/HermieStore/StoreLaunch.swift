import Foundation

/**
 The launch step for local state: open `hermie.sqlite`, take over the Expo app's settings, and hand
 back the store — synchronously, so it is done before the first frame.

 In this order, and each step is the reason for the next:

 1. Open and migrate the database. A corrupt file is moved aside and recreated (see
    `SQLiteDatabase.open`).
 2. After such a recovery the app lock is written as `immediately`. The lock setting was in the file
    that was lost, and the one thing a lost lock must not do is open.
 3. Run the Expo import. After a recovery its flag is gone with everything else, so on a device that
    still has the Expo storage it runs again and brings back the Expo-era settings and gateways.

 The database must live in Application Support, never in the App Group container: `run` refuses a
 location inside `appGroupContainer`.
 */
public enum StoreLaunch {
  public struct Result: Sendable {
    public let store: SQLiteStore
    public let report: Report
  }

  public struct Report: Sendable, Equatable {
    public let database: SQLiteOpenReport
    public let expoImport: ExpoImportReport

    /// Start locked whatever `kv` says: the lock setting was lost or could not be read.
    public var requiresLock: Bool {
      database.corruption != nil || expoImport.requiresLock
    }
  }

  public enum LaunchError: Error, Sendable, Equatable {
    case databaseInsideAppGroup
  }

  /// `<Application Support>/hermie.sqlite`.
  public static func databaseURL(applicationSupport: URL) -> URL {
    applicationSupport.appendingPathComponent(SQLiteSchema.fileName)
  }

  public static func run(
    database location: SQLiteLocation,
    expoStorage: URL?,
    appGroupContainer: URL? = nil,
    now: Date = Date()
  ) throws -> Result {
    if case let .file(url) = location, let group = appGroupContainer {
      let groupPath = group.standardizedFileURL.resolvingSymlinksInPath().path
      let databasePath = url.standardizedFileURL.resolvingSymlinksInPath().path

      if databasePath == groupPath || databasePath.hasPrefix(groupPath + "/") {
        throw LaunchError.databaseInsideAppGroup
      }
    }

    let (database, openReport) = try SQLiteDatabase.open(location)

    if openReport.corruption != nil {
      try database.kvSet(ExpoImport.failClosedLockValue, forKey: StoreKeys.lock, now: now)
    }

    let importReport: ExpoImportReport

    if let expoStorage {
      importReport = ExpoImport.run(source: expoStorage, into: database, now: now)
    } else {
      var skipped = ExpoImportReport()

      skipped.outcome = .nothingToImport
      skipped.lock = .notApplicable
      importReport = skipped
    }

    let store = SQLiteStore(database: database, openReport: openReport)

    return Result(store: store, report: Report(database: openReport, expoImport: importReport))
  }
}
