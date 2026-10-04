import HermieCore
import Testing

@testable import HermieUI

@Suite("Notification preferences")
struct NotificationPreferencesTests {
  @Test("every kind of notification a device can switch has a label of its own")
  func labels() {
    let labels = PushContract.types.map(PushTypeText.label)

    #expect(Set(labels).count == PushContract.types.count)
    #expect(zip(PushContract.types, labels).allSatisfy { $0 != $1 }, "no kind is shown under its wire name")
  }

  @Test("a kind this build does not know is shown as the wire names it")
  func unknownKind() {
    #expect(PushTypeText.label("telepathy") == "telepathy")
  }

  @Test(arguments: ["native.push.preferencesWriteFailed", "native.push.noTypeWanted"])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }
}
