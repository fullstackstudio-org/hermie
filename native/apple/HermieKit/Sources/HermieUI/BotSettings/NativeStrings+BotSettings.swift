import Foundation

/// The bot settings screen's own sentences, from `Resources/Native.xcstrings`. What the Expo app says
/// in the same words (the photo, the model and provider rows, the MCP reload question, the
/// capability hints) is read from the shared catalogue through `Strings` instead.
extension NativeStrings {
  enum BotSettings {
    /// Bot settings
    static var title: String {
      String(localized: "native.botSettings.title", table: "Native", bundle: .module)
    }
    /// Open bot settings
    static var open: String {
      String(localized: "native.botSettings.open", table: "Native", bundle: .module)
    }
    /// Identity
    static var identity: String {
      String(localized: "native.botSettings.identity", table: "Native", bundle: .module)
    }
    /// Description
    static var descriptionHeader: String {
      String(localized: "native.botSettings.descriptionHeader", table: "Native", bundle: .module)
    }
    /// The name the rest of Hermie addresses this bot by. It cannot be changed here.
    static var handleHint: String {
      String(localized: "native.botSettings.handleHint", table: "Native", bundle: .module)
    }
    /// Everyone on this gateway sees this colour, and the other Hermie apps use it too.
    static var colourHint: String {
      String(localized: "native.botSettings.colourHint", table: "Native", bundle: .module)
    }
    /// Personality
    static var personality: String {
      String(localized: "native.botSettings.personality", table: "Native", bundle: .module)
    }
    /// The instructions that give this bot its character: the SOUL.md of its profile on the gateway.
    static var personalityHint: String {
      String(localized: "native.botSettings.personalityHint", table: "Native", bundle: .module)
    }
    /// No personality is set.
    static var personalityEmpty: String {
      String(localized: "native.botSettings.personalityEmpty", table: "Native", bundle: .module)
    }
    /// Revert
    static var revert: String {
      String(localized: "native.botSettings.revert", table: "Native", bundle: .module)
    }
    /// Choose a model
    static var modelChoose: String {
      String(localized: "native.botSettings.modelChoose", table: "Native", bundle: .module)
    }
    /// Follows the gateway’s model
    static var modelFollows: String {
      String(localized: "native.botSettings.modelFollows", table: "Native", bundle: .module)
    }
    /// This gateway does not list the models it offers, so the model cannot be changed here.
    static var modelUnavailable: String {
      String(localized: "native.botSettings.modelUnavailable", table: "Native", bundle: .module)
    }
    /// Toolsets
    static var toolsets: String {
      String(localized: "native.botSettings.toolsets", table: "Native", bundle: .module)
    }
    /// Skills
    static var skills: String {
      String(localized: "native.botSettings.skills", table: "Native", bundle: .module)
    }
    /// MCP servers
    static var mcp: String {
      String(localized: "native.botSettings.mcp", table: "Native", bundle: .module)
    }
    /// Follow the gateway’s defaults
    static var followDefaults: String {
      String(localized: "native.botSettings.followDefaults", table: "Native", bundle: .module)
    }
    /// At least one toolset has to stay on.
    static var lastToolset: String {
      String(localized: "native.botSettings.lastToolset", table: "Native", bundle: .module)
    }
    /// Chat list
    static var chatList: String {
      String(localized: "native.botSettings.chatList", table: "Native", bundle: .module)
    }
    /// About this bot
    static var about: String {
      String(localized: "native.botSettings.about", table: "Native", bundle: .module)
    }
    /// Your account can look at this bot but not change it.
    static var readOnly: String {
      String(localized: "native.botSettings.readOnly", table: "Native", bundle: .module)
    }
    /// Connect to the gateway to change these settings.
    static var offline: String {
      String(localized: "native.botSettings.offline", table: "Native", bundle: .module)
    }
    /// This gateway does not offer these settings.
    static var unsupported: String {
      String(localized: "native.botSettings.unsupported", table: "Native", bundle: .module)
    }
    /// The gateway accepted the change but did not apply it.
    static var notApplied: String {
      String(localized: "native.botSettings.notApplied", table: "Native", bundle: .module)
    }
    /// The name, colour, pin, mute and archive are saved as soon as Hermie has synced with the gateway.
    static var notSynced: String {
      String(localized: "native.botSettings.notSynced", table: "Native", bundle: .module)
    }
    /// That photo could not be prepared. Choose another one.
    static var photoLarge: String {
      String(localized: "native.botSettings.photoLarge", table: "Native", bundle: .module)
    }
  }
}
