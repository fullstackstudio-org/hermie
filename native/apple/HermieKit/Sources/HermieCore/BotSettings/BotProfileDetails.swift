import Foundation
import HermieProtocol

/// One toolset the bot can use (`profiles.describe` `toolsets`).
public struct BotToolset: Sendable, Hashable, Identifiable {
  public var name: String
  public var label: String
  /// What the toolset is for. Untrusted text.
  public var details: String
  public var toolCount: Int
  public var enabled: Bool

  public var id: String { name }

  public init(name: String, label: String? = nil, details: String = "", toolCount: Int = 0, enabled: Bool = true) {
    self.name = name
    self.label = label.flatMap { $0.isEmpty ? nil : $0 } ?? name
    self.details = details
    self.toolCount = toolCount
    self.enabled = enabled
  }
}

/// One skill or MCP server with a switch.
public struct BotSwitch: Sendable, Hashable, Identifiable {
  public var name: String
  public var enabled: Bool
  /// MCP servers only: `stdio`, `http`, and so on.
  public var transport: String

  public var id: String { name }

  public init(name: String, enabled: Bool = true, transport: String = "") {
    self.name = name
    self.enabled = enabled
    self.transport = transport
  }
}

/// The model a bot pins. Both empty while it follows the gateway's own.
public struct BotModelPin: Sendable, Hashable {
  public var provider: String
  public var model: String

  public init(provider: String = "", model: String = "") {
    self.provider = provider
    self.model = model
  }

  /// The bot names a model of its own.
  public var isPinned: Bool { !model.isEmpty }
}

/**
 Everything the bot settings screen reads from `profiles.describe`: the editor snapshot of one
 profile, as the domain values the screen works with.

 The three capability lists are stored three different ways on the gateway and every write replaces
 a WHOLE list (`BotSettingsParams`), so this keeps all of each. Every text field here is the
 gateway's and untrusted: it is drawn as plain text, never as Markdown.
 */
public struct BotProfileDetails: Sendable, Equatable {
  /// The profile's handle.
  public var name: String
  public var description: String
  /// The profile's `SOUL.md`: its system prompt.
  public var soul: String
  public var model: BotModelPin
  public var toolsets: [BotToolset]
  /// Whether the bot has a toolset list of its own. `false` does not mean nothing is on: the
  /// switches are the gateway's defaults, and the first one moved pins the whole list.
  public var toolsetsPinned: Bool
  public var skills: [BotSwitch]
  public var mcpServers: [BotSwitch]

  public init(
    name: String,
    description: String = "",
    soul: String = "",
    model: BotModelPin = BotModelPin(),
    toolsets: [BotToolset] = [],
    toolsetsPinned: Bool = false,
    skills: [BotSwitch] = [],
    mcpServers: [BotSwitch] = []
  ) {
    self.name = name
    self.description = description
    self.soul = soul
    self.model = model
    self.toolsets = toolsets
    self.toolsetsPinned = toolsetsPinned
    self.skills = skills
    self.mcpServers = mcpServers
  }

  /// A `profiles.describe` answer. `fallbackName` is the profile asked about, for an answer that
  /// leaves its own name out.
  public init(_ described: ProfilesDescribeResult, fallbackName: String) {
    self.init(
      name: described.name.flatMap { $0.isEmpty ? nil : $0 } ?? fallbackName,
      description: described.profileDescription ?? "",
      soul: described.soul ?? "",
      model: BotModelPin(provider: described.model?.provider ?? "", model: described.model?.model ?? ""),
      toolsets: (described.toolsets ?? []).compactMap { entry in
        guard let name = entry.name, !name.isEmpty else { return nil }

        return BotToolset(
          name: name,
          label: entry.label,
          details: entry.profileDescription ?? "",
          toolCount: entry.toolCount ?? 0,
          enabled: entry.enabled != false
        )
      },
      toolsetsPinned: described.toolsetsPinned == true,
      skills: (described.skills ?? []).compactMap { entry in
        guard let name = entry.name, !name.isEmpty else { return nil }
        return BotSwitch(name: name, enabled: entry.enabled != false)
      },
      mcpServers: (described.mcpServers ?? []).compactMap { entry in
        guard let name = entry.name, !name.isEmpty else { return nil }
        return BotSwitch(name: name, enabled: entry.enabled != false, transport: entry.transport ?? "stdio")
      }
    )
  }
}

/// The three lists of switches, which are written one at a time.
public enum BotCapabilitySection: String, Sendable, Hashable, CaseIterable {
  case toolsets
  case skills
  case mcp
}

/// One model the gateway offers, flattened out of `model.options`.
public struct BotModelChoice: Sendable, Hashable, Identifiable {
  public var provider: String
  public var providerName: String
  /// The model id as the provider spells it.
  public var model: String

  /// The value `profiles.configure` takes as `model`: `provider/model`.
  public var qualified: String { "\(provider)/\(model)" }

  public var id: String { qualified }

  public init(provider: String, providerName: String? = nil, model: String) {
    self.provider = provider
    self.providerName = providerName.flatMap { $0.isEmpty ? nil : $0 } ?? provider
    self.model = model
  }

  /// The flattened inventory, in the gateway's order. A provider without a slug or a model without
  /// a name is skipped.
  public static func choices(_ options: ModelOptionsResult) -> [BotModelChoice] {
    (options.providers ?? []).flatMap { provider -> [BotModelChoice] in
      guard let slug = provider.slug, !slug.isEmpty else {
        return []
      }

      return (provider.models ?? []).filter { !$0.isEmpty }.map {
        BotModelChoice(provider: slug, providerName: provider.name, model: $0)
      }
    }
  }
}
