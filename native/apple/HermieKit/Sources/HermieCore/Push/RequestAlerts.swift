import Foundation
import HermieShared

/// What the reader chose about notifications, as the decision reads it.
public struct LocalAlertSettings: Sendable, Equatable {
  public var permission: PushPermission
  /// The reader's switch for notifications.
  public var enabled: Bool
  public var preferences: PushPreferences
  /// "Urgent requests break through Focus": whether an approval, a question or a confirmation is
  /// posted as time-sensitive. On unless the reader switched it off.
  public var urgentBreaksThroughFocus: Bool

  public init(
    permission: PushPermission,
    enabled: Bool,
    preferences: PushPreferences = .standard,
    urgentBreaksThroughFocus: Bool = true
  ) {
    self.permission = permission
    self.enabled = enabled
    self.preferences = preferences
    self.urgentBreaksThroughFocus = urgentBreaksThroughFocus
  }
}

/**
 Local notifications for what the bots ask while the app is not in front.

 The session says, whenever it changes, which requests are open (`update`); this class compares that
 with what it knew:

 - **A request it has not seen** is decided once (`LocalAlertPolicy`): the system must allow
   notifications, the reader's switches must want a `request`, the Focus that is on must let that bot
   and kind through (`FocusFilter`, set per Focus in the system's settings), and the person must not be
   looking at that chat already. If so, one notification is posted straight away, named by the request
   (`RequestAlertContent.identifier`), so a second post for the same request is the same
   notification. A request that arrived while the person was looking is never posted afterwards.
 - **A request that is gone** (answered here or on another device, cancelled, timed out, withdrawn)
   has its notification taken away, so no banner is left asking about something that is over.

 The notification carries the data bag a relay push carries, so a tap opens the right gateway and
 chat (`PushController.handleResponse`), Allow and Deny answer an approval through the existing
 re-read, and a clearing push from the relay withdraws it like any other.

 Nothing here asks for permission: the notification onboarding does. The badge follows the existing
 mechanism (`PushSystem.setBadgeCount`, which is zeroed when the app comes to the front): the number of
 notifications this class has posted and not taken away, or, when the shell gives a `badgeCount`, what
 that says (the "Needs you" inbox: everything waiting, whether or not a notification was posted for
 it). On the Mac, a confirmation also bounces the Dock icon once.

 A remote push for the same request is not suppressed here: the app has no code that runs when
 one is delivered to a background app (there is no notification service extension), so the system
 shows both when both arrive. The gateway holds its push back while the app's `seen` heartbeat is
 fresh, which is the usual case for the short window in which a local notification is posted.
 */
@MainActor
public final class RequestAlerts {
  /// Whether the build has the Time Sensitive Notifications entitlement
  /// (`com.apple.developer.usernotifications.time-sensitive`, in every `Hermie*.entitlements` of both
  /// apps; a test holds the two in step). An urgent request (`PushRequestMethod.isUrgent`) is posted at
  /// the `timeSensitive` level, everything else at `active`. A level the app is not entitled to is
  /// downgraded silently by the system, so a build signed without the entitlement still posts.
  ///
  /// Off until the App ID `dev.hermie.app` has the Time Sensitive Notifications capability in the
  /// developer account: a provisioning profile without it refuses the archive. Turning it on is this
  /// flag plus the key in the four app entitlements files.
  public static let timeSensitiveEntitled = false

  /// Where the person is: the windows report here.
  public let presence = AppPresence()

  private struct Entry {
    var request: OpenRequest
    /// The identifier it was posted under, or nil when it was not posted.
    var posted: String?
  }

  private let center: any LocalNotificationCenter
  private let settings: @MainActor () -> LocalAlertSettings
  private let isMuted: @MainActor (_ gatewayId: String, _ bot: String) -> Bool
  private let setBadge: @MainActor (Int) async -> Void
  private let requestDockAttention: @MainActor () -> Void
  private let copy: RequestAlertCopy
  private let entitled: Bool
  private let focusFilter: @MainActor () -> FocusFilter
  private let badgeCount: (@MainActor () -> Int)?

  private var entries: [String: Entry] = [:]
  /// The centre's calls, one after the other, in the order they were decided.
  private var tail: Task<Void, Never>?

  public init(
    center: any LocalNotificationCenter,
    settings: @escaping @MainActor () -> LocalAlertSettings,
    isMuted: @escaping @MainActor (_ gatewayId: String, _ bot: String) -> Bool = { _, _ in false },
    setBadge: @escaping @MainActor (Int) async -> Void = { _ in },
    requestDockAttention: @escaping @MainActor () -> Void = {},
    copy: RequestAlertCopy = .english,
    timeSensitive: Bool = RequestAlerts.timeSensitiveEntitled,
    focusFilter: @escaping @MainActor () -> FocusFilter = { .unfiltered },
    badgeCount: (@MainActor () -> Int)? = nil
  ) {
    self.badgeCount = badgeCount
    self.center = center
    self.settings = settings
    self.isMuted = isMuted
    self.setBadge = setBadge
    self.requestDockAttention = requestDockAttention
    self.copy = copy
    self.entitled = timeSensitive
    self.focusFilter = focusFilter
  }

  /// Alerts that read the reader's notification choices from the app's push controller and set the
  /// badge through its system.
  public convenience init(
    push: PushController,
    center: any LocalNotificationCenter,
    copy: RequestAlertCopy = .english,
    requestDockAttention: @escaping @MainActor () -> Void = {},
    timeSensitive: Bool = RequestAlerts.timeSensitiveEntitled,
    focusFilter: @escaping @MainActor () -> FocusFilter = { .unfiltered },
    badgeCount: (@MainActor () -> Int)? = nil
  ) {
    self.init(
      center: center,
      settings: {
        LocalAlertSettings(
          permission: push.permission, enabled: push.enabled, preferences: push.preferences,
          urgentBreaksThroughFocus: push.urgentBreaksThroughFocus)
      },
      isMuted: { gatewayId, bot in push.isMuted(gatewayId, bot) },
      setBadge: { count in await push.system.setBadgeCount(count) },
      requestDockAttention: requestDockAttention,
      copy: copy,
      timeSensitive: timeSensitive,
      focusFilter: focusFilter,
      badgeCount: badgeCount
    )
  }

  // MARK: What the session says

  /**
   The requests the gateway's session holds open now (all of them, not only the new ones).

   - Parameter authoritative: the list can be trusted to say what is over. Pass `false` while the
     connection is not ready: a request missing from a list read mid-reconnect is not an answered one,
     and its notification stays until a list that can be trusted says it is gone.
   */
  public func update(
    gatewayId: String,
    gatewayKey: String,
    requests: [OpenRequest],
    authoritative: Bool = true
  ) {
    var open = Set<String>()

    for request in requests where request.gatewayId == gatewayId {
      open.insert(request.key)

      if entries[request.key] == nil {
        arrived(request, gatewayKey: gatewayKey)
      }
    }

    guard authoritative else {
      return
    }

    withdraw(entries.filter { $0.value.request.gatewayId == gatewayId && !open.contains($0.key) }.map(\.key))
  }

  /// The session to this gateway ended (sign-out, another gateway went live): its requests can no
  /// longer be answered from here, so their notifications go.
  public func sessionEnded(gatewayId: String) {
    withdraw(entries.filter { $0.value.request.gatewayId == gatewayId }.map(\.key))
  }

  /// The identifiers of the notifications posted and not taken away yet.
  public var postedIdentifiers: [String] {
    entries.values.compactMap(\.posted).sorted()
  }

  /// Wait until every call to the centre decided so far has run.
  public func flush() async {
    await tail?.value
  }

  // MARK: Deciding

  private func arrived(_ request: OpenRequest, gatewayKey: String) {
    let current = settings()
    let chat = AppPresence.Chat(gatewayId: request.gatewayId, bot: request.chat)

    let context = LocalAlertContext(
      permission: current.permission,
      enabled: current.enabled,
      preferences: current.preferences,
      muted: isMuted(request.gatewayId, request.chat),
      appActive: presence.isActive,
      chatVisible: presence.isVisible(chat),
      focusAllows: focusFilter().allows(gatewayKey: gatewayKey, bot: request.chat, urgent: request.isUrgent)
    )

    guard LocalAlertPolicy.decide(context) == .post else {
      entries[request.key] = Entry(request: request, posted: nil)
      return
    }

    let content = RequestAlertContent.make(
      request,
      gatewayKey: gatewayKey,
      preview: current.preferences.preview,
      copy: copy,
      interruption: .level(
        for: request, entitled: entitled, urgentBreaksThroughFocus: current.urgentBreaksThroughFocus),
      badge: badgeCount?() ?? postedCount + 1
    )

    entries[request.key] = Entry(request: request, posted: content.identifier)

    let center = self.center
    enqueue { await center.post(content) }

    if request.requestMethod == .confirm {
      requestDockAttention()
    }
  }

  private var postedCount: Int {
    entries.values.filter { $0.posted != nil }.count
  }

  private func withdraw(_ keys: [String]) {
    guard !keys.isEmpty else {
      return
    }

    let identifiers = keys.compactMap { entries[$0]?.posted }

    for key in keys {
      entries[key] = nil
    }

    guard !identifiers.isEmpty else {
      return
    }

    let center = self.center
    let remaining = badgeCount?() ?? postedCount
    let inFront = presence.isActive
    let setBadge = self.setBadge

    enqueue {
      await center.remove(identifiers: identifiers)

      // In front the badge is zero (`PushController.becameActive`); only a background app shows it.
      if !inFront {
        await setBadge(remaining)
      }
    }
  }

  private func enqueue(_ work: @escaping @MainActor () async -> Void) {
    let previous = tail

    tail = Task { @MainActor in
      await previous?.value
      await work()
    }
  }
}
