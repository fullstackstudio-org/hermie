import Foundation
import Testing

@testable import HermieStore

private let canAuthenticate: @Sendable () -> Bool = { true }
private let cannotAuthenticate: @Sendable () -> Bool = { false }

@Suite("Store launch")
struct StoreLaunchTests {
  @Test("a normal launch opens the file, writes the lock mirror and keeps both out of backup")
  func normalLaunch() async throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let first = try StoreLaunch.run(
      applicationSupport: temporary.url,
      appGroupContainer: nil,
      deviceCanAuthenticate: canAuthenticate
    )
    let mirror = LockMirror(applicationSupport: temporary.url)

    #expect(first.report.lock == .notNeeded)
    #expect(!first.report.requiresLockThisLaunch)
    #expect(!first.report.lockSettingNotRestored)
    #expect(first.report.openFailure == nil)
    #expect(mirror.read() == .some(nil))
    #expect(isExcludedFromBackup(StoreLaunch.databaseURL(applicationSupport: temporary.url)))
    #expect(isExcludedFromBackup(mirror.url))

    // Every committed lock change reaches the mirror, removal included.
    let kv = KeyValueStore(store: first.store)

    try await kv.setString(#"{"threshold":"5m"}"#, forKey: StoreKeys.lock)
    #expect(mirror.read() == .some(#"{"threshold":"5m"}"#))

    _ = try? await first.store.write { database in
      try database.kvSet(#"{"threshold":"off"}"#, forKey: StoreKeys.lock)
      throw CancellationError()
    }
    #expect(mirror.read() == .some(#"{"threshold":"5m"}"#))

    try await kv.removeValue(forKey: StoreKeys.lock)
    #expect(mirror.read() == .some(nil))
  }

  @Test("after a corrupt file with nothing rescued, the lock comes back from the mirror")
  func restoredFromMirror() async throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = StoreLaunch.databaseURL(applicationSupport: temporary.url)

    do {
      let first = try StoreLaunch.run(
        applicationSupport: temporary.url,
        appGroupContainer: nil,
        deviceCanAuthenticate: canAuthenticate
      )

      try await KeyValueStore(store: first.store).setString(#"{"threshold":"1m"}"#, forKey: StoreKeys.lock)
    }

    try Data(repeating: 0x42, count: 4_096).write(to: url)
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: url.path + "-wal"))
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: url.path + "-shm"))

    let second = try StoreLaunch.run(
      applicationSupport: temporary.url,
      appGroupContainer: nil,
      deviceCanAuthenticate: canAuthenticate
    )

    #expect(second.report.recovered)
    #expect(second.report.lock == .mirror)
    #expect(!second.report.requiresLockThisLaunch)
    #expect(!second.report.lockSettingNotRestored)
    #expect(try await KeyValueStore(store: second.store).string(forKey: StoreKeys.lock) == #"{"threshold":"1m"}"#)
  }

  @Test("a mirror that says there was no lock restores no lock")
  func mirrorSaysNoLock() async throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = StoreLaunch.databaseURL(applicationSupport: temporary.url)

    try LockMirror(applicationSupport: temporary.url).write(nil)
    try Data(repeating: 0x42, count: 4_096).write(to: url)

    let result = try StoreLaunch.run(
      applicationSupport: temporary.url,
      appGroupContainer: nil,
      deviceCanAuthenticate: canAuthenticate
    )

    #expect(result.report.lock == .mirror)
    #expect(!result.report.requiresLockThisLaunch)
    #expect(try await KeyValueStore(store: result.store).string(forKey: StoreKeys.lock) == nil)
  }

  @Test("a complete rescue answers the lock question, even when it held no lock")
  func rescueAnswers() async throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = StoreLaunch.databaseURL(applicationSupport: temporary.url)

    try makeDatabaseFile(at: url, rows: [StoreKeys.gateways: #"{"v":1,"gateways":[],"activeGatewayId":null}"#])

    let result = try StoreLaunch.run(
      database: .file(url),
      lockMirror: nil,
      appGroupContainer: nil,
      deviceCanAuthenticate: canAuthenticate,
      probe: CorruptOnce().probe
    )

    #expect(result.report.recovered)
    #expect(result.report.lock == .rescued)
    #expect(!result.report.requiresLockThisLaunch)
    #expect(try await KeyValueStore(store: result.store).string(forKey: StoreKeys.gateways) != nil)
  }

  @Test("with neither rescue nor mirror, a device that can authenticate is locked for this launch only")
  func unknownLockCanAuthenticate() async throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = StoreLaunch.databaseURL(applicationSupport: temporary.url)

    try Data(repeating: 0x42, count: 4_096).write(to: url)

    let result = try StoreLaunch.run(
      applicationSupport: temporary.url,
      appGroupContainer: nil,
      deviceCanAuthenticate: canAuthenticate
    )

    #expect(result.report.lock == .unknown)
    #expect(result.report.requiresLockThisLaunch)
    #expect(result.report.lockSettingNotRestored)
    // Never persisted: a lock nobody chose is not written.
    #expect(try await KeyValueStore(store: result.store).string(forKey: StoreKeys.lock) == nil)

    let next = try StoreLaunch.run(
      applicationSupport: temporary.url,
      appGroupContainer: nil,
      deviceCanAuthenticate: canAuthenticate
    )

    #expect(!next.report.requiresLockThisLaunch)
  }

  @Test("with neither rescue nor mirror, a device that cannot authenticate opens with a notice")
  func unknownLockCannotAuthenticate() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    try Data(repeating: 0x42, count: 4_096).write(to: StoreLaunch.databaseURL(applicationSupport: temporary.url))

    let result = try StoreLaunch.run(
      applicationSupport: temporary.url,
      appGroupContainer: nil,
      deviceCanAuthenticate: cannotAuthenticate
    )

    #expect(result.report.lock == .unknown)
    #expect(!result.report.requiresLockThisLaunch)
    #expect(result.report.lockSettingNotRestored)
  }

  @Test("a database that cannot be opened gives a typed failure and an in-memory store for this launch")
  func openFailure() async throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let locked = temporary.url.appendingPathComponent("locked", isDirectory: true)

    try FileManager.default.createDirectory(at: locked, withIntermediateDirectories: true)
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: locked.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: locked.path) }

    for (authenticate, locks) in [(canAuthenticate, true), (cannotAuthenticate, false)] {
      let result = try StoreLaunch.run(
        applicationSupport: locked,
        appGroupContainer: nil,
        deviceCanAuthenticate: authenticate
      )

      #expect(result.report.openFailure != nil)
      #expect(result.report.database == nil)
      #expect(result.report.lock == .unknown)
      #expect(result.report.requiresLockThisLaunch == locks)
      #expect(result.report.lockSettingNotRestored)

      // The app can run on it; nothing reaches the disk.
      try await KeyValueStore(store: result.store).setString("1", forKey: "hermie.test")
      #expect(!FileManager.default.fileExists(atPath: StoreLaunch.databaseURL(applicationSupport: locked).path))
    }
  }

  @Test("the database is refused inside the App Group container")
  func notInAppGroup() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let group = temporary.url.appendingPathComponent("group")

    #expect(throws: StoreLaunch.LaunchError.databaseInsideAppGroup) {
      _ = try StoreLaunch.run(
        applicationSupport: group,
        appGroupContainer: group,
        deviceCanAuthenticate: canAuthenticate
      )
    }
  }

  @Test("a mirror file that is not the expected shape counts as no mirror")
  func badMirror() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let mirror = LockMirror(applicationSupport: temporary.url)

    try Data("{\"v\":1}".utf8).write(to: mirror.url)
    #expect(mirror.read() == nil)

    try Data("not json".utf8).write(to: mirror.url)
    #expect(mirror.read() == nil)

    try mirror.write("x")
    #expect(mirror.read() == .some("x"))
  }
}
