import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

@Suite(.timeLimit(.minutes(1))) struct McpServersServiceTests {
  private let rpc = ScriptedRPC()
  private var service: McpServersService { McpServersService(gateway: rpc.gateway) }

  @Test func theListIsTheConfigJoinedWithTheCachedRuntimeByName() async throws {
    rpc.respond(
      "mcp.servers.list",
      jsonValue(
        """
        {"servers": [{"name": "files", "transport": "stdio", "command": "npx", "args": [], "env": [], "enabled": true, "tools": 2},
                     {"name": "calendar", "transport": "http", "url": "https://c.example.test/mcp", "args": [], "env": [], "auth": "oauth", "enabled": true}]}
        """))
    rpc.respond(
      "mcp.servers.status",
      jsonValue(#"{"servers": [{"name": "files", "tools": 2, "status": "connected"}], "checked_at": 1}"#))

    let rows = try await service.servers(profile: "writer")

    #expect(rows.map(\.name) == ["files", "calendar"])
    #expect(rows.map(\.runtime) == [.connected, .unknown], "calendar has no runtime row: never started, not failed")
    #expect(rpc.calls("mcp.servers.list").first?["profile"] == "writer")
    #expect(rpc.calls("mcp.servers.status").first?["profile"] == "writer")
  }

  @Test func aGatewayThatCannotAnswerStatusStillListsTheServers() async throws {
    rpc.respond("mcp.servers.list", jsonValue(#"{"servers": [{"name": "files"}]}"#))
    rpc.refuse("mcp.servers.status", "unknown method", code: -32601)

    let rows = try await service.servers(profile: nil)

    #expect(rows.map(\.name) == ["files"])
    #expect(rows.first?.runtime == .unknown)
    #expect(rpc.calls("mcp.servers.list").first?["profile"] == nil, "the gateway's own: no scope is sent")
  }

  @Test func aRefusedListThrows() async {
    rpc.refuse("mcp.servers.list", "no such profile", code: 4001)

    await #expect(throws: GatewayRPCError.self) { try await service.servers(profile: "ghost") }
  }

  @Test func aProbeNamesTheServerAndTheBot() async throws {
    rpc.respond("mcp.servers.test", jsonValue(#"{"ok": true, "tools": [], "oauth_needed": false}"#))

    let probe = try await service.test("files", profile: "writer")

    #expect(probe.ok)
    #expect(rpc.calls("mcp.servers.test").first?["name"] == "files")
    #expect(rpc.calls("mcp.servers.test").first?["profile"] == "writer")
  }

  // MARK: OAuth

  @Test func anOAuthStartSendsNoClientRedirect() async throws {
    rpc.respond(
      "mcp.servers.oauth.start", jsonValue(#"{"ok": true, "session_id": "flow-1", "auth_url": "https://auth.example.test/x", "flow": "pkce"}"#))

    let started = try await service.startOAuth("calendar", profile: "writer")

    #expect(started.sessionID == "flow-1")
    #expect(started.authURL == "https://auth.example.test/x")
    #expect(rpc.calls("mcp.servers.oauth.start").first?["client_redirect_uri"] == nil, "this app hosts no loopback")
  }

  @Test func aPollIsPendingApprovedWithToolsOrFailedWithTheGatewaysWords() async throws {
    rpc.respond("mcp.servers.oauth.poll", jsonValue(#"{"ok": true, "status": "pending"}"#))
    #expect(try await service.pollOAuth("c", sessionID: "f", profile: nil) == .pending)

    rpc.respond("mcp.servers.oauth.poll", jsonValue(#"{"ok": true, "status": "approved", "tools": [{"name": "list_events"}]}"#))
    #expect(try await service.pollOAuth("c", sessionID: "f", profile: nil) == .approved([McpTool(name: "list_events")]))

    rpc.respond("mcp.servers.oauth.poll", jsonValue(#"{"ok": true, "status": "error", "error_message": "access_denied"}"#))
    #expect(try await service.pollOAuth("c", sessionID: "f", profile: nil) == .failed("access_denied"))

    rpc.respond("mcp.servers.oauth.poll", jsonValue(#"{"ok": true, "status": "error"}"#))
    if case .failed(let words) = try await service.pollOAuth("c", sessionID: "f", profile: nil) {
      #expect(words.isEmpty == false)
    } else {
      Issue.record("expected a failure")
    }
  }

  @Test func cancellingAFlowNeverThrows() async {
    rpc.refuse("mcp.servers.oauth.cancel", "gone", code: 4064)

    await service.cancelOAuth("c", sessionID: "f", profile: nil)

    #expect(rpc.calls("mcp.servers.oauth.cancel").count == 1)
  }

  // MARK: Writing

  @Test func addingFromAPresetNamesTheServerAfterIt() async throws {
    rpc.respond(
      "mcp.servers.add", jsonValue(#"{"ok": true, "name": "github", "server": {"name": "github", "transport": "stdio", "env": ["GITHUB_TOKEN"]}}"#))

    let row = try await service.addPreset("github", profile: "writer")

    #expect(row?.env == ["GITHUB_TOKEN"])

    let call = try #require(rpc.calls("mcp.servers.add").first)

    #expect(call["name"] == "github")
    #expect(call["preset"] == "github")
    #expect(call["profile"] == "writer")
  }

  @Test func aCustomHttpServerCarriesItsBearerTokenAndAStdioOneNeverDoes() async throws {
    rpc.respond("mcp.servers.add", jsonValue(#"{"ok": true, "name": "x", "server": {"name": "x"}}"#))

    _ = try await service.add(
      McpServerDraft(name: " notes ", url: "https://n.example.test/mcp", bearerToken: " sekret "), profile: nil)
    _ = try await service.add(
      McpServerDraft(name: "files", kind: .stdio, command: "npx", arguments: "-y fs", bearerToken: "ignored"), profile: nil)

    let http = try #require(rpc.calls("mcp.servers.add").first)
    let stdio = try #require(rpc.calls("mcp.servers.add").last)

    #expect(http["name"] == "notes")
    #expect(http["bearer_token"] == "sekret")
    #expect(http["config"]?["url"] == "https://n.example.test/mcp")
    #expect(stdio["bearer_token"] == nil, "a token means nothing to a stdio server")
    #expect(stdio["config"]?["command"] == "npx")
    #expect(stdio["config"]?["args"] == ["-y", "fs"])
  }

  @Test func aDraftWithProblemsIsNotSent() async {
    await #expect(throws: GatewayRPCError.self) { try await service.add(McpServerDraft(), profile: nil) }
    #expect(rpc.calls("mcp.servers.add").isEmpty)
  }

  @Test func anApiKeyNamesTheEnvVarOnlyWhereOneWasGiven() async throws {
    rpc.respond("mcp.servers.set_api_key", jsonValue(#"{"ok": true, "name": "files", "env_var": "X"}"#))

    try await service.setAPIKey("files", value: "abc", envVar: nil, profile: "writer")
    try await service.setAPIKey("files", value: "abc", envVar: "GITHUB_TOKEN", profile: "writer")

    let calls = rpc.calls("mcp.servers.set_api_key")

    #expect(calls.first?["env_var"] == nil)
    #expect(calls.last?["env_var"] == "GITHUB_TOKEN")
    #expect(calls.first?["value"] == "abc")
    #expect(calls.first?["profile"] == "writer")
  }

  @Test func aRemoveThatRemovedNothingIsAFailure() async {
    rpc.respond("mcp.servers.remove", jsonValue(#"{"ok": true, "removed": false}"#))

    await #expect(throws: GatewayRPCError.self) { try await service.remove("files", profile: nil) }
  }

  // MARK: Reloading

  @Test func aReloadMayRefuseByAnsweringAndTheSecondCallConfirms() async throws {
    rpc.handle("reload.mcp") { params in
      params["confirm"] == true || params["always"] == true
        ? jsonValue(#"{"status": "reloaded"}"#)
        : jsonValue(#"{"status": "confirm_required", "message": "This invalidates the prompt cache."}"#)
    }

    #expect(try await service.reload() == .confirmationRequired("This invalidates the prompt cache."))
    #expect(try await service.reload(confirm: true) == .reloaded)
    #expect(rpc.calls("reload.mcp").last?["confirm"] == true)
    #expect(try await service.reload(always: true) == .reloaded)
    #expect(rpc.calls("reload.mcp").last?["always"] == true)
  }
}
