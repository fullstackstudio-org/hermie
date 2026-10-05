import Foundation
import Testing

@testable import HermieCore

/// The shortcut as data: what is stored, what is read back, what is shown and what is refused. No
/// keyboard, window or system is involved.
@Suite struct HotKeyShortcutTests {
  @Test func theStandardShortcutIsOptionSpace() {
    let standard = HotKeyShortcut.standard

    #expect(standard.keyCode == 49)
    #expect(standard.modifiers == [.option])
    #expect(standard.isValid)
    #expect(standard.display == "⌥Space")
    #expect(standard.storageString == "option+space")
  }

  @Test func aShortcutIsStoredInAFixedOrderAndReadBackTheSame() {
    let shortcut = HotKeyShortcut(keyCode: 40, modifiers: [.command, .shift, .option, .control])

    #expect(shortcut.storageString == "control+option+shift+command+k")
    #expect(HotKeyShortcut(storage: shortcut.storageString) == shortcut)

    for (key, code) in [("a", 0), ("0", 29), ("f12", 111), ("left", 123), ("grave", 50), ("return", 36)] {
      let written = HotKeyShortcut(keyCode: UInt16(code), modifiers: [.command]).storageString

      #expect(written == "command+\(key)")
      #expect(HotKeyShortcut(storage: written)?.keyCode == UInt16(code))
    }
  }

  @Test func theUsualSpellingsAreRead() {
    #expect(HotKeyShortcut(storage: "alt+Space") == .standard)
    #expect(HotKeyShortcut(storage: "  Option + SPACE ") == .standard)
    #expect(HotKeyShortcut(storage: "cmd+shift+K") == HotKeyShortcut(keyCode: 40, modifiers: [.command, .shift]))
    #expect(HotKeyShortcut(storage: "ctrl+enter") == HotKeyShortcut(keyCode: 36, modifiers: [.control]))
    #expect(HotKeyShortcut(storage: "option+esc") == HotKeyShortcut(keyCode: 53, modifiers: [.option]))
  }

  @Test func whatIsNotAShortcutIsNotRead() {
    for text in ["", "+", "option+", "space", "option+nokey", "option+space+k", "hyper+space", "option+shift", "shift+k"] {
      #expect(HotKeyShortcut(storage: text) == nil, "\(text)")
    }
  }

  @Test func aShortcutNeedsAModifierThatIsNotShiftUnlessItIsAFunctionKey() {
    #expect(!HotKeyShortcut(keyCode: 49, modifiers: []).isValid, "a bare key would be taken from every app")
    #expect(!HotKeyShortcut(keyCode: 0, modifiers: [.shift]).isValid, "Shift types capitals")
    #expect(HotKeyShortcut(keyCode: 0, modifiers: [.control]).isValid)
    #expect(HotKeyShortcut(keyCode: 0, modifiers: [.command, .shift]).isValid)
    #expect(HotKeyShortcut(keyCode: 111, modifiers: []).isValid, "F12 stands alone")
    #expect(HotKeyShortcut(keyCode: 64, modifiers: [.shift]).isValid, "F17 too")
    #expect(!HotKeyShortcut(keyCode: 200, modifiers: [.command]).isValid, "a key the table does not know")
    #expect(HotKeyShortcut(storage: "f5") == HotKeyShortcut(keyCode: 96, modifiers: []))
  }

  @Test func theModifiersAreCarbonsBits() {
    #expect(HotKeyShortcut(keyCode: 49, modifiers: [.command]).carbonModifiers == 0x0100)
    #expect(HotKeyShortcut(keyCode: 49, modifiers: [.shift]).carbonModifiers == 0x0200)
    #expect(HotKeyShortcut(keyCode: 49, modifiers: [.option]).carbonModifiers == 0x0800)
    #expect(HotKeyShortcut(keyCode: 49, modifiers: [.control]).carbonModifiers == 0x1000)
    #expect(HotKeyShortcut(keyCode: 49, modifiers: [.command, .option]).carbonModifiers == 0x0900)
    #expect(HotKeyShortcut(keyCode: 49, modifiers: []).carbonModifiers == 0)
  }

  @Test func aShortcutIsShownTheWayTheMenusShowIt() {
    #expect(HotKeyShortcut(keyCode: 40, modifiers: [.command, .shift, .option, .control]).display == "⌃⌥⇧⌘K")
    #expect(HotKeyShortcut(keyCode: 36, modifiers: [.command]).display == "⌘↩")
    #expect(HotKeyShortcut(keyCode: 123, modifiers: [.control, .option]).display == "⌃⌥←")
    #expect(HotKeyShortcut(keyCode: 96, modifiers: []).display == "F5")
  }

  @Test func everyKeyInTheTableHasOneNameAndOneCode() {
    var names: Set<String> = []
    var codes: Set<UInt16> = []

    for code in UInt16(0)...UInt16(130) {
      guard let name = HotKeyKeys.name(of: code) else { continue }

      #expect(names.insert(name).inserted, "\(name) twice")
      #expect(codes.insert(code).inserted)
      #expect(HotKeyKeys.code(named: name) == code, "\(name) does not come back")
    }

    #expect(codes.count == 26 + 10 + 11 + 6 + 4 + 4 + 20, "letters, digits, punctuation, edit keys, navigation, arrows, F1 to F20")
  }
}

/// A registrar that records instead of registering, so no test ever takes a real shortcut on the Mac it runs on.
@MainActor
final class FakeHotKeyRegistrar: GlobalHotKeyRegistering {
  private(set) var registered: [HotKeyShortcut] = []
  private(set) var unregistered = 0
  private(set) var current: HotKeyShortcut?
  /// What the next registrations throw, in order; empty: they succeed.
  var failures: [GlobalHotKeyError] = []
  private var handler: (@MainActor () -> Void)?

  func register(_ shortcut: HotKeyShortcut, handler: @escaping @MainActor () -> Void) throws(GlobalHotKeyError) {
    registered.append(shortcut)

    if !failures.isEmpty {
      throw failures.removeFirst()
    }

    current = shortcut
    self.handler = handler
  }

  func unregister() {
    unregistered += 1
    current = nil
    handler = nil
  }

  /// The person presses the shortcut.
  func press() {
    handler?()
  }
}

@MainActor
@Suite struct GlobalHotKeyControllerTests {
  private let scratch = TemporaryDefaults()

  private func settings() -> QuickAskSettings {
    QuickAskSettings(defaults: scratch.defaults)
  }

  @Test func theShortcutInTheSettingsIsRegisteredOnceAndPressingItRunsTheAction() {
    let registrar = FakeHotKeyRegistrar()
    var pressed = 0
    let controller = GlobalHotKeyController(settings: settings(), registrar: registrar) { pressed += 1 }

    controller.apply()
    controller.apply()
    #expect(registrar.registered == [.standard], "asked of the system once, however often it is applied")
    #expect(controller.status == .active(.standard))

    registrar.press()
    registrar.press()
    #expect(pressed == 2)
  }

  @Test func chosingAnotherShortcutLetsGoOfTheFirstAndKeepsTheChoice() {
    let registrar = FakeHotKeyRegistrar()
    let settings = settings()
    let controller = GlobalHotKeyController(settings: settings, registrar: registrar) {}
    let other = HotKeyShortcut(keyCode: 40, modifiers: [.command, .shift])

    controller.apply()
    #expect(controller.choose(other))

    #expect(registrar.registered == [.standard, other])
    #expect(registrar.current == other)
    #expect(settings.hotKey == other)
    #expect(controller.status == .active(other))
  }

  @Test func noShortcutGivesTheRegistrationBack() {
    let registrar = FakeHotKeyRegistrar()
    let controller = GlobalHotKeyController(settings: settings(), registrar: registrar) {}

    controller.apply()
    #expect(controller.choose(nil))

    #expect(registrar.current == nil)
    #expect(controller.status == .off)
  }

  @Test func suspendingLetsGoOfTheShortcutAndApplyTakesItBack() {
    let registrar = FakeHotKeyRegistrar()
    let settings = settings()
    let controller = GlobalHotKeyController(settings: settings, registrar: registrar) {}

    controller.apply()
    controller.suspend()
    #expect(registrar.current == nil, "the keys pressed while recording reach the field")
    #expect(controller.status == .off)
    #expect(settings.hotKey == .standard, "suspended is not forgotten")

    controller.apply()
    #expect(registrar.current == .standard)
    #expect(controller.status == .active(.standard))
    #expect(registrar.registered == [.standard, .standard])
  }

  @Test func aShortcutThatIsNotValidChangesNothing() {
    let registrar = FakeHotKeyRegistrar()
    let settings = settings()
    let controller = GlobalHotKeyController(settings: settings, registrar: registrar) {}

    controller.apply()
    #expect(!controller.choose(HotKeyShortcut(keyCode: 0, modifiers: [])))

    #expect(settings.hotKey == .standard)
    #expect(registrar.registered == [.standard])
    #expect(controller.status == .active(.standard))
  }

  @Test func aShortcutTheSystemRefusesIsReportedAndAskedForAgainLater() {
    let registrar = FakeHotKeyRegistrar()
    registrar.failures = [.taken]
    let controller = GlobalHotKeyController(settings: settings(), registrar: registrar) {}

    controller.apply()
    #expect(controller.status == .unavailable(.standard, .taken))
    #expect(registrar.current == nil)

    // The other app let go of it.
    controller.apply()
    #expect(controller.status == .active(.standard))
    #expect(registrar.current == .standard)
    #expect(registrar.registered.count == 2)
  }
}
