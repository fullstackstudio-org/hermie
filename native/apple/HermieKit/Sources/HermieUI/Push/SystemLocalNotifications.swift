import HermieCore
import HermieProtocol
import UserNotifications

#if os(macOS)
  import AppKit
#endif

/**
 The real `LocalNotificationCenter`: a request's notification, posted at once (no trigger) through
 `UNUserNotificationCenter`. It never asks for permission: the notification onboarding does, and
 without it the system drops the request without a word.

 A tap, an action and a clearing push reach the app through the notification centre's delegate
 (`PushNotificationDelegate`) like a remote notification does, because the content carries the same
 data bag.
 */
@MainActor
public final class SystemLocalNotifications: LocalNotificationCenter {
  public init() {}

  public func post(_ content: LocalNotificationContent) async {
    let request = UNNotificationRequest(identifier: content.identifier, content: Self.content(content), trigger: nil)

    // The same identifier replaces what is delivered, so a request raised twice is one notification.
    try? await UNUserNotificationCenter.current().add(request)
  }

  public func remove(identifiers: [String]) async {
    let center = UNUserNotificationCenter.current()

    center.removePendingNotificationRequests(withIdentifiers: identifiers)
    center.removeDeliveredNotifications(withIdentifiers: identifiers)
  }

  // MARK: Mapping

  /// The system's content for one notification: the default sound, the thread of its chat, the
  /// category of an approval, and the data bag.
  nonisolated static func content(_ source: LocalNotificationContent) -> UNMutableNotificationContent {
    let content = UNMutableNotificationContent()

    content.title = source.title
    content.body = source.body
    content.threadIdentifier = source.threadIdentifier
    content.sound = .default
    content.userInfo = foundation(source.userInfo)

    if let category = source.categoryIdentifier {
      content.categoryIdentifier = category
    }

    if let badge = source.badge {
      content.badge = NSNumber(value: badge)
    }

    switch source.interruption {
    case .active: content.interruptionLevel = .active
    case .timeSensitive: content.interruptionLevel = .timeSensitive
    }

    return content
  }

  /// A data bag as the property list the system keeps: strings, numbers and booleans only.
  nonisolated static func foundation(_ object: JSONObject) -> [AnyHashable: Any] {
    var result: [AnyHashable: Any] = [:]

    for (key, value) in object {
      result[key] = foundation(value)
    }

    return result
  }

  private nonisolated static func foundation(_ value: JSONValue) -> Any {
    switch value {
    case .object(let object): foundation(object)
    case .array(let items): items.map(foundation)
    case .string(let text): text
    case .number(let number): number
    case .bool(let flag): flag
    case .null: NSNull()
    }
  }
}

/// The Mac's Dock icon, asked to bounce once.
@MainActor
public enum DockAttention {
  /// An informational request: the icon bounces once and stops, and nothing happens when the app is
  /// already in front. A confirmation is the one request this is for. iOS has no Dock: nothing.
  public static func bounce() {
    #if os(macOS)
      NSApplication.shared.requestUserAttention(.informationalRequest)
    #endif
  }
}
