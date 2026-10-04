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
    /// Save
    static var save: String { string("native.capability.save") }
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

  enum McpServersPage {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Add server…
    static var add: String { string("native.mcpServers.add") }
    /// Add server
    static var addTitle: String { string("native.mcpServers.addTitle") }
    /// FROM THE CATALOGUE
    static var catalogueHeader: String { string("native.mcpServers.catalogueHeader") }
    /// YOUR OWN SERVER
    static var customHeader: String { string("native.mcpServers.customHeader") }
    /// Kind
    static var kind: String { string("native.mcpServers.kind") }
    /// Web address
    static var kindHTTP: String { string("native.mcpServers.kindHTTP") }
    /// Command
    static var kindStdio: String { string("native.mcpServers.kindStdio") }
    /// Name
    static var name: String { string("native.mcpServers.name") }
    /// Web address
    static var url: String { string("native.mcpServers.url") }
    /// Command
    static var command: String { string("native.mcpServers.command") }
    /// Arguments
    static var arguments: String { string("native.mcpServers.arguments") }
    /// Separated by spaces. Put quotes around an argument that has spaces in it. The command runs on the gateway’s machine.
    static var argumentsHint: String { string("native.mcpServers.argumentsHint") }
    /// Bearer token (optional)
    static var bearer: String { string("native.mcpServers.bearer") }
    /// A token is sent to the gateway and stored in the bot’s .env there. Hermie does not keep it.
    static var bearerHint: String { string("native.mcpServers.bearerHint") }
    /// Give the server a name.
    static var nameMissing: String { string("native.mcpServers.nameMissing") }
    /// A name cannot have spaces in it.
    static var nameHasSpaces: String { string("native.mcpServers.nameHasSpaces") }
    /// Enter a web address that starts with https://.
    static var urlInvalid: String { string("native.mcpServers.urlInvalid") }
    /// Enter the command that starts the server.
    static var commandMissing: String { string("native.mcpServers.commandMissing") }
    /// The gateway sent a sign-in link that Hermie will not open.
    static var linkRefused: String { string("native.mcpServers.linkRefused") }
    /// It is taken out of this bot’s configuration. Chats that are already running keep it until the servers are reloaded.
    static var removeMessage: String { string("native.mcpServers.removeMessage") }
    /// Set API key…
    static var setKey: String { string("native.mcpServers.setKey") }
    /// Set API key
    static var keyTitle: String { string("native.mcpServers.keyTitle") }
    /// API key
    static var keyField: String { string("native.mcpServers.keyField") }
    /// Variable
    static var keyVariable: String { string("native.mcpServers.keyVariable") }
    /// The gateway stores the key in this bot’s .env. Hermie does not keep it.
    static var keyHint: String { string("native.mcpServers.keyHint") }

    /// Added {name}.
    static func added(name: String) -> String {
      String(localized: "native.mcpServers.added", defaultValue: "Added \(name).", table: "Native", bundle: .module)
    }
    /// Removed {name}.
    static func removed(name: String) -> String {
      String(localized: "native.mcpServers.removed", defaultValue: "Removed \(name).", table: "Native", bundle: .module)
    }
    /// Saved the API key for {name}.
    static func keySaved(name: String) -> String {
      String(
        localized: "native.mcpServers.keySaved", defaultValue: "Saved the API key for \(name).", table: "Native",
        bundle: .module)
    }
    /// Remove {name}?
    static func removeTitle(name: String) -> String {
      String(
        localized: "native.mcpServers.removeTitle", defaultValue: "Remove \(name)?", table: "Native", bundle: .module)
    }
    /// Switch it on or off in {name}'s settings
    static func openBotSettings(name: String) -> String {
      String(
        localized: "native.mcpServers.openBotSettings", defaultValue: "Switch it on or off in \(name)’s settings",
        table: "Native", bundle: .module)
    }
    /// Needs {keys}
    static func needs(keys: String) -> String {
      String(localized: "native.mcpServers.needs", defaultValue: "Needs \(keys)", table: "Native", bundle: .module)
    }
  }

  enum ConnectorsPage {
    /// The gateway sent a sign-in link that Hermie will not open. (not an https link, or the system would not open it)
    static var linkRefused: String {
      String(localized: "native.connectors.linkRefused", table: "Native", bundle: .module)
    }
  }

  enum KanbanPage {
    /// This board is no longer on the gateway. (a board that was removed since the list was read)
    static var boardGone: String { String(localized: "native.kanban.boardGone", table: "Native", bundle: .module) }
    /// Nobody (a card with no assignee)
    static var noAssignee: String { String(localized: "native.kanban.noAssignee", table: "Native", bundle: .module) }
  }
}
