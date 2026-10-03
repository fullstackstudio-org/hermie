import Foundation
import HermieShared
import HermieStore
import Testing

@testable import HermieCore

/// A notification system a test drives: it counts what was asked of it.
@MainActor
final class FakePushSystem: PushSystem {
  var current: PushPermission = .undetermined
  /// What the dialog answers when it is shown.
  var answer: PushPermission = .granted
  private(set) var asked = 0
  private(set) var registrations = 0
  private(set) var categories: [PushCategoryDescriptor] = []
  private(set) var badges: [Int] = []

  func permission() async -> PushPermission { current }

  func requestPermission() async -> PushPermission {
    asked += 1
    current = answer
    return current
  }

  func registerForRemoteNotifications() { registrations += 1 }
  func setCategories(_ categories: [PushCategoryDescriptor]) { self.categories = categories }
  func setBadgeCount(_ count: Int) async { badges.append(count) }
  func openSettings() {}
}

/// Two configured gateways, with their link keys; the first is the live one.
enum PushGateways {
  static let one = PushGatewayRef(id: "g1", key: "1111111111111111", active: true)
  static let two = PushGatewayRef(id: "g2", key: "2222222222222222")

  /// `n` gateways in registry order, `active` the live one.
  static func many(_ n: Int, active: Int = 1) -> [PushGatewayRef] {
    (1...n).map { PushGatewayRef(id: "g\($0)", key: String(format: "%016x", $0), active: $0 == active) }
  }
}

@MainActor
@Suite("Push controller")
struct PushControllerTests {
  typealias F = PushFixtures
  typealias G = PushGateways

  @MainActor
  struct Rig {
    let system = FakePushSystem()
    let relay: ScriptedRelay
    let database: SQLiteStore
    let secrets: InMemorySecretStore
    let settings: KeyValueStore
    let controller: PushController

    init(heldTapTimeout: Duration = .seconds(10)) throws {
      database = try SQLiteStore(.inMemory)
      secrets = InMemorySecretStore()
      relay = ScriptedRelay()
      settings = KeyValueStore(store: database)
      controller = Self.controller(database, secrets, relay, system, heldTapTimeout: heldTapTimeout)
    }

    static func controller(
      _ database: SQLiteStore,
      _ secrets: InMemorySecretStore,
      _ relay: ScriptedRelay,
      _ system: FakePushSystem,
      heldTapTimeout: Duration = .seconds(10)
    ) -> PushController {
      PushController(
        system: system,
        registrar: PushRegistrar(
          client: relay,
          store: PushRegistrationStore(keyValues: KeyValueStore(store: database), secrets: secrets)
        ),
        settings: KeyValueStore(store: database),
        topic: F.topic,
        environment: .sandbox,
        environmentSource: .fallback,
        heldTapTimeout: heldTapTimeout
      )
    }

    /// The next launch: a new controller and registrar over the same database, keychain and relay.
    func relaunch() -> PushController {
      Self.controller(database, secrets, relay, system)
    }

    static func tokenData(_ token: APNsDeviceToken = F.tokenA) -> Data {
      var bytes: [UInt8] = []
      var index = token.hex.startIndex

      while index < token.hex.endIndex {
        let next = token.hex.index(index, offsetBy: 2)
        bytes.append(UInt8(token.hex[index..<next], radix: 16)!)
        index = next
      }

      return Data(bytes)
    }

    /// Started, switched on, permitted and registered for `gateways`.
    func registered(
      _ gateways: [PushGatewayRef] = [G.one, G.two],
      on controller: PushController? = nil,
      expecting: Int? = nil
    ) async throws {
      let controller = controller ?? self.controller
      system.current = .granted
      await controller.setGateways(gateways)
      await controller.start()
      await controller.setEnabled(true)
      controller.didRegister(deviceToken: Self.tokenData())

      let expected = expecting ?? min(gateways.count, PushPlan.maxRegistrations)
      try await eventually("registered") { await controller.registrations.count == expected }
    }

    var registers: Int {
      relay.calls.filter { if case .register = $0 { true } else { false } }.count
    }
  }

  // MARK: Starting

  @Test("start never asks for permission and never registers while the switch is off")
  func startQuiet() async throws {
    let rig = try Rig()
    await rig.controller.setGateways([G.one])
    await rig.controller.start()

    #expect(rig.controller.started)
    #expect(rig.system.asked == 0)
    #expect(rig.system.registrations == 0)
    #expect(rig.system.categories.map(\.identifier) == ["hermie.request", "request", "hermie.approval"])
    #expect(rig.system.badges == [0])
    #expect(rig.controller.state(for: "g1") == .off)
  }

  @Test("start waits for a known gateway list; before it nothing runs")
  func startNeedsGateways() async throws {
    let rig = try Rig()
    await rig.controller.start()
    #expect(!rig.controller.started)

    await rig.controller.becameActive()
    #expect(!rig.controller.started)

    await rig.controller.setGateways([])
    await rig.controller.start()
    #expect(rig.controller.started)
  }

  @Test("setEnabled and didRegister before start do nothing: no question, no pass, no stored switch")
  func beforeStart() async throws {
    let rig = try Rig()

    await rig.controller.setEnabled(true)
    rig.controller.didRegister(deviceToken: Rig.tokenData())
    #expect(await rig.controller.reconcile() == nil)

    #expect(rig.system.asked == 0)
    #expect(rig.relay.calls.isEmpty)
    #expect(!rig.controller.enabled)
    #expect(try await rig.settings.string(forKey: StoreKeys.pushEnabled) == nil)
  }

  @Test("an unreadable switch is not 'off': push does not start, revokes nothing, and says so")
  func unreadableSwitch() async throws {
    let rig = try Rig()
    try await rig.registered([G.one])
    try await rig.settings.setString("not a boolean", forKey: StoreKeys.pushEnabled)

    let next = rig.relaunch()
    let before = rig.relay.calls.count

    await next.setGateways([G.one])
    await next.start()

    #expect(!next.started)
    #expect(next.trouble == .settingsUnreadable)
    #expect(rig.relay.calls.count == before)
  }

  // MARK: The switch

  @Test("turning it on asks once, asks APNs for a token, and the token registers every gateway")
  func enableFlow() async throws {
    let rig = try Rig()
    var changed: [Set<String>] = []
    rig.controller.onAddressesChanged = { changed.append($0) }

    await rig.controller.setGateways([G.one, G.two])
    await rig.controller.start()
    await rig.controller.setEnabled(true)

    #expect(rig.system.asked == 1)
    #expect(rig.system.registrations == 1)
    #expect(rig.controller.state(for: "g1") == .waiting)
    #expect(try await rig.settings.value(Bool.self, forKey: StoreKeys.pushEnabled) == true)

    rig.controller.didRegister(deviceToken: Rig.tokenData())
    let controller = rig.controller
    try await eventually("both registered") { await controller.registrations.count == 2 }

    #expect(rig.relay.calls.count == 2)
    #expect(changed == [["g1", "g2"]])

    let refreshedAt = try #require(rig.controller.registrations["g1"]).refreshedAt
    #expect(rig.controller.state(for: "g1") == .registered(handlePrefix: "h_1111", refreshedAt: refreshedAt))

    guard case .registered(let address) = await rig.controller.addressState(for: "g1") else {
      Issue.record("g1 is not registered")
      return
    }

    #expect(address.handle == F.handle(1))
    #expect(address.sendSecret == F.secret("send", 1))
    #expect(address.pushRow.json["secret"] == .string(F.secret("send", 1)))
    #expect(address.pushRow.json["sendSecret"] == nil)
  }

  @Test("a refusal keeps the switch on, registers nothing, and is not asked again")
  func refused() async throws {
    let rig = try Rig()
    rig.system.answer = .denied

    await rig.controller.setGateways([G.one])
    await rig.controller.start()
    await rig.controller.setEnabled(true)
    await rig.controller.setEnabled(false)
    await rig.controller.setEnabled(true)

    #expect(rig.system.asked == 1)
    #expect(rig.system.registrations == 0)
    #expect(rig.controller.enabled)
    #expect(rig.controller.permission == .denied)
  }

  @Test("turning it off revokes every registration")
  func disable() async throws {
    let rig = try Rig()
    try await rig.registered([G.one])

    await rig.controller.setEnabled(false)

    #expect(rig.relay.calls.last == .delete(handle: F.handle(1), manageSecret: F.secret("manage", 1)))
    #expect(rig.controller.registrations.isEmpty)
    #expect(rig.controller.state(for: "g1") == .off)
    #expect(await rig.controller.addressState(for: "g1") == PushAddressState.none)
  }

  @Test("permission revoked in the system's settings is noticed on return, and revokes")
  func revokedOutside() async throws {
    let rig = try Rig()
    try await rig.registered([G.one])

    rig.system.current = .denied
    await rig.controller.becameActive()

    #expect(rig.relay.calls.last == .delete(handle: F.handle(1), manageSecret: F.secret("manage", 1)))
  }

  // MARK: Sign-out

  @Test("sign-out lasts: retire, a list change, a relaunch, then sign-in again resumes")
  func retireLasts() async throws {
    let rig = try Rig()
    var changed: [Set<String>] = []
    rig.controller.onAddressesChanged = { changed.append($0) }
    try await rig.registered()

    try await rig.controller.retire(gatewayId: "g1")

    #expect(rig.controller.gatewayIds == ["g2"])
    #expect(rig.controller.registrations.keys.sorted() == ["g2"])
    #expect(rig.controller.state(for: "g1") == .signedOut)
    #expect(changed.last == ["g1"])

    // The directory changes (a rename, another gateway added): g1 is still in the list.
    let three = PushGatewayRef(id: "g3", key: "3333333333333333")
    await rig.controller.setGateways([G.one, G.two, three])
    #expect(rig.controller.registrations.keys.sorted() == ["g2", "g3"])

    // The next launch.
    let next = rig.relaunch()
    try await rig.registered([G.one, G.two, three], on: next, expecting: 2)
    #expect(next.registrations.keys.sorted() == ["g2", "g3"])
    #expect(next.retired == ["g1"])

    // Signing in again.
    await next.resume(gatewayId: "g1")
    #expect(next.registrations.keys.sorted() == ["g1", "g2", "g3"])
    #expect(next.retired.isEmpty)
  }

  // MARK: The limit

  @Test("past eight gateways the rest are limited, and switching the live gateway moves no registration")
  func stickyLimit() async throws {
    let rig = try Rig()
    try await rig.registered(G.many(9))

    #expect(rig.controller.state(for: "g9") == .limited)
    #expect(rig.registers == 8)

    let before = rig.relay.calls.count

    for active in [9, 1, 9, 5, 9] {
      // A list ordered with the live gateway first, as a caller might hand it over.
      var gateways = G.many(9, active: active)
      gateways.sort { $0.active && !$1.active }
      await rig.controller.setGateways(gateways)
    }

    #expect(rig.relay.calls.count == before)
    #expect(rig.controller.state(for: "g9") == .limited)
  }

  @Test("removing a registered gateway frees its slot for the next one in registry order")
  func freedSlot() async throws {
    let rig = try Rig()
    try await rig.registered(G.many(9))

    await rig.controller.setGateways(G.many(9).filter { $0.id != "g3" })

    #expect(rig.controller.registrations["g3"] == nil)
    #expect(rig.controller.registrations["g9"] != nil)
  }

  // MARK: Reset

  @Test("a corrupt registration map pauses push and says so; a reset revokes by the keychain and starts over")
  func reset() async throws {
    let rig = try Rig()
    try await rig.registered()
    try await rig.settings.setString("{broken", forKey: StoreKeys.pushRegistrations)

    await rig.controller.reconcile()
    #expect(rig.controller.trouble == .registrationsUnreadable)

    var changed: [Set<String>] = []
    rig.controller.onAddressesChanged = { changed.append($0) }

    await rig.controller.resetDevice()

    let deletes = rig.relay.calls.filter { if case .delete = $0 { true } else { false } }
    #expect(
      Set(deletes)
        == [
          .delete(handle: F.handle(1), manageSecret: F.secret("manage", 1)),
          .delete(handle: F.handle(2), manageSecret: F.secret("manage", 2))
        ]
    )
    #expect(rig.controller.trouble == nil)
    #expect(rig.controller.started)
    #expect(!rig.controller.enabled)
    #expect(rig.controller.resetLeftovers.isEmpty)
    #expect(try await rig.settings.string(forKey: StoreKeys.pushRegistrations) == nil)
    #expect(try rig.secrets.keys(prefix: "hermie.push.").isEmpty)
    #expect(changed.last == ["g1", "g2"])
  }

  // MARK: Taps

  static func payload(_ data: [String: String]) -> PushPayload {
    PushPayload(shape: .relay, data: data.mapValues { .string($0) })
  }

  /// An approval for `ops` on gateway one (the live one).
  static let approval = payload(["bot": "ops", "type": "request", "requestId": "r-1", "gatewayKey": G.one.key])
  static let chat = PushRoute.chat(.chat(bot: "ops", gatewayKey: G.one.key))

  static func open(_ requestId: String = "r-1", bot: String = "ops", session: String = "s-ops") -> PushOpenApproval {
    PushOpenApproval(bot: bot, sessionId: session, requestId: requestId, choices: ["once", "always", "deny"])
  }

  @Test("a tap before the gateway list and before any window is held, then opens the chat")
  func coldStartTap() async throws {
    let rig = try Rig()
    var opened: [PushRoute] = []

    await rig.controller.handleResponse(
      actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier",
      payload: Self.payload(["bot": "ops", "gatewayKey": G.one.key])
    )
    await rig.controller.setGateways([G.one])
    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }

    #expect(opened == [Self.chat])
  }

  @Test("a held tap whose gateway list never comes opens the chat list instead of nothing")
  func heldTapFallsBack() async throws {
    let rig = try Rig(heldTapTimeout: .milliseconds(20))
    let opened = Recorder<PushRoute>()
    rig.controller.attachLinkHandler(UUID()) { opened.items.append($0) }

    await rig.controller.handleResponse(actionIdentifier: "", payload: Self.payload(["bot": "ops", "gatewayKey": G.one.key]))
    #expect(opened.items.isEmpty)

    try await eventually("the fallback") { await opened.items == [.chatList] }
  }

  @Test("no usable gateway key or bot: the chat list, never a chat on whichever gateway is live", arguments: [
    ["bot": "ops"],
    ["bot": "ops", "gatewayKey": "9999999999999999"],
    ["bot": "ops", "gatewayKey": "not a key"],
    ["bot": "../../x", "gatewayKey": PushGateways.one.key],
    ["bot": "a\u{0}b", "gatewayKey": PushGateways.one.key],
    ["bot": String(repeating: "b", count: 3_000), "gatewayKey": PushGateways.one.key],
    ["type": "message", "gatewayKey": PushGateways.one.key]
  ])
  func chatList(data: [String: String]) async throws {
    let rig = try Rig()
    var opened: [PushRoute] = []
    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    await rig.controller.setGateways([G.one])

    for action in ["", "hermie.request.allow"] {
      await rig.controller.handleResponse(actionIdentifier: action, payload: Self.payload(data))
    }

    #expect(opened == [.chatList, .chatList])
  }

  @Test("Allow reads that bot's session, answers with its session id, and then opens the chat")
  func allowAnswers() async throws {
    let rig = try Rig()
    var scopes: [PushApprovalScope] = []
    var answers: [PushApprovalAnswer] = []
    var opened: [PushRoute] = []

    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    rig.controller.pendingApprovals = { scope in
      scopes.append(scope)
      return [Self.open()]
    }
    rig.controller.respond = { answers.append($0) }
    await rig.controller.setGateways([G.one, G.two])

    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval)
    await rig.controller.handleResponse(actionIdentifier: "deny", payload: Self.approval)

    #expect(scopes == [PushApprovalScope(gatewayId: "g1", bot: "ops", sessionId: "")].repeated(2))
    #expect(
      answers
        == [
          PushApprovalAnswer(gatewayId: "g1", bot: "ops", sessionId: "s-ops", requestId: "r-1", choice: "once"),
          PushApprovalAnswer(gatewayId: "g1", bot: "ops", sessionId: "s-ops", requestId: "r-1", choice: "deny")
        ]
    )
    #expect(opened == [Self.chat, Self.chat])
  }

  @Test("an action opens the chat first and answers after, so a cold start is not a blank wait")
  func opensBeforeAnswering() async throws {
    let rig = try Rig()
    var steps: [String] = []

    rig.controller.attachLinkHandler(UUID()) { _ in steps.append("open") }
    rig.controller.pendingApprovals = { _ in
      steps.append("read")
      return [Self.open()]
    }
    rig.controller.respond = { _ in steps.append("answer") }
    await rig.controller.setGateways([G.one])

    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval)

    #expect(steps == ["open", "read", "answer"])
  }

  @Test("a notification naming another bot with that bot's request id answers nothing")
  func borrowedRequestId() async throws {
    let rig = try Rig()
    var answered = 0
    var opened: [PushRoute] = []

    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    // `ops` has the dangerous request open; the notification claims it is `researcher`'s.
    rig.controller.pendingApprovals = { scope in
      [Self.open("appr-a2fedc71", bot: "ops")].filter { _ in scope.bot == "ops" || scope.bot == "researcher" }
    }
    rig.controller.respond = { _ in answered += 1 }
    await rig.controller.setGateways([G.one])

    let forged = Self.payload(["bot": "researcher", "type": "request", "requestId": "appr-a2fedc71", "gatewayKey": G.one.key])
    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: forged)

    #expect(answered == 0)
    #expect(opened == [.chat(.chat(bot: "researcher", gatewayKey: G.one.key))])
  }

  @Test("only open, never answered: a gateway that is not live, a branch, another conversation", arguments: [
    ["bot": "ops", "type": "request", "requestId": "r-1", "gatewayKey": PushGateways.two.key],
    ["bot": "ops", "type": "request", "requestId": "r-1", "gatewayKey": PushGateways.one.key, "sessionId": "s-b",
     "sessionKind": "branch"],
    ["bot": "ops", "type": "request", "requestId": "r-1", "gatewayKey": PushGateways.one.key, "sessionId": "s-o",
     "sessionKind": "other"]
  ])
  func onlyOpen(data: [String: String]) async throws {
    let rig = try Rig()
    var read = 0
    var answered = 0
    var opened: [PushRoute] = []

    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    rig.controller.pendingApprovals = { _ in
      read += 1
      return [Self.open(session: data["sessionId"] ?? "s-ops")]
    }
    rig.controller.respond = { _ in answered += 1 }
    await rig.controller.setGateways([G.one, G.two])

    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.payload(data))

    #expect(read == 0)
    #expect(answered == 0)
    #expect(opened.count == 1)
  }

  @Test("a stale request, a failed read or a failed answer: nothing (more) sent, the chat opens")
  func allowRefused() async throws {
    let rig = try Rig()
    var answered = 0
    var opened: [PushRoute] = []

    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    rig.controller.respond = { _ in answered += 1 }
    await rig.controller.setGateways([G.one])

    rig.controller.pendingApprovals = { _ in [] }
    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval)

    rig.controller.pendingApprovals = { _ in throw PushSessionUnavailable() }
    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval)

    rig.controller.pendingApprovals = { _ in [Self.open()] }
    rig.controller.respond = { _ in throw PushSessionUnavailable() }
    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval)

    #expect(answered == 0)
    #expect(opened == [Self.chat, Self.chat, Self.chat])
  }

  @Test("the same Allow delivered twice while the first is in flight sends one answer")
  func oneAnswerPerRequest() async throws {
    let rig = try Rig()
    var answers = 0
    let gate = Recorder<CheckedContinuation<Void, Never>>()

    rig.controller.attachLinkHandler(UUID()) { _ in }
    rig.controller.pendingApprovals = { _ in
      await withCheckedContinuation { gate.items.append($0) }
      return [Self.open()]
    }
    rig.controller.respond = { _ in answers += 1 }
    await rig.controller.setGateways([G.one])

    let controller = rig.controller
    let first = Task { await controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval) }
    try await eventually("the first read") { await !gate.items.isEmpty }

    await controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval)
    gate.items.first?.resume()
    await first.value

    #expect(answers == 1)
  }

  @Test("a tap about a branch or another conversation opens that conversation, not the bot's chat")
  func conversationRoute() async throws {
    let rig = try Rig()
    let opened = Recorder<PushRoute>()
    var answered = 0

    rig.controller.attachLinkHandler(UUID()) { opened.items.append($0) }
    rig.controller.canonicalSessionIds = { gateway, bot in gateway == "g1" && bot == "ops" ? ["s-main", "s-main-resolved"] : [] }
    rig.controller.pendingApprovals = { _ in [Self.open(session: "rt-b")] }
    rig.controller.respond = { _ in answered += 1 }
    await rig.controller.setGateways([G.one])

    let link = DeepLink.chat(bot: "ops", gatewayKey: G.one.key)

    await rig.controller.handleResponse(
      actionIdentifier: "", payload: Self.payload(["bot": "ops", "gatewayKey": G.one.key, "sessionId": "s-b", "sessionKind": "branch"]))
    // No kind, an id that is not the bot's chat: that conversation.
    await rig.controller.handleResponse(
      actionIdentifier: "", payload: Self.payload(["bot": "ops", "gatewayKey": G.one.key, "sessionId": "s-old"]))
    // No kind, the chat's own id under its other name: the chat.
    await rig.controller.handleResponse(
      actionIdentifier: "", payload: Self.payload(["bot": "ops", "gatewayKey": G.one.key, "sessionId": "s-main-resolved"]))
    // An Allow about a conversation opens it and answers nothing. A request names the conversation
    // by its stored `sessionKey`; its `sessionId` is the runtime id the request methods use.
    await rig.controller.handleResponse(
      actionIdentifier: "hermie.request.allow",
      payload: Self.payload([
        "bot": "ops", "type": "request", "method": "approval", "requestId": "r-1", "gatewayKey": G.one.key,
        "sessionId": "rt-b", "sessionKey": "s-b"
      ]))

    #expect(
      opened.items
        == [
          .conversation(link, sessionId: "s-b"), .conversation(link, sessionId: "s-old"), .chat(link),
          .conversation(link, sessionId: "s-b")
        ]
    )
    #expect(answered == 0)
  }

  // MARK: Windows

  @Test("taps go to the window most recently in front; a closed window is let go, then taps wait")
  func severalWindows() async throws {
    let rig = try Rig()
    var first: [PushRoute] = []
    var second: [PushRoute] = []
    let a = UUID()
    let b = UUID()
    let tap = Self.payload(["bot": "ops", "gatewayKey": G.one.key])

    await rig.controller.setGateways([G.one])
    rig.controller.attachLinkHandler(a) { first.append($0) }
    rig.controller.attachLinkHandler(b) { second.append($0) }

    await rig.controller.handleResponse(actionIdentifier: "", payload: tap)
    #expect((first.count, second.count) == (0, 1))

    rig.controller.activateLinkHandler(a)
    await rig.controller.handleResponse(actionIdentifier: "", payload: tap)
    #expect((first.count, second.count) == (1, 1))

    rig.controller.detachLinkHandler(a)
    await rig.controller.handleResponse(actionIdentifier: "", payload: tap)
    #expect((first.count, second.count) == (1, 2))

    rig.controller.detachLinkHandler(b)
    await rig.controller.handleResponse(actionIdentifier: "", payload: tap)
    #expect((first.count, second.count) == (1, 2))

    var third: [PushRoute] = []
    rig.controller.attachLinkHandler(UUID()) { third.append($0) }
    #expect(third.count == 1)
  }

  // MARK: Presentation

  @Test("a notification in front is shown without a sound and without the badge")
  func presentation() throws {
    let rig = try Rig()
    #expect(rig.controller.presentation(for: nil) == PushPresentation(banner: true, list: true, sound: false, badge: false))
  }

  @Test("the system's failure text is kept short and on one line")
  func tokenFailure() throws {
    let rig = try Rig()
    rig.controller.didFailToRegister(message: "no valid aps-environment\nentitlement" + String(repeating: "!", count: 400))

    #expect(rig.controller.tokenFailure?.count == 200)
    #expect(rig.controller.tokenFailure?.contains("\n") == false)
  }
}

/// A main-actor list a test and a closure both reach.
@MainActor
final class Recorder<Item> {
  var items: [Item] = []
}

extension Array {
  fileprivate func repeated(_ times: Int) -> [Element] {
    (0..<times).flatMap { _ in self }
  }
}
