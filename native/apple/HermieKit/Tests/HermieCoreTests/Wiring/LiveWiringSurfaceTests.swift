import Foundation
import HermieGateway
import HermieProtocol
import HermieShared
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// The live wiring over two configured gateways whose sessions run on scripted links that answer
/// by themselves (the roster has `researcher`, its chat opens, a prompt is taken), with the system
/// surfaces in a temporary App Group container. The live gateway is moved by hand (`follow`), never
/// by the directory, so a test can put the two out of step.
@MainActor
private final class WiringRig {
  let fixture: LiveGatewayTests.Fixture
  let folder: SurfaceFolder
  let surfaces: SystemSurfaces
  let live: LiveGateway
  let wiring: LiveWiring
  let lock = InstalledLock()
  private let links = Links()

  init() async throws {
    let fixture = try await LiveGatewayTests.Fixture()
    let links = self.links

    self.fixture = fixture
    folder = try SurfaceFolder()
    surfaces = SystemSurfaces(container: folder.container, copy: SystemSurfacesTests.copy, isLocked: { false })
    surfaces.replyPoll = .milliseconds(10)
    live = LiveGateway(
      directory: fixture.launch.gateways,
      connector: { record in
        let link = ScriptedLink()

        WiringRig.answerEverything(link)
        links.made.withLock { $0[record.id] = link }
        return GatewaySession(gatewayID: record.id, link: link)
      }
    )
    wiring = LiveWiring(
      launch: fixture.launch, accounts: fixture.accounts, live: live, surfaces: surfaces, installLock: lock.install)
  }

  static func answerEverything(_ link: ScriptedLink) {
    link.respond(to: RPC.ProfilesList.name, with: SessionHarness.roster)
    link.respond(to: RPC.SubagentList.name, with: ["subagents": []])
    link.respond(to: RPC.ProfilesGetAsset.name, with: ["found": false])
    link.respond(to: RPC.SessionResume.name, with: Fixture.resume())
    link.respond(to: RPC.SessionHistory.name, with: ["count": 2, "messages": .array(Fixture.rows(2))])
    link.respond(to: RPC.SessionEventsSince.name, with: Fixture.since(latest: 0))
    link.respond(to: RPC.PromptSubmit.name, with: ["status": "streaming"])
    link.respond(to: RPC.ApprovalPending.name, with: ["approvals": []])
  }

  func link(_ gatewayId: String) -> ScriptedLink? {
    links.made.withLock { $0[gatewayId] }
  }

  func key(_ gatewayId: String) throws -> String {
    try #require(fixture.launch.gateways.entry(id: gatewayId)?.key)
  }

  /// Make `gatewayId` live, its socket ready, its roster read and the surfaces open.
  func goLive(_ gatewayId: String) async throws {
    wiring.start()
    await live.follow(gatewayId)

    let scripted = try #require(link(gatewayId))
    let session = try #require(live.session)

    scripted.status(.ready)
    try await eventually("the roster") { await session.roster.bot(named: Fixture.profile) != nil }
    try await eventually("the surfaces to open") { await MainActor.run { self.wiring.isUnlocked } }
  }
}

/// The links the connector made, by gateway id.
private final class Links: Sendable {
  let made = Mutex<[String: ScriptedLink]>([:])
}

/// A bool a test flips while the code under test reads it.
private final class Flag: Sendable {
  private let value: Mutex<Bool>

  init(_ value: Bool) {
    self.value = Mutex(value)
  }

  var isSet: Bool {
    get { value.withLock { $0 } }
    set { value.withLock { $0 = newValue } }
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct LiveWiringSurfaceTests {
  @Test("a drain while the directory has moved on goes through the live session for ITS gateway only")
  func drainFollowsTheSessionsGateway() async throws {
    let rig = try await WiringRig()
    let first = rig.fixture.first
    let second = rig.fixture.second

    try await rig.goLive(first)

    // The directory switches to the second gateway; the live session is still the first's.
    try await rig.fixture.launch.gateways.activate(id: second)
    try rig.folder.intent("theirs", .send, "for the second", gateway: try rig.key(second))
    try rig.folder.intent("mine", .send, "for the first", gateway: try rig.key(first))

    await rig.wiring.drainSoon()?.value

    let folder = rig.folder
    try await eventually("the answer to mine") { await MainActor.run { folder.result("mine") != nil } }
    try await Task.sleep(for: .milliseconds(200))

    let link = try #require(rig.link(first))
    #expect(link.calls(RPC.PromptSubmit.name).map { $0.params["text"] } == ["for the first"])
    #expect(rig.folder.result("mine") == .reply(id: "mine", ""))
    #expect(rig.folder.result("theirs") == nil)
    #expect(rig.folder.exists("intents/pending/theirs.json"), "queued for the second gateway's own session")

    await rig.live.shutdown()
  }

  @Test("after a sign-out the surfaces stay purged, whatever the session that is ending still does")
  func purgeStaysPurged() async throws {
    let rig = try await WiringRig()
    let first = rig.fixture.first
    let snapshot = rig.folder.container.widgetSnapshotURL

    try await rig.goLive(first)
    try await eventually("the snapshot") { FileManager.default.fileExists(atPath: snapshot.path) }

    await rig.fixture.accounts.signOut(first)
    #expect(!FileManager.default.fileExists(atPath: snapshot.path))

    // The session to the gateway is still up here (ending it is the live gateway's), and its rows move.
    let session = try #require(rig.live.session)
    try await session.open(Fixture.profile)
    try await Task.sleep(for: .milliseconds(1200))

    #expect(!FileManager.default.fileExists(atPath: snapshot.path), "nothing is published for it again")
    await rig.live.shutdown()
  }

  @Test("a removal purges the surfaces only once it went through")
  func removalPurgesAfterwards() async throws {
    let rig = try await WiringRig()
    let second = rig.fixture.second
    let accounts = rig.fixture.accounts

    rig.wiring.start()
    try rig.folder.intent("queued", .send, "later", gateway: try rig.key(second))

    let ending = accounts.endSession
    let folder = rig.folder
    let queuedWhenTheSessionEnded = Flag(false)

    accounts.endSession = { id in
      await ending?(id)
      queuedWhenTheSessionEnded.isSet = folder.exists("intents/pending/queued.json")
    }

    try await accounts.remove(second)

    #expect(queuedWhenTheSessionEnded.isSet, "nothing purged before the removal could still be refused")
    #expect(!folder.exists("intents/pending/queued.json"), "purged once it went through")
  }

  @Test("a notification action answers only while the app lock is open; locked, the chat only opens")
  func actionsWaitForTheAppLock() async throws {
    let rig = try await WiringRig()
    let first = rig.fixture.first
    let open = Flag(false)

    rig.wiring.appLockState = { open.isSet }
    rig.wiring.readyWait = .milliseconds(300)
    try await rig.goLive(first)

    let push = rig.fixture.launch.push
    let link = try #require(rig.link(first))
    let scope = PushApprovalScope(gatewayId: first, bot: Fixture.profile, sessionId: "")
    let answer = PushApprovalAnswer(
      gatewayId: first, bot: Fixture.profile, sessionId: Fixture.runtime, requestId: "appr-1", choice: "once")

    await #expect(throws: PushSessionUnavailable.self) {
      _ = try await push.pendingApprovals(scope)
    }
    await #expect(throws: PushSessionUnavailable.self) {
      try await push.respond(answer)
    }
    #expect(link.calls(RPC.ApprovalPending.name).isEmpty, "nothing is read for an answer behind the lock")
    #expect(link.calls(RPC.ApprovalRespond.name).isEmpty)

    // The person unlocks the app within the wait: the action goes on.
    rig.wiring.readyWait = .seconds(5)
    Task {
      try? await Task.sleep(for: .milliseconds(100))
      open.isSet = true
    }
    #expect(try await push.pendingApprovals(scope).isEmpty)
    #expect(!link.calls(RPC.ApprovalPending.name).isEmpty)

    await rig.live.shutdown()
  }

  @Test("the app is in front while any of its windows is")
  func foregroundFollowsEveryWindow() async throws {
    let fixture = try await LiveGatewayTests.Fixture()
    let live = LiveGateway(launch: fixture.launch, accounts: fixture.accounts)
    let wiring = LiveWiring(
      launch: fixture.launch, accounts: fixture.accounts, live: live, surfaces: nil, installLock: InstalledLock().install)
    let front = UUID()
    let minimised = UUID()

    wiring.setForeground(true, window: front)
    wiring.setForeground(true, window: minimised)
    wiring.setForeground(false, window: minimised)
    #expect(wiring.isForeground, "a second window minimised does not take the app out of the front")

    wiring.windowClosed(front)
    #expect(!wiring.isForeground)

    wiring.setForeground(true, window: minimised)
    #expect(wiring.isForeground)
  }
}
