import Foundation

// `profiles.describe` and `model.options`: what the bot settings screen reads. The writes are
// `ProfilesConfigureParams` and `profiles.set_asset` (`ProfileTypes.swift`).

/// `profiles.describe` params: the profile's identifier as `name`.
public struct ProfilesDescribeParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(name: String) {
    self.init()
    self.name = name
  }

  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
}

/// The model a profile pins: `provider` and the model id (`default` on the wire). Both empty while
/// the profile inherits.
public struct ProfileModelPin: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
  public var model: String? { get { json[field: "default"] } set { json[field: "default"] = newValue } }
}

/// One toolset of `profiles.describe`, as the `hermes tools` checklist presents it.
public struct ProfileToolsetEntry: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var label: String? { get { json[field: "label"] } set { json[field: "label"] = newValue } }
  /// The `description` field (`description` itself is the canonical text, as on every view).
  public var profileDescription: String? {
    get { json[field: "description"] }
    set { json[field: "description"] = newValue }
  }
  public var toolCount: Int? { get { json[field: "tool_count"] } set { json[field: "tool_count"] = newValue } }
  public var enabled: Bool? { get { json[field: "enabled"] } set { json[field: "enabled"] = newValue } }
}

/// One installed skill or one MCP server of `profiles.describe`: a name and whether it is on.
public struct ProfileCapabilityEntry: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var enabled: Bool? { get { json[field: "enabled"] } set { json[field: "enabled"] = newValue } }
  /// MCP servers only: `stdio`, `http`, and so on.
  public var transport: String? { get { json[field: "transport"] } set { json[field: "transport"] = newValue } }
}

/// `profiles.describe` result: everything the profile editor shows.
public struct ProfilesDescribeResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  /// The `description` field (`description` itself is the canonical text, as on every view).
  public var profileDescription: String? {
    get { json[field: "description"] }
    set { json[field: "description"] = newValue }
  }
  /// The profile's `SOUL.md`: its system prompt. Untrusted text.
  public var soul: String? { get { json[field: "soul"] } set { json[field: "soul"] = newValue } }
  public var model: ProfileModelPin? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
  public var skills: [ProfileCapabilityEntry]? { get { json[field: "skills"] } set { json[field: "skills"] = newValue } }
  public var toolsets: [ProfileToolsetEntry]? { get { json[field: "toolsets"] } set { json[field: "toolsets"] = newValue } }
  public var toolsetsPinned: Bool? {
    get { json[field: "toolsets_pinned"] }
    set { json[field: "toolsets_pinned"] = newValue }
  }
  public var mcpServers: [ProfileCapabilityEntry]? {
    get { json[field: "mcp_servers"] }
    set { json[field: "mcp_servers"] = newValue }
  }
}

/// One provider of `model.options`: its slug, a name to show, and the plain model ids it offers.
public struct ModelProviderEntry: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var slug: String? { get { json[field: "slug"] } set { json[field: "slug"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var models: [String]? { get { json[field: "models"] } set { json[field: "models"] = newValue } }
  public var totalModels: Int? { get { json[field: "total_models"] } set { json[field: "total_models"] = newValue } }
  public var isCurrent: Bool? { get { json[field: "is_current"] } set { json[field: "is_current"] = newValue } }
}

/// `model.options` result: the inventory, and the model in force for the caller.
public struct ModelOptionsResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var providers: [ModelProviderEntry]? { get { json[field: "providers"] } set { json[field: "providers"] = newValue } }
  public var model: String? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
}
