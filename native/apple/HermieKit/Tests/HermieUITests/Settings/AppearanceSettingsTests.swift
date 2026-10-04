import HermieCore
import HermieProtocol
import HermieStore
import SwiftUI
import Testing

@testable import HermieUI

/// The pure parts of Settings › Appearance and › Chats: what a choice means, not how it is drawn.
@Suite("Appearance and Chats settings")
struct AppearanceSettingsTests {
  // MARK: The scheme

  @Test("system follows the device; light and dark pin the app")
  func scheme() {
    #expect(AppearanceChoice.system.colorScheme == nil)
    #expect(AppearanceChoice.light.colorScheme == .light)
    #expect(AppearanceChoice.dark.colorScheme == .dark)
  }

  // MARK: The text size

  @Test("a text size moves the transcript from where the device has it, one step at a time")
  func textSizeSteps() {
    #expect(TranscriptTextSize.standard.scaling(.large) == .large)
    #expect(TranscriptTextSize.small.scaling(.large) == .medium)
    #expect(TranscriptTextSize.large.scaling(.large) == .xLarge)
    #expect(TranscriptTextSize.xlarge.scaling(.large) == .xxLarge)
  }

  @Test("it is on top of the device's own size, and never leaves the sizes Dynamic Type has")
  func textSizeBounds() {
    #expect(TranscriptTextSize.small.scaling(.xLarge) == .large)
    #expect(TranscriptTextSize.xlarge.scaling(.xLarge) == .xxxLarge)
    #expect(TranscriptTextSize.small.scaling(.xSmall) == .xSmall)
    #expect(TranscriptTextSize.xlarge.scaling(.accessibility5) == .accessibility5)
    #expect(TranscriptTextSize.large.scaling(.accessibility4) == .accessibility5)
    #expect(TranscriptTextSize.xlarge.scaling(.accessibility3) == .accessibility5)
  }

  @Test("every text size has a name in the catalogue")
  func textSizeNames() {
    let names = TranscriptTextSize.allCases.map(\.label)
    #expect(Set(names).count == names.count)
    #expect(names.allSatisfy { !$0.isEmpty })
  }

  // MARK: The accent

  @Test("Blue is the app's own accent; Graphite and Lime are the colours the Expo app gives them")
  func presets() {
    #expect(ThemeAccent.of(.preset("blue"), userThemes: []) == .system)
    #expect(ThemeAccent.of(.preset("graphite"), userThemes: []) == .fixed(BotAccent.graphite.bubbleHex))
    #expect(ThemeAccent.of(.preset("lime"), userThemes: []) == .fixed(BotAccent.lime.bubbleHex))
    #expect(ThemeAccent.of(.preset("tartan"), userThemes: []) == .system)
  }

  @Test("a theme of the reader's own takes the accent it chose for each face, and its preset's for the rest")
  func userThemes() {
    let themes: [JSONObject] = [
      ["id": "both", "base": "lime", "light": ["accentBubble": "#112233"], "dark": ["accentFill": "#445566"]],
      ["id": "lightOnly", "base": "graphite", "light": ["accentBubble": "#112233"]],
      ["id": "plain", "base": "graphite", "dark": ["background": "#000000"]],
      ["id": "broken", "base": "lime", "light": ["accentBubble": "teal"]]
    ]

    #expect(ThemeAccent.of(.user(id: "both"), userThemes: themes) == .adaptive(light: 0x112233, dark: 0x445566))
    #expect(
      ThemeAccent.of(.user(id: "lightOnly"), userThemes: themes)
        == .adaptive(light: 0x112233, dark: BotAccent.graphite.bubbleHex))
    #expect(ThemeAccent.of(.user(id: "plain"), userThemes: themes) == .fixed(BotAccent.graphite.bubbleHex))
    #expect(ThemeAccent.of(.user(id: "broken"), userThemes: themes) == .fixed(BotAccent.lime.bubbleHex))
    // Deleted on another device: the window stays readable.
    #expect(ThemeAccent.of(.user(id: "gone"), userThemes: themes) == .system)
  }

  @Test("an accent is #RRGGBB or nothing")
  func hex() {
    #expect(ThemeAccent.hex("#0A1B2C") == 0x0A1B2C)
    #expect(ThemeAccent.hex("0A1B2C") == nil)
    #expect(ThemeAccent.hex("#0A1B2") == nil)
    #expect(ThemeAccent.hex("#GGGGGG") == nil)
    #expect(ThemeAccent.hex(nil) == nil)
  }

  @Test("the picker lists the presets, then the reader's own themes by name")
  func themeRows() {
    let rows = ThemeRow.rows(userThemes: [["id": "a", "name": "Studio"], ["id": "b"], ["name": "no id"]])

    #expect(rows.map(\.choice) == [.preset("blue"), .preset("graphite"), .preset("lime"), .user(id: "a"), .user(id: "b")])
    #expect(rows.map(\.name).suffix(2) == ["Studio", "b"])
    #expect(Set(rows.map(\.id)).count == rows.count)
    #expect(rows[1].isChosen(.preset("graphite")))
    #expect(!rows[1].isChosen(.preset("lime")))
    #expect(rows.allSatisfy { !$0.isChosen(.user(id: "gone")) })
  }

  // MARK: The language

  @Test("the language is named in its own words, from the app's own bundle")
  func language() {
    #expect(AppLanguage.current(preferred: ["nl"]) == "Nederlands")
    #expect(AppLanguage.current(preferred: ["de", "en"]) == "Deutsch")
    #expect(AppLanguage.current(preferred: ["en"]) == "English")
    #expect(AppLanguage.current(preferred: []) == "")
    #expect(AppLanguage.settingsURL != nil)
  }

  // MARK: The Chats page

  @MainActor
  private func makeSettings() throws -> (AppSettings, SQLiteStore) {
    let store = try SQLiteStore(.inMemory)
    return (AppSettings(keyValues: KeyValueStore(store: store), store: store), store)
  }

  @MainActor
  @Test("switching the cache off clears what is stored, and says so")
  func switchingOff() async throws {
    let (settings, store) = try makeSettings()
    let page = ChatsPageState()
    try await SQLiteChatCache(store: store, gatewayId: "g1").write(
      CachedTranscript(bot: "a", itemsJSON: "[]", lastRowId: nil, lastSeq: nil, epoch: nil, updatedAt: 1))

    await page.keep(false, in: settings)

    #expect(!settings.transcriptCache)
    #expect(page.message == .cacheOff)
    #expect(!page.clearing)
    #expect(try await SQLiteChatCache(store: store, gatewayId: "g1").read(bot: "a") == nil)
  }

  @MainActor
  @Test("switching it on keeps what is stored and says it is kept again")
  func switchingOn() async throws {
    let (settings, _) = try makeSettings()
    let page = ChatsPageState()

    settings.setTranscriptCache(false)
    await page.keep(true, in: settings)

    #expect(settings.transcriptCache)
    #expect(page.message == .cacheOn)
  }

  @MainActor
  @Test("Clear Now says it was cleared, and a database that refuses says that instead")
  func clearNow() async throws {
    let (settings, _) = try makeSettings()
    let page = ChatsPageState()

    await page.clearNow(in: settings)
    #expect(page.message == .cleared)
    #expect(!page.message!.isFailure)

    let failing = ChatsPageState()
    await failing.clearNow(in: AppSettings())
    #expect(failing.message == .failed)
    #expect(failing.message!.isFailure)
    #expect(!failing.clearing)
  }
}
