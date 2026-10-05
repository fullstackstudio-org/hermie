import Foundation

/// The quick ask's and the Mac's General settings' own sentences, from `Resources/Native.xcstrings`.
extension NativeStrings {
  enum QuickAsk {
    /// Quick Ask (the window and the menu bar item)
    static var title: String { String(localized: "native.quickAsk.title", table: "Native", bundle: .module) }
    /// Ask a bot (the menu bar item's accessibility label)
    static var menuBarLabel: String {
      String(localized: "native.quickAsk.menuBarLabel", table: "Native", bundle: .module)
    }
    /// To (the label of the bot picker)
    static var bot: String { String(localized: "native.quickAsk.bot", table: "Native", bundle: .module) }
    /// Open in Hermie
    static var openInHermie: String {
      String(localized: "native.quickAsk.openInHermie", table: "Native", bundle: .module)
    }
    /// Opens this chat in the main window. (the hint)
    static var openInHermieHint: String {
      String(localized: "native.quickAsk.openInHermieHint", table: "Native", bundle: .module)
    }
    /// Sign in to a gateway to ask a bot.
    static var noGateway: String { String(localized: "native.quickAsk.noGateway", table: "Native", bundle: .module) }
    /// This gateway has no bots yet.
    static var noBots: String { String(localized: "native.quickAsk.noBots", table: "Native", bundle: .module) }
    /// The chat could not be opened: {reason}
    static func openFailed(_ reason: String) -> String {
      String(
        localized: "native.quickAsk.openFailed", defaultValue: "The chat could not be opened: \(reason)",
        table: "Native", bundle: .module)
    }
    /// Waiting for {bot}…
    static func waiting(for bot: String) -> String {
      String(
        localized: "native.quickAsk.waiting", defaultValue: "Waiting for \(bot)…", table: "Native", bundle: .module)
    }
    /// Drop text or files here
    static var drop: String { String(localized: "native.quickAsk.drop", table: "Native", bundle: .module) }
  }

  enum General {
    /// General (the Settings category)
    static var title: String { String(localized: "native.general.title", table: "Native", bundle: .module) }
    /// The menu bar and the shortcut that asks a bot from any app. (under the category)
    static var blurb: String { String(localized: "native.general.blurb", table: "Native", bundle: .module) }
    /// Quick ask (the section)
    static var quickAsk: String { String(localized: "native.general.quickAsk", table: "Native", bundle: .module) }
    /// Show in menu bar
    static var showInMenuBar: String {
      String(localized: "native.general.showInMenuBar", table: "Native", bundle: .module)
    }
    /// Ask a bot without opening Hermie… (under the switch)
    static var showInMenuBarFooter: String {
      String(localized: "native.general.showInMenuBarFooter", table: "Native", bundle: .module)
    }
    /// Shortcut
    static var shortcut: String { String(localized: "native.general.shortcut", table: "Native", bundle: .module) }
    /// None (no shortcut)
    static var shortcutNone: String {
      String(localized: "native.general.shortcutNone", table: "Native", bundle: .module)
    }
    /// Press the keys… (while recording)
    static var shortcutRecording: String {
      String(localized: "native.general.shortcutRecording", table: "Native", bundle: .module)
    }
    /// Escape cancels. Delete switches the shortcut off. (while recording)
    static var shortcutRecordingHint: String {
      String(localized: "native.general.shortcutRecordingHint", table: "Native", bundle: .module)
    }
    /// Starts recording a new shortcut. (the field's hint)
    static var shortcutHint: String {
      String(localized: "native.general.shortcutHint", table: "Native", bundle: .module)
    }
    /// Use ⌥Space
    static var shortcutReset: String {
      String(localized: "native.general.shortcutReset", table: "Native", bundle: .module)
    }
    /// Opens the quick ask from any app… (under the field)
    static var shortcutFooter: String {
      String(localized: "native.general.shortcutFooter", table: "Native", bundle: .module)
    }
    /// That is not a shortcut: use ⌘, ⌥ or ⌃ with a key, or a function key.
    static var shortcutRefused: String {
      String(localized: "native.general.shortcutRefused", table: "Native", bundle: .module)
    }
    /// Another app already uses {shortcut}. Choose another shortcut.
    static func shortcutTaken(_ shortcut: String) -> String {
      String(
        localized: "native.general.shortcutTaken",
        defaultValue: "Another app already uses \(shortcut). Choose another shortcut.", table: "Native",
        bundle: .module)
    }
    /// {shortcut} could not be set up. Choose another shortcut.
    static func shortcutFailed(_ shortcut: String) -> String {
      String(
        localized: "native.general.shortcutFailed",
        defaultValue: "\(shortcut) could not be set up. Choose another shortcut.", table: "Native", bundle: .module)
    }
    /// {shortcut} opens the quick ask from any app.
    static func shortcutActive(_ shortcut: String) -> String {
      String(
        localized: "native.general.shortcutActive", defaultValue: "\(shortcut) opens the quick ask from any app.",
        table: "Native", bundle: .module)
    }
  }
}
