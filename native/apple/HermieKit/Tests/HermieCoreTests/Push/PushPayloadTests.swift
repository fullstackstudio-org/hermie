import Foundation
import HermieProtocol
import HermieShared
import Testing

@testable import HermieCore

/// Reading a notification: the relay's shape (`hermie`) and Expo's (`body`), built from the
/// contract's own field list, then what a tap on it means.
@Suite("Push payload")
struct PushPayloadTests {
  /// Every data key the contract lists, read from the contract itself.
  static func contractKeys() throws -> Set<String> {
    guard case .object(let contract) = try ContractFiles.json("push/contract.json"),
      case .object(let data)? = contract["data"], case .array(let fields)? = data["fields"]
    else {
      throw TimedOut(what: "the contract's data fields")
    }

    return Set(
      fields.compactMap { field -> String? in
        if case .object(let object) = field, case .string(let key)? = object["key"] { key } else { nil }
      })
  }

  static let eventId = "request:" + String(repeating: "0", count: 31) + "1"

  static let gatewayKey = "0123456789abcdef"

  /// One value per contract field, typed as the contract says, for an approval.
  static func contractData() throws -> [String: Any] {
    guard case .object(let contract) = try ContractFiles.json("push/contract.json"),
      case .object(let data)? = contract["data"], case .array(let fields)? = data["fields"]
    else {
      throw TimedOut(what: "the contract's data fields")
    }

    var bag: [String: Any] = [:]

    for case .object(let field) in fields {
      guard case .string(let key)? = field["key"], case .string(let type)? = field["type"] else {
        continue
      }

      switch (key, type) {
      case ("bot", _): bag[key] = "researcher"
      case ("type", _): bag[key] = "request"
      case ("sessionId", _): bag[key] = "sess-1"
      case ("session", _): bag[key] = "sess-legacy"
      case ("sessionKind", _): bag[key] = "branch"
      case ("requestId", _): bag[key] = "req-1"
      case ("method", _): bag[key] = "approval"
      case ("gatewayKey", _): bag[key] = gatewayKey
      case ("sessionKey", _): bag[key] = "20261003_101500_a1b2c3"
      case ("level", _): bag[key] = "passkey"
      case ("reason", _): bag[key] = "answered"
      case ("replaces", _): bag[key] = eventId
      case ("event", _): bag[key] = "background.complete"
      case ("change", _): bag[key] = "added"
      case ("eventId", _): bag[key] = "approval:" + String(repeating: "0", count: 32)
      case (_, "boolean"): bag[key] = true
      case (_, "number"): bag[key] = 1
      default: bag[key] = "x"
      }
    }

    return bag
  }

  static func relayUserInfo(_ data: [String: Any]) -> [AnyHashable: Any] {
    [
      "aps": ["alert": ["title": "Researcher", "body": "needs your input"], "category": "hermie.request"],
      "hermie": data
    ]
  }

  static func expoUserInfo(_ data: Any) -> [AnyHashable: Any] {
    [
      "aps": ["alert": ["title": "Researcher", "body": "needs your input"], "category": "request"],
      "body": data,
      "experienceId": "@someone/hermie",
      "scopeKey": "@someone/hermie"
    ]
  }

  @Test("the relay shape: data under `hermie`, every contract field read or carried")
  func relayShape() throws {
    let payload = try #require(PushPayload(userInfo: Self.relayUserInfo(try Self.contractData())))

    #expect(payload.shape == .relay)
    #expect(Set(payload.data.keys) == (try Self.contractKeys()))
    #expect(payload.type == "request")
    // Every field at once makes a clearing push (`clear: true`), which never has the actions.
    #expect(payload.isClear)
    #expect(!payload.wantsActions)
    #expect(payload.sessionKey == "20261003_101500_a1b2c3")
    #expect(payload.level == .passkey)
    #expect(payload.clearReason == .answered)
    #expect(payload.replaces == Self.eventId)
    #expect(payload.event == .backgroundComplete)
    #expect(payload.securityChange == .added)
    #expect(payload.requestMethod == .approval)
    #expect(payload.data["cron"] == .bool(true))
    #expect(payload.data["at"] == .number(1))

    // The Allow on it is only an open: this bag is a clearing push, which is never answered.
    let tap = try #require(PushTap(actionIdentifier: "hermie.request.allow", payload: payload))
    #expect(
      tap
        == PushTap(
          bot: "researcher", requestId: "req-1", action: .open, gatewayKey: Self.gatewayKey, sessionId: "sess-1",
          sessionKind: .branch, type: "request", method: "approval", sessionKey: "20261003_101500_a1b2c3",
          level: .passkey, isClear: true)
    )
    #expect(tap.link == .chat(bot: "researcher", gatewayKey: Self.gatewayKey))
  }

  @Test("the Expo shape: data under `body`, as a dictionary or as JSON text")
  func expoShape() throws {
    let data: [String: Any] = ["v": 1, "type": "message", "bot": "writer", "sessionId": "s-9", "at": 1_790_000_000]

    let fromDictionary = try #require(PushPayload(userInfo: Self.expoUserInfo(data)))
    #expect(fromDictionary.shape == .expo)
    #expect(fromDictionary.string("bot") == "writer")
    #expect(!fromDictionary.wantsActions)

    let fromText = try #require(
      PushPayload(userInfo: Self.expoUserInfo(#"{"v":1,"type":"message","bot":"writer","sessionId":"s-9"}"#)))
    #expect(fromText.shape == .expo)
    #expect(PushTap(actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier", payload: fromText)
      == PushTap(bot: "writer", sessionId: "s-9", type: "message"))
  }

  @Test("the relay shape wins when both keys are present")
  func relayWins() throws {
    var info = Self.expoUserInfo(["bot": "expo"])
    info["hermie"] = ["bot": "relay"]

    #expect(PushPayload(userInfo: info)?.string("bot") == "relay")
  }

  @Test("the Expo app's older spellings: `request`, `session`, and the `allow`/`deny` action ids")
  func legacySpellings() throws {
    let payload = try #require(
      PushPayload(userInfo: Self.expoUserInfo(["bot": "ops", "type": "request", "request": "r-7", "session": "s-1"])))

    #expect(
      PushTap(actionIdentifier: "deny", payload: payload)
        == PushTap(bot: "ops", requestId: "r-7", action: .deny, sessionId: "s-1", type: "request")
    )
  }

  @Test("an Allow that names no request is only an open")
  func allowWithoutRequest() throws {
    let payload = try #require(PushPayload(userInfo: Self.relayUserInfo(["bot": "ops", "type": "request"])))
    #expect(PushTap(actionIdentifier: "hermie.request.allow", payload: payload)?.action == .open)
  }

  @Test("an unusable gateway key or session kind is read as none")
  func unusableLookups() throws {
    let payload = try #require(
      PushPayload(
        userInfo: Self.relayUserInfo(["bot": "ops", "gatewayKey": "ZZZZ", "sessionKind": "future", "sessionId": " s "])))
    let tap = try #require(PushTap(actionIdentifier: "", payload: payload))

    #expect(tap.gatewayKey == "")
    #expect(tap.sessionKind == .unknown)
    #expect(tap.sessionId == "s")
    #expect(tap.link == .chat(bot: "ops", gatewayKey: ""))
  }

  @Test("no bot, no tap; neither shape, no payload; nested values are not walked")
  func unusable() throws {
    #expect(PushTap(actionIdentifier: "", payload: try #require(PushPayload(userInfo: Self.relayUserInfo(["bot": "  "])))) == nil)
    #expect(PushPayload(userInfo: ["aps": ["alert": "hi"]]) == nil)
    #expect(PushPayload(userInfo: ["hermie": "not an object"]) == nil)

    let nested = try #require(PushPayload(userInfo: Self.relayUserInfo(["bot": "ops", "deep": ["a": ["b": 1]]])))
    #expect(nested.data == ["bot": "ops"])
  }

  @Test("a bot name is held to the link rule: no slash, no control character, bounded", arguments: [
    "../../x", "a/b", "a\u{0}b", "a\nb", "a\u{200E}b", ".", "..", String(repeating: "b", count: 129)
  ])
  func unsafeBotNames(bot: String) throws {
    let payload = try #require(PushPayload(userInfo: Self.relayUserInfo(["bot": bot])))
    #expect(PushTap(actionIdentifier: "", payload: payload) == nil)
  }

  @Test("an unknown type is read as none, so it never grows actions")
  func unknownType() throws {
    let payload = try #require(PushPayload(userInfo: Self.relayUserInfo(["bot": "ops", "type": "surprise"])))
    #expect(payload.type == "")
    #expect(!payload.wantsActions)
  }

  // MARK: Resolving against the gateway

  static let tap = PushTap(bot: "ops", requestId: "r-1", action: .allow)

  static func approval(
    _ requestId: String = "r-1",
    bot: String = "ops",
    session: String = "s-ops",
    choices: [String] = ["once", "session", "always", "deny"]
  ) -> PushOpenApproval {
    PushOpenApproval(bot: bot, sessionId: session, requestId: requestId, choices: choices)
  }

  @Test("an action answers only a request that is still open, with the narrowest choice offered")
  func resolve() {
    let open = [Self.approval()]

    #expect(
      PushTapRules.resolve(Self.tap, pending: open)
        == .respond(bot: "ops", sessionId: "s-ops", requestId: "r-1", choice: "once"))

    var deny = Self.tap
    deny.action = .deny
    #expect(
      PushTapRules.resolve(deny, pending: open) == .respond(bot: "ops", sessionId: "s-ops", requestId: "r-1", choice: "deny"))

    // Answered elsewhere, or never real.
    #expect(PushTapRules.resolve(Self.tap, pending: []) == .openChat(bot: "ops"))
    #expect(PushTapRules.resolve(Self.tap, pending: [Self.approval("r-2")]) == .openChat(bot: "ops"))

    // Only `session` or `always` offered: never widened.
    #expect(PushTapRules.resolve(Self.tap, pending: [Self.approval(choices: ["session", "always"])]) == .openChat(bot: "ops"))

    var plain = Self.tap
    plain.action = .open
    #expect(PushTapRules.resolve(plain, pending: open) == .openChat(bot: "ops"))
  }

  @Test("a request id borrowed from another bot's session answers nothing")
  func anotherBotsRequest() {
    // The notification says `researcher`; the open request with that id is `ops`'s dangerous one.
    let tap = PushTap(bot: "researcher", requestId: "appr-a2fedc71", action: .allow)
    let pending = [Self.approval("appr-a2fedc71", bot: "ops", session: "s-ops")]

    #expect(PushTapRules.resolve(tap, pending: pending) == .openChat(bot: "researcher"))
  }

  @Test("the session must match when the notification names one; a row with no session never answers")
  func sessionMatch() {
    var tap = Self.tap
    tap.sessionId = "s-other"
    #expect(PushTapRules.resolve(tap, pending: [Self.approval()]) == .openChat(bot: "ops"))

    tap.sessionId = "s-ops"
    tap.sessionKind = .canonical
    #expect(
      PushTapRules.resolve(tap, pending: [Self.approval()])
        == .respond(bot: "ops", sessionId: "s-ops", requestId: "r-1", choice: "once"))

    #expect(PushTapRules.resolve(Self.tap, pending: [Self.approval(session: "")]) == .openChat(bot: "ops"))
  }

  @Test("a branch or another conversation is only opened, never answered", arguments: [
    PushSessionKind.branch, .other
  ])
  func conversationsOnlyOpen(kind: PushSessionKind) {
    var tap = Self.tap
    tap.sessionId = "s-ops"
    tap.sessionKind = kind

    #expect(!PushTapRules.answersInPlace(tap))
    #expect(PushTapRules.resolve(tap, pending: [Self.approval()]) == .openChat(bot: "ops"))
  }

  @Test("where a tap lands: the notifier's kind first, then the canonical ids, else the chat")
  func destination() {
    func tap(_ session: String, _ kind: PushSessionKind) -> PushTap {
      PushTap(bot: "ops", sessionId: session, sessionKind: kind)
    }

    #expect(PushTapRules.destination(tap("s", .canonical), canonicalIds: []) == .chat)
    #expect(PushTapRules.destination(tap("", .branch), canonicalIds: []) == .chat)
    #expect(PushTapRules.destination(tap("s", .branch), canonicalIds: ["s"]) == .conversation(sessionId: "s"))
    #expect(PushTapRules.destination(tap("s", .other), canonicalIds: []) == .conversation(sessionId: "s"))
    #expect(PushTapRules.destination(tap("s", .unknown), canonicalIds: []) == .chat)
    #expect(PushTapRules.destination(tap("s", .unknown), canonicalIds: ["s", "t"]) == .chat)
    #expect(PushTapRules.destination(tap("s", .unknown), canonicalIds: ["t"]) == .conversation(sessionId: "s"))
  }
}
