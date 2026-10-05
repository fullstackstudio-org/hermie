import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

/// The live wiring hands the live session's open requests and connector cards to the "Needs you"
/// inbox: it follows what opens and ends, goes with the session, counts for the app icon while the app
/// is in the background, and the notification's badge reads the same count.
@MainActor
@Suite("Live wiring: the Needs you inbox", .timeLimit(.minutes(1)))
struct LiveWiringInboxTests {
  @MainActor
  struct Rig {
    let launch: AppLaunch
    let accounts: GatewayAccounts
    let system = FakePushSystem()
    let gatewayId: String
    let harness: SessionHarness
    let live: LiveGateway
    let inbox = NeedsYouInbox()
    let shown = AlertRig()
    let wiring: LiveWiring
    let lock = InstalledLock()

    /// The name of a second gateway, when the rig has one: configured, but not the live one.
    let otherName: String?

    init(otherGateway: String? = nil) async throws {
      otherName = otherGateway
      system.current = .granted
      launch = AppLaunch(
        environment: .inMemory(dataDirectory: nil, authenticator: ScriptedAuthenticator()), pushSystem: system)
      accounts = GatewayAccounts(launch: launch, services: GatewayServices())
      await launch.start()
      gatewayId = try await launch.sync.addGateway(
        NewGateway(name: "Home", address: "http://127.0.0.1:1", authKind: .sessionToken, sessionToken: "token"))
      if let otherGateway {
        _ = try await launch.sync.addGateway(
          NewGateway(name: otherGateway, address: "http://127.0.0.1:2", authKind: .sessionToken, sessionToken: "other"))
      }

      await launch.gateways.load()
      try await launch.gateways.activate(id: gatewayId)

      harness = SessionHarness(gatewayID: gatewayId)
      harness.link.takeEveryAnswer()
      let session = harness.session
      live = LiveGateway(directory: launch.gateways, connector: { _ in session }, ready: { true })
      wiring = LiveWiring(
        launch: launch, accounts: accounts, live: live, surfaces: nil, installLock: lock.install,
        alerts: shown.alerts, inbox: inbox)
    }

    func start() async throws {
      try await harness.start()
      try await harness.open()
      try await harness.frame()
      wiring.start()
      await live.follow(gatewayId)
      let live = self.live
      try await eventually("the live session") { await MainActor.run { live.session === self.harness.session } }
    }

    func raiseForm(_ id: String) {
      var params = InteractiveFrames.form()
      params["session_id"] = .string(Fixture.runtime)
      harness.link.raise(id: id, method: "input.form", params: params)
    }
  }

  @Test("what the live session is asked shows up in the inbox, with its gateway and bot, and goes when it ends")
  func followsTheSession() async throws {
    let rig = try await Rig()
    try await rig.start()

    #expect(rig.inbox.isEmpty)

    rig.raiseForm("srq-f")
    let inbox = rig.inbox
    try await eventually("the form to be listed") { await inbox.count == 1 }

    let item = try #require(inbox.items.first)
    #expect(item.requestId == "srq-f")
    #expect(item.kind == .input)
    #expect(item.gatewayId == rig.gatewayId)
    #expect(item.gatewayName == "Home")
    #expect(item.gatewayKey == rig.launch.gateways.entry(id: rig.gatewayId)?.key)
    #expect(item.bot == Fixture.profile)
    #expect(item.method == "input.form")

    rig.harness.link.emit(
      "request.cancel", session: Fixture.runtime, payload: ["id": "srq-f", "method": "input.form", "reason": "timeout"])
    try await rig.harness.frame()
    try await eventually("the form to leave") { await inbox.isEmpty }

    await rig.live.shutdown()
  }

  @Test("a connector card the agent waits on is listed too, and goes when it is settled")
  func listsConnectorCards() async throws {
    let rig = try await Rig()
    try await rig.start()
    let session = rig.harness.session

    session.connectionRequests.requested(
      chat: Fixture.profile, runtimeSessionID: Fixture.runtime,
      ConnectionRequestPayload(json: [
        "op_id": "op-1", "seq": 1, "deadline_at": .number(Date().timeIntervalSince1970 + 600), "timeout_seconds": 600,
        "tool_call_id": "call-1",
        "targets": [["name": "GitHub", "kind": "connector", "action": "authorize", "state": "pending"]]
      ]))

    let inbox = rig.inbox
    try await eventually("the card to be listed") { await inbox.count == 1 }

    let item = try #require(inbox.items.first)
    #expect(item.kind == .connector)
    #expect(item.targets == ["GitHub"])
    #expect(item.bot == Fixture.profile)
    #expect(item.requestId == "op-1")

    session.connectionRequests.forget(chat: Fixture.profile)
    try await eventually("the card to leave") { await inbox.isEmpty }

    await rig.live.shutdown()
  }

  @Test("signing out takes the gateway's requests out of the inbox")
  func signOutEmptiesIt() async throws {
    let rig = try await Rig()
    try await rig.start()

    rig.raiseForm("srq-f")
    let inbox = rig.inbox
    try await eventually("the form to be listed") { await inbox.count == 1 }

    await rig.accounts.signOut(rig.gatewayId)
    try await eventually("the inbox to empty") { await inbox.isEmpty }

    await rig.live.shutdown()
  }

  @Test("the app icon says how many wait while the app is in the background and notifications are allowed")
  func badgeInTheBackground() async throws {
    let rig = try await Rig()
    let push = rig.launch.push

    await push.setGateways([PushGatewayRef(id: rig.gatewayId, key: "1111111111111111", active: true)])
    await push.start()
    await push.setEnabled(true)
    #expect(push.permission == .granted)
    #expect(push.enabled)

    try await rig.start()
    let window = UUID()
    rig.wiring.setForeground(true, window: window)

    rig.raiseForm("srq-1")
    let inbox = rig.inbox
    try await eventually("the form to be listed") { await inbox.count == 1 }
    try await Task.sleep(for: .milliseconds(50))
    #expect(rig.system.badges.allSatisfy { $0 == 0 }, "in front the badge is zero, and nothing sets it")

    rig.wiring.setForeground(false, window: window)
    try await eventually("the badge to say one") { await MainActor.run { rig.system.badges.last == 1 } }

    rig.raiseForm("srq-2")
    try await eventually("the badge to say two") { await MainActor.run { rig.system.badges.last == 2 } }

    await rig.live.shutdown()
  }

  @Test("with notifications switched off, the app icon is left alone")
  func noBadgeWhenOff() async throws {
    let rig = try await Rig()
    let push = rig.launch.push

    await push.setGateways([PushGatewayRef(id: rig.gatewayId, key: "1111111111111111", active: true)])
    await push.start()
    #expect(!push.enabled)

    try await rig.start()
    rig.wiring.setForeground(false, window: UUID())
    rig.raiseForm("srq-1")
    let inbox = rig.inbox
    try await eventually("the form to be listed") { await inbox.count == 1 }
    try await Task.sleep(for: .milliseconds(50))

    #expect(rig.system.badges.allSatisfy { $0 == 0 })
    await rig.live.shutdown()
  }

  @Test("the emergency stop is over the live session, and says which gateways it has no connection to")
  func emergencyStopIsOverTheLiveSession() async throws {
    let rig = try await Rig(otherGateway: "Work")
    try await rig.start()
    rig.harness.link.respond(
      to: RPC.SessionActiveList.name,
      with: [
        "sessions": [["id": .string(Fixture.runtime), "session_key": .string(Fixture.stored), "status": "working"]]
      ])
    rig.harness.link.respond(to: RPC.SessionInterrupt.name, with: ["status": "interrupted"])

    let stop = rig.wiring.emergencyStop
    await stop.begin()

    guard case .confirming(let plan) = stop.phase else {
      Issue.record("expected a question, got \(stop.phase)")
      return
    }

    #expect(plan.total == 1)
    #expect(plan.entries.first?.gatewayId == rig.gatewayId)
    #expect(plan.entries.first?.gatewayName == "Home")
    #expect(plan.notAsked == ["Work"], "one socket at a time: the other gateway is out of reach, and it says so")

    await stop.confirm()

    guard case .finished(let summary) = stop.phase else {
      Issue.record("expected a summary, got \(stop.phase)")
      return
    }

    #expect(summary.stopped == 1)
    #expect(rig.harness.link.calls(RPC.SessionInterrupt.name).count == 1)

    await rig.live.shutdown()
  }

  @Test("the notification's badge reads the inbox's count, so both say the same number")
  func notificationBadgeReadsTheInbox() async {
    let inbox = NeedsYouInbox()
    let center = RecordingLocalNotifications()
    let knobs = AlertKnobs()
    let alerts = RequestAlerts(
      center: center, settings: { knobs.settings }, setBadge: { knobs.badge($0) }, badgeCount: { inbox.count })
    alerts.presence.report(window: UUID(), active: false, key: false, chat: nil)

    // Two things wait. The inbox counts both before either is posted, so each notification says two.
    let first = openRequest("srq-1")
    let second = openRequest("srq-2")
    inbox.update(gatewayId: "g1", gatewayName: "Home", gatewayKey: "", requests: [first, second])
    alerts.update(gatewayId: "g1", gatewayKey: PushGateways.one.key, requests: [first, second])
    await alerts.flush()

    #expect(center.posted.map(\.badge) == [2, 2], "both were posted after the inbox had counted both")

    inbox.update(gatewayId: "g1", gatewayName: "Home", gatewayKey: "", requests: [second])
    alerts.update(gatewayId: "g1", gatewayKey: PushGateways.one.key, requests: [second])
    await alerts.flush()

    #expect(knobs.badges == [1], "what is left, while in the background")
  }
}
