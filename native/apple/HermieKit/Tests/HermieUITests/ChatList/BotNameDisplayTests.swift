import HermieCore
import Testing

@testable import HermieUI

@MainActor
@Suite("Bot names in the chat list")
struct BotNameDisplayTests {
  private let presence = Presence.of(gatewayReady: true, sessionAttached: true, working: false, needsInput: false)

  private func row(display: String, secondary: String?) -> ChatListRow {
    ChatListRow(bot: Bot(name: "ops", displayName: display), secondaryName: secondary)
  }

  @Test("a row that nothing named shows the handle beside a name that is another word")
  func derivedCompanion() {
    #expect(row(display: "Operations", secondary: nil).companionName == "ops")
    #expect(row(display: "ops", secondary: nil).companionName == "")
  }

  @Test("a row the reader's order named shows what it left")
  func chosenCompanion() {
    #expect(row(display: "ops", secondary: "Operations").companionName == "Operations", "the handle leads")
    #expect(row(display: "Operations", secondary: "").companionName == "", "the handle is hidden")
    #expect(row(display: "Operations", secondary: "ops").companionName == "ops")
  }

  @Test("VoiceOver reads the names in the order they are drawn, and never a hidden handle")
  func spoken() {
    let label = { (row: ChatListRow) in ChatListFormat.accessibilityLabel(row, presence: presence) }

    #expect(label(row(display: "Operations", secondary: "ops")).hasPrefix("Operations, ops"))
    #expect(label(row(display: "ops", secondary: "Operations")).hasPrefix("ops, Operations"))
    #expect(!label(row(display: "Operations", secondary: "")).contains("ops"))
    // Nothing chose: the handle follows a name that is another word, as before.
    #expect(label(row(display: "Operations", secondary: nil)).hasPrefix("Operations, ops"))
  }

  @Test("the two names are the Expo app's words")
  func settingsWords() {
    #expect(Strings.App.Settings.BotNameOptions.display != Strings.App.Settings.BotNameOptions.profile)
    #expect(!Strings.App.Settings.botNames.isEmpty)
    #expect(!Strings.App.Settings.hideHandle.isEmpty)
  }
}
