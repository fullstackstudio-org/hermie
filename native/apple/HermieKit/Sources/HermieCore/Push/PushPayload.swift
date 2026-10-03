import Foundation
import HermieProtocol
import HermieShared

/**
 A notification's data bag, read defensively: it arrived from a push service.

 Two shapes reach this app:

 - **Relay** (`push.hermie.dev`): the relay puts the sender's `data` under the `hermie` key of the
   APNs payload, beside `aps`.
 - **Expo** (the old chain, still used by gateways that do not advertise `push.relay` yet): Expo's
   push service puts it under `body`.

 Either way only ids and kinds are trusted, and only as lookups (ADR-0017): which gateway, which
 bot, which session, which request. Nothing in here is acted on until the gateway has been asked.
 Message text is never needed: a relay payload carries none (D29).
 */
public enum PushPayloadShape: String, Sendable, Equatable {
  case relay
  case expo
}

public struct PushPayload: Sendable, Equatable {
  public var shape: PushPayloadShape
  /// The data bag as it arrived, strings, numbers and booleans only.
  public var data: JSONObject

  public init(shape: PushPayloadShape, data: JSONObject) {
    self.shape = shape
    self.data = data
  }

  /// The APNs key the relay puts the data under.
  public static let relayKey = "hermie"
  /// The APNs key Expo's push service puts the data under.
  public static let expoKey = "body"

  /// Read a notification's `userInfo`. nil when neither shape is there.
  public init?(userInfo: [AnyHashable: Any]) {
    if let bag = userInfo[Self.relayKey], let data = Self.object(bag) {
      self.init(shape: .relay, data: data)
    } else if let bag = userInfo[Self.expoKey], let data = Self.object(bag) {
      self.init(shape: .expo, data: data)
    } else {
      return nil
    }
  }

  /// A string field, trimmed, or `""`.
  public func string(_ key: String) -> String {
    if case .string(let value)? = data[key] {
      return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    return ""
  }

  /// The data keys this reader reads (an accessor below, or the tap's). Together with
  /// `carriedKeys` they are every key `contract/push/contract.json` lists, and a test holds the two
  /// to that file in both directions.
  public static let readKeys: Set<String> = [
    "bot", "type", "sessionId", "sessionKey", "session", "sessionKind", "requestId", "method", "level", "clear",
    "reason", "replaces", "event", "change", "gatewayKey", "eventId"
  ]

  /// The data keys the contract lists that nothing here acts on: they stay in `data` as they came.
  public static let carriedKeys: Set<String> = ["cron", "cronCertain", "jobId", "v", "at"]

  /// The payload's `type`, when it is one the contract names: a switch (`PushContract.types`), an
  /// unfiltered type (`security`) or the legacy `dm`. `""` for anything else.
  public var type: String {
    let type = string("type")
    return PushContract.isKnownType(type) ? type : ""
  }

  /// A `type: security` notice, or any other type the person cannot switch off: delivered whatever
  /// the per-type switches, the per-chat overrides, a mute and the open-chat suppression say.
  public var bypassesFilters: Bool {
    PushContract.unfilteredTypes.contains(type)
  }

  /// The `type: request` method as the contract names it, or nil (absent, not a request, or one
  /// this build does not know).
  public var requestMethod: PushRequestMethod? {
    PushRequestMethod(rawValue: string("method"))
  }

  /**
   True when this payload is posted under `hermie.request`, with Allow and Deny: a `request` whose
   `method` is `approval`, and nothing else (`category.when`). Every other request method has no
   actions, a request that names no method is not an approval, and a clearing push never carries a
   category.
   */
  public var wantsActions: Bool {
    PushContract.typesWithActions.contains(type) && !isClear && requestMethod?.offersActions == true
  }

  /// The category the notification is posted under, or nil for none.
  public var categoryIdentifier: String? {
    wantsActions ? PushContract.requestCategory : nil
  }

  /// `data.sessionKey` of a request: the conversation under its stored id. `""` when unknown.
  public var sessionKey: String { string("sessionKey") }

  /// `data.level` of a `confirm`, or nil when absent or unknown.
  public var level: PushConfirmLevel? { PushConfirmLevel(rawValue: string("level")) }

  /// A clearing push: `type: request` with `clear: true`. It withdraws a delivered notification, is
  /// silent and is never shown, never answered and never opens anything.
  public var isClear: Bool {
    type == "request" && data["clear"] == .bool(true)
  }

  /// `data.reason` of a clearing push, or nil.
  public var clearReason: PushClearReason? { PushClearReason(rawValue: string("reason")) }

  /// `data.replaces`: the `eventId` of the notification a clearing push withdraws, or `""` when absent
  /// or not shaped like one.
  public var replaces: String {
    let value = string("replaces")
    return Self.isEventId(value) ? value : ""
  }

  /// `data.eventId`, or `""` when absent or not shaped like one.
  public var eventId: String {
    let value = string("eventId")
    return Self.isEventId(value) ? value : ""
  }

  /// `data.event`, or nil. `background.complete` is sent under `type: turn_done`.
  public var event: PushEvent? { PushEvent(rawValue: string("event")) }

  /// The per-type switch that decides this notification (`PushContract.types`), or nil for an
  /// unfiltered type, which has none. A `background.complete` is the `turn_done` switch.
  public var switchType: String? {
    PushContract.types.contains(type) ? type : nil
  }

  /// `data.change` of a `type: security` notification, or nil.
  public var securityChange: PushSecurityChange? { PushSecurityChange(rawValue: string("change")) }

  /// `'<kind>:'` and 32 hex digits (`eventId`, `replaces`).
  static func isEventId(_ value: String) -> Bool {
    guard let colon = value.firstIndex(of: ":") else {
      return false
    }

    let kind = value[..<colon]
    let digest = value[value.index(after: colon)...]

    return !kind.isEmpty && kind.allSatisfy { ("a"..."z").contains($0) || $0 == "_" } && digest.count == 32
      && digest.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
  }

  // MARK: Reading the bag

  /// A dictionary (or an Expo body sent as JSON text) as a flat JSON object. Only scalars are kept;
  /// nothing this app reads is nested, and a deep structure from a push service is not walked.
  static func object(_ value: Any) -> JSONObject? {
    if let text = value as? String {
      guard case .object(let object)? = try? JSONValue(parsing: text) else {
        return nil
      }

      return object.filter { $0.value.isScalar }
    }

    guard let dictionary = value as? [AnyHashable: Any] else {
      return nil
    }

    var object: JSONObject = [:]

    for (key, value) in dictionary {
      guard let key = key as? String, let scalar = scalar(value) else {
        continue
      }

      object[key] = scalar
    }

    return object
  }

  private static func scalar(_ value: Any) -> JSONValue? {
    if let number = value as? NSNumber {
      // A property-list boolean is an NSNumber too; CFBoolean is how to tell.
      if CFGetTypeID(number) == CFBooleanGetTypeID() {
        return .bool(number.boolValue)
      }

      return .number(number.doubleValue)
    }

    if let string = value as? String {
      return .string(string)
    }

    if value is NSNull {
      return .null
    }

    return nil
  }
}

extension JSONValue {
  fileprivate var isScalar: Bool {
    switch self {
    case .array, .object: false
    default: true
    }
  }
}

// MARK: - Taps

/// Which conversation a payload says it is about: the notifier's word, or `unknown` when it said
/// nothing (every payload from before the field existed).
public enum PushSessionKind: String, Sendable, Equatable {
  case canonical
  case branch
  case other
  case unknown = ""
}

/// What a tap asked for, before the gateway has been consulted (`pushTapOf` in `actions.ts`).
public struct PushTap: Sendable, Equatable {
  public enum Action: String, Sendable, Equatable {
    case allow
    case deny
    case open
  }

  public var bot: String
  /// Empty unless the payload named one; an action without one cannot answer.
  public var requestId: String
  public var action: Action
  /// The sending gateway's link key, or `""` when the payload carried none or not a valid one.
  public var gatewayKey: String
  /// The session the notified thing happened in, or `""`. For a `request` this is the RUNTIME
  /// session id (what the request methods name); for every other type the stored one.
  public var sessionId: String
  public var sessionKind: PushSessionKind
  /// The payload's `type` when the contract names it, else `""`.
  public var type: String
  /// The request method as the payload spelled it (`PushRequestMethod`), or `""`.
  public var method: String
  /// `type: request` only: the conversation under its STORED id, for opening it. `""` when unknown.
  public var sessionKey: String
  /// `method: confirm` only.
  public var level: PushConfirmLevel?
  /// A clearing push (`clear: true`): never answered and never opened; it only withdraws.
  public var isClear: Bool

  public init(
    bot: String,
    requestId: String = "",
    action: Action = .open,
    gatewayKey: String = "",
    sessionId: String = "",
    sessionKind: PushSessionKind = .unknown,
    type: String = "",
    method: String = "",
    sessionKey: String = "",
    level: PushConfirmLevel? = nil,
    isClear: Bool = false
  ) {
    self.bot = bot
    self.requestId = requestId
    self.action = action
    self.gatewayKey = gatewayKey
    self.sessionId = sessionId
    self.sessionKind = sessionKind
    self.type = type
    self.method = method
    self.sessionKey = sessionKey
    self.level = level
    self.isClear = isClear
  }

  /**
   Read a tap, or nil when the payload names no usable bot (`Identifiers.isBotName`): every
   destination resolves against the roster, and "open some chat" is not one.

   Both spellings of the actions and the request id are read (`hermie.request.allow` and `allow`,
   `requestId` and `request`), and both of the session id (`sessionId`, and Hermie Web's `session`).
   An Allow or Deny that names no request degrades to a plain open rather than answering whichever
   question is oldest, and so does one on a notification that is not an approval (a clarify, a
   secure input, a confirmation, a clearing push): a request with no `method` is still read as an
   approval, the only kind the senders before the contract posted with the actions.
   */
  public init?(actionIdentifier: String, payload: PushPayload) {
    let bot = payload.string("bot")

    // The rule a `hermie://chat/` link is held to: anyone who can send to this device chooses this
    // string, so a name with a slash, a control character or no end is not a chat to open.
    guard Identifiers.isBotName(bot) else {
      return nil
    }

    let requestId = payload.string("requestId").isEmpty ? payload.string("request") : payload.string("requestId")

    let action: Action =
      switch PushContract.Action(identifier: actionIdentifier) {
      case .allow?: .allow
      case .deny?: .deny
      case nil: .open
      }

    let key = payload.string("gatewayKey")
    let sessionId = payload.string("sessionId").isEmpty ? payload.string("session") : payload.string("sessionId")
    let method = payload.string("method")
    let answers = Self.methodAnswersInPlace(method) && !payload.isClear

    self.init(
      bot: bot,
      requestId: requestId,
      action: action != .open && (requestId.isEmpty || !answers) ? .open : action,
      gatewayKey: Identifiers.isGatewayKey(key) ? key : "",
      sessionId: sessionId,
      // A kind this build does not know is read as no kind at all.
      sessionKind: PushSessionKind(rawValue: payload.string("sessionKind")) ?? .unknown,
      type: payload.type,
      method: method,
      sessionKey: payload.sessionKey,
      level: payload.level,
      isClear: payload.isClear
    )
  }

  /// Whether an Allow or Deny may answer a notification of this method: an approval, or one that
  /// names none (older senders).
  static func methodAnswersInPlace(_ method: String) -> Bool {
    method.isEmpty || method == PushContract.actionsMethod.rawValue
  }

  /// Whether this tap's notification is one an Allow or Deny could answer.
  public var methodAnswersInPlace: Bool {
    Self.methodAnswersInPlace(method) && !isClear
  }

  /// A `type: request` notification.
  public var isRequest: Bool {
    type == "request"
  }

  /// The id of the conversation the notification is about, as the session list knows it: for a
  /// request the `sessionKey` (its `sessionId` is the runtime id, which names no conversation), for
  /// every other type the `sessionId`.
  public var conversationId: String {
    isRequest ? sessionKey : sessionId
  }

  /// Whether a tap on this notification opens a request in the app rather than only a chat: a
  /// request of any method but an approval (a clarify, a secure input, a confirmation).
  public var opensRequest: Bool {
    isRequest && !isClear && !method.isEmpty && method != PushContract.actionsMethod.rawValue
  }

  /// The chat a tap opens through the app's link handling. Only used once `gatewayKey` is known to
  /// name a configured gateway (`PushController`); a key-less link would open the bot on whichever
  /// gateway happens to be live.
  public var link: DeepLink {
    .chat(bot: bot, gatewayKey: gatewayKey)
  }
}

/**
 The seam for opening a request in the app: what a tap on a `type: request` notification that is not
 an approval hands to the shell (`PushRoute.request`). The handling (the secure input sheet, the
 confirmation, the passkey ceremony) is a later task; this is everything the notification said, as
 lookups: the shell re-reads the open request from the gateway by `requestId` (or finds the pending
 clarify) and shows it only if it is still open. Nothing in here is acted on unverified.

 At `level: passkey` the confirmation can only be done in the app with the device's own
 authentication, so the tap lands here and nowhere else.
 */
public struct PushOpenRequest: Sendable, Equatable {
  public var bot: String
  public var gatewayKey: String
  /// The method as the payload spelled it; `PushRequestMethod(rawValue:)` when this build knows it.
  public var method: String
  /// Empty for a clarify the sender had no id for.
  public var requestId: String
  /// The RUNTIME session id the request is addressed with, or `""` when the sender could not know it.
  public var sessionId: String
  /// The conversation under its STORED id, or `""`.
  public var sessionKey: String
  public var level: PushConfirmLevel?
  /// Where the conversation behind it opens: the bot's chat, or the conversation `sessionKey` names.
  public var destination: PushDestination

  public init(
    bot: String,
    gatewayKey: String = "",
    method: String,
    requestId: String = "",
    sessionId: String = "",
    sessionKey: String = "",
    level: PushConfirmLevel? = nil,
    destination: PushDestination = .chat
  ) {
    self.bot = bot
    self.gatewayKey = gatewayKey
    self.method = method
    self.requestId = requestId
    self.sessionId = sessionId
    self.sessionKey = sessionKey
    self.level = level
    self.destination = destination
  }

  /// The method this build knows, or nil.
  public var requestMethod: PushRequestMethod? {
    PushRequestMethod(rawValue: method)
  }

  /// Proven in the app with the device's own authentication, never from the notification.
  public var needsDeviceAuthentication: Bool {
    requestMethod == .confirm && level == .passkey
  }
}

/// One row of `approval.pending`, as far as an action needs to read it: which bot's session it is
/// open in, and what it offers.
public struct PushOpenApproval: Sendable, Equatable {
  /// The bot (profile) whose session asked.
  public var bot: String
  /// The session it is open in: what `approval.respond` needs as `session_id`.
  public var sessionId: String
  public var requestId: String
  public var choices: [String]

  public init(bot: String, sessionId: String, requestId: String, choices: [String]) {
    self.bot = bot
    self.sessionId = sessionId
    self.requestId = requestId
    self.choices = choices
  }
}

/// What to read the open requests of: one bot's session on one gateway. `sessionId` is the one the
/// notification named, or `""` for the bot's own chat.
public struct PushApprovalScope: Sendable, Hashable {
  public var gatewayId: String
  public var bot: String
  public var sessionId: String

  public init(gatewayId: String, bot: String, sessionId: String) {
    self.gatewayId = gatewayId
    self.bot = bot
    self.sessionId = sessionId
  }
}

/// One answer to send: `approval.respond` for one request of one bot's session on one gateway.
public struct PushApprovalAnswer: Sendable, Hashable {
  public var gatewayId: String
  public var bot: String
  public var sessionId: String
  public var requestId: String
  public var choice: String

  public init(gatewayId: String, bot: String, sessionId: String, requestId: String, choice: String) {
    self.gatewayId = gatewayId
    self.bot = bot
    self.sessionId = sessionId
    self.requestId = requestId
    self.choice = choice
  }
}

/// What the app should do about a tap once it has asked the gateway.
public enum PushIntent: Sendable, Equatable {
  case openChat(bot: String)
  /// Answer this request of this session.
  case respond(bot: String, sessionId: String, requestId: String, choice: String)
}

/// Where a tap lands.
public enum PushDestination: Sendable, Equatable {
  /// The bot's own chat.
  case chat
  /// One named conversation of that bot, by the id the session list shows (for a request that is
  /// its `sessionKey`).
  case conversation(sessionId: String)
}

public enum PushTapRules {
  /**
   The tap, decided against what the gateway currently lists as open (`resolvePushTap`). Every path
   that is not an exact match on a still-open request opens the chat, which is the safe answer and
   the useful one. Allow sends `once` and Deny sends `deny`, and only when the gateway offers them.

   An exact match is the request id AND the bot AND the session: a notification that names bot A
   and the id of a request open in bot B's session answers nothing (anyone who can send to this
   device chooses what the payload says). A notification about a branch or another conversation
   answers nothing either, as in the Expo app: the reader lands there and answers it in place.
   */
  public static func resolve(_ tap: PushTap, pending: [PushOpenApproval]) -> PushIntent {
    let open = PushIntent.openChat(bot: tap.bot)

    guard tap.action != .open, !tap.requestId.isEmpty, tap.methodAnswersInPlace, answersInPlace(tap) else {
      return open
    }

    let match = pending.first { approval in
      approval.requestId.trimmingCharacters(in: .whitespacesAndNewlines) == tap.requestId
        && approval.bot == tap.bot
        && !approval.sessionId.isEmpty
        && (tap.sessionId.isEmpty || approval.sessionId == tap.sessionId)
    }

    guard let match else {
      return open
    }

    let wanted = tap.action == .allow ? "once" : "deny"

    return match.choices.contains(wanted)
      ? .respond(bot: tap.bot, sessionId: match.sessionId, requestId: tap.requestId, choice: wanted) : open
  }

  /// Whether an action on this tap may be answered without opening anything: only for the bot's own
  /// chat, never for a branch or another conversation.
  public static func answersInPlace(_ tap: PushTap) -> Bool {
    tap.sessionKind != .branch && tap.sessionKind != .other
  }

  /**
   The conversation a tap opens (`pushDestinationOf`): the notifier's kind wins when it gave one;
   otherwise a session id that is not one of the bot's canonical ids opens that conversation; and
   anything else opens the chat.
   */
  public static func destination(_ tap: PushTap, canonicalIds: [String]) -> PushDestination {
    // A request names its conversation by `sessionKey`; its `sessionId` is the runtime id, which no
    // session list shows.
    let conversation = tap.conversationId

    if tap.sessionKind == .canonical || conversation.isEmpty {
      return .chat
    }

    if tap.sessionKind == .branch || tap.sessionKind == .other {
      return .conversation(sessionId: conversation)
    }

    if canonicalIds.isEmpty || canonicalIds.contains(conversation) {
      return .chat
    }

    return .conversation(sessionId: conversation)
  }

  /// What a tap on a request that is not an approval opens in the app, or nil for every other tap
  /// (a message, an approval, a security notice). See `PushOpenRequest`.
  public static func openRequest(_ tap: PushTap, canonicalIds: [String]) -> PushOpenRequest? {
    guard tap.opensRequest else {
      return nil
    }

    return PushOpenRequest(
      bot: tap.bot,
      gatewayKey: tap.gatewayKey,
      method: tap.method,
      requestId: tap.requestId,
      sessionId: tap.sessionId,
      sessionKey: tap.sessionKey,
      level: tap.level,
      destination: destination(tap, canonicalIds: canonicalIds)
    )
  }
}
