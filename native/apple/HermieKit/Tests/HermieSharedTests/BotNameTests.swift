import Testing

@testable import HermieShared

/// `Identifiers.isBotName`: the one rule a chat link and a notification's bot name are held to.
@Suite("Bot names")
struct BotNameTests {
  @Test("names a person gives a bot pass", arguments: [
    "researcher", "code reviewer", "ünïcödé ✓ & friends?#%", "a.b", "…", String(repeating: "b", count: 128)
  ])
  func accepted(name: String) {
    #expect(Identifiers.isBotName(name))
  }

  @Test("anything that could leave a path segment, hide in a control character or run on is refused", arguments: [
    "", "/", "a/b", "../../x", ".", "..", "a\u{0}b", "a\nb", "a\u{7F}b", "a\u{200E}b", String(repeating: "b", count: 129)
  ])
  func refused(name: String) {
    #expect(!Identifiers.isBotName(name))
  }

  @Test("a chat link follows the same rule")
  func links() {
    #expect(DeepLink("hermie://chat/a%0Ab") == nil)
    #expect(DeepLink("hermie://chat/..") == nil)
    #expect(DeepLink("hermie://chat/\(String(repeating: "b", count: 129))") == nil)
    #expect(DeepLink("hermie://chat/\(String(repeating: "b", count: 128))") != nil)
  }
}
