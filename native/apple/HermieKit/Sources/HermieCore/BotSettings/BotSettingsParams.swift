import Foundation
import HermieProtocol

/**
 The params of every write the bot settings make, and how each answer is read, as pure functions so
 the rules that are invisible at the call site can be asserted without a socket.

 Every section of `profiles.configure` is independent: a request carries only the sections it
 means, and `applied` reports each. The three capability sections are stored with three different
 polarities, and every one of them replaces a WHOLE list (`profiles.configure` in the gateway's
 `methods_profiles.py`, and the Expo app's `capabilities-controller.ts`, which this follows):

 - **skills** are stored as the DISABLED set. Sending only the skill that changed would switch every
   other disabled skill back on.
 - **toolsets** are stored as an optional PIN of enabled names, and an EMPTY list removes the pin
   rather than emptying it. So a switch always writes the names that are on, which is exactly what
   is on screen; and "follow the gateway's defaults" is its own explicit request, an empty list
   (`toolsetDefaults`). Sending an empty list for "everything on" would be wrong whenever a toolset
   is off by default: the gateway would take the pin away and the toolset the person just switched
   on would be off again. A pin of nothing cannot be written at all.
 - **MCP servers** are stored per server as off, so the wire carries the ENABLED list, the opposite
   of skills in the same call.

 `tools.configure` is deliberately not used: it edits the profile of the live session it is handed,
 which is whichever bot happens to be talking.
 */
public enum BotSettingsParams {
  /// The one asset a profile has.
  public static let avatarAsset = "avatar"

  /// `description`: trimmed, as the gateway stores it.
  public static func description(_ profile: String, _ text: String) -> JSONObject {
    ["name": .string(profile), "description": .string(text.trimmingCharacters(in: .whitespacesAndNewlines))]
  }

  /// `soul`: the system prompt exactly as typed. Its whitespace is the author's.
  public static func soul(_ profile: String, _ text: String) -> JSONObject {
    ["name": .string(profile), "soul": .string(text)]
  }

  /// A model pin. `model` and `provider` go together or not at all (the gateway pins only when it
  /// has both), and `model` is the id exactly as `model.options` lists it, with the provider in its
  /// own field, as the gateway's desktop client sends it. Never `provider/model`: the gateway's
  /// `normalize_model_for_provider` keeps a leading `provider/` for openrouter, nous, ollama,
  /// lmstudio and the user's own providers, so a prefix added here would be part of the model's name
  /// and break that bot. `confirmExpensive` answers a `confirm_required` the gateway gave for a
  /// guarded model.
  public static func model(_ profile: String, _ choice: BotModelChoice, confirmExpensive: Bool = false) -> JSONObject {
    var params: JSONObject = [
      "name": .string(profile),
      "model": .string(choice.model),
      "provider": .string(choice.provider)
    ]

    if confirmExpensive {
      params["confirm_expensive_model"] = .bool(true)
    }

    return params
  }

  /// The toolsets that are on, whole: a pin of exactly what is on screen.
  public static func toolsets(_ profile: String, _ toolsets: [BotToolset]) -> JSONObject {
    ["name": .string(profile), "enabled_toolsets": .array(toolsets.filter(\.enabled).map { .string($0.name) })]
  }

  /// Take the pin away: the bot follows the gateway's own toolset defaults again. An empty list is
  /// how the gateway is asked.
  public static func toolsetDefaults(_ profile: String) -> JSONObject {
    ["name": .string(profile), "enabled_toolsets": .array([])]
  }

  /// The skills that are OFF, whole.
  public static func skills(_ profile: String, _ skills: [BotSwitch]) -> JSONObject {
    ["name": .string(profile), "disabled_skills": .array(skills.filter { !$0.enabled }.map { .string($0.name) })]
  }

  /// The MCP servers that are ON, whole.
  public static func mcp(_ profile: String, _ servers: [BotSwitch]) -> JSONObject {
    ["name": .string(profile), "enabled_mcp_servers": .array(servers.filter(\.enabled).map { .string($0.name) })]
  }

  /// `profiles.set_asset` with a picture: bare base64 (PNG, JPEG or WebP, up to 2 MB).
  public static func avatar(_ profile: String, base64: String) -> JSONObject {
    ["name": .string(profile), "asset": .string(avatarAsset), "data": .string(base64)]
  }

  /// `profiles.set_asset` taking the picture away.
  public static func clearAvatar(_ profile: String) -> JSONObject {
    ["name": .string(profile), "asset": .string(avatarAsset), "clear": .bool(true)]
  }

  /// `reload.mcp`: applies a changed MCP list to chats that are already running. Without
  /// `confirm` the gateway may answer `confirm_required`; `always` proceeds and clears that
  /// approval in the gateway's own config, which the CLI and the desktop app share.
  public static func reloadMcp(confirm: Bool = false, always: Bool = false, sessionID: String? = nil) -> JSONObject {
    var params: JSONObject = [:]

    if confirm { params["confirm"] = .bool(true) }
    if always { params["always"] = .bool(true) }
    if let sessionID, !sessionID.isEmpty { params["session_id"] = .string(sessionID) }

    return params
  }

  // MARK: - Reading the answers

  /// The key `applied` reports a section under: the gateway's word, which is not the parameter's.
  static func appliedKey(_ section: BotCapabilitySection) -> String {
    switch section {
    case .toolsets: "toolsets"
    case .skills: "skills"
    case .mcp: "mcp_servers"
    }
  }

  /// A `profiles.configure` answer for one section. A request the gateway accepted but did not
  /// apply is a failure the screen must say, not a success: `applied` names every section the
  /// request carried, so a section that is not `true` there was not written. An answer with no
  /// `applied` at all reports nothing, and is taken at its word.
  public static func check(_ reply: JSONValue, applied key: String) throws(BotSettingsFailure) {
    guard let applied = reply["applied"]?.objectValue else {
      return
    }

    if applied[key] != .bool(true) {
      throw .notApplied
    }
  }

  /// What a `profiles.configure` for a model said: written, or a guarded model that wrote nothing
  /// until the person confirms (`confirm_required`, with the gateway's own words).
  public enum ModelAnswer: Sendable, Equatable {
    case applied
    case confirmationRequired(String)
  }

  public static func modelAnswer(_ reply: JSONValue) throws(BotSettingsFailure) -> ModelAnswer {
    if reply["confirm_required"] == .bool(true) {
      let message = reply["confirm_message"]?.stringValue ?? ""

      return .confirmationRequired(message)
    }

    try check(reply, applied: "model")
    return .applied
  }

  /// What a `reload.mcp` said.
  public enum ReloadAnswer: Sendable, Equatable {
    case reloaded
    case confirmationRequired(String)
  }

  public static func reloadAnswer(_ reply: JSONValue) -> ReloadAnswer {
    if reply["status"]?.stringValue == "confirm_required" {
      return .confirmationRequired(reply["message"]?.stringValue ?? "")
    }

    return .reloaded
  }
}
