import Foundation
import Testing

@testable import HermieCore

/// A preferences suite of its own, removed again when the test is done.
@MainActor
final class TemporaryDefaults {
  let suite = "quick-ask-test-\(UUID().uuidString)"
  let defaults: UserDefaults

  init() {
    defaults = UserDefaults(suiteName: suite)!
  }

  isolated deinit {
    defaults.removePersistentDomain(forName: suite)
  }
}

/// What the Mac keeps about the quick ask, in a suite of its own so a run never reads or writes the
/// reader's own preferences.
@MainActor
@Suite struct QuickAskSettingsTests {
  private let scratch = TemporaryDefaults()

  private func defaults() -> UserDefaults {
    scratch.defaults
  }

  @Test func aFreshMacShowsTheMenuBarItemAndHasOptionSpace() {
    let settings = QuickAskSettings(defaults: defaults())

    #expect(settings.showInMenuBar)
    #expect(settings.hotKey == .standard)
    #expect(settings.lastBot == nil)
  }

  @Test func theMenuBarSwitchIsKeptAcrossALaunchAndOnlyTheDepartureIsStored() {
    let settings = QuickAskSettings(defaults: defaults())

    settings.setShowInMenuBar(false)
    #expect(!QuickAskSettings(defaults: defaults()).showInMenuBar)
    #expect(defaults().object(forKey: QuickAskSettings.showKey) as? Bool == false)

    settings.setShowInMenuBar(true)
    #expect(QuickAskSettings(defaults: defaults()).showInMenuBar)
    #expect(defaults().object(forKey: QuickAskSettings.showKey) == nil, "the default is not written down")
  }

  @Test func aChosenShortcutIsKeptAndReadBackAsTheSameShortcut() {
    let settings = QuickAskSettings(defaults: defaults())
    let chosen = HotKeyShortcut(keyCode: 40, modifiers: [.command, .shift])

    #expect(settings.setHotKey(chosen))
    #expect(defaults().string(forKey: QuickAskSettings.hotKeyKey) == "shift+command+k")
    #expect(QuickAskSettings(defaults: defaults()).hotKey == chosen)
  }

  @Test func noShortcutIsNotTheSameAsTheDefault() {
    let settings = QuickAskSettings(defaults: defaults())

    #expect(settings.setHotKey(nil))
    #expect(QuickAskSettings(defaults: defaults()).hotKey == nil, "switched off stays off")

    settings.resetHotKey()
    #expect(QuickAskSettings(defaults: defaults()).hotKey == .standard)
    #expect(defaults().object(forKey: QuickAskSettings.hotKeyKey) == nil, "back to the default: nothing stored")
  }

  @Test func aShortcutThatIsNotValidIsNotTaken() {
    let settings = QuickAskSettings(defaults: defaults())

    #expect(!settings.setHotKey(HotKeyShortcut(keyCode: 0, modifiers: [])))
    #expect(settings.hotKey == .standard)
    #expect(defaults().object(forKey: QuickAskSettings.hotKeyKey) == nil)
  }

  @Test func aStoredValueThatDoesNotReadBackIsTheDefaultAndIsLeftWhereItIs() {
    defaults().set("hyper+banana", forKey: QuickAskSettings.hotKeyKey)

    #expect(QuickAskSettings(defaults: defaults()).hotKey == .standard)
    #expect(defaults().string(forKey: QuickAskSettings.hotKeyKey) == "hyper+banana")
  }

  @Test func theLastBotIsKeptWithItsGateway() {
    let settings = QuickAskSettings(defaults: defaults())
    let target = QuickAskTarget(gatewayID: "g2", bot: "writer")

    settings.setLastBot(target)
    #expect(QuickAskSettings(defaults: defaults()).lastBot == target)

    defaults().set(["gateway": "", "bot": "writer"], forKey: QuickAskSettings.lastBotKey)
    #expect(QuickAskSettings(defaults: defaults()).lastBot == nil, "half a record is none")
  }
}
