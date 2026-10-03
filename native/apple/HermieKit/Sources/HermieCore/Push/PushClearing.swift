import Foundation
import HermieShared

/**
 A clearing push (`clear` in the contract): the sender saying that the request a delivered
 notification was raised for stopped being open (answered on another device, cancelled, timed out),
 so the notification should go. It is a `type: request` data bag with `clear: true`, the same
 `method`, `requestId` and conversation as the notification it withdraws, a `reason`, and `replaces`:
 the `eventId` of that notification, which is the only handle for a clarify seen without a request
 id.

 It is silent. It never carries a category, is never shown, is never answered and never opens
 anything, and what it names is a lookup: the app removes a delivered notification of the same bot
 that says the same request id or event id, and nothing else.
 */
public struct PushClear: Sendable, Equatable {
  public var bot: String
  /// The sending gateway's link key, or `""`.
  public var gatewayKey: String
  /// The method of the notification it withdraws, or `""`.
  public var method: String
  /// The request it closes, or `""` when the sender did not know one.
  public var requestId: String
  /// The `eventId` of the notification it withdraws, or `""`.
  public var replaces: String
  public var reason: PushClearReason?

  public init(
    bot: String,
    gatewayKey: String = "",
    method: String = "",
    requestId: String = "",
    replaces: String = "",
    reason: PushClearReason? = nil
  ) {
    self.bot = bot
    self.gatewayKey = gatewayKey
    self.method = method
    self.requestId = requestId
    self.replaces = replaces
    self.reason = reason
  }

  /// Read a clearing push, or nil when the payload is not one, names no usable bot, or names nothing
  /// to withdraw (neither a request id nor an event id).
  public init?(payload: PushPayload) {
    let bot = payload.string("bot")

    guard payload.isClear, Identifiers.isBotName(bot) else {
      return nil
    }

    let key = payload.string("gatewayKey")

    self.init(
      bot: bot,
      gatewayKey: Identifiers.isGatewayKey(key) ? key : "",
      method: payload.string("method"),
      requestId: payload.string("requestId"),
      replaces: payload.replaces,
      reason: payload.clearReason
    )

    guard !requestId.isEmpty || !replaces.isEmpty else {
      return nil
    }
  }

  /// Whether a delivered notification is the one this withdraws: a request of the same bot (never a
  /// clearing push itself, never another type) on the same gateway when both say which, that
  /// carries this request id (with the same method when both say one) or whose event id (or system
  /// identifier, which a collapse id makes the same) is `replaces`.
  public func withdraws(_ delivered: PushDeliveredNotification) -> Bool {
    guard let payload = delivered.payload, payload.type == "request", !payload.isClear, payload.string("bot") == bot
    else {
      return false
    }

    let key = payload.string("gatewayKey")

    if !gatewayKey.isEmpty, !key.isEmpty, key != gatewayKey {
      return false
    }

    if !replaces.isEmpty, payload.eventId == replaces || delivered.identifier == replaces {
      return true
    }

    let delivery = payload.string("requestId")
    let sameMethod = method.isEmpty || payload.string("method").isEmpty || payload.string("method") == method

    return !requestId.isEmpty && delivery == requestId && sameMethod
  }
}

/// One notification the system has delivered and still shows, as far as clearing needs to read it.
public struct PushDeliveredNotification: Sendable, Equatable {
  /// The system's identifier for it: what `remove(identifiers:)` takes.
  public var identifier: String
  /// Its data bag, or nil when it carries none this app reads.
  public var payload: PushPayload?

  public init(identifier: String, payload: PushPayload?) {
    self.identifier = identifier
    self.payload = payload
  }
}

/**
 The platform's delivered notifications, behind a seam so clearing runs in a test process, which has
 no bundle and must never touch `UNUserNotificationCenter`. The notification service extension and
 the app delegate give `PushClearing` one over `UNUserNotificationCenter` (`getDeliveredNotifications`
 and `removeDeliveredNotifications(withIdentifiers:)`); a test gives it a double.
 */
public protocol PushDeliveredNotifications: Sendable {
  /// What the system still shows, in no particular order.
  func delivered() async -> [PushDeliveredNotification]
  /// Take these off the screen and out of the notification list.
  func remove(identifiers: [String]) async
}

/// No delivered notifications and nothing to remove: before the system's centre is attached, and in
/// previews.
public struct NoDeliveredNotifications: PushDeliveredNotifications {
  public init() {}

  public func delivered() async -> [PushDeliveredNotification] { [] }
  public func remove(identifiers: [String]) async {}
}

/**
 The model-level API behind a clearing push: what the notification service extension and the app
 delegate call when one arrives. Both reach the system only through `PushDeliveredNotifications`.
 */
public enum PushClearing {
  /// The identifiers of the delivered notifications this clearing push withdraws.
  public static func identifiers(for clear: PushClear, among delivered: [PushDeliveredNotification]) -> [String] {
    delivered.filter(clear.withdraws).map(\.identifier)
  }

  /**
   Handle a payload that may be a clearing push: remove what it withdraws and report how many
   notifications went, or nil when the payload is not a clearing push at all (so the caller goes on
   treating it as a notification). A clearing push that matches nothing is still a clearing push: 0.
   */
  @discardableResult
  public static func apply(_ payload: PushPayload, to center: any PushDeliveredNotifications) async -> Int? {
    guard payload.isClear else {
      return nil
    }

    guard let clear = PushClear(payload: payload) else {
      return 0
    }

    let identifiers = identifiers(for: clear, among: await center.delivered())

    if !identifiers.isEmpty {
      await center.remove(identifiers: identifiers)
    }

    return identifiers.count
  }
}

/**
 Which notifications a device shows, applied on the device. The gateway's notifier filters before it
 sends (per-type switches, per-chat overrides, a mute, the open-chat suppression), so the app does
 not normally need this; it exists so the one rule that must hold on every path is written once: an
 unfiltered type (`security`) is shown whatever the switches and a mute say.
 */
public enum PushFilter {
  /// Whether a notification is shown given this device's per-type switches and a mute. A mute
  /// silences everything but what needs an answer (a request) and the unfiltered types.
  public static func allows(_ payload: PushPayload, wanted: [String: Bool], muted: Bool) -> Bool {
    if payload.bypassesFilters {
      return true
    }

    guard let type = payload.switchType else {
      return false
    }

    return !(muted && payload.silencedByMute) && wanted[type] == true
  }
}
