import Foundation
@_spi(GatewaySync) import HermieGateway
@_spi(GatewaySync) import HermieStore
import Testing

@testable import HermieCore

private struct Scratch {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-launch-\(UUID().uuidString)")

  func cleanUp() {
    try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    try? FileManager.default.removeItem(at: url)
  }
}

@MainActor
@Suite("App launch")
struct AppLaunchTests {
  @Test("a first launch opens the file, says nothing, and starts open")
  func firstLaunch() async throws {
    let scratch = Scratch()
    defer { scratch.cleanUp() }

    let launch = AppLaunch(environment: LaunchEnvironment.inMemory(dataDirectory: scratch.url, authenticator: ScriptedAuthenticator()))

    #expect(launch.notices.isEmpty)
    #expect(launch.report?.openFailure == nil)
    #expect(FileManager.default.fileExists(atPath: StoreLaunch.databaseURL(applicationSupport: scratch.url).path))

    await launch.start()

    #expect(launch.lock.ready)
    #expect(!launch.lock.machine.locked)
    #expect(launch.gateways.loaded)
    #expect(launch.gateways.isEmpty)
  }

  @Test("a database that cannot be opened runs on memory, locked, and says so")
  func openFailure() async throws {
    let scratch = Scratch()
    defer { scratch.cleanUp() }

    // A file where the directory should be: nothing can be created inside it.
    try Data("not a directory".utf8).write(to: scratch.url)

    let launch = AppLaunch(environment: LaunchEnvironment.inMemory(dataDirectory: scratch.url, authenticator: ScriptedAuthenticator()))

    #expect(launch.report?.openFailure != nil)
    #expect(launch.notices.contains(.runningInMemory))
    #expect(launch.notices.contains(.lockSettingNotRestored))
    // The setting is unknown and the device can authenticate: locked from the first frame.
    #expect(launch.lock.ready)
    #expect(launch.lock.machine.locked)

    // The in-memory store works for this launch.
    try await launch.keyValues.setString("x", forKey: "hermie.test")
    #expect(try await launch.keyValues.string(forKey: "hermie.test") == "x")
  }

  @Test("a corrupt database is recovered, and the lock comes back from the mirror")
  func recovered() async throws {
    let scratch = Scratch()
    defer { scratch.cleanUp() }

    do {
      let first = AppLaunch(environment: LaunchEnvironment.inMemory(dataDirectory: scratch.url, authenticator: ScriptedAuthenticator()))
      try await first.keyValues.setString(#"{"threshold":"5m"}"#, forKey: StoreKeys.lock)
    }

    let url = StoreLaunch.databaseURL(applicationSupport: scratch.url)

    try Data(repeating: 0x42, count: 4_096).write(to: url)
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: url.path + "-wal"))
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: url.path + "-shm"))

    let second = AppLaunch(environment: LaunchEnvironment.inMemory(dataDirectory: scratch.url, authenticator: ScriptedAuthenticator()))

    #expect(second.notices == [.recovered])

    await second.start()

    #expect(second.lock.machine == .start(.fiveMinutes))
  }

  @Test("a recovery that loses the lock setting starts locked and says so")
  func recoveredWithoutLock() async throws {
    let scratch = Scratch()
    defer { scratch.cleanUp() }

    do {
      let first = AppLaunch(environment: LaunchEnvironment.inMemory(dataDirectory: scratch.url, authenticator: ScriptedAuthenticator()))
      try await first.keyValues.setString(#"{"threshold":"5m"}"#, forKey: StoreKeys.lock)
    }

    let url = StoreLaunch.databaseURL(applicationSupport: scratch.url)

    try Data(repeating: 0x42, count: 4_096).write(to: url)
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: url.path + "-wal"))
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: url.path + "-shm"))
    try FileManager.default.removeItem(at: LockMirror(applicationSupport: scratch.url).url)

    let second = AppLaunch(environment: LaunchEnvironment.inMemory(dataDirectory: scratch.url, authenticator: ScriptedAuthenticator()))

    #expect(second.notices == [.recovered, .lockSettingNotRestored])
    #expect(second.lock.machine.locked)

    await second.start()

    #expect(second.lock.machine.locked)
    #expect(second.lock.settingUnknown)
  }

  @Test("an unreadable lock on a device that cannot authenticate opens with a notice")
  func unreadableLockNoticed() async throws {
    let launch = AppLaunch(
      environment: LaunchEnvironment.inMemory(dataDirectory: nil, authenticator: ScriptedAuthenticator(enrolment: .none))
    )

    try await launch.keyValues.setString("garbage", forKey: StoreKeys.lock)
    await launch.start()

    #expect(!launch.lock.machine.locked)
    #expect(launch.notices == [.lockSettingNotRestored])

    launch.dismiss(.lockSettingNotRestored)
    #expect(launch.notices.isEmpty)
  }

  @Test("the directory follows the registry and resolves link keys")
  func directory() async throws {
    let launch = AppLaunch(environment: LaunchEnvironment.inMemory(dataDirectory: nil, authenticator: ScriptedAuthenticator()))

    await launch.start()

    let registry = launch.gateways.store

    try await registry.add(
      GatewayRecord(id: "g0011223344556677", name: "Home", address: "http://home.test:9119", authKind: .sessionToken, addedAt: 1)
    )
    try await registry.add(
      GatewayRecord(id: "g8899aabbccddeeff", name: "", address: "https://work.test", authKind: .nativePKCE, addedAt: 2)
    )

    // The change stream reaches the directory without another load.
    for _ in 0..<100 where launch.gateways.entries.count < 2 {
      try await Task.sleep(for: .milliseconds(5))
    }

    #expect(launch.gateways.entries.map(\.name) == ["Home", "work.test"])
    #expect(launch.gateways.activeId == "g0011223344556677")
    #expect(launch.gateways.entry(forKey: GatewayKey.of("https://work.test"))?.id == "g8899aabbccddeeff")
    #expect(launch.gateways.entry(forKey: "") == nil)

    var removed: [String] = []

    launch.gateways.onRemoved = { removed.append($0) }
    try await launch.gateways.remove(id: "g0011223344556677")

    #expect(removed == ["g0011223344556677"])
    #expect(launch.gateways.activeId == "g8899aabbccddeeff")
  }

  #if DEBUG
    @Test("the UI test switches exist only with -HermieUITest, and seed before anything is read")
    func testHooks() async throws {
      #expect(LaunchTestHooks(arguments: ["Hermie"]) == nil)
      #expect(LaunchTestHooks(arguments: ["Hermie", "-HermieUITest", "NO"]) == nil)

      let scratch = Scratch()
      defer { scratch.cleanUp() }

      let hooks = try #require(
        LaunchTestHooks(arguments: [
          "Hermie", "-HermieUITest", "YES",
          "-HermieDataDirectory", scratch.url.path,
          "-HermieFakeAuth", "fail,ok",
          "-HermieSeedLock", #"{"threshold":"1m"}"#,
          "-HermieSeedGateway", "Home|http://home.test:9119"
        ])
      )

      #expect(hooks.dataDirectory.path == scratch.url.path)

      let environment = LaunchEnvironment.live(arguments: [
        "Hermie", "-HermieUITest", "YES",
        "-HermieDataDirectory", scratch.url.path,
        "-HermieFakeAuth", "fail,ok",
        "-HermieSeedLock", #"{"threshold":"1m"}"#,
        "-HermieSeedGateway", "Home|http://home.test:9119"
      ])
      let launch = AppLaunch(environment: environment)

      await launch.start()

      #expect(launch.lock.machine == .start(.oneMinute))
      #expect(launch.gateways.entries.map(\.name) == ["Home"])
      #expect(!(await launch.lock.unlock(reason: "test")))
      #expect(await launch.lock.unlock(reason: "test"))
    }
  #endif
}
