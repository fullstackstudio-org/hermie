import Foundation
import Testing

@testable import HermieShared

/// The cases of `expo/hermie/__tests__/deep-link.test.tsx` and `widget-deep-link.test.ts`, ported.
@Suite("Deep links")
struct DeepLinkTests {
  @Test("reads the bot out of a chat link")
  func chat() {
    #expect(DeepLink("hermie://chat/researcher") == .chat(bot: "researcher", gatewayKey: ""))
  }

  @Test("accepts the dev client scheme, so a link tested in development is the same link")
  func devScheme() {
    #expect(DeepLink("exp+hermie://chat/researcher") == .chat(bot: "researcher", gatewayKey: ""))
  }

  @Test("tolerates a trailing slash and a query nobody asked for")
  func trailing() {
    #expect(DeepLink("hermie://chat/researcher/") == .chat(bot: "researcher", gatewayKey: ""))
    #expect(DeepLink("hermie://chat/researcher?from=widget") == .chat(bot: "researcher", gatewayKey: ""))
    #expect(DeepLink("hermie://chat/researcher#top") == .chat(bot: "researcher", gatewayKey: ""))
  }

  @Test("decodes a name that had to be escaped")
  func escaped() {
    #expect(DeepLink("hermie://chat/code%20reviewer") == .chat(bot: "code reviewer", gatewayKey: ""))
  }

  @Test(
    "refuses links another app could send",
    arguments: [
      ("nothing at all", nil),
      ("an empty string", ""),
      ("another scheme", "https://hermie.dev/chat/researcher"),
      ("a look-alike scheme", "hermie-evil://chat/researcher"),
      ("no bot", "hermie://chat/"),
      ("no bot and no slash", "hermie://chat"),
      ("a second path segment", "hermie://chat/researcher/settings"),
      ("a verb this app does not answer", "hermie://gateway/https%3A%2F%2Fevil.invalid"),
      ("an escaped slash that would climb out of the chat", "hermie://chat/%2E%2E%2Fadmin"),
      ("a malformed escape", "hermie://chat/%E0%A4%A"),
      ("a fragment across a line break", "hermie://chat/researcher#a\nb")
    ] as [(String, String?)]
  )
  func refusals(label: String, url: String?) {
    #expect(DeepLink(url) == nil, "\(label)")
  }

  @Test("reads the id out of a share link, and never decodes it")
  func share() {
    let id = "0f2a4c6e8a0c2e4f6a8c0e2f4a6c8e0f"

    #expect(DeepLink("hermie://share/\(id)") == .share(id: id))
    #expect(DeepLink("hermie://share/abc?text=hello") == .share(id: "abc"))
  }

  @Test(
    "refuses a share link with a bad id",
    arguments: [
      "hermie://share/a%2Fb", "hermie://share/%2E%2E", "hermie://share/a%20b", "hermie://share/",
      "hermie://share/abc/def"
    ]
  )
  func shareRefusals(url: String) {
    #expect(DeepLink(url) == nil)
  }

  @Test("reads the id out of an intent link")
  func intent() {
    #expect(DeepLink("hermie://intent/0f2a4c6e") == .intent(id: "0f2a4c6e"))
  }

  @Test(
    "refuses an intent link with a bad id",
    arguments: ["hermie://intent/a%2Fb", "hermie://intent/", "hermie://intent/abc/def"]
  )
  func intentRefusals(url: String) {
    #expect(DeepLink(url) == nil)
  }

  @Test("reads the id out of a folder link")
  func folder() {
    #expect(DeepLink("hermie://folder/fm4k2a1") == .folder(id: "fm4k2a1"))
  }

  @Test(
    "refuses a folder link with a bad id",
    arguments: [
      "hermie://folder/a%2Fb", "hermie://folder/%2E%2E", "hermie://folder/", "hermie://folder/f1/open",
      "hermie://folder/a.b"
    ]
  )
  func folderRefusals(url: String) {
    #expect(DeepLink(url) == nil)
  }

  // MARK: The gateway key (widget-deep-link.test.ts)

  /// `gatewayKeyOf("https://gateway.example.com:8443")`, the pinned vector in `gateway-key.ts`.
  private let key = "bf796761db84e312"

  @Test("the key the app writes is what the parser accepts")
  func gatewayKey() {
    #expect(DeepLink("hermie://chat/researcher?gateway=\(key)") == .chat(bot: "researcher", gatewayKey: key))
    #expect(DeepLink("hermie://chat/some%20bot?gateway=\(key)") == .chat(bot: "some bot", gatewayKey: key))
    #expect(
      DeepLink("hermie://chat/researcher?from=widget&gateway=\(key)") == .chat(bot: "researcher", gatewayKey: key)
    )
  }

  @Test("a key that is not sixteen lowercase hex digits is dropped, not carried")
  func badGatewayKey() {
    for bad in ["BF796761DB84E312", "bf796761db84e31", "bf796761db84e3120", "https://evil.invalid", ""] {
      #expect(DeepLink("hermie://chat/researcher?gateway=\(bad)") == .chat(bot: "researcher", gatewayKey: ""))
    }
  }

  // MARK: Building

  @Test("built links parse back to the same link")
  func roundTrip() throws {
    let links: [DeepLink] = [
      .chat(bot: "researcher", gatewayKey: ""),
      .chat(bot: "researcher", gatewayKey: key),
      .chat(bot: "code reviewer", gatewayKey: key),
      .chat(bot: "ünïcödé ✓ & friends?#%", gatewayKey: ""),
      .conversation(bot: "researcher", session: "20260915_142233_a1b2c3", gatewayKey: key),
      .conversation(bot: "code reviewer & co?", session: "s1", gatewayKey: ""),
      .share(id: "0f2a4c6e8a0c2e4f6a8c0e2f4a6c8e0f"),
      .intent(id: "req.1"),
      .folder(id: "fm4k2a1")
    ]

    for link in links {
      let string = try #require(link.string)

      #expect(DeepLink(string) == link, "\(string)")
      #expect(link.url != nil)
    }

    #expect(
      DeepLink.chat(bot: "code reviewer", gatewayKey: key).string == "hermie://chat/code%20reviewer?gateway=\(key)"
    )
  }

  @Test("a link that could not parse back is not built")
  func refusedBuilds() {
    #expect(DeepLink.chat(bot: "", gatewayKey: "").string == nil)
    #expect(DeepLink.share(id: "../x").string == nil)
    #expect(DeepLink.intent(id: "").string == nil)
    #expect(DeepLink.folder(id: "a.b").string == nil)
    // A name with a slash is built escaped, and the parser then refuses it, as the TypeScript does.
    #expect(DeepLink(DeepLink.chat(bot: "a/b", gatewayKey: "").string) == nil)
    // A malformed key is left off rather than written.
    #expect(DeepLink.chat(bot: "x", gatewayKey: "nope").string == "hermie://chat/x")
  }

  // MARK: Conversation links

  @Test("reads the conversation, the bot and the gateway out of a conversation link")
  func conversation() {
    #expect(
      DeepLink("hermie://conversation/20260915_142233_a1b2c3?bot=researcher&gateway=\(key)")
        == .conversation(bot: "researcher", session: "20260915_142233_a1b2c3", gatewayKey: key))
    #expect(
      DeepLink("hermie://conversation/s1?bot=code%20reviewer")
        == .conversation(bot: "code reviewer", session: "s1", gatewayKey: ""))
    // The order of the parameters is nobody's business.
    #expect(
      DeepLink("hermie://conversation/s1?gateway=\(key)&bot=a")
        == .conversation(bot: "a", session: "s1", gatewayKey: key))
  }

  @Test(
    "refuses a conversation link that names no usable bot or session",
    arguments: [
      ("no bot", "hermie://conversation/s1"),
      ("an empty bot", "hermie://conversation/s1?bot="),
      ("a bot with an escaped slash", "hermie://conversation/s1?bot=a%2Fb"),
      ("a session that climbs", "hermie://conversation/..?bot=a"),
      ("a session with an escape", "hermie://conversation/a%2Fb?bot=a"),
      ("a second segment", "hermie://conversation/s1/extra?bot=a")
    ] as [(String, String)]
  )
  func conversationRefusals(label: String, url: String) {
    #expect(DeepLink(url) == nil, "\(label)")
  }

  @Test("a conversation link with a session or bot outside the alphabet is not built")
  func conversationRefusedBuilds() {
    #expect(DeepLink.conversation(bot: "a", session: "../x", gatewayKey: "").string == nil)
    #expect(DeepLink.conversation(bot: "a", session: "", gatewayKey: "").string == nil)
    #expect(DeepLink.conversation(bot: "", session: "s1", gatewayKey: "").string == nil)
    #expect(
      DeepLink.conversation(bot: "a", session: "s1", gatewayKey: "nope").string == "hermie://conversation/s1?bot=a")
  }
}
