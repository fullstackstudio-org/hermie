import Foundation
import HermieGateway
import HermieShared
import HermieStore
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

/// The lock the wiring installs, kept here instead of in the process-wide `SystemSurfaceLock`.
final class InstalledLock: Sendable {
  private let provider = Mutex<(@Sendable () -> Bool)?>(nil)

  func install(_ isLocked: @escaping @Sendable () -> Bool) {
    provider.withLock { $0 = isLocked }
  }

  /// Locked until something is installed, as the real one is.
  var isLocked: Bool {
    provider.withLock { $0 }?() ?? true
  }
}

/// What the live wiring does besides the screens: the surfaces' lock follows the live session,
/// push's seams answer only for the live gateway, and the push route of a `security` notice.
@MainActor
@Suite("Live wiring")
struct LiveWiringTests {
  typealias Fixture = LiveGatewayTests.Fixture

  @Test("the surfaces open once the live gateway has a signed-in session, and close on a sign-out")
  func surfaceLockFollowsTheSession() async throws {
    let fixture = try await Fixture()
    let live = LiveGateway(launch: fixture.launch, accounts: fixture.accounts)
    let lock = InstalledLock()
    let wiring = LiveWiring(
      launch: fixture.launch,
      accounts: fixture.accounts,
      live: live,
      surfaces: nil,
      installLock: lock.install
    )

    wiring.start()
    #expect(lock.isLocked, "locked until the session is up")

    live.start()
    try await eventually("unlocked") { await MainActor.run { !lock.isLocked } }
    #expect(wiring.isUnlocked)

    await fixture.accounts.signOut(fixture.first)
    try await eventually("relocked") { await MainActor.run { lock.isLocked } }
    #expect(!wiring.isUnlocked)

    await live.shutdown()
  }

  @Test("each live session gets a ui_meta bridge of its own, also when it is rebuilt for the same gateway")
  func bridgeFollowsTheSession() async throws {
    let fixture = try await Fixture()
    let live = LiveGateway(launch: fixture.launch, accounts: fixture.accounts)
    let wiring = LiveWiring(
      launch: fixture.launch,
      accounts: fixture.accounts,
      live: live,
      surfaces: nil,
      installLock: InstalledLock().install
    )

    wiring.start()
    live.start()
    try await eventually("the first bridge") {
      await MainActor.run { live.session.map { wiring.meta?.follows($0) == true } ?? false }
    }
    let first = try #require(live.session)
    #expect(wiring.meta?.gatewayID == fixture.first)

    // New credentials for the same gateway: a new session, and the old bridge must not stay on it.
    fixture.accounts.credentialsChanged(fixture.first)
    try await eventually("the rebuilt bridge") {
      await MainActor.run {
        guard let next = live.session, next !== first else {
          return false
        }

        return wiring.meta?.follows(next) == true
      }
    }

    await live.shutdown()
  }

  @Test("push's seams answer only for the live gateway's session")
  func pushSeamsAreTheLiveSession() async throws {
    let fixture = try await Fixture()
    let live = LiveGateway(launch: fixture.launch, accounts: fixture.accounts)
    let wiring = LiveWiring(
      launch: fixture.launch,
      accounts: fixture.accounts,
      live: live,
      surfaces: nil,
      installLock: InstalledLock().install
    )

    wiring.start()
    live.start()
    try await eventually("the session") { await MainActor.run { live.phase == .live } }

    let push = fixture.launch.push
    let elsewhere = PushApprovalAnswer(gatewayId: fixture.second, bot: "ops", sessionId: "s", requestId: "r", choice: "once")

    await #expect(throws: PushSessionUnavailable.self) {
      try await push.respond(elsewhere)
    }
    await #expect(throws: PushSessionUnavailable.self) {
      _ = try await push.pendingApprovals(PushApprovalScope(gatewayId: fixture.second, bot: "ops", sessionId: ""))
    }
    #expect(push.canonicalSessionIds(fixture.second, "ops").isEmpty)

    await live.shutdown()
  }

  @Test("a security notice opens the account of the gateway it names; without one, the chat list")
  func securityRoute() async throws {
    let rig = try PushControllerTests.Rig()
    var opened: [PushRoute] = []

    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    await rig.controller.setGateways([PushGateways.one, PushGateways.two])

    let security = ["bot": "ops", "type": "security", "change": "added"]

    await rig.controller.handleResponse(
      actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier",
      payload: PushControllerTests.payload(security.merging(["gatewayKey": PushGateways.two.key]) { $1 })
    )
    await rig.controller.handleResponse(
      actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier",
      payload: PushControllerTests.payload(security)
    )

    #expect(opened == [.security(gatewayId: PushGateways.two.id), .chatList])
  }
}

/// What the app writes for the widgets, the share sheet and Spotlight, and what it sends itself.
@MainActor
@Suite("System surfaces")
struct SystemSurfacesTests {
  static func row(_ name: String, display: String = "", at: Double, canonical: String? = nil, preview: String = "")
    -> ChatListRow
  {
    ChatListRow(
      bot: Bot(
        name: name,
        displayName: display.isEmpty ? nil : display,
        canonical: canonical.map { CanonicalSession(id: $0, resolvedID: $0) }
      ),
      preview: preview.isEmpty ? nil : ChatPreview(text: preview, system: false),
      unreadCount: 2,
      needsInput: name == "ops",
      lastMessageAt: at
    )
  }

  static let rows = [
    row("ops", display: "Ops Desk", at: 20, canonical: "s-ops", preview: "Deployed."),
    row("scout", at: 10)
  ]

  @Test("the widget snapshot names the gateway and draws every row, most recent first")
  func snapshot() throws {
    let snapshot = SystemSurfaces.snapshot(
      rows: Self.rows,
      gatewayKey: "1111111111111111",
      gatewayReady: true,
      now: Date(timeIntervalSince1970: 1_790_000_000)
    )

    #expect(snapshot.gatewayKey == "1111111111111111")
    #expect(snapshot.generatedAt == 1_790_000_000_000)
    #expect(snapshot.bots.map(\.name) == ["ops", "scout"])
    #expect(snapshot.bots[0].initials == "OD")
    #expect(snapshot.bots[0].lastLine == "Deployed.")
    #expect(snapshot.bots[0].needsInput)
    #expect(snapshot.bots[0].presence == "needsInput")
    #expect(snapshot.bots[1].presence == "offline", "no canonical chat and not attached")
    #expect(SystemSurfaces.snapshot(rows: [], gatewayKey: "not a key", gatewayReady: true, now: Date()).gatewayKey == nil)
  }

  @Test("the share targets name each bot's durable session and nothing for a bot without one")
  func targets() {
    let copy = ShareTargets.Copy(sent: "Sent to {bot}", queued: "Later", sending: "Sending")
    let targets = SystemSurfaces.targets(rows: Self.rows, gatewayKey: "1111111111111111", copy: copy, now: Date())

    #expect(targets.targets == [ShareTargets.Target(bot: "ops", session: "s-ops")])
    #expect(targets.copy == copy)
    #expect(targets.gatewayKey == "1111111111111111")
  }

  @Test("publishing writes the snapshot without previews while asked to, and purging takes it away")
  func publishAndPurge() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-surfaces-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let container = AppGroupContainer(url: directory)
    let surfaces = SystemSurfaces(container: container, copy: Self.copy, isLocked: { false })
    let session = GatewaySession(gatewayID: "g1", link: ScriptedLink())

    surfaces.publish(session: session, gatewayKey: "1111111111111111", hidePreviews: true)

    let written = try #require(WidgetSnapshot.decodeUsable(try Data(contentsOf: container.widgetSnapshotURL)))
    #expect(written.gatewayKey == "1111111111111111")

    surfaces.purge(gatewayKey: "1111111111111111")
    #expect(!FileManager.default.fileExists(atPath: container.widgetSnapshotURL.path))
  }

  @Test("a share the app cannot send alone stays queued: files, a claim, no bot, or no socket")
  func sharesItKeeps() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("hermie-surfaces-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }

    let surfaces = SystemSurfaces(container: AppGroupContainer(url: directory), copy: Self.copy, isLocked: { false })
    let session = GatewaySession(gatewayID: "g1", link: ScriptedLink())
    let words = PendingShare.Item.words(kind: .text, text: "hello")
    let file = PendingShare.Item.file(
      kind: .file, url: directory.appendingPathComponent("a.txt"), filename: "a.txt", size: 1, mimeType: "text/plain")

    let shares = [
      PendingShare(id: "a", bot: "ops", note: "", createdAt: 0, items: [file], claim: nil),
      PendingShare(id: "b", bot: "ops", note: "", createdAt: 0, items: [words], claim: ShareClaim(bot: "ops", at: 1)),
      PendingShare(id: "c", bot: nil, note: "", createdAt: 0, items: [words], claim: nil),
      PendingShare(id: "d", bot: "ops", note: "", createdAt: 0, items: [words], claim: nil)
    ]

    for share in shares {
      #expect(await surfaces.deliver(share, session: session) == .keep, "\(share.id)")
    }
  }

  static let copy = SurfaceCopy(
    shareTargets: ShareTargets.Copy(sent: "Sent to {bot}", queued: "Later", sending: "Sending"),
    intentFailures: IntentQueueFailures(unreadable: "u", expired: "e", gatewayGone: "g"),
    stillWorking: { "\($0) is still working" },
    botNotHere: { "\($0) is not here" },
    notSent: { "not sent: \($0)" }
  )
}
