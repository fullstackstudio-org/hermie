import HermieCore
import Testing
import UserNotifications

@testable import HermieUI

/// The system categories built from the contract's descriptors. Only the value types are made;
/// the notification centre is never touched in a test process.
@MainActor
@Suite("Push categories")
struct PushCategoryTests {
  @Test("each category carries Allow and Deny with the contract's flags and a localised title")
  func categories() {
    let categories = PushCategoryDescriptor.all(title: \.contractTitle).map(SystemPushBridge.category)

    #expect(categories.map(\.identifier) == ["hermie.request", "request", "hermie.approval"])

    for category in categories {
      #expect(category.actions.map(\.identifier) == ["hermie.request.allow", "hermie.request.deny"])

      let allow = category.actions[0]
      let deny = category.actions[1]

      // In front for now (`PushContract.actionsForegroundOverride`), and never from a locked device.
      #expect(allow.options == [.foreground, .authenticationRequired])
      #expect(deny.options == [.destructive, .foreground, .authenticationRequired])
      #expect(allow.title == Strings.Chat.Approval.Choices.once)
      #expect(deny.title == Strings.Chat.Approval.Choices.deny)
    }
  }

  @Test("presentation in front: banner and list, no sound, no badge")
  func presentation() {
    #expect(SystemPushBridge.options(.foreground) == [.banner, .list])
  }

  @Test("authorisation statuses map onto the three permissions")
  func permissions() {
    #expect(SystemPushBridge.permission(.authorized) == .granted)
    #expect(SystemPushBridge.permission(.provisional) == .granted)
    #expect(SystemPushBridge.permission(.denied) == .denied)
    #expect(SystemPushBridge.permission(.notDetermined) == .undetermined)
  }
}
