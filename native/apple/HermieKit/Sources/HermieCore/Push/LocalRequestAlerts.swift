import Foundation
import HermieProtocol
import HermieShared

// MARK: - What is open

/**
 One request that waits for the person: an approval, a clarify question, a secure prompt, a
 passkey confirmation or an interactive request, whichever of the session's models holds it.

 Only what a notification may be built from. `text` is the one line an approval or a clarify may
 show when the person asked for previews (`PushRequestMethod.carriesPreview`); it is empty for
 everything else, and `RequestAlertContent` ignores it for a method that carries none, so a
 source that fills it in too eagerly leaks nothing.
 */
public struct OpenRequest: Sendable, Equatable {
  public var gatewayId: String
  /// The chat it belongs to (the bot's name).
  public var chat: String
  /// What the person calls that bot; falls back to `chat`.
  public var chatName: String
  /// The wire method (`PushRequestMethod`).
  public var method: String
  /// The id the notification names. An approval is named by its queue id (what `approval.pending`
  /// lists and a remote push carries), every other request by its `srq-…` id.
  public var requestId: String
  /// The runtime session the request is addressed with, or `""` when the model holding it does not know.
  public var sessionId: String
  /// A `confirm`'s level.
  public var level: PushConfirmLevel?
  public var text: String

  public init(
    gatewayId: String,
    chat: String,
    chatName: String = "",
    method: String,
    requestId: String,
    sessionId: String = "",
    level: PushConfirmLevel? = nil,
    text: String = ""
  ) {
    self.gatewayId = gatewayId
    self.chat = chat
    self.chatName = chatName
    self.method = method
    self.requestId = requestId
    self.sessionId = sessionId
    self.level = level
    self.text = text
  }

  /// One request, wherever it was found: the gateway's ids restart, so the gateway is part of it.
  public var key: String {
    "\(gatewayId)\u{1F}\(requestId)"
  }

  /// The method this build names, or nil.
  public var requestMethod: PushRequestMethod? {
    PushRequestMethod(rawValue: method)
  }
}

// MARK: - The decision

/// Whether, and why not, a local notification is posted for a request that just arrived.
public enum LocalAlertDecision: Sendable, Equatable {
  case post
  case skip(LocalAlertSkip)
}

public enum LocalAlertSkip: Sendable, Equatable {
  /// The system does not let this app show notifications. Asking is the notification onboarding's
  /// business, never this path's.
  case notAuthorised
  /// The reader's switch for notifications is off.
  case switchedOff
  /// The reader switched the `request` type off.
  case typeOff
  /// The app is in front and the chat is on screen: the request is already in the reader's face.
  case chatInFront
}

/// What the decision reads, all of it as plain values.
public struct LocalAlertContext: Sendable, Equatable {
  public var permission: PushPermission
  /// The reader's switch (`PushController.enabled`).
  public var enabled: Bool
  public var preferences: PushPreferences
  /// The reader muted this chat. A mute never silences a request (`PushContract.alwaysShownTypes`):
  /// it is carried so the decision and the remote path are written from the same filter.
  public var muted: Bool
  /// Some window of the app is active (macOS: the app is the active one; iOS: a scene is `.active`).
  public var appActive: Bool
  /// The request's chat is on screen in a window that is key and active.
  public var chatVisible: Bool

  public init(
    permission: PushPermission,
    enabled: Bool,
    preferences: PushPreferences = .standard,
    muted: Bool = false,
    appActive: Bool,
    chatVisible: Bool
  ) {
    self.permission = permission
    self.enabled = enabled
    self.preferences = preferences
    self.muted = muted
    self.appActive = appActive
    self.chatVisible = chatVisible
  }
}

public enum LocalAlertPolicy {
  /**
   Whether a request that arrived now gets a local notification.

   The same filter the remote path applies (`PushFilter`): the reader's switch for the `request` type
   decides, and a mute does not. On top of it, the one question only this device can answer: is the
   reader looking at it already.
   */
  public static func decide(_ context: LocalAlertContext) -> LocalAlertDecision {
    guard context.permission == .granted else {
      return .skip(.notAuthorised)
    }

    guard context.enabled else {
      return .skip(.switchedOff)
    }

    let wanted = Dictionary(uniqueKeysWithValues: PushContract.types.map { ($0, context.preferences.wants($0)) })
    let probe = PushPayload(shape: .relay, data: ["type": .string("request")])

    guard PushFilter.allows(probe, wanted: wanted, muted: context.muted) else {
      return .skip(.typeOff)
    }

    if context.appActive, context.chatVisible {
      return .skip(.chatInFront)
    }

    return .post
  }
}

// MARK: - What is posted

/// How loudly the system may interrupt.
public enum LocalInterruption: Sendable, Equatable {
  case active
  /// Only with the Time Sensitive Notifications entitlement (`RequestAlerts.timeSensitiveEntitled`).
  case timeSensitive
}

/// One local notification, without the UserNotifications types (which need a bundle), so what is
/// posted is tested on its own. `HermieUI`'s `SystemLocalNotifications` turns it into the real one.
public struct LocalNotificationContent: Sendable, Equatable {
  public var identifier: String
  public var title: String
  public var body: String
  public var threadIdentifier: String
  public var categoryIdentifier: String?
  public var interruption: LocalInterruption
  /// The badge after this one is posted, or nil to leave it.
  public var badge: Int?
  /// `["hermie": <the data bag>]`: the shape a relay push carries, so a tap, an action and a
  /// clearing push treat a local notification exactly like a remote one.
  public var userInfo: JSONObject

  public init(
    identifier: String,
    title: String,
    body: String,
    threadIdentifier: String,
    categoryIdentifier: String? = nil,
    interruption: LocalInterruption = .active,
    badge: Int? = nil,
    userInfo: JSONObject = [:]
  ) {
    self.identifier = identifier
    self.title = title
    self.body = body
    self.threadIdentifier = threadIdentifier
    self.categoryIdentifier = categoryIdentifier
    self.interruption = interruption
    self.badge = badge
    self.userInfo = userInfo
  }

  /// The data bag a tap reads (`PushPayload`), or nil.
  public var payload: PushPayload? {
    guard case .object(let bag)? = userInfo[PushPayload.relayKey] else {
      return nil
    }

    return PushPayload(shape: .relay, data: bag)
  }
}

/**
 The words of a local notification, in the reader's language. The app shell hands over the
 localised ones (`RequestAlertCopy.localized` in HermieUI); `english` is the contract's own text
 (`contract/push/contract.json`, `examples`) and what the tests read.
 */
public struct RequestAlertCopy: Sendable {
  /// What a notification says when the reader keeps previews off: it names nobody and nothing.
  public var attention: String
  /// What a method is, in a few words, for a reader who allowed previews.
  public var phrase: @Sendable (PushRequestMethod, PushConfirmLevel?) -> String

  public init(attention: String, phrase: @escaping @Sendable (PushRequestMethod, PushConfirmLevel?) -> String) {
    self.attention = attention
    self.phrase = phrase
  }

  public static let english = RequestAlertCopy(attention: "Needs your attention") { method, level in
    switch method {
    case .approval: "Needs your approval"
    case .clarify: "Asked you a question"
    case .secret: "Needs a secret"
    case .sudo: "Needs your password"
    case .vaultUnlockPrompt: "Needs your master password"
    case .vaultCode: "Needs a verification code"
    case .vaultSaveLogin: "Wants to save a login"
    case .confirm: level == .passkey ? "Confirm this in the app" : "Needs your confirmation"
    case .inputForm: "Has a form for you"
    case .inputFile: "Needs a file"
    case .reviewDraft: "Has a draft to review"
    case .reviewDiff: "Has changes to review"
    case .inputSignature: "Needs your signature"
    case .deviceLocation: "Needs your location"
    case .deviceContact: "Needs a contact"
    case .deviceCalendar: "Has an event for your calendar"
    case .deviceScan: "Needs a scan"
    }
  }
}

/// Builds the notification for one request. Pure.
public enum RequestAlertContent {
  /// The longest line of an approval's or a clarify's own words a preview carries.
  public static let textLimit = 120

  /**
   The system identifier of a request's notification: scoped to its gateway (the ids restart) and
   built from the request id, so the same request posted twice is one notification, and so a clearing
   push or an answer finds it again.
   */
  public static func identifier(gatewayId: String, requestId: String) -> String {
    "hermie.request.\(gatewayId).\(requestId)"
  }

  /// The thread a chat's notifications are grouped under.
  public static func thread(gatewayId: String, gatewayKey: String, chat: String) -> String {
    "hermie.chat.\(gatewayKey.isEmpty ? gatewayId : gatewayKey).\(chat)"
  }

  /**
   The data bag, in the shape the remote contract gives it. Ids and kinds only: nothing the
   notification says about the request travels in it, and a tap re-reads the request from the
   gateway before it shows anything (ADR-0017).
   */
  public static func bag(_ request: OpenRequest, gatewayKey: String) -> JSONObject {
    var bag: JSONObject = [
      "type": .string("request"),
      "bot": .string(request.chat),
      "method": .string(request.method),
      "requestId": .string(request.requestId)
    ]

    if Identifiers.isGatewayKey(gatewayKey) {
      bag["gatewayKey"] = .string(gatewayKey)
    }

    if !request.sessionId.isEmpty {
      bag["sessionId"] = .string(request.sessionId)
    }

    if request.requestMethod == .confirm, let level = request.level {
      bag["level"] = .string(level.rawValue)
    }

    return bag
  }

  /**
   What the notification says.

   - Previews off (the default): "Needs your attention" and nothing else.
   - Previews on: what kind of request it is, in the contract's words. An approval or a clarify
     (the two that may carry text) adds its own short line when it has one. A secure prompt, a
     confirmation, a form, a file, a draft, a diff, a signature or a device request never does:
     its fields, its values, its diff and its detail stay in the app.
   */
  public static func body(for request: OpenRequest, preview: Bool, copy: RequestAlertCopy) -> String {
    guard preview else {
      return copy.attention
    }

    guard let method = request.requestMethod else {
      return copy.attention
    }

    let phrase = copy.phrase(method, request.level)

    guard method.carriesPreview else {
      return phrase
    }

    let line = oneLine(request.text, limit: textLimit)

    return line.isEmpty ? phrase : "\(phrase): \(line)"
  }

  public static func make(
    _ request: OpenRequest,
    gatewayKey: String,
    preview: Bool,
    copy: RequestAlertCopy,
    interruption: LocalInterruption,
    badge: Int?
  ) -> LocalNotificationContent {
    let bag = bag(request, gatewayKey: gatewayKey)
    let name = oneLine(request.chatName, limit: 80)

    // An approval is posted under the category with Allow and Deny, and nothing else is: the same
    // rule as the remote notification (`PushPayload.wantsActions`).
    let payload = PushPayload(shape: .relay, data: bag)

    return LocalNotificationContent(
      identifier: identifier(gatewayId: request.gatewayId, requestId: request.requestId),
      title: name.isEmpty ? request.chat : name,
      body: body(for: request, preview: preview, copy: copy),
      threadIdentifier: thread(gatewayId: request.gatewayId, gatewayKey: gatewayKey, chat: request.chat),
      categoryIdentifier: payload.categoryIdentifier,
      interruption: interruption,
      badge: badge,
      userInfo: [PushPayload.relayKey: .object(bag)]
    )
  }

  /// `raw` as one line of plain text, cleaned and bounded like every text of a request (no control or
  /// direction characters, which could make a lock screen say something else), cut at `limit`.
  static func oneLine(_ raw: String, limit: Int) -> String {
    InteractivePrompt.line(raw, limit: limit)
  }
}

// MARK: - Where it is posted

/**
 The system's local notifications, behind a seam so the coordinator runs in a test process, which
 has no bundle and must never post a real notification. `HermieUI` has the one over
 `UNUserNotificationCenter`; `RecordingLocalNotifications` stands in for it in tests.
 */
@MainActor
public protocol LocalNotificationCenter: AnyObject {
  func post(_ content: LocalNotificationContent) async
  /// Take these off the screen and out of the list, and cancel them if they are still pending.
  func remove(identifiers: [String]) async
}

/// Posts nothing: before the shell attaches the real centre, and in previews.
@MainActor
public final class InertLocalNotifications: LocalNotificationCenter {
  public init() {}

  public func post(_ content: LocalNotificationContent) async {}
  public func remove(identifiers: [String]) async {}
}

// MARK: - Where the person is

/**
 Which of the app's windows the person can see, as the windows report it: the one fact the
 decision cannot get from the session. A window reports whether the app is active in it and which
 chat it shows; the app is in front while any window is active, and a chat is on screen while a
 window that is key shows it.

 On iOS and iPadOS a scene is active and key together. On the Mac a window is key only when it is the
 one the person types into (`ControlActiveState.key`); one that is merely visible does not count,
 so a request for the chat in the window behind still raises a notification.
 */
@MainActor
public final class AppPresence {
  /// A chat as a window shows it.
  public struct Chat: Sendable, Hashable {
    public var gatewayId: String
    public var bot: String

    public init(gatewayId: String, bot: String) {
      self.gatewayId = gatewayId
      self.bot = bot
    }
  }

  private struct Window {
    var active: Bool
    var key: Bool
    var chat: Chat?
  }

  private var windows: [UUID: Window] = [:]

  public init() {}

  /// One window's state: whether the app is active in it, whether it is the key window, and the chat
  /// it shows.
  public func report(window: UUID, active: Bool, key: Bool, chat: Chat?) {
    windows[window] = Window(active: active, key: key, chat: chat)
  }

  /// A window closed: it no longer shows anything.
  public func windowClosed(_ window: UUID) {
    windows[window] = nil
  }

  /// Some window is active.
  public var isActive: Bool {
    windows.values.contains { $0.active }
  }

  /// A window that is active and key shows this chat.
  public func isVisible(_ chat: Chat) -> Bool {
    windows.values.contains { $0.active && $0.key && $0.chat == chat }
  }
}
