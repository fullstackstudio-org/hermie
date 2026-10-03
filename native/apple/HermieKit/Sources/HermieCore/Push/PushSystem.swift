import Foundation

/// Whether the system lets this app show notifications.
public enum PushPermission: String, Sendable, Equatable {
  /// Authorised (provisional and ephemeral count too; this app never asks for those).
  case granted
  /// The reader said no; only the system's settings can undo it.
  case denied
  /// Never asked.
  case undetermined
}

/// How a notification is shown while the app is in front.
public struct PushPresentation: Sendable, Equatable {
  public var banner: Bool
  public var list: Bool
  public var sound: Bool
  public var badge: Bool

  public init(banner: Bool, list: Bool, sound: Bool, badge: Bool) {
    self.banner = banner
    self.list = list
    self.sound = sound
    self.badge = badge
  }

  /**
   As the Expo app does it: still shown, without a sound and without touching the badge. The app
   cannot know whether the reader is looking at the chat it is about; that suppression is the
   gateway's, from the `seen` heartbeat.
   */
  public static let foreground = PushPresentation(banner: true, list: true, sound: false, badge: false)

  /// Not shown at all: a clearing push, which only takes a delivered notification away.
  public static let hidden = PushPresentation(banner: false, list: false, sound: false, badge: false)
}

/**
 The platform's notification machinery, behind a seam so everything above it runs in a test
 process, which has no bundle and must never touch `UNUserNotificationCenter`. The app's
 implementation is in HermieUI (`SystemPushBridge`); `InertPushSystem` stands in everywhere else.
 */
@MainActor
public protocol PushSystem: AnyObject {
  func permission() async -> PushPermission
  /// Show the system's question, if it can still be asked, and return the settled answer.
  func requestPermission() async -> PushPermission
  /// Ask APNs for a token; the answer arrives through `PushController.didRegister(deviceToken:)`.
  func registerForRemoteNotifications()
  func setCategories(_ categories: [PushCategoryDescriptor])
  func setBadgeCount(_ count: Int) async
  /// Open this app's page in the system's notification settings.
  func openSettings()
}

/// A system with no notifications: never granted, never registers. Tests and previews.
@MainActor
public final class InertPushSystem: PushSystem {
  public init() {}

  public func permission() async -> PushPermission { .undetermined }
  public func requestPermission() async -> PushPermission { .undetermined }
  public func registerForRemoteNotifications() {}
  public func setCategories(_ categories: [PushCategoryDescriptor]) {}
  public func setBadgeCount(_ count: Int) async {}
  public func openSettings() {}
}

/**
 Where the app delegate and the notification-centre delegate hand the system's callbacks.

 Those objects are created by the system, before any window, and on a background launch for a
 notification action there may never be a window at all, so they cannot be handed a controller
 through the view hierarchy. The app shell attaches its launch's `PushController` here in its `App`
 initialiser, which runs before the system delivers anything; whatever arrives earlier anyway is
 held and handed over on `attach`.
 */
@MainActor
public final class PushInbox {
  public static let shared = PushInbox()

  public private(set) weak var controller: PushController?

  private var pendingToken: Data?
  private var pendingFailure: String?
  private var pendingResponses: [(action: String, payload: PushPayload?)] = []

  init() {}

  public func attach(_ controller: PushController) {
    self.controller = controller

    if let token = pendingToken {
      pendingToken = nil
      controller.didRegister(deviceToken: token)
    }

    if let failure = pendingFailure {
      pendingFailure = nil
      controller.didFailToRegister(message: failure)
    }

    let responses = pendingResponses
    pendingResponses = []

    for response in responses {
      Task { await controller.handleResponse(actionIdentifier: response.action, payload: response.payload) }
    }
  }

  public func didRegister(deviceToken: Data) {
    if let controller {
      controller.didRegister(deviceToken: deviceToken)
    } else {
      pendingToken = deviceToken
    }
  }

  public func didFailToRegister(message: String) {
    if let controller {
      controller.didFailToRegister(message: message)
    } else {
      pendingFailure = message
    }
  }

  public func handleResponse(actionIdentifier: String, payload: PushPayload?) async {
    if let controller {
      await controller.handleResponse(actionIdentifier: actionIdentifier, payload: payload)
    } else {
      pendingResponses.append((actionIdentifier, payload))
    }
  }

  public func presentation(for payload: PushPayload?) -> PushPresentation {
    controller?.presentation(for: payload) ?? .foreground
  }

  /// A notification arrived (in front, or a silent data message in the background). A clearing push
  /// is handled; nil when the payload is not one, or when no controller is attached yet (a launch
  /// from a silent push then has nothing delivered to remove through the app, and the notification
  /// service extension, which does not need a controller, is the path for it: `PushClearing.apply`).
  @discardableResult
  public func handleDelivery(_ payload: PushPayload?) async -> Int? {
    await controller?.handleDelivery(payload)
  }
}
