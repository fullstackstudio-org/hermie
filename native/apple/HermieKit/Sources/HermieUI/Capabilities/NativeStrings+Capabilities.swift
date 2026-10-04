import Foundation

/// What the capability pages (Memory, Skills, MCP servers, Connectors, Boards) say that the Expo app
/// does not, from `Resources/Native.xcstrings`. What the Expo app says in the same words is read from
/// the shared catalogue through `Strings.Memory`, `Strings.Skills`, `Strings.Mcp`, `Strings.Connectors`
/// and `Strings.Kanban`.
extension NativeStrings {
  enum Capability {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Connect to a gateway to use this. (a capability page while there is no live gateway)
    static var noGateway: String { string("native.capability.noGateway") }
    /// Bot (the label of the picker that says whose settings a page is reading)
    static var bot: String { string("native.capability.bot") }
  }

  enum SkillsPage {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// On (a skill the bot has switched on)
    static var on: String { string("native.skills.state.on") }
    /// Off (a skill the bot has switched off)
    static var off: String { string("native.skills.state.off") }
    /// Show more (the next page of the hub)
    static var more: String { string("native.skills.more") }
    /// Switch skills on or off in {name}'s settings (the link to the bot's own settings)
    static func openBotSettings(name: String) -> String {
      String(
        localized: "native.skills.openBotSettings", defaultValue: "Switch skills on or off in \(name)’s settings",
        table: "Native", bundle: .module)
    }
    /// Copy the command that removes it (a skill's menu)
    static var copyRemoveCommand: String { string("native.skills.copyRemoveCommand") }
    /// A skill is removed on the machine that runs the gateway…
    static var removeFooter: String { string("native.skills.removeFooter") }
    /// Source
    static var source: String { string("native.skills.source") }
    /// Trust
    static var trust: String { string("native.skills.trust") }
    /// Tags
    static var tags: String { string("native.skills.tags") }
    /// Start of SKILL.md
    static var preview: String { string("native.skills.preview") }
    /// Reading the details…
    static var detailsLoading: String { string("native.skills.detailsLoading") }
    /// The hub has nothing on this skill.
    static var detailsUnknown: String { string("native.skills.detailsUnknown") }
  }
}
