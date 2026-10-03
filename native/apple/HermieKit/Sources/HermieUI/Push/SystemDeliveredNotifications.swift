import HermieCore
import UserNotifications

/**
 The real `PushDeliveredNotifications`: what `UNUserNotificationCenter` still shows, and taking some
 of it away. A clearing push reaches it through `PushController.handleDelivery`; nothing else in the
 app removes a delivered notification.
 */
public struct SystemDeliveredNotifications: PushDeliveredNotifications {
  public init() {}

  public func delivered() async -> [PushDeliveredNotification] {
    let notifications = await UNUserNotificationCenter.current().deliveredNotifications()

    return notifications.map { notification in
      PushDeliveredNotification(
        identifier: notification.request.identifier,
        payload: PushPayload(userInfo: notification.request.content.userInfo)
      )
    }
  }

  public func remove(identifiers: [String]) async {
    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
  }
}
