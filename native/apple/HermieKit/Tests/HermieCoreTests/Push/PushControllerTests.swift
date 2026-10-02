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

/// Two configured gateways, with their link keys.
enum PushGateways {
  static let one = PushGatewayRef(id: "g1", key: "1111111111111111")
  static let two = PushGatewayRef(id: "g2", key: "2222222222222222")
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
    let settings: KeyValueStore
    let controller: PushController

    init() throws {
      let database = try SQLiteStore(.inMemory)
      let relay = ScriptedRelay()
      self.relay = relay
      settings = KeyValueStore(store: database)
      controller = PushController(
        system: system,
        registrar: PushRegistrar(
          client: relay,
          store: PushRegistrationStore(keyValues: KeyValueStore(store: database), secrets: InMemorySecretStore())
        ),
        settings: settings,
        topic: F.topic,
        environment: .sandbox,
        environmentSource: .fallback
      )
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
    func registered(_ gateways: [PushGatewayRef] = [G.one, G.two]) async throws {
      system.current = .granted
      await controller.setGateways(gateways)
      await controller.start()
      await controller.setEnabled(true)
      controller.didRegister(deviceToken: Self.tokenData())

      let controller = controller
      try await eventually("registered") { await controller.registrations.count == gateways.count }
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

  @Test("an unreadable switch is not 'off': push does not start and revokes nothing")
  func unreadableSwitch() async throws {
    let rig = try Rig()
    try await rig.registered([G.one])

    try await rig.settings.setString("not a boolean", forKey: StoreKeys.pushEnabled)

    // A fresh controller on the same database, as on the next launch.
    let next = PushController(
      system: rig.system,
      registrar: rig.controller.registrar,
      settings: rig.settings,
      topic: F.topic,
      environment: .sandbox,
      environmentSource: .fallback
    )
    let before = rig.relay.calls.count

    await next.setGateways([G.one])
    await next.start()

    #expect(!next.started)
    #expect(next.switchUnreadable)
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

    let address = await rig.controller.address(for: "g1")
    #expect(address?.handle == F.handle(1))
    #expect(address?.sendSecret == F.secret("send", 1))
    #expect(address?.pushRow.transport == "relay")
    #expect(address?.pushRow.sendSecret == F.secret("send", 1))
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
  }

  @Test("permission revoked in the system's settings is noticed on return, and revokes")
  func revokedOutside() async throws {
    let rig = try Rig()
    try await rig.registered([G.one])

    rig.system.current = .denied
    await rig.controller.becameActive()

    #expect(rig.relay.calls.last == .delete(handle: F.handle(1), manageSecret: F.secret("manage", 1)))
  }

  @Test("sign-out retires one gateway now and reports its address gone")
  func retire() async throws {
    let rig = try Rig()
    var changed: [Set<String>] = []
    rig.controller.onAddressesChanged = { changed.append($0) }
    try await rig.registered()

    await rig.controller.retire(gatewayId: "g1")

    #expect(rig.controller.gatewayIds == ["g2"])
    #expect(rig.controller.registrations.keys.sorted() == ["g2"])
    #expect(changed.last == ["g1"])
  }

  @Test("past eight gateways the rest are shown as limited")
  func limited() async throws {
    let rig = try Rig()
    let gateways = (1...9).map { PushGatewayRef(id: "g\($0)", key: String(repeating: "\($0)", count: 16)) }
    try await rig.registered(Array(gateways.prefix(8)))

    await rig.controller.setGateways(gateways)

    #expect(rig.controller.state(for: "g9") == .limited)
    #expect(rig.relay.calls.filter { if case .register = $0 { true } else { false } }.count == 8)
  }

  // MARK: Taps

  static func payload(_ data: [String: String]) -> PushPayload {
    PushPayload(shape: .relay, data: data.mapValues { .string($0) })
  }

  static let approval = payload(["bot": "ops", "type": "request", "requestId": "r-1", "gatewayKey": G.two.key])

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

    #expect(opened == [.chat(.chat(bot: "ops", gatewayKey: G.one.key))])
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

  @Test("Allow answers only a request in the freshly read list of the notification's own gateway")
  func allowAnswers() async throws {
    let rig = try Rig()
    var read: [String] = []
    var answered: [String] = []
    var opened: [PushRoute] = []

    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    rig.controller.pendingApprovals = { gateway in
      read.append(gateway)
      return [PushOpenApproval(requestId: "r-1", choices: ["once", "always", "deny"])]
    }
    rig.controller.respond = { gateway, request, choice in answered.append("\(gateway) \(request) \(choice)") }
    await rig.controller.setGateways([G.one, G.two])

    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval)
    await rig.controller.handleResponse(actionIdentifier: "deny", payload: Self.approval)

    // Gateway two named the request, so gateway two is asked, even though one is listed first.
    #expect(read == ["g2", "g2"])
    #expect(answered == ["g2 r-1 once", "g2 r-1 deny"])
    #expect(opened.isEmpty)
  }

  @Test("a stale request, a request of another gateway, or a failed read: nothing answered, the chat opens")
  func allowRefused() async throws {
    let rig = try Rig()
    var answered = 0
    var opened: [PushRoute] = []
    let chat = PushRoute.chat(.chat(bot: "ops", gatewayKey: G.two.key))

    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    rig.controller.respond = { _, _, _ in answered += 1 }
    await rig.controller.setGateways([G.one, G.two])

    // Stale: answered elsewhere already.
    rig.controller.pendingApprovals = { _ in [] }
    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval)

    // Another gateway's request: open on gateway one, the notification says gateway two.
    rig.controller.pendingApprovals = { gateway in
      gateway == "g1" ? [PushOpenApproval(requestId: "r-1", choices: ["once"])] : []
    }
    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval)

    // The read fails, which is also the default before the session layer is wired.
    rig.controller.pendingApprovals = { _ in throw PushSessionUnavailable() }
    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval)

    #expect(answered == 0)
    #expect(opened == [chat, chat, chat])
  }

  @Test("an answer that fails to send opens the chat")
  func respondFails() async throws {
    let rig = try Rig()
    var opened: [PushRoute] = []

    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    rig.controller.pendingApprovals = { _ in [PushOpenApproval(requestId: "r-1", choices: ["once"])] }
    await rig.controller.setGateways([G.two])

    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: Self.approval)

    #expect(opened == [.chat(.chat(bot: "ops", gatewayKey: G.two.key))])
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
