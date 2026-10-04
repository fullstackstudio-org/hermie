import HermieCore
import HermieProtocol
import SwiftUI
import Testing

@testable import HermieUI

@MainActor
@Suite("Theme editor")
struct ThemeEditorTests {
  @Test("a theme without a name is untitled, and one with a name is called by it")
  func names() {
    #expect(ThemeText.name(of: ["id": "t1", "name": "  "]) == Strings.App.Settings.Themes.untitled)
    #expect(ThemeText.name(of: ["id": "t1"]) == Strings.App.Settings.Themes.untitled)
    #expect(ThemeText.name(of: ["id": "t1", "name": " Evening "]) == "Evening")
  }

  @Test("each face and each colour has a label of its own")
  func labels() {
    #expect(ThemeText.face(.light) != ThemeText.face(.dark))
    #expect(Set(ThemeColourField.allCases.map(ThemeText.label)).count == 3)
  }

  @Test("a refusal says what was wrong in the Expo app's words, with the ratio it measured")
  func rejections() {
    #expect(ThemeText.rejection(.ok) == nil)
    #expect(ThemeText.rejection(.malformed)?.contains(Strings.App.Settings.Themes.reasonMalformed) == true)

    let light = ThemeText.rejection(.tooLight(ratio: 1.07, floor: 4.5))
    #expect(light?.contains("1.07") == true)
    #expect(light?.contains(Strings.App.Settings.Themes.reasonBubble(ratio: "1.07")) == true)
  }

  @Test("a theme the reader made tints the app with the accent it chose for each face")
  func theTintFollowsTheEdit() throws {
    var themes = UserThemes.creating(base: "blue", name: "Mine", id: "t1", in: [])

    // Only floors so far: nothing of the theme's own to tint with, so its preset's tint.
    #expect(ThemeAccent.of(.user(id: "t1"), userThemes: themes) == .system)

    themes = UserThemes.setting(.accentBubble, .light, to: "#8244CE", on: "t1", in: themes)
    themes = UserThemes.setting(.accentFill, .dark, to: "#C7FF4A", on: "t1", in: themes)

    #expect(
      ThemeAccent.of(.user(id: "t1"), userThemes: themes)
        == .adaptive(light: 0x8244CE, dark: 0xC7FF4A))
  }

  @Test("a colour goes to the picker and back as the six digits it came from")
  func colourRoundTrip() throws {
    for hex in ["#2A72DC", "#C7FF4A", "#000000", "#FFFFFF", "#0B1206"] {
      let back = try #require(Color(themeHex: hex).themeHex)

      #expect(back == hex)
    }

    // Anything that is not a colour is a neutral grey in the picker.
    #expect(Color(themeHex: "nope").themeHex != nil)
  }

  @Test(arguments: [
    "app.settings.themes.title", "app.settings.themes.create", "app.settings.themes.accentFill",
    "app.settings.themes.accentBubble", "app.settings.themes.followPreset", "app.settings.themes.deleteHint"
  ])
  func theWordsAreTheExpoAppsAndTranslated(_ key: String) throws {
    // The shared catalogue's words: read in every language, not the Native table's.
    for language in ["en", "nl", "de"] {
      let path = try #require(HermieStringsLookup.bundle.path(forResource: language, ofType: "lproj"))
      let bundle = try #require(Bundle(path: path))

      #expect(bundle.localizedString(forKey: key, value: "MISSING", table: "Localizable") != "MISSING")
    }
  }
}
