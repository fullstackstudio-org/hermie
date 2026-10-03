import HermieCore
import SwiftUI
import UserNotifications

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/**
 The real `PushSystem`: `UNUserNotificationCenter` for permission, categories and the badge, and the
 application object for the APNs token. Created by the app shell and handed to `AppLaunch`; nothing
 else in the app touches the notification centre.

 Permission is asked for alert, sound and badge, never provisionally (the Expo app did not either).
 */
@MainActor
public final class SystemPushBridge: PushSystem {
  public init() {}

  public func permission() async -> PushPermission {
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    return Self.permission(settings.authorizationStatus)
  }

  public func requestPermission() async -> PushPermission {
    let current = await permission()

    guard current == .undetermined else {
      // Asking again shows nothing and answers the same refusal; Settings says where to go instead.
      return current
    }

    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])

    return await permission()
  }

  public func registerForRemoteNotifications() {
    #if os(macOS)
      NSApplication.shared.registerForRemoteNotifications()
    #else
      UIApplication.shared.registerForRemoteNotifications()
    #endif
  }

  public func setCategories(_ categories: [PushCategoryDescriptor]) {
    UNUserNotificationCenter.current().setNotificationCategories(Set(categories.map(Self.category)))
  }

  public func setBadgeCount(_ count: Int) async {
    try? await UNUserNotificationCenter.current().setBadgeCount(count)
  }

  public func openSettings() {
    #if os(macOS)
      if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
        NSWorkspace.shared.open(url)
      }
    #else
      if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
        UIApplication.shared.open(url)
      }
    #endif
  }

  // MARK: Mapping

  nonisolated static func permission(_ status: UNAuthorizationStatus) -> PushPermission {
    switch status {
    case .authorized, .provisional, .ephemeral: .granted
    case .denied: .denied
    case .notDetermined: .undetermined
    @unknown default: .undetermined
    }
  }

  /// The system category for one descriptor, with the actions titled in the reader's language.
  static func category(_ descriptor: PushCategoryDescriptor) -> UNNotificationCategory {
    let actions = descriptor.actions.map { action in
      var options: UNNotificationActionOptions = []

      if action.destructive {
        options.insert(.destructive)
      }

      if action.foreground {
        options.insert(.foreground)
      }

      if action.requiresAuthentication {
        options.insert(.authenticationRequired)
      }

      return UNNotificationAction(identifier: action.identifier, title: title(for: action), options: options)
    }

    return UNNotificationCategory(identifier: descriptor.identifier, actions: actions, intentIdentifiers: [], options: [])
  }

  /// Allow is titled for what it sends (`once`), in the words the chat's own request card uses.
  static func title(for action: PushActionDescriptor) -> String {
    switch PushContract.Action(rawValue: action.identifier) {
    case .allow?: Strings.Chat.Approval.Choices.once
    case .deny?: Strings.Chat.Approval.Choices.deny
    case nil: action.title
    }
  }

  nonisolated static func options(_ presentation: PushPresentation) -> UNNotificationPresentationOptions {
    var options: UNNotificationPresentationOptions = []

    if presentation.banner {
      options.insert(.banner)
    }

    if presentation.list {
      options.insert(.list)
    }

    if presentation.sound {
      options.insert(.sound)
    }

    if presentation.badge {
      options.insert(.badge)
    }

    return options
  }
}

/**
 The notification centre's delegate: how a notification is shown in front, and what a tap or an
 action does. Both are handed to `PushInbox` (and from there to the launch's `PushController`) as
 a `PushPayload`, so nothing that is not `Sendable` leaves this object.
 */
public final class PushNotificationDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
  public static let shared = PushNotificationDelegate()

  public nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    let payload = PushPayload(userInfo: notification.request.content.userInfo)
    let presentation = await PushInbox.shared.presentation(for: payload)

    // A clearing push that arrives as an alert (the relay carries no silent ones) is not shown, and
    // takes away the notification it withdraws.
    if payload?.isClear == true {
      await PushInbox.shared.handleDelivery(payload)
    }

    return SystemPushBridge.options(presentation)
  }

  public nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
  ) async {
    let payload = PushPayload(userInfo: response.notification.request.content.userInfo)
    let action = response.actionIdentifier

    await PushInbox.shared.handleResponse(actionIdentifier: action, payload: payload)
  }
}

#if os(macOS)
  /**
   The Mac app's delegate, for push only: it puts the notification delegate in place before launch
   finishes (so a launch from a notification is not missed) and hands APNs' answer to `PushInbox`.
   */
  public final class PushAppDelegate: NSObject, NSApplicationDelegate {
    public func applicationWillFinishLaunching(_ notification: Notification) {
      UNUserNotificationCenter.current().delegate = PushNotificationDelegate.shared
    }

    public func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
      PushInbox.shared.didRegister(deviceToken: deviceToken)
    }

    public func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
      PushInbox.shared.didFailToRegister(message: error.localizedDescription)
    }

    /// A silent data message: only a clearing push means anything here.
    public func application(_ application: NSApplication, didReceiveRemoteNotification userInfo: [String: Any]) {
      let payload = PushPayload(userInfo: userInfo)

      Task { await PushInbox.shared.handleDelivery(payload) }
    }
  }
#else
  /**
   The iPhone and iPad app's delegate, for push only: it puts the notification delegate in place
   before launch finishes (so a launch from a notification is not missed) and hands APNs' answer to
   `PushInbox`.
   */
  public final class PushAppDelegate: NSObject, UIApplicationDelegate {
    public func application(
      _ application: UIApplication,
      willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
      UNUserNotificationCenter.current().delegate = PushNotificationDelegate.shared
      return true
    }

    public func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
      PushInbox.shared.didRegister(deviceToken: deviceToken)
    }

    public func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
      PushInbox.shared.didFailToRegister(message: error.localizedDescription)
    }

    /// A silent data message: only a clearing push means anything here.
    public func application(
      _ application: UIApplication,
      didReceiveRemoteNotification userInfo: [AnyHashable: Any]
    ) async -> UIBackgroundFetchResult {
      let payload = PushPayload(userInfo: userInfo)
      let removed = await PushInbox.shared.handleDelivery(payload)

      return (removed ?? 0) > 0 ? .newData : .noData
    }
  }
#endif
