import Foundation
import HermieGateway
import HermieStore
import Testing

@testable import HermieCore

/// The log in the app: the launch owns it, every live session writes to it, and a gateway's entries go with its
/// sign-in or its removal and nothing else's.
@Suite("Decision log: in the app", .timeLimit(.minutes(1))) @MainActor
struct DecisionLogWiringTests {
  @Test("the launch's log is on the launch's database, and a session built for a gateway writes to it")
  func sessionsWriteToTheLaunchsLog() async throws {
    let fixture = try await LiveGatewayTests.Fixture()
    let connect = LiveGateway.accountsConnector(launch: fixture.launch, accounts: fixture.accounts)
    let record = try #require(try await fixture.launch.gateways.store.load().gateway(id: fixture.first))
    let session = try #require(try await connect(record))

    #expect(session.decisions.isRecording)
    #expect(session.decisions.gatewayID == fixture.first)
    #expect(session.decisions.gatewayName == "First")

    await session.decisions.confirm(confirmed: false, bot: "researcher", session: "rt-1", via: .tap)

    let entries = await fixture.launch.decisions.entries()

    #expect(entries.map(\.gatewayID) == [fixture.first])
    #expect(entries.first?.gateway == "First")
    await session.shutdown()
  }

  @Test("the log lives in the launch's database file, which is outside the App Group and out of iCloud and device backups")
  func fileIsLocalOnly() async throws {
    let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-decisions-\(UUID().uuidString)")

    defer { try? FileManager.default.removeItem(at: scratch) }

    let launch = AppLaunch(environment: .inMemory(dataDirectory: scratch, authenticator: ScriptedAuthenticator()))

    await launch.start()
    await launch.decisions.record(DecisionFixture.entry("a"))

    let database = StoreLaunch.databaseURL(applicationSupport: scratch)
    let values = try database.resourceValues(forKeys: [.isExcludedFromBackupKey])

    #expect(FileManager.default.fileExists(atPath: database.path))
    #expect(values.isExcludedFromBackup == true)
    #expect(!database.path.contains("group."), "not in an App Group container")
    #expect(await launch.decisions.count() == 1)
  }

  @Test("a session with no log keeps nothing")
  func sessionWithoutLog() {
    let session = GatewaySession(gatewayID: "g1", link: ScriptedLink())

    #expect(!session.decisions.isRecording)
  }

  @Test("signing out of a gateway purges its entries and no other gateway's")
  func signOutPurges() async throws {
    let fixture = try await LiveGatewayTests.Fixture()
    let log = fixture.launch.decisions

    await log.record(DecisionFixture.entry("a", gatewayID: fixture.first))
    await log.record(DecisionFixture.entry("b", gatewayID: fixture.second))
    await log.record(DecisionFixture.entry("c", gatewayID: fixture.first))

    let before = log.revision

    await fixture.accounts.signOut(fixture.first)

    #expect(await log.entries().map(\.id) == ["b"])
    #expect(log.revision > before, "a screen showing the log is told")
  }

  @Test("removing a gateway purges its entries and no other gateway's")
  func removalPurges() async throws {
    let fixture = try await LiveGatewayTests.Fixture()
    let log = fixture.launch.decisions

    fixture.launch.gateways.onRemoved = { [accounts = fixture.accounts] id in await accounts.forgotten(id) }
    await log.record(DecisionFixture.entry("a", gatewayID: fixture.first))
    await log.record(DecisionFixture.entry("b", gatewayID: fixture.second))

    let before = log.revision

    try await fixture.accounts.remove(fixture.first)

    #expect(await log.entries().map(\.id) == ["b"])
    #expect(log.revision > before)
  }

  @Test("the launch prunes what is past its age, and keeps the rest")
  func launchPrunes() async throws {
    let fixture = try await LiveGatewayTests.Fixture()
    let log = fixture.launch.decisions
    let day = 86_400.0

    // Written straight to the table: `record` would drop the old one itself.
    try await fixture.launch.store.write { database in
      for (id, age) in [("old", 100.0), ("recent", 1.0)] {
        let at = Int64((Date().timeIntervalSince1970 - age * day) * 1000)

        try database.execute(
          "INSERT INTO decisions (id, ns, bot, at, json) VALUES (?, ?, ?, ?, ?)",
          [.text(id), .text("g1"), .text("researcher"), .integer(at), .text("{}")]
        )
      }
    }

    await log.prune()

    let left = try await fixture.launch.store.read { try $0.query("SELECT id FROM decisions").compactMap { $0["id"].text } }

    #expect(left == ["recent"])
  }
}
