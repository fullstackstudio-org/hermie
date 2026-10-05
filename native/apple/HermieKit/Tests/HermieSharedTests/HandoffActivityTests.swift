import Foundation
import Testing

@testable import HermieShared

private let key = "aaaaaaaaaaaaaaaa"

/// The repository root, found from this file: six levels up from `Tests/HermieSharedTests/<file>`.
private let repositoryRoot: URL = {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<6 { url.deleteLastPathComponent() }
  return url
}()

@Suite("Handoff activity")
struct HandoffActivityTests {
  @Test("a chat is advertised as its link and nothing else")
  func chatPayload() throws {
    let userInfo = try #require(HandoffActivity.userInfo(for: .chat(bot: "researcher", gatewayKey: key)))

    #expect(Set(userInfo.keys) == HandoffActivity.requiredUserInfoKeys)
    #expect(userInfo[HandoffActivity.linkKey] == "hermie://chat/researcher?gateway=\(key)")
  }

  @Test("a conversation of a bot is advertised with its session id, gateway and bot")
  func conversationPayload() throws {
    let link = DeepLink.conversation(bot: "researcher", session: "20260930_101500_ab12cd", gatewayKey: key)
    let userInfo = try #require(HandoffActivity.userInfo(for: link))

    #expect(userInfo[HandoffActivity.linkKey] == "hermie://conversation/20260930_101500_ab12cd?bot=researcher&gateway=\(key)")
  }

  @Test("the payload names a place and carries no message text: only the link's own parts appear")
  func noMessageText() throws {
    // A bot name is the only free text a link holds, and it is the roster's, not anything typed.
    let userInfo = try #require(HandoffActivity.userInfo(for: .chat(bot: "code reviewer", gatewayKey: key)))
    let payload = try #require(userInfo[HandoffActivity.linkKey])
    let components = try #require(URLComponents(string: payload))

    #expect(userInfo.count == 1)
    #expect(components.scheme == DeepLink.scheme)
    #expect(components.host == "chat")
    #expect(components.queryItems?.map(\.name) == ["gateway"])
    #expect(components.fragment == nil)
    #expect(components.user == nil && components.password == nil)
    #expect(DeepLink.chat(bot: "x", gatewayKey: key).string?.contains("?gateway=") == true)
  }

  @Test(
    "what is advertised round-trips to the route the receiving device follows",
    arguments: [
      DeepLink.chat(bot: "researcher", gatewayKey: key),
      DeepLink.chat(bot: "böb", gatewayKey: ""),
      DeepLink.chat(bot: "code reviewer", gatewayKey: key),
      DeepLink.conversation(bot: "researcher", session: "20260930_101500_ab12cd", gatewayKey: key),
      DeepLink.conversation(bot: "böb", session: "s1", gatewayKey: "")
    ]
  )
  func roundTrip(link: DeepLink) throws {
    let userInfo = try #require(HandoffActivity.userInfo(for: link))
    // As Handoff delivers it: a property list with `AnyHashable` keys.
    let delivered = Dictionary(uniqueKeysWithValues: userInfo.map { (AnyHashable($0.key), $0.value as Any) })

    #expect(HandoffActivity.link(from: delivered) == link)
  }

  @Test("an activity that is not a chat or a conversation is neither sent nor continued")
  func onlyPlacesEveryDeviceHas() {
    let id = "0f2a4c6e8a0c2e4f6a8c0e2f4a6c8e0f"

    for link in [DeepLink.share(id: id), .intent(id: id), .folder(id: "work"), .ask(bot: "researcher", gatewayKey: key)] {
      #expect(HandoffActivity.userInfo(for: link) == nil, "\(link)")
      #expect(HandoffActivity.link(from: [HandoffActivity.linkKey: link.string as Any]) == nil, "\(link)")
    }

    #expect(HandoffActivity.userInfo(for: nil) == nil)
    #expect(HandoffActivity.userInfo(for: .chat(bot: "", gatewayKey: key)) == nil)
  }

  @Test(
    "an activity from outside is held to the rules of a link from outside",
    arguments: [
      "https://hermie.dev/chat/researcher",
      "hermie://chat/researcher/settings",
      "hermie://chat/",
      "hermie://gateway/https%3A%2F%2Fevil.invalid",
      ""
    ]
  )
  func refusals(text: String) {
    #expect(HandoffActivity.link(from: [HandoffActivity.linkKey: text]) == nil)
  }

  @Test("an activity with no link, a link of the wrong type or under another key is dropped")
  func malformed() {
    #expect(HandoffActivity.link(from: nil) == nil)
    #expect(HandoffActivity.link(from: [:]) == nil)
    #expect(HandoffActivity.link(from: [HandoffActivity.linkKey: 7]) == nil)
    #expect(HandoffActivity.link(from: ["url": "hermie://chat/researcher"]) == nil)
  }

  @Test("both apps declare the activity type, and only that type")
  func declaredInBothApps() throws {
    for path in ["native/ios/App/Info.plist", "native/macos/App/Info.plist"] {
      let data = try Data(contentsOf: repositoryRoot.appendingPathComponent(path))
      let plist = try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

      #expect(plist["NSUserActivityTypes"] as? [String] == [HandoffActivity.type], "\(path)")
    }
  }
}
