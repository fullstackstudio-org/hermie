import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// The live wiring hands the live session's open requests to the local notifications: one posted per
/// request that arrives while the person is not looking, taken away when it ends, and gone with the
/// session. A fake centre stands in for the system's.
@MainActor
@Suite("Live wiring: notifications for open requests", .timeLimit(.minutes(1)))
struct LiveWiringAlertsTests {
  typealias Launch = LiveGatewayTests.Fixture

  @MainActor
  struct Rig {
    let fixture: Launch
    let harness: SessionHarness
    let live: LiveGateway
    let shown = AlertRig()
    let wiring: LiveWiring
    let lock = InstalledLock()

    init() async throws {
      fixture = try await Launch()
      harness = SessionHarness(gatewayID: fixture.first)
      harness.link.takeEveryAnswer()
      let session = harness.session
      live = LiveGateway(directory: fixture.launch.gateways, connector: { _ in session }, ready: { true })
      wiring = LiveWiring(
        launch: fixture.launch, accounts: fixture.accounts, live: live, surfaces: nil, installLock: lock.install,
        alerts: shown.alerts)
    }

    func start() async throws {
      try await harness.start()
      try await harness.open()
      try await harness.frame()
      wiring.start()
      await live.follow(fixture.first)
      let live = self.live
      try await eventually("the live session") { await MainActor.run { live.session === self.harness.session } }
    }

    func raiseForm(_ id: String) {
      var params = InteractiveFrames.form()
      params["session_id"] = .string(Fixture.runtime)
      harness.link.raise(id: id, method: "input.form", params: params)
    }
  }

  @Test("a request that arrives while the app is in the background is posted, and goes when it ends")
  func postsAndWithdraws() async throws {
    let rig = try await Rig()
    try await rig.start()
    rig.shown.background()

    rig.raiseForm("srq-f")

    let center = rig.shown.center
    try await eventually("the notification") { await center.posted.count == 1 }

    let posted = try #require(center.posted.first)
    #expect(posted.identifier == RequestAlertContent.identifier(gatewayId: rig.fixture.first, requestId: "srq-f"))
    #expect(posted.body == "Needs your attention", "previews are off by default")
    #expect(posted.payload?.string("requestId") == "srq-f")
    #expect(posted.payload?.string("method") == "input.form")
    #expect(posted.payload?.string("bot") == Fixture.profile)
    #expect(posted.payload?.string("gatewayKey") == rig.fixture.launch.gateways.entry(id: rig.fixture.first)?.key)

    rig.harness.link.emit(
      "request.cancel", session: Fixture.runtime, payload: ["id": "srq-f", "method": "input.form", "reason": "timeout"])
    try await rig.harness.frame()
    try await eventually("the notification to go") { await center.delivered.isEmpty }
    #expect(center.removals == [[posted.identifier]])

    await rig.live.shutdown()
  }

  @Test("with the chat on screen in the key window nothing is posted")
  func nothingWhileLooking() async throws {
    let rig = try await Rig()
    try await rig.start()
    rig.shown.front(showing: AppPresence.Chat(gatewayId: rig.fixture.first, bot: Fixture.profile))

    rig.raiseForm("srq-f")
    let session = rig.harness.session
    try await eventually("the request to open") { await session.interactive.isOpen("srq-f") }
    try await Task.sleep(for: .milliseconds(100))

    #expect(rig.shown.center.posted.isEmpty)
    await rig.live.shutdown()
  }

  @Test("the session ending takes its notifications away, and the window reports reach the presence")
  func sessionEndsAndWindows() async throws {
    let rig = try await Rig()
    try await rig.start()

    let window = UUID()
    rig.wiring.setPresence(window: window, active: true, key: true, gatewayId: rig.fixture.first, bot: Fixture.profile)
    #expect(rig.shown.alerts.presence.isActive)
    #expect(rig.shown.alerts.presence.isVisible(AppPresence.Chat(gatewayId: rig.fixture.first, bot: Fixture.profile)))
    rig.wiring.windowClosed(window)
    #expect(!rig.shown.alerts.presence.isActive)

    rig.raiseForm("srq-f")
    let center = rig.shown.center
    try await eventually("the notification") { await center.posted.count == 1 }

    await rig.fixture.accounts.signOut(rig.fixture.first)
    try await eventually("the notification to go") { await center.delivered.isEmpty }
    await rig.live.shutdown()
  }

  @Test("a tap brings a request the person had put away back")
  func tapBringsItBack() async throws {
    let rig = try await Rig()
    try await rig.start()
    let session = rig.harness.session
    let key = try #require(rig.fixture.launch.gateways.entry(id: rig.fixture.first)?.key)

    session.requestShelf.putAway("srq-f", chat: Fixture.profile, kind: .interactive)
    session.requestShelf.putAway("srq-s", chat: Fixture.profile, kind: .secure)
    session.requestShelf.putAway("srq-a", chat: Fixture.profile, kind: .answer)

    rig.wiring.bringBack(gatewayKey: "0000000000000000", bot: Fixture.profile, requestId: "srq-f")
    #expect(session.requestShelf.contains("srq-f", chat: Fixture.profile, kind: .interactive), "another gateway's key")

    for id in ["srq-f", "srq-s", "srq-a"] {
      rig.wiring.bringBack(gatewayKey: key, bot: Fixture.profile, requestId: id)
    }

    #expect(!session.requestShelf.contains("srq-f", chat: Fixture.profile, kind: .interactive))
    #expect(!session.requestShelf.contains("srq-s", chat: Fixture.profile, kind: .secure))
    #expect(!session.requestShelf.contains("srq-a", chat: Fixture.profile, kind: .answer))
    await rig.live.shutdown()
  }
}
