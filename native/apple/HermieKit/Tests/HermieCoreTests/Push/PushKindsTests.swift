import Foundation
import HermieProtocol
import HermieShared
import Testing

@testable import HermieCore

/// What each kind of notification is, as the contract says: request methods and their actions, the
/// security notice, a background completion, a clearing push, and what a tap on each opens.
@Suite("Push kinds")
struct PushKindsTests {
  static let gatewayKey = "bf796761db84e312"
  static let approvalEvent = "request:e73f568f3575f6b525d031267d258a0b"
  static let clarifyEvent = "clarify:7bd013f2a727a9ba545683ba5fd3d80f"

  /// A relay payload of `type: request` for `scout`, with `extra` on top.
  static func request(_ method: String, _ extra: [String: JSONValue] = [:], without: [String] = []) -> PushPayload {
    var data: JSONObject = [
      "v": 1, "type": "request", "bot": "scout", "gatewayKey": .string(gatewayKey), "method": .string(method),
      "sessionId": "8a1b2c3d", "sessionKey": "20261003_101500_a1b2c3", "sessionKind": "canonical",
      "requestId": "srq-0123456789ab"
    ]

    for (key, value) in extra {
      data[key] = value
    }

    for key in without {
      data[key] = nil
    }

    return PushPayload(shape: .relay, data: data)
  }

  // MARK: Methods

  @Test("only an approval is posted under the category; every other method never gets Allow or Deny", arguments: PushRequestMethod.allCases)
  func categoryOnlyForApprovals(method: PushRequestMethod) {
    let payload = Self.request(method.rawValue)

    #expect(payload.requestMethod == method)
    #expect(payload.wantsActions == (method == .approval))
    #expect(payload.categoryIdentifier == (method == .approval ? "hermie.request" : nil))
    #expect(method.offersActions == (method == .approval))

    // Even a tap that says Allow or Deny (a sender that put the category on it anyway, a forged
    // payload) is a plain open for every method but an approval.
    for action in ["hermie.request.allow", "hermie.request.deny", "allow", "deny"] {
      let tap = PushTap(actionIdentifier: action, payload: payload)
      #expect(tap?.action == (method == .approval ? (action.hasSuffix("allow") ? .allow : .deny) : .open))
    }
  }

  @Test("an approval that carries no request id is posted without the category, and a tap on it only opens")
  func approvalWithoutRequestId() {
    let bare = Self.request("approval", without: ["requestId"])

    #expect(!bare.wantsActions)
    #expect(bare.categoryIdentifier == nil)
    #expect(PushTap(actionIdentifier: "hermie.request.allow", payload: bare)?.action == .open)
    #expect(Self.request("approval").wantsActions)
  }

  @Test("a request that names no method, an unknown method or a vault method this build does not know has no actions")
  func unknownMethods() {
    for method in ["", "future.thing", "vault.something_new"] {
      let data: JSONObject = ["type": "request", "bot": "scout", "requestId": "r-1", "method": .string(method)]
      let payload = PushPayload(shape: .relay, data: data)

      #expect(!payload.wantsActions, "\(method)")
      #expect(payload.categoryIdentifier == nil)
      #expect(payload.requestMethod == nil)
    }

    #expect(PushRequestMethod.isRequestKind("vault.something_new"))
    #expect(!PushRequestMethod.isRequestKind("future.thing"))
    #expect(PushRequestMethod.vaultCode.isSecureInput)
    #expect(!PushRequestMethod.confirm.isSecureInput)
  }

  @Test("an Allow on a method the payload does not name at all is still the approval older senders meant")
  func legacyApproval() throws {
    let payload = PushPayload(shape: .relay, data: ["type": "request", "bot": "ops", "request": "r-7"])
    #expect(PushTap(actionIdentifier: "allow", payload: payload)?.action == .allow)
  }

  @Test("a defensive resolve: a tap built by hand as Allow on a confirm answers nothing even when a request matches")
  func resolveRefusesNonApprovals() {
    let tap = PushTap(bot: "ops", requestId: "r-1", action: .allow, method: "confirm")
    let open = PushOpenApproval(bot: "ops", sessionId: "s", requestId: "r-1", choices: ["once", "deny"])

    #expect(PushTapRules.resolve(tap, pending: [open]) == .openChat(bot: "ops"))
  }

  // MARK: Matching approvals

  @Test("an approval with no runtime session id is matched by request id and bot; with one, by that runtime id")
  func approvalMatching() throws {
    let open = PushOpenApproval(bot: "scout", sessionId: "8a1b2c3d", requestId: "appr-1", choices: ["once", "deny"])
    let answer = PushIntent.respond(bot: "scout", sessionId: "8a1b2c3d", requestId: "appr-1", choice: "once")

    // The contract's `approval` example: no `sessionId`, only the stored `sessionKey`.
    let without = PushPayload(
      shape: .relay,
      data: [
        "type": "request", "bot": "scout", "method": "approval", "requestId": "appr-1", "sessionKey": "20261003_101500_a1b2c3",
        "sessionKind": "canonical", "gatewayKey": .string(Self.gatewayKey)
      ])
    let tap = try #require(PushTap(actionIdentifier: "hermie.request.allow", payload: without))

    #expect(tap.sessionId == "")
    #expect(PushTapRules.resolve(tap, pending: [open]) == answer)
    // Another bot's request with the same id, or another request id, is not it.
    #expect(
      PushTapRules.resolve(tap, pending: [PushOpenApproval(bot: "other", sessionId: "x", requestId: "appr-1", choices: ["once"])])
        == .openChat(bot: "scout"))
    #expect(
      PushTapRules.resolve(tap, pending: [PushOpenApproval(bot: "scout", sessionId: "x", requestId: "appr-2", choices: ["once"])])
        == .openChat(bot: "scout"))

    // The `approval_runtime_session` example: `sessionId` is the runtime id the gateway names.
    var withRuntime = without.data
    withRuntime["sessionId"] = "8a1b2c3d"
    let runtimeTap = try #require(
      PushTap(actionIdentifier: "hermie.request.allow", payload: PushPayload(shape: .relay, data: withRuntime)))

    #expect(runtimeTap.sessionId == "8a1b2c3d")
    #expect(PushTapRules.resolve(runtimeTap, pending: [open]) == answer)

    // A runtime id that is not the open request's session answers nothing, and the stored key is
    // never compared with it.
    var stored = without.data
    stored["sessionId"] = "20261003_101500_a1b2c3"
    let storedTap = try #require(
      PushTap(actionIdentifier: "hermie.request.allow", payload: PushPayload(shape: .relay, data: stored)))
    #expect(PushTapRules.resolve(storedTap, pending: [open]) == .openChat(bot: "scout"))
  }

  // MARK: Conversations

  @Test("a request opens its conversation by the stored sessionKey; its runtime sessionId names no conversation")
  func conversationBySessionKey() throws {
    let branch = Self.request("approval", ["sessionKind": "branch", "sessionKey": "key-branch", "sessionId": "runtime-1"])
    let tap = try #require(PushTap(actionIdentifier: "", payload: branch))

    #expect(tap.sessionId == "runtime-1")
    #expect(tap.sessionKey == "key-branch")
    #expect(tap.conversationId == "key-branch")
    #expect(PushTapRules.destination(tap, canonicalIds: []) == .conversation(sessionId: "key-branch"))

    // No key (the sender did not know the conversation): the chat, whatever the runtime id says.
    let unkeyed = Self.request("approval", ["sessionKind": "branch", "sessionId": "runtime-1"], without: ["sessionKey"])
    let bare = try #require(PushTap(actionIdentifier: "", payload: unkeyed))
    #expect(PushTapRules.destination(bare, canonicalIds: []) == .chat)

    // A message keeps reading the stored `sessionId`.
    let message = PushPayload(shape: .relay, data: ["type": "message", "bot": "scout", "sessionId": "stored-1", "sessionKind": "branch"])
    let messageTap = try #require(PushTap(actionIdentifier: "", payload: message))
    #expect(PushTapRules.destination(messageTap, canonicalIds: []) == .conversation(sessionId: "stored-1"))

    // A kind-less request is told from the bot's own chat by the roster's ids, on the key.
    let unknownKind = try #require(
      PushTap(actionIdentifier: "", payload: Self.request("approval", ["sessionKind": "", "sessionKey": "key-9"])))
    #expect(PushTapRules.destination(unknownKind, canonicalIds: ["key-9"]) == .chat)
    #expect(PushTapRules.destination(unknownKind, canonicalIds: ["other"]) == .conversation(sessionId: "key-9"))
  }

  @Test("a confirmation, a secure input or a clarify opens the request in the app, with everything it said")
  func opensRequest() throws {
    let passkey = Self.request("confirm", ["level": "passkey", "sessionKind": "branch", "sessionKey": "key-b"])
    let tap = try #require(PushTap(actionIdentifier: "", payload: passkey))
    let request = try #require(PushTapRules.openRequest(tap, canonicalIds: []))

    #expect(
      request
        == PushOpenRequest(
          bot: "scout", gatewayKey: Self.gatewayKey, method: "confirm", requestId: "srq-0123456789ab", sessionId: "8a1b2c3d",
          sessionKey: "key-b", level: .passkey, destination: .conversation(sessionId: "key-b")))
    #expect(request.requestMethod == .confirm)
    #expect(request.needsDeviceAuthentication)

    let plain = try #require(PushTap(actionIdentifier: "", payload: Self.request("confirm", ["level": "plain"])))
    #expect(try #require(PushTapRules.openRequest(plain, canonicalIds: [])).needsDeviceAuthentication == false)

    for method in PushRequestMethod.allCases where method != .approval {
      let tap = try #require(PushTap(actionIdentifier: "", payload: Self.request(method.rawValue)))
      #expect(PushTapRules.openRequest(tap, canonicalIds: []) != nil, "\(method)")
    }

    // An approval is answered or opened as a chat; a message and a security notice open no request.
    for payload in [Self.request("approval"), PushPayload(shape: .relay, data: ["type": "message", "bot": "scout"]),
      PushPayload(shape: .relay, data: ["type": "security", "bot": "scout", "change": "added"])]
    {
      let tap = try #require(PushTap(actionIdentifier: "", payload: payload))
      #expect(PushTapRules.openRequest(tap, canonicalIds: []) == nil)
    }
  }

  // MARK: Security, background

  @Test("type security is read, bypasses every filter, and is no switch")
  func security() throws {
    let payload = PushPayload(
      shape: .relay, data: ["type": "security", "bot": "scout", "change": "revoked", "gatewayKey": .string(Self.gatewayKey)])

    #expect(payload.type == "security")
    #expect(payload.bypassesFilters)
    #expect(payload.securityChange == .revoked)
    #expect(payload.switchType == nil)
    #expect(!payload.wantsActions)
    #expect(PushContract.unfilteredTypes == ["security"])
    #expect(!PushContract.types.contains("security"))
    #expect(PushPayload(shape: .relay, data: ["type": "security", "change": "other"]).securityChange == nil)

    // Everything off and muted: a message goes, the security notice stays.
    let off = Dictionary(uniqueKeysWithValues: PushContract.types.map { ($0, false) })
    let message = PushPayload(shape: .relay, data: ["type": "message", "bot": "scout"])

    #expect(PushFilter.allows(payload, wanted: off, muted: true))
    #expect(!PushFilter.allows(message, wanted: off, muted: false))
    #expect(!PushFilter.allows(message, wanted: Dictionary(uniqueKeysWithValues: PushContract.types.map { ($0, true) }), muted: true))
    #expect(PushFilter.allows(message, wanted: ["message": true], muted: false))

    // The switches a registration row writes stay the seven: no key for the security notice.
    #expect(!PushRows.defaultTypes.keys.contains("security"))
    #expect(!PushRows.noTypes().keys.contains("security"))
    #expect(PushRows.effectiveTypes(PushRows.defaultTypes, overrides: ["security": false]).keys.contains("security") == false)
  }

  @Test("a background completion is the turn_done notification, with its event")
  func backgroundComplete() {
    let payload = PushPayload(
      shape: .relay,
      data: [
        "type": "turn_done", "bot": "scout", "event": "background.complete", "sessionId": "20261003_101500_a1b2c3",
        "eventId": "background:588fc71ff8f30734f6e00c82ab7e0a68"
      ])

    #expect(payload.type == "turn_done")
    #expect(payload.event == .backgroundComplete)
    #expect(payload.event?.type == "turn_done")
    #expect(payload.switchType == "turn_done")
    #expect(!payload.bypassesFilters)
    #expect(payload.eventId == "background:588fc71ff8f30734f6e00c82ab7e0a68")
    #expect(PushPayload(shape: .relay, data: ["type": "turn_done", "event": "other"]).event == nil)
    #expect(PushFilter.allows(payload, wanted: ["turn_done": true], muted: false))
    #expect(!PushFilter.allows(payload, wanted: ["turn_done": false], muted: false))
  }

  @Test("an eventId or a replaces that is not '<kind>:' and 32 hex digits is read as none", arguments: [
    "x", "request:", ":e73f568f3575f6b525d031267d258a0b", "request:E73F568F3575F6B525D031267D258A0B",
    "request:e73f568f3575f6b525d031267d258a0", "Request:e73f568f3575f6b525d031267d258a0b",
    "request:e73f568f3575f6b525d031267d258a0bb"
  ])
  func eventIdShape(value: String) {
    let payload = PushPayload(shape: .relay, data: ["type": "request", "eventId": .string(value), "replaces": .string(value)])

    #expect(payload.eventId == "")
    #expect(payload.replaces == "")
    #expect(PushPayload(shape: .relay, data: ["eventId": .string(Self.approvalEvent)]).eventId == Self.approvalEvent)
  }

  // MARK: Clearing

  static func clearing(_ method: String, _ extra: [String: JSONValue] = [:], without: [String] = []) -> PushPayload {
    request(method, ["clear": true, "reason": "answered"].merging(extra) { _, new in new }, without: without)
  }

  static func shown(_ id: String, _ payload: PushPayload) -> PushDeliveredNotification {
    PushDeliveredNotification(identifier: id, payload: payload)
  }

  @Test("a clearing push is a request with clear true: no actions, no presentation, nothing to answer")
  func clearIsSilent() throws {
    let payload = Self.clearing("approval", ["requestId": "appr-1", "replaces": .string(Self.approvalEvent)])

    #expect(payload.isClear)
    #expect(!payload.wantsActions)
    #expect(payload.categoryIdentifier == nil)
    #expect(payload.clearReason == .answered)
    #expect(payload.replaces == Self.approvalEvent)

    // `clear: true` on anything but a request is not a clearing push.
    #expect(!PushPayload(shape: .relay, data: ["type": "message", "bot": "scout", "clear": true]).isClear)
    // Only the boolean true is one.
    #expect(!Self.request("approval", ["clear": "true"]).isClear)
    #expect(!Self.request("approval", ["clear": false]).isClear)

    // Allow on it is an open, never an answer.
    #expect(PushTap(actionIdentifier: "hermie.request.allow", payload: payload)?.action == .open)
  }

  @Test("a clearing push removes the notification with its request id, or the one it replaces, and nothing else")
  func clearMatching() throws {
    let approval = Self.shown("n1", Self.request("approval", ["requestId": "appr-1", "eventId": .string(Self.approvalEvent)]))
    let clarifyBare = Self.shown(
      "n2", Self.request("clarify", ["eventId": .string(Self.clarifyEvent)], without: ["requestId"]))
    let otherBot = Self.shown("n3", Self.request("approval", ["bot": "other", "requestId": "appr-1"]))
    let otherGateway = Self.shown("n4", Self.request("approval", ["requestId": "appr-1", "gatewayKey": "0123456789abcdef"]))
    let message = Self.shown("n5", PushPayload(shape: .relay, data: ["type": "message", "bot": "scout", "requestId": "appr-1"]))
    let otherRequest = Self.shown("n6", Self.request("approval", ["requestId": "appr-2"]))
    let noPayload = PushDeliveredNotification(identifier: "n7", payload: nil)
    let all = [approval, clarifyBare, otherBot, otherGateway, message, otherRequest, noPayload]

    // By request id.
    let byId = try #require(PushClear(payload: Self.clearing("approval", ["requestId": "appr-1"])))
    #expect(PushClearing.identifiers(for: byId, among: all) == ["n1"])

    // By `replaces`, which is the only handle for a clarify seen without a request id.
    let byEvent = try #require(
      PushClear(payload: Self.clearing("clarify", ["replaces": .string(Self.clarifyEvent)], without: ["requestId"])))
    #expect(byEvent.requestId == "")
    #expect(PushClearing.identifiers(for: byEvent, among: all) == ["n2"])

    // By `replaces` when the system's identifier is the collapse id.
    let collapsed = Self.shown(Self.approvalEvent, Self.request("approval", ["requestId": "appr-9"]))
    let byIdentifier = try #require(
      PushClear(payload: Self.clearing("approval", ["replaces": .string(Self.approvalEvent)], without: ["requestId"])))
    #expect(PushClearing.identifiers(for: byIdentifier, among: [collapsed, otherRequest]) == [Self.approvalEvent])

    // A clearing push never withdraws another clearing push, and a method that differs is not it.
    let anotherClear = Self.shown("n8", Self.clearing("approval", ["requestId": "appr-1"]))
    #expect(PushClearing.identifiers(for: byId, among: [anotherClear]).isEmpty)
    let wrongMethod = try #require(PushClear(payload: Self.clearing("secret", ["requestId": "appr-1"])))
    #expect(PushClearing.identifiers(for: wrongMethod, among: [approval]).isEmpty)
  }

  @Test("a clearing push that names nothing to withdraw, or no usable bot, removes nothing")
  func clearNeedsAHandle() async {
    let bare = Self.clearing("approval", without: ["requestId"])

    #expect(PushClear(payload: bare) == nil)
    #expect(PushClear(payload: Self.clearing("approval", ["requestId": "r-1", "bot": "../../x"])) == nil)
    #expect(PushClear(payload: Self.request("approval")) == nil)

    let center = FakeDeliveredNotifications([Self.shown("n1", Self.request("approval"))])
    let removed = await PushClearing.apply(bare, to: center)

    #expect(removed == 0)
    #expect(center.removed.isEmpty)
  }

  @Test("PushClearing.apply removes what the push withdraws and says how many; a notification that is not a clear is nil")
  func applyClear() async {
    let approval = Self.shown("n1", Self.request("approval", ["requestId": "appr-1"]))
    let other = Self.shown("n2", Self.request("approval", ["requestId": "appr-2"]))
    let center = FakeDeliveredNotifications([approval, other])

    #expect(await PushClearing.apply(Self.request("approval", ["requestId": "appr-1"]), to: center) == nil)
    #expect(center.removed.isEmpty)

    #expect(await PushClearing.apply(Self.clearing("approval", ["requestId": "appr-1"]), to: center) == 1)
    #expect(center.removed == ["n1"])
    #expect(center.shown == [other])

    // Already gone: still a clearing push, nothing more to remove.
    #expect(await PushClearing.apply(Self.clearing("approval", ["requestId": "appr-1"]), to: center) == 0)
    #expect(center.removed == ["n1"])
  }

  @Test("the registration row says clears true, and every key it did before")
  func rowClearsKey() {
    #expect(PushRows.clearsKey == "clears")
    #expect(PushRows.requestMethodsKey == "requestMethods")
    // The reference's own port is untouched: the vectors replay it, and the writer adds the key.
    #expect(PushRows.rowFor(["platform": "ios", "types": .object(PushRows.defaultTypes), "preview": false])["clears"] == nil)
    #expect(PushRows.rowFor(["platform": "ios", "types": .object(PushRows.defaultTypes), "preview": false])["requestMethods"] == nil)
  }
}

/// The controller's side of the same kinds: where a tap lands, and what a clearing push does.
@MainActor
@Suite("Push kinds through the controller")
struct PushKindsControllerTests {
  typealias G = PushGateways

  static func request(_ method: String, _ extra: [String: JSONValue] = [:]) -> PushPayload {
    PushKindsTests.request(method, ["gatewayKey": .string(G.one.key)].merging(extra) { _, new in new })
  }

  @Test("a passkey confirmation opens in the app: a request route with the level, and no answer is ever sent")
  func passkeyOpens() async throws {
    let rig = try PushControllerTests.Rig()
    var opened: [PushRoute] = []
    var answers = 0
    var reads = 0

    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    rig.controller.pendingApprovals = { _ in
      reads += 1
      return []
    }
    rig.controller.respond = { _ in answers += 1 }
    await rig.controller.setGateways([G.one])

    let payload = Self.request("confirm", ["level": "passkey"])

    for action in ["", "hermie.request.allow", "hermie.request.deny"] {
      await rig.controller.handleResponse(actionIdentifier: action, payload: payload)
    }

    let expected = PushRoute.request(
      .chat(bot: "scout", gatewayKey: G.one.key),
      PushOpenRequest(
        bot: "scout", gatewayKey: G.one.key, method: "confirm", requestId: "srq-0123456789ab", sessionId: "8a1b2c3d",
        sessionKey: "20261003_101500_a1b2c3", level: .passkey, destination: .chat))

    #expect(opened == [expected, expected, expected])
    #expect(answers == 0)
    #expect(reads == 0)
  }

  @Test("a secure input and a clarify open as requests too, in the conversation the sessionKey names")
  func otherKindsOpen() async throws {
    let rig = try PushControllerTests.Rig()
    var opened: [PushRoute] = []
    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    await rig.controller.setGateways([G.one])

    let secret = Self.request("secret", ["sessionKind": "branch", "sessionKey": "key-b"])
    await rig.controller.handleResponse(actionIdentifier: "", payload: secret)

    guard case .request(let link, let request)? = opened.first else {
      Issue.record("expected a request route, got \(opened)")
      return
    }

    #expect(link == .chat(bot: "scout", gatewayKey: G.one.key))
    #expect(request.method == "secret")
    #expect(request.destination == .conversation(sessionId: "key-b"))
  }

  @Test("an approval for a branch opens that conversation by its stored key, not by the runtime id")
  func approvalConversation() async throws {
    let rig = try PushControllerTests.Rig()
    var opened: [PushRoute] = []
    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    await rig.controller.setGateways([G.one])

    let payload = Self.request("approval", ["sessionKind": "branch", "sessionKey": "key-b", "sessionId": "runtime-1"])
    await rig.controller.handleResponse(actionIdentifier: "", payload: payload)

    #expect(opened == [.conversation(.chat(bot: "scout", gatewayKey: G.one.key), sessionId: "key-b")])
  }

  @Test("an approval Allow answers by request id and bot when the notification has no runtime session id")
  func allowWithoutRuntimeId() async throws {
    let rig = try PushControllerTests.Rig()
    var scopes: [PushApprovalScope] = []
    var answers: [PushApprovalAnswer] = []

    rig.controller.pendingApprovals = { scope in
      scopes.append(scope)
      return [PushOpenApproval(bot: "scout", sessionId: "8a1b2c3d", requestId: "appr-1", choices: ["once", "deny"])]
    }
    rig.controller.respond = { answers.append($0) }
    await rig.controller.setGateways([G.one])

    let payload = PushKindsTests.request(
      "approval", ["gatewayKey": .string(G.one.key), "requestId": "appr-1"], without: ["sessionId"])
    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: payload)

    #expect(scopes == [PushApprovalScope(gatewayId: "g1", bot: "scout", sessionId: "")])
    #expect(answers == [PushApprovalAnswer(gatewayId: "g1", bot: "scout", sessionId: "8a1b2c3d", requestId: "appr-1", choice: "once")])
  }

  @Test("a clearing push removes the delivered notification, opens nothing and is never shown")
  func clearingPush() async throws {
    let rig = try PushControllerTests.Rig()
    let shown = PushDeliveredNotification(
      identifier: "n1", payload: Self.request("approval", ["requestId": "appr-1"]))
    let center = FakeDeliveredNotifications([shown])
    var opened: [PushRoute] = []

    rig.controller.deliveredNotifications = center
    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }

    let clear = Self.request("approval", ["requestId": "appr-1", "clear": true, "reason": "timeout"])

    #expect(rig.controller.presentation(for: clear) == .hidden)
    #expect(rig.controller.presentation(for: Self.request("approval")) == .foreground)
    #expect(await rig.controller.handleDelivery(Self.request("approval")) == nil)
    #expect(center.removed.isEmpty)

    // Even before the gateway list is known: a clear is not a tap to hold.
    await rig.controller.handleResponse(actionIdentifier: "", payload: clear)
    #expect(center.removed == ["n1"])

    await rig.controller.setGateways([G.one])
    #expect(await rig.controller.handleDelivery(clear) == 0)
    #expect(opened.isEmpty)
  }

  @Test("the inbox hands a clearing push to the attached controller")
  func inboxClears() async throws {
    let rig = try PushControllerTests.Rig()
    let center = FakeDeliveredNotifications([
      PushDeliveredNotification(identifier: "n1", payload: Self.request("clarify", ["requestId": "srq-1"]))
    ])
    rig.controller.deliveredNotifications = center

    let inbox = PushInbox()
    #expect(await inbox.handleDelivery(Self.request("clarify", ["requestId": "srq-1", "clear": true])) == nil)

    inbox.attach(rig.controller)
    #expect(await inbox.handleDelivery(Self.request("clarify", ["requestId": "srq-1", "clear": true])) == 1)
    #expect(center.removed == ["n1"])
  }

  /// A plain message of a muted chat; `type: "message"` on this gateway.
  static func message(_ extra: [String: JSONValue] = [:]) -> PushPayload {
    var data: JSONObject = ["v": 1, "type": "message", "bot": "scout", "gatewayKey": .string(G.one.key), "sessionId": "8a1b2c3d"]

    for (key, value) in extra {
      data[key] = value
    }

    return PushPayload(shape: .relay, data: data)
  }

  @Test("a mute silences a muted chat's informational notifications in front, never what needs an answer")
  func mutedChatIsHidden() async throws {
    let rig = try PushControllerTests.Rig()
    var asked: [String] = []

    rig.controller.isMuted = { gatewayId, bot in
      asked.append("\(gatewayId)/\(bot)")
      return gatewayId == G.one.id && bot == "scout"
    }

    // The gateway list is not known yet: nothing names a gateway, nothing is held back.
    #expect(rig.controller.presentation(for: Self.message()) == .foreground)
    #expect(asked.isEmpty)

    await rig.controller.setGateways([G.one, G.two])

    // Everything informational of the muted chat: hidden, a type this build does not know included.
    for type in ["message", "dm", "cron", "cron_done", "cron_failed", "turn_done", "turn_failed", "something-new"] {
      #expect(rig.controller.presentation(for: Self.message(["type": .string(type)])) == .hidden, "\(type)")
    }
    // The explicit list of what a mute never silences.
    #expect(PushContract.alwaysShownTypes == ["request", "security"])
    // Another bot, another gateway: shown.
    #expect(rig.controller.presentation(for: Self.message(["bot": "writer"])) == .foreground)
    #expect(rig.controller.presentation(for: Self.message(["gatewayKey": .string(G.two.key)])) == .foreground)

    // Everything that needs the person, of the muted chat: shown.
    for method in ["approval", "clarify", "secret", "sudo", "confirm"] {
      #expect(rig.controller.presentation(for: Self.request(method, ["level": "passkey"])) == .foreground, "\(method)")
    }

    let security = PushPayload(
      shape: .relay, data: ["type": "security", "bot": "scout", "change": "revoked", "gatewayKey": .string(G.one.key)])
    #expect(rig.controller.presentation(for: security) == .foreground)

    // The rule written once for the device: a mute stops a message, not a request.
    let all = Dictionary(uniqueKeysWithValues: PushContract.types.map { ($0, true) })
    #expect(!PushFilter.allows(Self.message(), wanted: all, muted: true))
    #expect(PushFilter.allows(Self.request("approval"), wanted: all, muted: true))
    #expect(asked.allSatisfy { $0 == "g1/scout" || $0 == "g1/writer" || $0 == "g2/scout" })
  }
}
