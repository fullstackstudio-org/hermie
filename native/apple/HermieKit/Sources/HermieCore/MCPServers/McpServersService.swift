import Foundation
import HermieGateway
import HermieProtocol

/// The gateway's calls behind the MCP servers page. Every one of them is scoped to a profile where one
/// is named: the servers are configured per profile, so the list, a probe, an OAuth flow and a write
/// all land on that bot's config and nobody else's.
public struct McpServersService: Sendable {
  let gateway: BotSettingsGateway

  public init(gateway: BotSettingsGateway) {
    self.gateway = gateway
  }

  private func params(_ profile: String?, _ extra: JSONObject = [:]) -> JSONObject {
    var params = extra

    if let profile, !profile.isEmpty {
      params["profile"] = .string(profile)
    }

    return params
  }

  /// The list, as one paint: the config rows joined by name with the cached runtime rows. `status` is
  /// allowed to fail on its own: it only answers runtime rows for the launch profile (or under a
  /// multiplexer) and an older gateway may not have the method at all. Losing the dots is survivable;
  /// losing the list is not.
  public func servers(profile: String?) async throws -> [McpServerRow] {
    let listed = try await gateway.request(RPC.McpServersList.name, params(profile))
    let status = try? await gateway.request(RPC.McpServersStatus.name, params(profile))
    var runtime: [String: JSONObject] = [:]

    for row in status?["servers"]?.arrayValue ?? [] {
      if let object = row.objectValue, let name = object["name"]?.stringValue {
        runtime[name] = object
      }
    }

    return (listed["servers"]?.arrayValue ?? []).compactMap { McpServerRow(config: $0) }.map {
      $0.merged(runtime: runtime[$0.name])
    }
  }

  /// The curated presets, with what this profile has installed.
  public func catalog(profile: String?) async throws -> [McpCatalogEntry] {
    let result = try await gateway.request(RPC.McpCatalog.name, params(profile))

    return (result["servers"]?.arrayValue ?? []).compactMap { McpCatalogEntry($0) }
  }

  /// Connect to one server and list what it offers.
  public func test(_ name: String, profile: String?) async throws -> McpProbe {
    McpProbe(try await gateway.request(RPC.McpServersTest.name, params(profile, ["name": .string(name)])))
  }

  // MARK: OAuth

  /// Begin a PKCE flow: where to send the person, and the id the poll names.
  ///
  /// `client_redirect_uri` is deliberately not sent: it exists so a client that can host a loopback
  /// listener takes the redirect itself. This app offers none, so the gateway keeps its own and the
  /// flow works the ordinary way; sending the parameter without a listener behind it would break it.
  public func startOAuth(_ name: String, profile: String?) async throws -> (sessionID: String, authURL: String) {
    let result = try await gateway.request(RPC.McpServersOauthStart.name, params(profile, ["name": .string(name)]))

    return (result["session_id"]?.stringValue ?? "", result["auth_url"]?.stringValue ?? "")
  }

  public func pollOAuth(_ name: String, sessionID: String, profile: String?) async throws -> McpOAuthPoll {
    let result = try await gateway.request(
      RPC.McpServersOauthPoll.name, params(profile, ["name": .string(name), "session_id": .string(sessionID)]))

    switch result["status"]?.stringValue {
    case "approved":
      return .approved((result["tools"]?.arrayValue ?? []).compactMap { McpTool($0) })
    case "error":
      let said = CapabilityText.line(result["error_message"]?.stringValue)

      return .failed(said.isEmpty ? "Authorisation was refused." : said)
    default:
      return .pending
    }
  }

  /// Tell the gateway the flow is over: an abandoned PKCE flow holds a verifier and a listener on its
  /// side, and the person who gave up is the one who will try again in a minute. Best effort.
  public func cancelOAuth(_ name: String, sessionID: String, profile: String?) async {
    _ = try? await gateway.request(
      RPC.McpServersOauthCancel.name, params(profile, ["name": .string(name), "session_id": .string(sessionID)]))
  }

  // MARK: Writing

  /// Add a server from a catalogue preset.
  public func addPreset(_ preset: String, profile: String?) async throws -> McpServerRow? {
    McpServerRow(
      config: try await gateway.request(
        RPC.McpServersAdd.name, params(profile, ["name": .string(preset), "preset": .string(preset)]))["server"] ?? .null)
  }

  /// Add a server from what the person wrote. A bearer token goes to the profile's `.env` on the gateway
  /// and only a header template persists, so no answer ever carries it.
  public func add(_ draft: McpServerDraft, profile: String?) async throws -> McpServerRow? {
    guard let config = draft.config else {
      throw GatewayRPCError(.rejected, "The server is not complete.")
    }

    var extra: JSONObject = ["name": .string(draft.trimmedName), "config": .object(config)]
    let token = draft.bearerToken.trimmingCharacters(in: .whitespacesAndNewlines)

    if draft.kind == .http, !token.isEmpty {
      extra["bearer_token"] = .string(token)
    }

    return McpServerRow(
      config: try await gateway.request(RPC.McpServersAdd.name, params(profile, extra))["server"] ?? .null)
  }

  /// Write an API key for a server. The gateway puts it in the profile's `.env` and keeps only a
  /// reference in the config; `envVar` names the variable where the default (`MCP_<NAME>_API_KEY`) is
  /// not wanted, such as a key a preset asks for by name.
  public func setAPIKey(_ name: String, value: String, envVar: String?, profile: String?) async throws {
    var extra: JSONObject = ["name": .string(name), "value": .string(value)]

    if let envVar, !envVar.isEmpty {
      extra["env_var"] = .string(envVar)
    }

    _ = try await gateway.request(RPC.McpServersSetApiKey.name, params(profile, extra))
  }

  /// Take a server out of the profile's config.
  public func remove(_ name: String, profile: String?) async throws {
    let result = try await gateway.request(RPC.McpServersRemove.name, params(profile, ["name": .string(name)]))

    if result["removed"]?.boolValue == false {
      throw GatewayRPCError(.rejected, "The gateway did not remove \(name).")
    }
  }

  /// Ask the gateway to reload its MCP servers into the chats that are running. The call that can
  /// refuse by succeeding: without `confirm` it may answer `confirm_required` with no error frame.
  public func reload(confirm: Bool = false, always: Bool = false) async throws -> BotSettingsParams.ReloadAnswer {
    BotSettingsParams.reloadAnswer(
      try await gateway.request(RPC.ReloadMcp.name, BotSettingsParams.reloadMcp(confirm: confirm, always: always)))
  }
}
