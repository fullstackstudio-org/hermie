import Foundation

// `profiles.*` params and results. `ProfileRow` is also the row of `GET /api/profiles`.

/// `profiles.list` params.
public struct ProfilesListParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  /// A boolean or a word upstream; kept raw.
  public var includeSessions: JSONValue? { get { json["include_sessions"] } set { json["include_sessions"] = newValue } }
}

/// `profiles.list` result.
public struct ProfilesListResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var profiles: [ProfileRow]? { get { json[field: "profiles"] } set { json[field: "profiles"] = newValue } }
  public var botModeProtocol: Bool? {
    get { json[field: "bot_mode_protocol"] }
    set { json[field: "bot_mode_protocol"] = newValue }
  }
}

/// One bot on the gateway.
public struct ProfileRow: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var path: String? { get { json[field: "path"] } set { json[field: "path"] = newValue } }
  public var isDefault: Bool? { get { json[field: "is_default"] } set { json[field: "is_default"] = newValue } }
  public var model: String? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
  /// The `description` field (`description` itself is the canonical text, as on every view).
  public var profileDescription: String? {
    get { json[field: "description"] }
    set { json[field: "description"] = newValue }
  }
  public var displayName: String? { get { json[field: "display_name"] } set { json[field: "display_name"] = newValue } }
  public var skillCount: Int? { get { json[field: "skill_count"] } set { json[field: "skill_count"] = newValue } }
  public var lastSession: ProfileSessionPreview? {
    get { json[field: "last_session"] }
    set { json[field: "last_session"] = newValue }
  }
  public var workerSession: ProfileWorkerSession? {
    get { json[field: "worker_session"] }
    set { json[field: "worker_session"] = newValue }
  }
  /// The profile's Bot Chat, when it has one.
  public var canonicalSession: ProfileCanonicalSession? {
    get { json[field: "canonical_session"] }
    set { json[field: "canonical_session"] = newValue }
  }
  /// Section → revision, the compare-and-swap counters of `ui_meta`.
  public var uiMetaRevisions: [String: Int]? {
    get { json[field: "ui_meta_revisions"] }
    set { json[field: "ui_meta_revisions"] = newValue }
  }
  /// Client-owned sections (`hermie-app`, `hermie-plugin`, …), kept raw.
  public var uiMeta: JSONObject? { get { json[field: "ui_meta"] } set { json[field: "ui_meta"] = newValue } }
  public var hasAvatar: Bool? { get { json[field: "has_avatar"] } set { json[field: "has_avatar"] = newValue } }
}

public struct ProfileSessionPreview: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  public var preview: String? { get { json[field: "preview"] } set { json[field: "preview"] = newValue } }
  public var startedAt: Double? { get { json[field: "started_at"] } set { json[field: "started_at"] = newValue } }
  public var lastActive: Double? { get { json[field: "last_active"] } set { json[field: "last_active"] = newValue } }
  public var messageCount: Int? { get { json[field: "message_count"] } set { json[field: "message_count"] = newValue } }
}

public struct ProfileWorkerSession: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  public var source: String? { get { json[field: "source"] } set { json[field: "source"] = newValue } }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  public var lastActive: Double? { get { json[field: "last_active"] } set { json[field: "last_active"] = newValue } }
}

public struct ProfileCanonicalSession: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  /// The stored id the chat is resumed by.
  public var id: String? { get { json[field: "id"] } set { json[field: "id"] = newValue } }
  /// The lineage tip REST rows are read under.
  public var resolvedID: String? { get { json[field: "resolved_id"] } set { json[field: "resolved_id"] = newValue } }
  public var rootTitle: String? { get { json[field: "root_title"] } set { json[field: "root_title"] = newValue } }
  public var title: String? { get { json[field: "title"] } set { json[field: "title"] = newValue } }
  public var preview: String? { get { json[field: "preview"] } set { json[field: "preview"] = newValue } }
  public var startedAt: Double? { get { json[field: "started_at"] } set { json[field: "started_at"] = newValue } }
  public var lastActive: Double? { get { json[field: "last_active"] } set { json[field: "last_active"] = newValue } }
  public var messageCount: Int? { get { json[field: "message_count"] } set { json[field: "message_count"] = newValue } }
}

/// `profiles.get_asset` params.
public struct ProfilesGetAssetParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public init(name: String, asset: String) {
    self.init()
    self.name = name
    self.asset = asset
  }

  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var asset: String? { get { json[field: "asset"] } set { json[field: "asset"] = newValue } }
}

/// `profiles.get_asset` result: `found`, and when found the bytes as base64 `data`.
public struct ProfilesGetAssetResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var found: Bool? { get { json[field: "found"] } set { json[field: "found"] = newValue } }
  public var mime: String? { get { json[field: "mime"] } set { json[field: "mime"] = newValue } }
  public var size: Int? { get { json[field: "size"] } set { json[field: "size"] = newValue } }
  public var data: String? { get { json[field: "data"] } set { json[field: "data"] = newValue } }
}

/// `profiles.configure` params; every section is optional and only the ones sent are touched.
public struct ProfilesConfigureParams: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var profile: String? { get { json[field: "profile"] } set { json[field: "profile"] = newValue } }
  public var name: String? { get { json[field: "name"] } set { json[field: "name"] = newValue } }
  public var uiMeta: JSONObject? { get { json[field: "ui_meta"] } set { json[field: "ui_meta"] = newValue } }
  public var uiMetaExpectedRevisions: [String: Int]? {
    get { json[field: "ui_meta_expected_revisions"] }
    set { json[field: "ui_meta_expected_revisions"] = newValue }
  }
  public var soul: String? { get { json[field: "soul"] } set { json[field: "soul"] = newValue } }
  /// The `description` field (`description` itself is the canonical text, as on every view).
  public var profileDescription: String? {
    get { json[field: "description"] }
    set { json[field: "description"] = newValue }
  }
  public var model: String? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
  public var provider: String? { get { json[field: "provider"] } set { json[field: "provider"] = newValue } }
  /// A boolean or a word upstream; kept raw.
  public var confirmExpensiveModel: JSONValue? {
    get { json["confirm_expensive_model"] }
    set { json["confirm_expensive_model"] = newValue }
  }
  public var disabledSkills: [String]? { get { json[field: "disabled_skills"] } set { json[field: "disabled_skills"] = newValue } }
  public var enabledToolsets: [String]? { get { json[field: "enabled_toolsets"] } set { json[field: "enabled_toolsets"] = newValue } }
  public var enabledMcpServers: [String]? {
    get { json[field: "enabled_mcp_servers"] }
    set { json[field: "enabled_mcp_servers"] = newValue }
  }
}

/// One `ui_meta` section whose expected revision no longer matched.
public struct UiMetaConflict: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var expected: JSONValue? { get { json["expected"] } set { json["expected"] = newValue } }
  public var actual: Int? { get { json[field: "actual"] } set { json[field: "actual"] = newValue } }
}

/// What a `profiles.configure` call actually wrote, per section.
public struct ProfilesConfigureApplied: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var uiMeta: Bool? { get { json[field: "ui_meta"] } set { json[field: "ui_meta"] = newValue } }
  public var uiMetaRevisions: [String: Int]? {
    get { json[field: "ui_meta_revisions"] }
    set { json[field: "ui_meta_revisions"] = newValue }
  }
  public var uiMetaConflicts: [String: UiMetaConflict]? {
    get { json[field: "ui_meta_conflicts"] }
    set { json[field: "ui_meta_conflicts"] = newValue }
  }
  public var soul: Bool? { get { json[field: "soul"] } set { json[field: "soul"] = newValue } }
  /// The `description` section flag (`description` itself is the canonical text).
  public var profileDescription: Bool? { get { json[field: "description"] } set { json[field: "description"] = newValue } }
  public var model: Bool? { get { json[field: "model"] } set { json[field: "model"] = newValue } }
  public var skills: Bool? { get { json[field: "skills"] } set { json[field: "skills"] = newValue } }
  public var toolsets: Bool? { get { json[field: "toolsets"] } set { json[field: "toolsets"] = newValue } }
  public var mcpServers: Bool? { get { json[field: "mcp_servers"] } set { json[field: "mcp_servers"] = newValue } }
}

/// `profiles.configure` result.
public struct ProfilesConfigureResult: JSONObjectBacked {
  public var json: JSONObject
  public init(json: JSONObject) { self.json = json }

  public var ok: Bool? { get { json[field: "ok"] } set { json[field: "ok"] = newValue } }
  public var applied: ProfilesConfigureApplied? { get { json[field: "applied"] } set { json[field: "applied"] = newValue } }
  public var confirmRequired: Bool? { get { json[field: "confirm_required"] } set { json[field: "confirm_required"] = newValue } }
  public var confirmMessage: String? { get { json[field: "confirm_message"] } set { json[field: "confirm_message"] = newValue } }
}
