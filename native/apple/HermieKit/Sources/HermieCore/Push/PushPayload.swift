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

  /// The payload's `type`, when it is one the contract (or its legacy list) names.
  public var type: String {
    let type = string("type")
    return PushContract.types.contains(type) || type == "dm" ? type : ""
  }

  /// True when this payload is the kind that carries the two actions.
  public var wantsActions: Bool {
    PushContract.typesWithActions.contains(type)
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
  /// The session the notified thing happened in, or `""`.
  public var sessionId: String
  public var sessionKind: PushSessionKind

  public init(
    bot: String,
    requestId: String = "",
    action: Action = .open,
    gatewayKey: String = "",
    sessionId: String = "",
    sessionKind: PushSessionKind = .unknown
  ) {
    self.bot = bot
    self.requestId = requestId
    self.action = action
    self.gatewayKey = gatewayKey
    self.sessionId = sessionId
    self.sessionKind = sessionKind
  }

  /**
   Read a tap, or nil when the payload names no usable bot (`Identifiers.isBotName`): every
   destination resolves against the roster, and "open some chat" is not one.

   Both spellings of the actions and the request id are read (`hermie.request.allow` and `allow`,
   `requestId` and `request`), and both of the session id (`sessionId`, and Hermie Web's `session`).
   An Allow or Deny that names no request degrades to a plain open rather than answering whichever
   question is oldest.
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

    self.init(
      bot: bot,
      requestId: requestId,
      action: action != .open && requestId.isEmpty ? .open : action,
      gatewayKey: Identifiers.isGatewayKey(key) ? key : "",
      sessionId: sessionId,
      // A kind this build does not know is read as no kind at all.
      sessionKind: PushSessionKind(rawValue: payload.string("sessionKind")) ?? .unknown
    )
  }

  /// The chat a tap opens through the app's link handling. Only used once `gatewayKey` is known to
  /// name a configured gateway (`PushController`); a key-less link would open the bot on whichever
  /// gateway happens to be live.
  public var link: DeepLink {
    .chat(bot: bot, gatewayKey: gatewayKey)
  }
}

/// One row of `approval.pending`, as far as an action needs to read it.
public struct PushOpenApproval: Sendable, Equatable {
  public var requestId: String
  public var choices: [String]

  public init(requestId: String, choices: [String]) {
    self.requestId = requestId
    self.choices = choices
  }
}

/// What the app should do about a tap once it has asked the gateway.
public enum PushIntent: Sendable, Equatable {
  case openChat(bot: String)
  case respond(bot: String, requestId: String, choice: String)
}

/// Where a tap lands.
public enum PushDestination: Sendable, Equatable {
  /// The bot's own chat.
  case chat
  /// One named conversation of that bot.
  case conversation(sessionId: String)
}

public enum PushTapRules {
  /**
   The tap, decided against what the gateway currently lists as open (`resolvePushTap`). Every path
   that is not an exact match on a still-open request opens the chat, which is the safe answer and
   the useful one. Allow sends `once` and Deny sends `deny`, and only when the gateway offers them.
   */
  public static func resolve(_ tap: PushTap, pending: [PushOpenApproval]) -> PushIntent {
    let open = PushIntent.openChat(bot: tap.bot)

    guard tap.action != .open, !tap.requestId.isEmpty,
      let match = pending.first(where: { $0.requestId.trimmingCharacters(in: .whitespacesAndNewlines) == tap.requestId })
    else {
      return open
    }

    let wanted = tap.action == .allow ? "once" : "deny"

    return match.choices.contains(wanted) ? .respond(bot: tap.bot, requestId: tap.requestId, choice: wanted) : open
  }

  /**
   The conversation a tap opens (`pushDestinationOf`): the notifier's kind wins when it gave one;
   otherwise a session id that is not one of the bot's canonical ids opens that conversation; and
   anything else opens the chat.
   */
  public static func destination(_ tap: PushTap, canonicalIds: [String]) -> PushDestination {
    if tap.sessionKind == .canonical || tap.sessionId.isEmpty {
      return .chat
    }

    if tap.sessionKind == .branch || tap.sessionKind == .other {
      return .conversation(sessionId: tap.sessionId)
    }

    if canonicalIds.isEmpty || canonicalIds.contains(tap.sessionId) {
      return .chat
    }

    return .conversation(sessionId: tap.sessionId)
  }
}
