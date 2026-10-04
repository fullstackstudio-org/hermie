import Foundation
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

struct UserThemesTests {
  private func theme(_ id: String = "t1", name: String = "Mine", base: String = "blue") -> JSONObject {
    UserThemes.creating(base: base, name: name, id: id, in: []).first!
  }

  // MARK: Colours

  @Test func aColourIsSixHexDigitsAfterAHash() {
    #expect(UserThemes.parse("#2A72DC")! == (42, 114, 220))
    #expect(UserThemes.parse(" #c7ff4a ")! == (199, 255, 74))

    for bad in ["", "2A72DC", "#2A72D", "#2A72DCC", "#GGGGGG", "#+12345", "rgb(1,2,3)", "#12 456"] {
      #expect(UserThemes.parse(bad) == nil, "\(bad) is not a colour")
    }
  }

  @Test func hexIsUpperCaseAndClamped() {
    #expect(UserThemes.hex(red: 42, green: 114, blue: 220) == "#2A72DC")
    #expect(UserThemes.hex(red: -5, green: 300, blue: 0) == "#00FF00")
    #expect(UserThemes.hexText(0x1668E3) == "#1668E3")
  }

  @Test func theRatioIsTheWebsAndRoundedToTwoPlaces() {
    #expect(UserThemes.contrastWithWhite((255, 255, 255)) == 1)
    #expect(UserThemes.contrastWithWhite((0, 0, 0)) == 21)
    // The reference's own check: #767676 on white is the textbook 4.54.
    #expect(UserThemes.contrastWithWhite((0x76, 0x76, 0x76)) == 4.54)
  }

  @Test func theBubbleHasToCarryWhiteTextAndTheMessageSaysWhatWasMeasured() {
    #expect(UserThemes.judge(.accentBubble, "#2A72DC") == .ok)
    #expect(UserThemes.judge(.accentBubble, "#000000") == .ok)

    guard case .tooLight(let ratio, let floor) = UserThemes.judge(.accentBubble, "#FFFF00") else {
      Issue.record("yellow cannot carry white text")
      return
    }

    #expect(ratio < floor)
    #expect(floor == 4.5)
    #expect(UserThemes.judge(.accentBubble, "blue") == .malformed)
  }

  @Test func theAccentFillCarriesNoTextSoNoRatioAppliesToIt() {
    // The studio's own lime would be refused by any floor invented here.
    #expect(UserThemes.judge(.accentFill, "#C7FF4A") == .ok)
    #expect(UserThemes.judge(.accentFill, "#FFFFFF") == .ok)
    #expect(UserThemes.judge(.accentFill, "nope") == .malformed)
  }

  @Test func everyPresetAccentThePresetsShipPassesItsOwnGuard() {
    for preset in ThemeChoice.presets {
      let accent = UserThemes.presetAccent(preset)

      #expect(UserThemes.judge(.accentBubble, UserThemes.hexText(accent.bubbleHex)) == .ok, "\(preset)'s bubble")
    }
  }

  // MARK: Making

  @Test func aNewThemeIsACopyOfThePresetsTwoFloors() {
    let made = theme(base: "graphite")

    #expect(
      made == [
        "id": "t1", "name": "Mine", "base": "graphite", "light": ["background": "#F0F1F3"],
        "dark": ["background": "#2E3138"]
      ])
    #expect(UserThemes.id(of: made) == "t1")
    #expect(UserThemes.name(of: made) == "Mine")
    #expect(UserThemes.base(of: made) == "graphite")
  }

  @Test func aPresetNobodyKnowsIsBlue() {
    #expect(UserThemes.base(of: theme(base: "paisley")) == "blue")
    #expect(UserThemes.base(of: ["id": "x", "base": "paisley"]) == "blue")
  }

  @Test func theListGrowsAtTheEndAndAnIDIsAValue() {
    let list = UserThemes.creating(base: "lime", name: "B", id: "t2", in: [theme()])

    #expect(list.compactMap(UserThemes.id(of:)) == ["t1", "t2"])
    #expect(UserThemes.newID(now: 1_790_000_000_000, counter: 1) == "t" + String(1_790_000_000_000, radix: 36) + "1")
    #expect(UserThemes.newID(now: 1_790_000_000_000.9, counter: 36) == "t" + String(1_790_000_000_000, radix: 36) + "10")
  }

  // MARK: Editing

  @Test func renamingKeepsEverythingElse() {
    var made = theme()
    made["unknownByThisBuild"] = ["kept": true]

    let renamed = UserThemes.renaming("t1", to: "Evening", in: [made, theme("t2", name: "Other")])

    #expect(UserThemes.name(of: renamed[0]) == "Evening")
    #expect(renamed[0]["unknownByThisBuild"] == ["kept": true])
    #expect(UserThemes.name(of: renamed[1]) == "Other")
  }

  @Test func aColourIsSetOnOneFaceAndTheRestOfTheFaceIsKept() {
    var made = theme()
    made["dark"] = ["background": "#070F1D", "somethingNew": 3]

    let edited = UserThemes.setting(.accentBubble, .dark, to: " #2A72DC ", on: "t1", in: [made])[0]

    #expect(edited["dark"] == ["background": "#070F1D", "somethingNew": 3, "accentBubble": "#2A72DC"])
    #expect(edited["light"] == ["background": "#EAF3FF"], "the other face was not touched")
    #expect(UserThemes.stored(.accentBubble, .dark, in: edited) == "#2A72DC")
    #expect(UserThemes.stored(.accentBubble, .light, in: edited) == nil)
  }

  @Test func letGoOfAColourItFollowsThePresetAgainAndAnEmptyFaceGoes() {
    let set = UserThemes.setting(.accentFill, .light, to: "#C7FF4A", on: "t1", in: [theme()])
    #expect(UserThemes.stored(.accentFill, .light, in: set[0]) == "#C7FF4A")

    let back = UserThemes.setting(.accentFill, .light, to: nil, on: "t1", in: set)
    #expect(UserThemes.stored(.accentFill, .light, in: back[0]) == nil)
    #expect(back[0]["light"] == ["background": "#EAF3FF"])

    // A face left with nothing is not kept as an empty object.
    let bare = UserThemes.setting(.background, .light, to: nil, on: "t1", in: back)
    #expect(bare[0]["light"] == nil)
    #expect(bare[0]["dark"] != nil)
  }

  @Test func aStoredValueThatIsNotAColourIsNoColour() {
    let odd: JSONObject = ["id": "t1", "base": "blue", "light": ["accentFill": "red", "accentBubble": 4]]

    #expect(UserThemes.stored(.accentFill, .light, in: odd) == nil)
    #expect(UserThemes.stored(.accentBubble, .light, in: odd) == nil)
  }

  @Test func theColourAFieldShowsWhileItFollowsIsThePresets() {
    #expect(UserThemes.followed(.accentFill, .light, base: "blue") == "#1668E3")
    #expect(UserThemes.followed(.accentBubble, .dark, base: "blue") == "#2A72DC")
    #expect(UserThemes.followed(.accentBubble, .dark, base: "lime") == "#4A7F15")
    #expect(UserThemes.followed(.background, .dark, base: "graphite") == "#2E3138")
    #expect(UserThemes.followed(.background, .light, base: "paisley") == "#EAF3FF")
  }

  @Test func anEditNamingAThemeThatIsGoneChangesNothing() {
    let list = [theme()]

    #expect(UserThemes.setting(.accentFill, .light, to: "#C7FF4A", on: "ghost", in: list) == list)
    #expect(UserThemes.renaming("ghost", to: "x", in: list) == list)
  }

  // MARK: Deleting

  @Test func deletingTakesOutThatThemeOnly() {
    let list = UserThemes.creating(base: "lime", name: "B", id: "t2", in: [theme()])

    #expect(UserThemes.deleting("t1", from: list).compactMap(UserThemes.id(of:)) == ["t2"])
    #expect(UserThemes.deleting("ghost", from: list) == list)
  }

  @Test func theThemeThatWasOnFallsBackToItsBase() {
    let list = [theme("t1", base: "lime")]

    #expect(UserThemes.choice(afterDeleting: "t1", current: .user(id: "t1"), themes: list) == .preset("lime"))
    #expect(UserThemes.choice(afterDeleting: "t1", current: .preset("graphite"), themes: list) == .preset("graphite"))
    #expect(UserThemes.choice(afterDeleting: "t1", current: .user(id: "t9"), themes: list) == .user(id: "t9"))
    #expect(UserThemes.choice(afterDeleting: "ghost", current: .user(id: "ghost"), themes: list) == .preset("blue"))
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct UserThemeSettingsTests {
  private func open() throws -> (store: SQLiteStore, keyValues: KeyValueStore) {
    let store = try SQLiteStore(.inMemory)
    return (store, KeyValueStore(store: store))
  }

  @Test func aNewThemeIsStartedFromAPresetPutOnAndWrittenOnce() async throws {
    let opened = try open()
    let settings = AppSettings(keyValues: opened.keyValues, store: opened.store, clock: { 1_790_000_000_000 })
    await settings.hydrate()

    let id = settings.createUserTheme(base: "lime", name: "Lime")

    #expect(settings.synced.themeChoice == .user(id: id))
    #expect(settings.synced.userThemes.count == 1)
    #expect(UserThemes.base(of: settings.synced.userThemes[0]) == "lime")
    #expect(UserThemes.name(of: settings.synced.userThemes[0]) == "Lime")

    await settings.settled()
    let mirror = try await opened.keyValues.value(JSONObject.self, forKey: StoreKeys.syncedSettings)
    #expect(mirror?[UIMetaField.themes]?.arrayValue?.count == 1)
    #expect(mirror?[UIMetaField.themeChoice] == ["kind": "user", "id": .string(id)])

    let again = AppSettings(keyValues: opened.keyValues, store: opened.store)
    await again.hydrate()
    #expect(again.synced.userThemes == settings.synced.userThemes)
    #expect(again.synced.themeChoice == .user(id: id))
  }

  @Test func twoThemesMadeInOneMillisecondHaveTwoIDs() async throws {
    let settings = AppSettings(clock: { 1_790_000_000_000 })
    await settings.hydrate()

    let first = settings.createUserTheme(base: "blue", name: "A")
    let second = settings.createUserTheme(base: "blue", name: "B")

    #expect(first != second)
    #expect(settings.synced.userThemes.compactMap(UserThemes.id(of:)) == [first, second])
  }

  @Test func theColoursAreStoredWhenTheyPassAndNotWhenTheyDoNot() async throws {
    let settings = AppSettings()
    await settings.hydrate()
    let id = settings.createUserTheme(base: "blue", name: "Mine")

    settings.setThemeColour(.accentBubble, .dark, to: "#8244CE", on: id)
    #expect(UserThemes.stored(.accentBubble, .dark, in: settings.synced.userThemes[0]) == "#8244CE")

    // Refused: white text cannot be read on it. Nothing changes.
    settings.setThemeColour(.accentBubble, .dark, to: "#FFFF00", on: id)
    settings.setThemeColour(.accentFill, .dark, to: "not a colour", on: id)
    #expect(UserThemes.stored(.accentBubble, .dark, in: settings.synced.userThemes[0]) == "#8244CE")
    #expect(UserThemes.stored(.accentFill, .dark, in: settings.synced.userThemes[0]) == nil)

    settings.setThemeColour(.accentBubble, .dark, to: nil, on: id)
    #expect(UserThemes.stored(.accentBubble, .dark, in: settings.synced.userThemes[0]) == nil)
  }

  @Test func renamingAndDeletingGoThroughTheAccountsSettings() async throws {
    let settings = AppSettings()
    await settings.hydrate()
    let kept = settings.createUserTheme(base: "graphite", name: "Kept")
    let gone = settings.createUserTheme(base: "lime", name: "Gone")

    settings.renameUserTheme(kept, to: "Evening")
    #expect(UserThemes.name(of: UserThemes.theme(kept, in: settings.synced.userThemes)!) == "Evening")

    // The one that is on is deleted: the preset it was built on is on instead.
    #expect(settings.synced.themeChoice == .user(id: gone))
    settings.deleteUserTheme(gone)
    #expect(settings.synced.themeChoice == .preset("lime"))
    #expect(settings.synced.userThemes.compactMap(UserThemes.id(of:)) == [kept])

    // A theme that is not on goes without moving the choice.
    settings.setThemeChoice(.preset("blue"))
    settings.deleteUserTheme(kept)
    #expect(settings.synced.themeChoice == .preset("blue"))
    #expect(settings.synced.userThemes.isEmpty)
  }

  @Test func theChangesReachTheGatewaysSectionThroughTheSettingsBridge() async throws {
    let gateway = HoldingGateway()
    let sync = UIMetaSync.device(gateway.gateway)
    let settings = AppSettings()
    await settings.hydrate()
    let bridge = UIMetaSettingsBridge(store: settings, sync: sync)
    await bridge.start()
    await sync.reconcile()

    let id = settings.createUserTheme(base: "lime", name: "Mine")
    settings.setThemeColour(.accentFill, .light, to: "#C7FF4A", on: id)
    await bridge.settingsDidChange()
    await sync.reconcile()

    let section = gateway.meta("researcher")[ownerKey]
    let themes = section?[UIMetaField.themes]?.arrayValue ?? []
    #expect(themes.count == 1)
    #expect(themes.first?["id"]?.stringValue == id)
    #expect(themes.first?["light"]?["accentFill"] == "#C7FF4A")
    #expect(section?[UIMetaField.themeChoice] == ["kind": "user", "id": .string(id)])
  }
}
