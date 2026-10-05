#if os(macOS)
import Foundation
import HermieCore
import HermieGateway
import HermieStore
import Testing

/// What a reinstall on iOS leaves: the app's files are gone, both keychain sets are not. Never the
/// real keychain: both sets are in memory, iCloud Keychain is a `FakeCloud`.
@MainActor
final class ReinstallStores {
  let secrets = InMemorySecretStore()
  let cloud = FakeCloud(delivery: .immediate)
  private var directories: [URL] = []
  private var launches: [AppLaunch] = []

  deinit {
    for directory in directories { try? FileManager.default.removeItem(at: directory) }
  }

  /// A fresh install over the kept keychains: a new data directory, started as the app starts it.
  func install() async -> (AppLaunch, GatewayAccounts) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-reinstall-\(UUID().uuidString)")
    directories.append(directory)

    let launch = AppLaunch(
      environment: LaunchEnvironment(
        dataDirectory: directory,
        authenticator: ScriptedAuthenticator(),
        secrets: secrets,
        synced: cloud.replica("phone")
      )
    )

    launches.append(launch)
    await launch.start()

    let accounts = GatewayAccounts(launch: launch, services: GatewayServices())
    launch.gateways.onRemoved = { [weak accounts] id in await accounts?.forgotten(id) }
    await launch.gateways.load()
    accounts.follow()
    await accounts.refresh()
    return (launch, accounts)
  }
}

extension Integration {
  @Suite("Reinstall and iCloud Sync")
  struct ReinstallSyncIntegrationTests {
    @Test("the same gateway set up again after a reinstall, then Sync with iCloud: one gateway, signed in")
    func reinstallThenSync() async throws {
      try await FakeGateway.with(FakeGateway.Options(auth: .native)) { gateway in
        try await Self.reinstallThenSync(baseURL: gateway.baseURL)
      }
    }

    @MainActor
    static func setUp(_ baseURL: String, accounts: GatewayAccounts) async throws -> String {
      let model = OnboardingModel(mode: .newGateway, accounts: accounts)
      model.address = baseURL
      await until { model.resolved != nil }
      model.continueFromAddress()
      model.startBrowserSignIn(presenter: ScriptedBrowser())
      await until { model.signIn == .signedIn || { if case .failed = model.signIn { true } else { false } }() }
      #expect(model.signIn == .signedIn)
      _ = await model.continueFromSignIn()
      model.continueFromName()
      return try #require(await model.finish())
    }

    @MainActor
    static func reinstallThenSync(baseURL: String) async throws {
      let stores = ReinstallStores()

      // The earlier install: set up, synced.
      let (first, firstAccounts) = await stores.install()
      let old = try await setUp(baseURL, accounts: firstAccounts)
      await first.iCloudSync.acceptDisclosure()
      await first.sync.waitUntilIdle()
      #expect(first.iCloudSync.isOn)

      // Another device keeps a second gateway in the same iCloud Keychain.
      let other = GatewaySyncEngine(
        database: try SQLiteStore(.inMemory), secrets: InMemorySecretStore(), synced: stores.cloud.replica("mac"),
        timing: SyncTiming(localChangeDelay: .zero), logger: .none)
      try await other.disclose()
      _ = try await other.addGateway(
        NewGateway(name: "Lab", address: "https://lab.invalid", authKind: .sessionToken, sessionToken: "tok-lab"))
      _ = try await other.addGateway(NewGateway(name: "Same", address: baseURL, authKind: .nativePKCE))
      await other.reconcileNow(.manual)
      await other.waitUntilIdle()

      // Deleted and installed again: the setup, then the disclosure.
      let (launch, accounts) = await stores.install()
      launch.iCloudSync.lookInICloud()
      await launch.iCloudSync.availableSettled()
      let id = try await setUp(baseURL, accounts: accounts)
      #expect(id != old)
      await launch.sync.waitUntilIdle()
      await until { launch.iCloudSync.needsDisclosure }

      await launch.iCloudSync.acceptDisclosure()
      await launch.sync.waitUntilIdle()
      await launch.sync.reconcileNow(.manual)
      await launch.sync.waitUntilIdle()
      await launch.gateways.load()
      await accounts.refresh()

      #expect(launch.iCloudSync.isOn)
      #expect(launch.iCloudSync.actionFailure == nil)
      let addresses = launch.gateways.entries.map(\.address)
      #expect(addresses.filter { $0 == baseURL }.count == 1)
      #expect(addresses.contains("https://lab.invalid"))
      #expect(accounts.status(for: id) == .signedIn)
    }
  }
}
#endif
