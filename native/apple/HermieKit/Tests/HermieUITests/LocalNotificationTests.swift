import HermieCore
import HermieProtocol
import Testing
import UserNotifications

@testable import HermieUI

/// The system content built for a request's local notification, and the words in three languages.
/// Only value types are made; the notification centre is never touched in a test process.
@MainActor
@Suite("Local notifications: the system content and its words")
struct LocalNotificationTests {
  private func content(
    _ method: String = "approval", id: String = "appr-1", interruption: LocalInterruption = .active, badge: Int? = 2
  ) -> LocalNotificationContent {
    RequestAlertContent.make(
      OpenRequest(
        gatewayId: "g1", chat: "scout", chatName: "Scout", method: method, requestId: id, sessionId: "rt-1"),
      gatewayKey: "bf796761db84e312", preview: false, copy: .english, interruption: interruption, badge: badge)
  }

  @Test("the system content has the title, the thread, the default sound, the category and the badge")
  func mapsTheFields() {
    let system = SystemLocalNotifications.content(content())

    #expect(system.title == "Scout")
    #expect(system.body == "Needs your attention")
    #expect(system.threadIdentifier == "hermie.chat.bf796761db84e312.scout")
    #expect(system.categoryIdentifier == PushContract.requestCategory)
    #expect(system.sound == .default)
    #expect(system.badge == 2)
    #expect(system.interruptionLevel == .active)
  }

  @Test("a request that is not an approval has no category, and a content without a badge leaves it alone")
  func noCategoryNoBadge() {
    let system = SystemLocalNotifications.content(content("confirm", id: "srq-1", badge: nil))

    #expect(system.categoryIdentifier == "")
    #expect(system.badge == nil)
  }

  @Test("the time-sensitive level maps to the system's")
  func timeSensitive() {
    #expect(SystemLocalNotifications.content(content(interruption: .timeSensitive)).interruptionLevel == .timeSensitive)
  }

  @Test("the data bag survives the property list the system keeps, and reads as the payload of a remote push")
  func userInfoRoundTrips() throws {
    let source = content("confirm", id: "srq-9")
    let system = SystemLocalNotifications.content(source)
    let payload = try #require(PushPayload(userInfo: system.userInfo))

    #expect(payload.shape == .relay)
    #expect(payload == source.payload)
    #expect(payload.string("bot") == "scout")
    #expect(payload.string("requestId") == "srq-9")
    #expect(payload.string("method") == "confirm")
    #expect(payload.string("gatewayKey") == "bf796761db84e312")
    #expect(payload.requestMethod == .confirm)

    let tap = try #require(PushTap(actionIdentifier: "", payload: payload))
    #expect(tap.gatewayKey == "bf796761db84e312")
    #expect(tap.opensRequest)
  }

  @Test("the nested bag turns scalars and nothing else into the system's types")
  func foundationTypes() {
    let bag: JSONObject = ["a": "text", "b": 3, "c": true, "d": .null, "e": ["f": "g"], "h": ["i"]]
    let converted = SystemLocalNotifications.foundation(bag)

    #expect(converted["a"] as? String == "text")
    #expect(converted["b"] as? Double == 3)
    #expect(converted["c"] as? Bool == true)
    #expect(converted["d"] is NSNull)
    #expect((converted["e"] as? [AnyHashable: Any])?["f"] as? String == "g")
    #expect(converted["h"] as? [String] == ["i"])
  }

  // MARK: Words

  private static let keys: [PushRequestMethod: String] = [
    .approval: "approval", .clarify: "clarify", .secret: "secret", .sudo: "sudo",
    .vaultUnlockPrompt: "vaultUnlock", .vaultCode: "vaultCode", .vaultSaveLogin: "vaultSaveLogin",
    .confirm: "confirmPlain", .inputForm: "form", .inputFile: "file", .reviewDraft: "draft",
    .reviewDiff: "diff", .inputSignature: "signature", .deviceLocation: "location",
    .deviceContact: "contact", .deviceCalendar: "calendar", .deviceScan: "scan"
  ]

  @Test("every kind and the generic line is in all three languages, and the English is the contract's")
  func wordsInThreeLanguages() throws {
    #expect(Set(Self.keys.keys) == Set(PushRequestMethod.allCases))

    for (method, key) in Self.keys {
      let name = "native.requestAlert.\(key)"
      try expectTranslated(name)
      #expect(try nativeTexts(name)["en"] == RequestAlertCopy.english.phrase(method, nil), "\(method)")
    }

    try expectTranslated("native.requestAlert.confirmPasskey")
    #expect(
      try nativeTexts("native.requestAlert.confirmPasskey")["en"] == RequestAlertCopy.english.phrase(.confirm, .passkey))
    try expectTranslated("native.requestAlert.attention")
    #expect(try nativeTexts("native.requestAlert.attention")["en"] == RequestAlertCopy.english.attention)
  }

  @Test("the localised copy says something for every kind")
  func localisedCopy() {
    let copy = RequestAlertCopy.localized

    #expect(!copy.attention.isEmpty)

    for method in PushRequestMethod.allCases {
      #expect(!copy.phrase(method, nil).isEmpty, "\(method)")
      #expect(!copy.phrase(method, nil).hasPrefix("native."), "\(method) is looked up, not shown as its key")
    }

    #expect(copy.phrase(.confirm, .passkey) != copy.phrase(.confirm, .plain))
  }
}
