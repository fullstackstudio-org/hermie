#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// A notification system that grants and does nothing else.
@MainActor
private final class GrantedSystem: PushSystem {
  func permission() async -> PushPermission { .granted }
  func requestPermission() async -> PushPermission { .granted }
  func registerForRemoteNotifications() {}
  func setCategories(_ categories: [PushCategoryDescriptor]) {}
  func setBadgeCount(_ count: Int) async {}
  func openSettings() {}
}

/// Where the wiring's lock goes in a test: never the process-wide `SystemSurfaceLock`.
private final class TestLock: Sendable {
  private let provider = Mutex<(@Sendable () -> Bool)?>(nil)

  func install(_ isLocked: @escaping @Sendable () -> Bool) {
    provider.withLock { $0 = isLocked }
  }

  var isLocked: Bool {
    provider.withLock { $0 }?() ?? true
  }
}

/// The app as the shell builds it, on memory, against one fake gateway signed in with a session
/// token and a loopback relay: launch, accounts, live gateway and live wiring, push switched on
/// with a token.
@MainActor
private final class WiredApp {
  nonisolated static let token = "push-wiring-token"

  let launch: AppLaunch
  let accounts: GatewayAccounts
  let live: LiveGateway
  let wiring: LiveWiring
  let lock = TestLock()
  let gatewayId: String
  let gatewayKey: String

  init(gateway: FakeGateway, relay: String) async throws {
    let push = PushLaunchConfiguration(
      relayOrigin: relay,
      topic: "dev.hermie.app",
      environment: .sandbox,
      environmentSource: .fallback
    )

    launch = AppLaunch(
      environment: .inMemory(dataDirectory: nil, authenticator: ScriptedAuthenticator(), push: push),
      pushSystem: GrantedSystem()
    )
    accounts = GatewayAccounts(launch: launch, services: GatewayServices())
    await launch.start()
    gatewayId = try await launch.sync.addGateway(
      NewGateway(name: "Fake", address: gateway.baseURL, authKind: .sessionToken, sessionToken: Self.token))
    await launch.gateways.load()
    gatewayKey = try #require(launch.gateways.entry(id: gatewayId)?.key)

    live = LiveGateway(launch: launch, accounts: accounts)
    wiring = LiveWiring(launch: launch, accounts: accounts, live: live, surfaces: nil, installLock: lock.install)
    wiring.metaDebounce = .milliseconds(20)
    wiring.start()
    live.start()

    let controller = launch.push
    await controller.setGateways(try #require(launch.gateways.pushGateways))
    await controller.start()
    await controller.setEnabled(true)
    controller.didRegister(deviceToken: Data(repeating: 0xAB, count: 32))
  }

  func shutdown() async {
    await live.shutdown()
  }
}

/// This installation's row in the gateway's own copy of its push section, read over a connection
/// of its own (wherever the notifier reads the rows: the per-person key or the bare one).
private func gatewayRow(_ gateway: FakeGateway, installation: String) async throws -> JSONValue? {
  try await LiveConnection.with(gateway, credentials: SessionTokenCredentials(token: WiredApp.token)) { live in
    await live.connection.start()
    try await live.waitFor(.ready)

    let rows = try await live.connection.request("profiles.list")["profiles"]?.arrayValue ?? []
    let home = rows.first { $0["is_default"] == true }?["ui_meta"]?.objectValue ?? [:]
    let sections = [home[UIMeta.appKey(for: GatewaySession.sessionTokenUser)], home[UIMeta.legacyAppKey]]

    return sections.compactMap { $0?["push"]?["registrations"]?[installation] }.first
  }
}

/// Poll until `condition` holds, generously; a cap turns a hang into a failure.
@MainActor
private func waitFor(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while try !(await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(25))
  }
}

extension Integration {
  /**
   PG-6 end to end: the live wiring against `packages/fake-gateway` and a loopback relay. The
   registration lands as this installation's row on the live gateway (through the session's own
   ui_meta bridge), a sign-out takes the row off and retires the relay registration, and a
   notification action answers an approval only while the gateway still lists it and only when
   the bot and the request id match.
   */
  @Suite("push wiring against the fake gateway", .serialized) @MainActor
  struct PushWiringIntegrationTests {
    nonisolated static let handle = "h_" + String(repeating: "B", count: 22)
    nonisolated static let sendSecret = String(repeating: "t", count: 43)
    nonisolated static let manageSecret = String(repeating: "n", count: 43)

    nonisolated static func relay() throws -> LoopbackListener {
      try LoopbackListener { head in
        if head.hasPrefix("POST /v1/registrations ") {
          return LoopbackListener.reply(
            "201 Created",
            headers: ["Content-Type: application/json"],
            body: #"{"handle":"\#(Self.handle)","sendSecret":"\#(Self.sendSecret)","manageSecret":"\#(Self.manageSecret)"}"#
          )
        }

        return head.hasPrefix("DELETE") ? LoopbackListener.reply("204 No Content") : LoopbackListener.reply("200 OK")
      }
    }

    @Test("sign-in registers and writes the row on that gateway; sign-out withdraws it and retires the registration")
    func registrationRoundTrip() async throws {
      let relay = try Self.relay()
      try await relay.start()
      defer { relay.stop() }

      try await FakeGateway.with(FakeGateway.Options(auth: .token, token: WiredApp.token)) { @Sendable gateway in
        try await Self.roundTrip(gateway, relay: relay)
      }
    }

    private static func roundTrip(_ gateway: FakeGateway, relay: LoopbackListener) async throws {
      let app = try await WiredApp(gateway: gateway, relay: relay.origin)
      let installation = try await PushInstallation.id(in: app.launch.keyValues)

      try await waitFor("the registration") { app.launch.push.registrations[app.gatewayId] != nil }
      try await waitFor("the surfaces to open") { !app.lock.isLocked }
      try await waitFor("the row on the gateway") {
        try await gatewayRow(gateway, installation: installation)?["handle"] == .string(Self.handle)
      }

      let row = try #require(try await gatewayRow(gateway, installation: installation))
      #expect(row["secret"] == .string(Self.sendSecret))
      #expect(row["gatewayKey"] == .string(app.gatewayKey))
      #expect(row["clears"] == .bool(true))
      #expect(row["requestMethods"] == .bool(true))
      #expect(row.canonicalStringOrEmpty.contains(Self.manageSecret) == false)

      await app.accounts.signOut(app.gatewayId)

      #expect(app.launch.push.retired.contains(app.gatewayId))
      #expect(!app.accounts.pushStillRegistered.contains(app.gatewayId))
      #expect(relay.requests.contains { $0.hasPrefix("DELETE ") }, "the relay registration is retired")
      #expect(try await gatewayRow(gateway, installation: installation) == nil, "the row left the gateway")
      try await waitFor("the surfaces to lock again") { app.lock.isLocked }

      await app.shutdown()
    }

    @Test("a notification action answers an approval only while it is open and only when it matches")
    func approvalFromANotification() async throws {
      let relay = try Self.relay()
      try await relay.start()
      defer { relay.stop() }

      try await FakeGateway.with(FakeGateway.Options(auth: .token, token: WiredApp.token)) { @Sendable gateway in
        try await Self.answer(gateway, relay: relay)
      }
    }

    private static func answer(_ gateway: FakeGateway, relay: LoopbackListener) async throws {
      let app = try await WiredApp(gateway: gateway, relay: relay.origin)
      let push = app.launch.push

      try await waitFor("the session") { app.live.session?.status.phase == .ready }
      let session = try #require(app.live.session)
      try await waitFor("the roster") { session.chatList.rows["researcher"] != nil }

      try await gateway.raiseRequest(
        "approval",
        params: ["request_id": "appr-push", "command": "ls", "choices": ["once", "deny"]]
      )

      func listed() async throws -> [String] {
        try await session.pushOpenApprovals(bot: "researcher").map(\.requestId)
      }

      try await waitFor("the approval to be listed") { try await listed().contains("appr-push") }

      func tap(_ action: String, _ data: [String: String]) async {
        var bag = ["type": "request", "method": "approval", "gatewayKey": app.gatewayKey]
        bag.merge(data) { $1 }
        await push.handleResponse(
          actionIdentifier: action,
          payload: PushPayload(shape: .relay, data: bag.mapValues { .string($0) })
        )
      }

      let allow = PushContract.Action.allow.rawValue

      // Another request id, another bot, a plain tap, another method: nothing is answered.
      await tap(allow, ["bot": "researcher", "requestId": "appr-other"])
      await tap(allow, ["bot": "writer", "requestId": "appr-push"])
      await tap("com.apple.UNNotificationDefaultActionIdentifier", ["bot": "researcher", "requestId": "appr-push"])
      await tap(allow, ["bot": "researcher", "requestId": "appr-push", "method": "clarify"])
      #expect(try await listed().contains("appr-push"), "still open after taps that do not match")

      await tap(allow, ["bot": "researcher", "requestId": "appr-push"])
      try await waitFor("the answer") { try await !listed().contains("appr-push") }

      let answered = try await Self.answers(gateway)
      #expect(answered >= 1)

      // The same action again, after the gateway closed the request: nothing more goes out.
      await tap(allow, ["bot": "researcher", "requestId": "appr-push"])
      #expect(try await Self.answers(gateway) == answered)

      await app.shutdown()
    }

    /// Every way an approval was answered on the gateway: on its own reply frame, or by queue id.
    static func answers(_ gateway: FakeGateway) async throws -> Int {
      let state = try await gateway.control("GET", "/__fake/state")
      let frames = state["serverRequestAnswers"]?.arrayValue?.count ?? state["serverRequestAnswers"]?.objectValue?.count ?? 0
      let calls = (state["methodLog"]?.arrayValue ?? []).filter { $0 == "approval.respond" }.count

      return frames + calls
    }
  }
}

extension JSONValue {
  fileprivate var canonicalStringOrEmpty: String {
    (try? canonicalString()) ?? ""
  }
}
#endif
