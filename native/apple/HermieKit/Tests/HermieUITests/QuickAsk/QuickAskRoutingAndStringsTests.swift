import Foundation
import HermieCore
import Testing

@testable import HermieUI

private let home = GatewayIndex.Entry(id: "g0011223344556677", key: "aaaaaaaaaaaaaaaa")
private let work = GatewayIndex.Entry(id: "g8899aabbccddeeff", key: "bbbbbbbbbbbbbbbb")
private let both = GatewayIndex(entries: [home, work], activeId: home.id)

/// What "Open in Hermie" does to a main window's router: the chat it opens, the gateway it makes the
/// live one, and what it does when it arrives before the gateway list is known.
@MainActor
@Suite("Router: the quick ask")
struct QuickAskRoutingTests {
  @Test("the chat of the bot asked is selected on the gateway it was asked on")
  func opensTheChat() {
    let router = AppRouter()
    router.gatewaysChanged(both)

    let effects = router.openFromQuickAsk(ChatRef(gatewayId: home.id, bot: "writer"))

    #expect(effects.isEmpty)
    #expect(router.selectedChat == ChatRef(gatewayId: home.id, bot: "writer"))
    #expect(router.section == .chats)
  }

  @Test("a chat on a gateway that is not the live one makes it the live one, as a chat link does")
  func switchesGateway() {
    let router = AppRouter()
    router.gatewaysChanged(both)

    let effects = router.openFromQuickAsk(ChatRef(gatewayId: work.id, bot: "writer"))

    #expect(effects == [.activateGateway(work.id)])
    #expect(router.selectedGatewayId == work.id)
    #expect(router.selectedChat == ChatRef(gatewayId: work.id, bot: "writer"))
  }

  @Test("it closes what stood over the chat before, and a page pushed on another chat")
  func replacesThePreviousChat() {
    let router = AppRouter()
    router.gatewaysChanged(both)
    router.openChat(ChatRef(gatewayId: home.id, bot: "researcher"))
    router.showBotSettings(ChatRef(gatewayId: home.id, bot: "researcher"))
    router.present(.settings)

    router.openFromQuickAsk(ChatRef(gatewayId: home.id, bot: "writer"))

    #expect(router.selectedChat?.bot == "writer")
    #expect(router.detailPath.isEmpty)
    #expect(router.sheet == nil, "a settings sheet would cover the chat that was asked for")
  }

  @Test("a gateway this device no longer has opens nothing and says so")
  func unknownGateway() {
    let router = AppRouter()
    router.gatewaysChanged(both)

    let effects = router.openFromQuickAsk(ChatRef(gatewayId: "g-gone", bot: "writer"))

    #expect(effects.isEmpty)
    #expect(router.selectedChat == nil)
    #expect(router.notice == .gatewayNotConfigured)
  }

  @Test("asked before the gateway list is known, it waits for it and wins over a restored selection")
  func waitsForTheList() {
    let router = AppRouter()

    router.openFromQuickAsk(ChatRef(gatewayId: home.id, bot: "writer"))
    #expect(router.selectedChat == nil)
    #expect(router.pendingLinks.count == 1)

    router.restore(RouterSnapshot(selectedChat: ChatRef(gatewayId: home.id, bot: "restored")))
    #expect(router.selectedChat == nil, "a link has arrived: what the scene showed last time is not brought back")

    router.gatewaysChanged(both)
    #expect(router.selectedChat == ChatRef(gatewayId: home.id, bot: "writer"))
    #expect(router.pendingLinks.isEmpty)
  }
}

/// The quick ask's and General settings' sentences, in the three languages.
@MainActor
@Suite("Quick ask strings")
struct QuickAskStringsTests {
  @Test(arguments: [
    "native.quickAsk.title", "native.quickAsk.menuBarLabel", "native.quickAsk.bot", "native.quickAsk.openInHermieHint",
    "native.quickAsk.noGateway", "native.quickAsk.noBots", "native.quickAsk.openFailed", "native.quickAsk.waiting",
    "native.quickAsk.drop", "native.general.title", "native.general.blurb", "native.general.quickAsk",
    "native.general.showInMenuBar", "native.general.showInMenuBarFooter", "native.general.shortcut",
    "native.general.shortcutNone", "native.general.shortcutRecording", "native.general.shortcutRecordingHint",
    "native.general.shortcutHint", "native.general.shortcutReset", "native.general.shortcutFooter",
    "native.general.shortcutRefused", "native.general.shortcutTaken", "native.general.shortcutFailed",
    "native.general.shortcutActive"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }

  @Test func openInHermieIsTheSameBrandInEveryLanguageButNotTheSameWords() throws {
    let texts = try nativeTexts("native.quickAsk.openInHermie")

    #expect(texts.values.allSatisfy { $0.contains("Hermie") })
    #expect(Set(texts.values).count == 3)
  }

  @Test func theSentencesWithAWordInThemKeepTheirPlaceholders() throws {
    for key in [
      "native.quickAsk.openFailed", "native.quickAsk.waiting", "native.general.shortcutTaken",
      "native.general.shortcutFailed", "native.general.shortcutActive"
    ] {
      for (language, text) in try nativeTexts(key) {
        #expect(text.contains("%@"), "\(key) in \(language)")
      }
    }
  }

  @Test func theWordsAreReadWithTheirValuesInPlace() {
    #expect(NativeStrings.QuickAsk.waiting(for: "Researcher").contains("Researcher"))
    #expect(NativeStrings.QuickAsk.openFailed("no route").contains("no route"))
    #expect(NativeStrings.General.shortcutTaken("⌥Space").contains("⌥Space"))
    #expect(NativeStrings.General.shortcutFailed("⌥Space").contains("⌥Space"))
    #expect(NativeStrings.General.shortcutActive("⌥Space").contains("⌥Space"))
    #expect(!NativeStrings.QuickAsk.title.hasPrefix("native."))
  }

  #if os(macOS)
    @Test func generalIsACategoryOfTheMacWithItsWords() {
      #expect(SettingsCategory.groups.flatMap { $0 }.contains(.general))
      #expect(SettingsCategory.general.title == NativeStrings.General.title)
      #expect(SettingsCategory.general.blurb == NativeStrings.General.blurb)
      #expect(!SettingsCategory.general.systemImage.isEmpty)
    }

    /// The Services menu item is the app's own table, which the app's bundle holds, in all three languages.
    @Test func theServicesMenuItemIsTranslatedInTheAppsOwnTable() throws {
      let app = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("macos/App")
      var titles: [String: String] = [:]

      for language in ["en", "nl", "de"] {
        let table = app.appendingPathComponent("\(language).lproj/ServicesMenu.strings")
        let entries = try #require(NSDictionary(contentsOf: table) as? [String: String], "\(language) has no table")

        let title = entries["Send to Hermie"]
        #expect(title != nil, "\(language) lacks the item")
        titles[language] = title
      }

      #expect(titles["en"] == "Send to Hermie", "the key is the plist's own words")
      #expect(Set(titles.values).count == 3)
    }
  #endif
}
