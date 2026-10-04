import Foundation

/// The strings of Settings › Chats and Settings › Appearance that only the native apps have
/// (`native.chats.*` and `native.appearance.*` in `Resources/Native.xcstrings`). The rest of both
/// pages is read from the catalogue the Expo app shares (`Strings.App.Settings`).
extension NativeStrings {
  enum Chats {
    /// What a new conversation shows
    static var defaultsHeader: String { String(localized: "native.chats.defaultsHeader", table: "Native", bundle: .module) }
    /// These follow you to your other devices signed in as you. A conversation with its own setting keeps it.
    static var defaultsFooter: String { String(localized: "native.chats.defaultsFooter", table: "Native", bundle: .module) }
    /// Transcripts on this device
    static var cacheHeader: String { String(localized: "native.chats.cacheHeader", table: "Native", bundle: .module) }
    /// Keep transcripts on this device
    static var cacheKeep: String { String(localized: "native.chats.cacheKeep", table: "Native", bundle: .module) }
    /// Recent conversations and the list of bots are kept here, so they open at once, before the gateway has answered. Switched off, nothing is kept, and switching off clears what is stored.
    static var cacheFooter: String { String(localized: "native.chats.cacheFooter", table: "Native", bundle: .module) }
    /// Clear Now
    static var cacheClear: String { String(localized: "native.chats.cacheClear", table: "Native", bundle: .module) }
    /// The stored transcripts were cleared.
    static var cacheCleared: String { String(localized: "native.chats.cacheCleared", table: "Native", bundle: .module) }
    /// Transcripts are no longer kept on this device, and what was stored is cleared.
    static var cacheOff: String { String(localized: "native.chats.cacheOff", table: "Native", bundle: .module) }
    /// Transcripts are kept on this device again.
    static var cacheOn: String { String(localized: "native.chats.cacheOn", table: "Native", bundle: .module) }
    /// The stored transcripts could not be cleared.
    static var cacheFailed: String { String(localized: "native.chats.cacheFailed", table: "Native", bundle: .module) }
  }

  enum Appearance {
    /// Accent colour
    static var tintHeader: String { String(localized: "native.appearance.tintHeader", table: "Native", bundle: .module) }
    /// Colours buttons, links and selections. It follows you to your other devices signed in as you.
    static var tintFooter: String { String(localized: "native.appearance.tintFooter", table: "Native", bundle: .module) }
    /// Hermie uses the language you set for it in the system settings, so every app can have its own.
    static var languageFooter: String {
      String(localized: "native.appearance.languageFooter", table: "Native", bundle: .module)
    }
    /// Change in Settings (iPhone and iPad: Hermie's own page in Settings)
    static var languageChange: String {
      String(localized: "native.appearance.languageChange", table: "Native", bundle: .module)
    }
    /// Change in System Settings (the Mac)
    static var languageChangeMac: String {
      String(localized: "native.appearance.languageChangeMac", table: "Native", bundle: .module)
    }
  }
}
