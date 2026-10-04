import Foundation
import HermieStore
import Testing

@testable import HermieCore

/// What the reader chose to be told about reaches the row this device writes on the live gateway.
@MainActor
@Suite("Live wiring: push preferences")
struct LiveWiringPreferencesTests {
  typealias Fixture = LiveGatewayTests.Fixture

  @Test("the choices are in the bridge's row writer, as they were when it was built and as they change")
  func theWriterFollowsTheChoices() async throws {
    let fixture = try await Fixture()
    let live = LiveGateway(launch: fixture.launch, accounts: fixture.accounts)
    let wiring = LiveWiring(
      launch: fixture.launch,
      accounts: fixture.accounts,
      live: live,
      surfaces: nil,
      installLock: InstalledLock().install
    )
    let push = fixture.launch.push

    await push.setGateways([PushGatewayRef(id: fixture.first, key: "1111111111111111", active: true)])
    await push.start()
    #expect(push.started)
    await push.setType("cron", false)
    wiring.start()
    live.start()
    try await eventually("the bridge") { await MainActor.run { wiring.meta != nil } }

    // Chosen before the bridge existed: the first row already says so.
    let writer = try #require(wiring.meta?.writer)
    #expect(writer.types["cron"] == false)
    #expect(writer.types["message"] == true)
    #expect(!writer.preview)

    await push.setPreview(true)
    await push.setType("turn_failed", false)

    #expect(writer.preview)
    #expect(writer.types["turn_failed"] == false)

    await live.shutdown()
  }
}
