import CryptoKit
import Foundation

/**
 The one-time move of the Expo app's settings into `kv`.

 The native app keeps the bundle id `dev.hermie.app`, so its first launch happens inside the Expo
 app's container, and what the Expo app knew is still on disk in React Native's AsyncStorage. Every
 `hermie.*` key there is copied into `kv` once; the credentials need no move (they are keychain items
 of the same shape, D12) and the Expo chat cache is not moved (it is rebuilt from the gateway).

 ## The source layout (`@react-native-async-storage/async-storage` 2.2.0, `ios/RNCAsyncStorage.mm`)

 - The directory is `<Application Support>/<bundle id>/RCTAsyncLocalStorage_V1`.
 - `manifest.json` in it is one JSON object, key to value. A string is the value itself (written
   inline when it is at most 1024 UTF-16 code units). `null` means the value is in a file of its own.
 - That file is in the same directory, named by the MD5 of the key's UTF-8 bytes in lowercase hex
   (`RCTMD5Hash`), and holds the value as UTF-8 text.
 - A `null` entry whose file is missing reads, in React Native, as a key that does not exist.
 - React Native treats a manifest that does not parse as empty and starts a new one.

 ## The rules

 - **The source is never written to.** Files are opened for reading only; nothing is moved, renamed
   or deleted. A rollback to an Expo build finds its storage as it left it.
 - **Once.** The flag `migration.expo.v1` is written in the same transaction as the copied keys, so
   the import either happened completely or not at all. A launch killed halfway leaves no flag and
   no keys, and the next launch runs it again from the start.
 - **Nothing is overwritten.** A key already in `kv` keeps its value (`INSERT OR IGNORE`).
 - **Never a secret.** Keys that name keychain items are refused even if they turn up here.
 - **The lock fails closed.** A lock setting that exists but cannot be read — not JSON, an unknown
   threshold, an overflow file that is missing or not text — is written as the strictest setting,
   `immediately`, and the report says so. A manifest that is not JSON at all gets the same treatment,
   because then nobody can say whether there was a lock.
 - **A source that cannot be read yet is not a source that is empty.** Before the first unlock
   after a reboot, data protection keeps the files closed. That launch imports nothing, sets no flag,
   and reports the lock as unknown — which the caller must treat as locked.
 */
public enum ExpoImport {
  /// The flag in `kv`. Present means the import is done and never runs again.
  public static let flagKey = "migration.expo.v1"

  /// The prefix of every key the Expo app wrote.
  public static let keyPrefix = "hermie."

  /// React Native's directory name.
  public static let storageDirectoryName = "RCTAsyncLocalStorage_V1"
  public static let manifestFileName = "manifest.json"

  /// The thresholds the Expo lock understood (`LOCK_THRESHOLDS`).
  public static let lockThresholds: Set<String> = ["off", "immediately", "1m", "5m", "15m"]

  /// What a lock that could not be read becomes.
  public static let failClosedLockValue = #"{"threshold":"immediately"}"#

  /// Keychain names (`hermie.auth.*`, the share credential, push manage tokens): never copied.
  static let secretPrefixes = ["hermie.auth.", "hermie.secret", "hermie.share.delivery", "hermie.push.manage"]

  /// Where the Expo app's storage is: `<Application Support>/<bundle id>/RCTAsyncLocalStorage_V1`.
  public static func storageDirectory(applicationSupport: URL, bundleIdentifier: String) -> URL {
    applicationSupport
      .appendingPathComponent(bundleIdentifier, isDirectory: true)
      .appendingPathComponent(storageDirectoryName, isDirectory: true)
  }

  /// React Native's overflow file name for a key.
  public static func overflowFileName(forKey key: String) -> String {
    Insecure.MD5.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /**
   Run the import against `database`, synchronously.

   Meant for the launch, before the first frame: it reads one manifest and a handful of files and
   writes one transaction. `faultAfterWrites` is for tests: it throws after that many keys have been
   written, which is how a launch killed halfway is simulated.
   */
  public static func run(
    source directory: URL,
    into database: SQLiteDatabase,
    now: Date = Date(),
    faultAfterWrites: Int? = nil
  ) -> ExpoImportReport {
    let clock = ContinuousClock()
    let started = clock.now
    var report = perform(directory, database, now, faultAfterWrites)

    report.elapsed = clock.now - started

    return report
  }

  // MARK: Steps

  private static func perform(
    _ directory: URL,
    _ database: SQLiteDatabase,
    _ now: Date,
    _ faultAfterWrites: Int?
  ) -> ExpoImportReport {
    var report = ExpoImportReport()

    do {
      if try database.kvValue(forKey: flagKey) != nil {
        report.outcome = .alreadyImported
        report.lock = .notApplicable

        return report
      }
    } catch {
      return deferred(report, "the database could not be read: \(error)")
    }

    let manager = FileManager.default
    var isDirectory: ObjCBool = false
    let manifestURL = directory.appendingPathComponent(manifestFileName)

    guard manager.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue,
      manager.fileExists(atPath: manifestURL.path) else {
      // No Expo storage: a fresh install, or an Expo install that never wrote a setting.
      report.outcome = .nothingToImport
      report.lock = .notSet

      return commit(report, entries: [], database, now, faultAfterWrites)
    }

    let manifestData: Data

    do {
      manifestData = try Data(contentsOf: manifestURL)
    } catch {
      return deferred(report, "the Expo storage could not be read yet: \(error.localizedDescription)")
    }

    guard let text = String(data: manifestData, encoding: .utf8),
      let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
      let manifest = object as? [String: Any] else {
      report.outcome = .sourceCorrupt
      report.lock = .failedClosed(reason: "the Expo storage manifest is not a JSON object")
      report.notes.append("The Expo storage manifest could not be parsed; nothing but the lock was imported.")

      return commit(report, entries: [(StoreKeys.lock, failClosedLockValue)], database, now, faultAfterWrites)
    }

    var entries: [(String, String)] = []

    report.lock = .notSet

    for key in manifest.keys.sorted() {
      guard key.hasPrefix(keyPrefix) else {
        report.ignoredKeyCount += 1
        continue
      }

      if secretPrefixes.contains(where: { key.hasPrefix($0) }) {
        report.skipped.append(.init(key: key, reason: "names a keychain item; never copied"))
        continue
      }

      let value: String?

      switch manifest[key] {
      case let inline as String:
        value = inline
      case is NSNull:
        switch readOverflow(directory, key: key) {
        case let .value(text):
          value = text
        case let .skip(reason):
          report.skipped.append(.init(key: key, reason: reason))
          value = nil
        case let .unreadable(reason):
          return deferred(report, reason)
        }
      default:
        report.skipped.append(.init(key: key, reason: "the manifest value is not a string or null"))
        value = nil
      }

      if key == StoreKeys.lock {
        let lock = checkLock(value)

        report.lock = lock
        entries.append((key, lock.isFailedClosed ? failClosedLockValue : value ?? failClosedLockValue))
        continue
      }

      if let value {
        entries.append((key, value))
      }
    }

    report.outcome = .imported

    return commit(report, entries: entries, database, now, faultAfterWrites)
  }

  private enum Overflow {
    case value(String)
    /// Permanently unusable: skip the key, as React Native would.
    case skip(String)
    /// Not readable now (data protection, I/O): retry on a later launch.
    case unreadable(String)
  }

  private static func readOverflow(_ directory: URL, key: String) -> Overflow {
    let url = directory.appendingPathComponent(overflowFileName(forKey: key))

    guard FileManager.default.fileExists(atPath: url.path) else {
      return .skip("its overflow file is missing (React Native reads this as no value)")
    }

    let data: Data

    do {
      data = try Data(contentsOf: url)
    } catch {
      return .unreadable("an overflow file could not be read yet: \(error.localizedDescription)")
    }

    guard let text = String(data: data, encoding: .utf8) else {
      return .skip("its overflow file is not UTF-8 text")
    }

    return .value(text)
  }

  private static func checkLock(_ value: String?) -> ExpoImportReport.Lock {
    guard let value else {
      return .failedClosed(reason: "the lock setting exists but its value could not be read")
    }

    guard let object = (try? JSONSerialization.jsonObject(with: Data(value.utf8))) as? [String: Any],
      let threshold = object["threshold"] as? String else {
      return .failedClosed(reason: "the lock setting is not the expected JSON")
    }

    guard lockThresholds.contains(threshold) else {
      return .failedClosed(reason: "the lock threshold \"\(threshold)\" is not one this build knows")
    }

    return .imported(threshold: threshold)
  }

  private static func deferred(_ report: ExpoImportReport, _ reason: String) -> ExpoImportReport {
    var report = report

    report.outcome = .deferred(reason: reason)
    report.lock = .unknown
    report.importedKeys = []

    return report
  }

  private static func commit(
    _ report: ExpoImportReport,
    entries: [(String, String)],
    _ database: SQLiteDatabase,
    _ now: Date,
    _ faultAfterWrites: Int?
  ) -> ExpoImportReport {
    var report = report
    var imported: [String] = []
    var kept: [String] = []

    do {
      try database.transaction {
        for (index, (key, value)) in entries.enumerated() {
          if let faultAfterWrites, index >= faultAfterWrites {
            throw ExpoImportFault()
          }

          if try database.kvInsertIfAbsent(value, forKey: key, now: now) {
            imported.append(key)
          } else {
            kept.append(key)
          }
        }

        try database.kvSet(try flagValue(report, count: imported.count, now: now), forKey: flagKey, now: now)
      }
    } catch {
      return deferred(report, "the import could not be written: \(error)")
    }

    report.importedKeys = imported
    report.keptExistingKeys = kept

    return report
  }

  private static func flagValue(_ report: ExpoImportReport, count: Int, now: Date) throws -> String {
    struct Flag: Encodable {
      let v = 1
      let at: Int64
      let outcome: String
      let keys: Int
      let lock: String
    }

    return try KeyValueCoding.encode(
      Flag(at: SQLiteDatabase.milliseconds(now), outcome: report.outcome.name, keys: count, lock: report.lock.name)
    )
  }
}

struct ExpoImportFault: Error {}

/// What the import did, for the launch and for the developer screen.
public struct ExpoImportReport: Sendable, Equatable {
  public enum Outcome: Sendable, Equatable {
    case imported
    /// The flag was already set.
    case alreadyImported
    /// There is no Expo storage here.
    case nothingToImport
    /// The manifest is not JSON. Only the fail-closed lock was written.
    case sourceCorrupt
    /// Nothing was written and no flag set; it runs again on the next launch.
    case deferred(reason: String)

    var name: String {
      switch self {
      case .imported: "imported"
      case .alreadyImported: "alreadyImported"
      case .nothingToImport: "nothingToImport"
      case .sourceCorrupt: "sourceCorrupt"
      case .deferred: "deferred"
      }
    }
  }

  public enum Lock: Sendable, Equatable {
    /// The Expo app had no lock setting (the lock was off).
    case notSet
    /// Copied as it was.
    case imported(threshold: String)
    /// It existed and could not be read, so it was written as `immediately`.
    case failedClosed(reason: String)
    /// The import did not run this launch; treat the app as locked.
    case unknown
    /// The import had already run; the lock is whatever `kv` says.
    case notApplicable

    public var isFailedClosed: Bool {
      if case .failedClosed = self {
        return true
      }

      return false
    }

    var name: String {
      switch self {
      case .notSet: "notSet"
      case .imported: "imported"
      case .failedClosed: "failedClosed"
      case .unknown: "unknown"
      case .notApplicable: "notApplicable"
      }
    }
  }

  public struct Skip: Sendable, Equatable {
    public let key: String
    public let reason: String
  }

  public var outcome: Outcome = .nothingToImport
  public var lock: Lock = .unknown
  /// Keys written into `kv`.
  public var importedKeys: [String] = []
  /// Keys that were already in `kv` and kept their value.
  public var keptExistingKeys: [String] = []
  public var skipped: [Skip] = []
  /// Keys in the source that are not `hermie.*` (other libraries' state).
  public var ignoredKeyCount = 0
  public var notes: [String] = []
  public var elapsed: Duration = .zero

  /**
   Whether the app must start locked regardless of what `kv` says.

   True when the lock could not be read and was failed closed, and when the import could not run
   at all this launch: then the setting is unknown, and an app lock that opens because the disk was
   not readable yet is a lock that does not work.
   */
  public var requiresLock: Bool {
    lock.isFailedClosed || lock == .unknown
  }
}
