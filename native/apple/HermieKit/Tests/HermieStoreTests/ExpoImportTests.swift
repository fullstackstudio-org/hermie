import Foundation
import Testing

@testable import HermieStore

@Suite("Expo import")
struct ExpoImportTests {
  // MARK: The recorded directory

  @Test("overflow files are named by the MD5 of the key, as React Native names them")
  func overflowFileNames() {
    // The name observed for this key in a real Expo install's storage directory on a simulator.
    #expect(ExpoImport.overflowFileName(forKey: "hermie.chats.layout") == "cbebfd8b9998f7384c7de749d7e62d4f")
    #expect(
      ExpoImport.storageDirectory(
        applicationSupport: URL(fileURLWithPath: "/AS"),
        bundleIdentifier: "dev.hermie.app"
      ).path == "/AS/dev.hermie.app/RCTAsyncLocalStorage_V1"
    )
  }

  @Test("the recorded directory imports every hermie key, inline and overflow, and nothing else")
  func recordedDirectory() throws {
    let database = try memoryDatabase()
    let before = try snapshotTree(Fixtures.expoApplicationSupport)
    let report = ExpoImport.run(source: Fixtures.expoStorage, into: database)
    let one = Fixtures.gatewayOne
    let two = Fixtures.gatewayTwo

    #expect(report.outcome == .imported)
    #expect(report.lock == .imported(threshold: "5m"))
    #expect(!report.requiresLock)
    #expect(report.ignoredKeyCount == 2)
    #expect(
      Set(report.importedKeys) == [
        "hermie.gateways", "hermie.gateway.config@\(one)", "hermie.gateway.config@\(two)", "hermie.chat.view@\(one)",
        "hermie.push@\(one)", "hermie.bots.last_seen@\(one)", "hermie.lock", "hermie.installation", "hermie.language",
        "hermie.appearance", "hermie.voice", "hermie.chats.layout", "hermie.gateway.auth_timeline@\(one)"
      ]
    )
    #expect(report.skipped.map(\.key).sorted() == ["hermie.auth.access_token-\(one)", "hermie.bots.seen_counts@\(one)"])

    // No secret, and no other library's state.
    let keys = try database.kvKeys()

    #expect(!keys.contains { $0.hasPrefix("hermie.auth.") })
    #expect(!keys.contains { !$0.hasPrefix("hermie.") && $0 != ExpoImport.flagKey })
    let values = try database.query("SELECT value FROM kv").compactMap { $0["value"].text }

    #expect(!values.contains { $0.contains("not-a-real-token") })

    // Overflow values arrive whole.
    let layout = try #require(try database.kvValue(forKey: StoreKeys.chatsLayout))

    #expect(layout.utf16.count > 1_024)
    #expect(layout.contains("Wörk ✓"))
    #expect(try database.kvValue(forKey: "hermie.gateway.auth_timeline@\(one)")?.contains("token_refreshed") == true)

    // The gateways, the active one and their per-gateway configuration.
    let registry = GatewayRegistry.decode(try database.kvValue(forKey: StoreKeys.gateways))

    #expect(registry.gateways.map(\.id) == [one, two])
    #expect(registry.active?.name == "Home")
    #expect(registry.active?.authKind == .sessionToken)
    #expect(registry.active?.signedInUser == "Test Person")
    let config = try database.kvValue(forKey: GatewayNamespace(one).key(StoreKeys.gatewayConfig))

    #expect(config?.contains("session_token") == true)

    // Settings that must survive.
    #expect(try database.kvValue(forKey: StoreKeys.lock) == #"{"threshold":"5m"}"#)
    #expect(try database.kvValue(forKey: StoreKeys.installation) == #"{"id":"i00112233445566778899aabbccddeeff"}"#)
    #expect(try database.kvValue(forKey: StoreKeys.language) == #"{"choice":"nl"}"#)
    #expect(try database.kvValue(forKey: StoreKeys.appearance) == #"{"scheme":"dark"}"#)
    #expect(try database.kvValue(forKey: StoreKeys.voice) != nil)
    #expect(try database.kvValue(forKey: GatewayNamespace(one).key(StoreKeys.push)) != nil)
    #expect(try database.kvValue(forKey: GatewayNamespace(one).key(StoreKeys.chatView)) != nil)

    // The flag, and an untouched source.
    #expect(try database.kvValue(forKey: ExpoImport.flagKey)?.contains(#""outcome":"imported""#) == true)
    #expect(try snapshotTree(Fixtures.expoApplicationSupport) == before)
  }

  @Test("it runs once; later launches change nothing, including values changed since")
  func idempotent() throws {
    let database = try memoryDatabase()

    _ = ExpoImport.run(source: Fixtures.expoStorage, into: database)
    try database.kvSet(#"{"threshold":"off"}"#, forKey: StoreKeys.lock)
    try database.kvRemove(StoreKeys.language)

    let again = ExpoImport.run(source: Fixtures.expoStorage, into: database)

    #expect(again.outcome == .alreadyImported)
    #expect(again.importedKeys.isEmpty)
    #expect(!again.requiresLock)
    #expect(try database.kvValue(forKey: StoreKeys.lock) == #"{"threshold":"off"}"#)
    #expect(try database.kvValue(forKey: StoreKeys.language) == nil)
  }

  @Test("a launch killed halfway leaves no keys and no flag, and the next one completes")
  func crashSafe() throws {
    let database = try memoryDatabase()
    let crashed = ExpoImport.run(source: Fixtures.expoStorage, into: database, faultAfterWrites: 5)

    guard case .deferred = crashed.outcome else {
      Issue.record("expected the import to be deferred, got \(crashed.outcome)")
      return
    }

    #expect(crashed.requiresLock)
    #expect(try database.kvKeys().isEmpty)

    let rerun = ExpoImport.run(source: Fixtures.expoStorage, into: database)

    #expect(rerun.outcome == .imported)
    #expect(rerun.importedKeys.count == 13)
    #expect(try database.kvValue(forKey: ExpoImport.flagKey) != nil)
  }

  @Test("a key the native app already holds keeps its value")
  func existingKeysWin() throws {
    let database = try memoryDatabase()

    try database.kvSet(#"{"choice":"de"}"#, forKey: StoreKeys.language)

    let report = ExpoImport.run(source: Fixtures.expoStorage, into: database)

    #expect(report.keptExistingKeys == [StoreKeys.language])
    #expect(try database.kvValue(forKey: StoreKeys.language) == #"{"choice":"de"}"#)
  }

  @Test("no Expo storage: nothing to import, the flag is set, the lock is off")
  func noSource() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let database = try memoryDatabase()
    let report = ExpoImport.run(source: temporary.url.appendingPathComponent("missing"), into: database)

    #expect(report.outcome == .nothingToImport)
    #expect(report.lock == .notSet)
    #expect(!report.requiresLock)
    #expect(try database.kvKeys() == [ExpoImport.flagKey])

    // A directory with no manifest yet is the same thing.
    let empty = try memoryDatabase()

    #expect(ExpoImport.run(source: temporary.url, into: empty).outcome == .nothingToImport)
  }

  // MARK: The lock fails closed

  @Test(
    "a lock that exists but cannot be read is imported as the strictest setting",
    arguments: [
      #"{"threshold":"#,
      #"{"threshold":"30m"}"#,
      #"{"threshold":5}"#,
      #"{}"#,
      #""5m""#,
      ""
    ]
  )
  func lockFailsClosed(value: String) throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    var writer = try AsyncStorageWriter(directory: temporary.url)

    try writer.set(StoreKeys.lock, value)
    try writer.set(StoreKeys.language, #"{"choice":"en"}"#)
    try writer.writeManifest()

    let database = try memoryDatabase()
    let report = ExpoImport.run(source: temporary.url, into: database)

    #expect(report.outcome == .imported)
    #expect(report.lock.isFailedClosed)
    #expect(report.requiresLock)
    #expect(try database.kvValue(forKey: StoreKeys.lock) == ExpoImport.failClosedLockValue)
    #expect(try database.kvValue(forKey: StoreKeys.language) == #"{"choice":"en"}"#)
  }

  @Test("a lock whose overflow file is missing or not text fails closed")
  func lockOverflowBroken() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    var writer = try AsyncStorageWriter(directory: temporary.url)

    writer.setDangling(StoreKeys.lock)
    try writer.writeManifest()

    let database = try memoryDatabase()
    let report = ExpoImport.run(source: temporary.url, into: database)

    #expect(report.lock.isFailedClosed)
    #expect(try database.kvValue(forKey: StoreKeys.lock) == ExpoImport.failClosedLockValue)

    let overflow = temporary.url.appendingPathComponent(ExpoImport.overflowFileName(forKey: StoreKeys.lock))

    try Data([0xFF, 0xFE, 0x00]).write(to: overflow)

    let second = try memoryDatabase()

    #expect(ExpoImport.run(source: temporary.url, into: second).lock.isFailedClosed)
  }

  @Test("every valid threshold is copied as it is")
  func validThresholds() throws {
    for threshold in ExpoImport.lockThresholds.sorted() {
      let temporary = try TemporaryDirectory()
      defer { temporary.cleanUp() }

      var writer = try AsyncStorageWriter(directory: temporary.url)

      try writer.set(StoreKeys.lock, #"{"threshold":"\#(threshold)"}"#)
      try writer.writeManifest()

      let database = try memoryDatabase()
      let report = ExpoImport.run(source: temporary.url, into: database)

      #expect(report.lock == .imported(threshold: threshold))
      #expect(try database.kvValue(forKey: StoreKeys.lock) == #"{"threshold":"\#(threshold)"}"#)
    }
  }

  @Test("a manifest that is not JSON imports only a fail-closed lock")
  func corruptManifest() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    try Data("{\"hermie.lock\": \"{\\\"thresh".utf8).write(to: temporary.url.appendingPathComponent("manifest.json"))

    let database = try memoryDatabase()
    let report = ExpoImport.run(source: temporary.url, into: database)

    #expect(report.outcome == .sourceCorrupt)
    #expect(report.requiresLock)
    #expect(try database.kvValue(forKey: StoreKeys.lock) == ExpoImport.failClosedLockValue)
    #expect(try database.kvValue(forKey: ExpoImport.flagKey) != nil)
    #expect(!report.notes.isEmpty)
  }

  @Test("a manifest that cannot be read yet defers the import and reports the lock as unknown")
  func unreadableManifest() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    var writer = try AsyncStorageWriter(directory: temporary.url)

    try writer.set(StoreKeys.lock, #"{"threshold":"off"}"#)
    try writer.writeManifest()

    let manifest = temporary.url.appendingPathComponent("manifest.json")

    // Unreadable, the way data protection makes it before the first unlock.
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: manifest.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: manifest.path) }

    let database = try memoryDatabase()
    let report = ExpoImport.run(source: temporary.url, into: database)

    guard case .deferred = report.outcome else {
      Issue.record("expected the import to be deferred, got \(report.outcome)")
      return
    }

    #expect(report.lock == .unknown)
    #expect(report.requiresLock)
    #expect(try database.kvKeys().isEmpty)
  }

  @Test("an overflow file that cannot be read yet defers the whole import")
  func unreadableOverflow() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    var writer = try AsyncStorageWriter(directory: temporary.url)

    try writer.set(StoreKeys.lock, #"{"threshold":"1m"}"#)
    try writer.set(StoreKeys.chatsLayout, String(repeating: "x", count: 2_000))
    try writer.writeManifest()

    let overflow = temporary.url.appendingPathComponent(ExpoImport.overflowFileName(forKey: StoreKeys.chatsLayout))

    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: overflow.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: overflow.path) }

    let database = try memoryDatabase()
    let report = ExpoImport.run(source: temporary.url, into: database)

    #expect(report.requiresLock)
    #expect(try database.kvKeys().isEmpty)
  }

  // MARK: Timing

  @Test("200 keys, a quarter of them overflow, import well inside a frame budget")
  func twoHundredKeys() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    var writer = try AsyncStorageWriter(directory: temporary.url)

    for index in 0..<200 {
      let gateway = String(format: "g%016x", index % 5)
      let key = index == 0 ? StoreKeys.lock : "hermie.setting\(index % 20).\(index)@\(gateway)"
      let size = index % 4 == 0 ? 3_000 : 200
      let value = index == 0 ? #"{"threshold":"immediately"}"# : #"{"v":"\#(String(repeating: "é", count: size))"}"#

      try writer.set(key, value)
    }

    try writer.writeManifest()

    var timings: [Duration] = []

    for _ in 0..<5 {
      let database = try memoryDatabase()
      let report = ExpoImport.run(source: temporary.url, into: database)

      #expect(report.importedKeys.count == 200)
      timings.append(report.elapsed)
    }

    let best = timings.min() ?? .zero
    let worst = timings.max() ?? .zero

    print("ExpoImport 200 keys (50 overflow), in memory: best \(best), worst \(worst)")
    #expect(worst < .milliseconds(250))

    // And the whole launch step against a real file: open, migrate, import.
    let launch = try StoreLaunch.run(
      database: .file(temporary.url.appendingPathComponent("support/hermie.sqlite")),
      expoStorage: temporary.url
    )

    print("StoreLaunch on a file, 200 keys: import \(launch.report.expoImport.elapsed)")
    #expect(launch.report.expoImport.importedKeys.count == 200)
  }
}

@Suite("Store launch")
struct StoreLaunchTests {
  @Test("a fresh launch over an Expo install hands back a store holding the imported settings")
  func launch() async throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = StoreLaunch.databaseURL(applicationSupport: temporary.url)
    let result = try StoreLaunch.run(database: .file(url), expoStorage: Fixtures.expoStorage)

    #expect(result.report.expoImport.outcome == .imported)
    #expect(!result.report.requiresLock)

    let registry = try await GatewayRegistryStore(store: result.store).load()

    #expect(registry.activeGatewayId == Fixtures.gatewayOne)
  }

  @Test("after a corrupt database the lock fails closed and the import runs again")
  func corruptionRecovery() async throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let url = StoreLaunch.databaseURL(applicationSupport: temporary.url)

    do {
      let first = try StoreLaunch.run(database: .file(url), expoStorage: Fixtures.expoStorage)

      try await KeyValueStore(store: first.store).setString(#"{"threshold":"off"}"#, forKey: StoreKeys.lock)
    }

    try Data(repeating: 0x42, count: 4_096).write(to: url)
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: url.path + "-wal"))
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: url.path + "-shm"))

    let second = try StoreLaunch.run(database: .file(url), expoStorage: Fixtures.expoStorage)
    let kv = KeyValueStore(store: second.store)

    #expect(second.report.database.corruption != nil)
    #expect(second.report.requiresLock)
    #expect(second.report.expoImport.outcome == .imported)
    #expect(try await kv.string(forKey: StoreKeys.lock) == ExpoImport.failClosedLockValue)
    #expect(try await GatewayRegistryStore(store: second.store).load().gateways.count == 2)
  }

  @Test("the database is refused inside the App Group container")
  func notInAppGroup() throws {
    let temporary = try TemporaryDirectory()
    defer { temporary.cleanUp() }

    let group = temporary.url.appendingPathComponent("group")

    #expect(throws: StoreLaunch.LaunchError.databaseInsideAppGroup) {
      _ = try StoreLaunch.run(
        database: .file(group.appendingPathComponent("hermie.sqlite")),
        expoStorage: nil,
        appGroupContainer: group
      )
    }
  }
}
