import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

@Suite(.timeLimit(.minutes(1))) struct McpServersTypesTests {
  // MARK: Rows

  @Test func aConfigRowReadsItsAddressTransportAndEnvKeyNames() throws {
    let stdio = try #require(
      McpServerRow(
        config: jsonValue(
          #"{"name": "files", "transport": "stdio", "command": "npx", "args": ["-y", "server-fs", "/tmp"], "env": ["KEY"], "enabled": true, "tools": 2}"#
        )))
    let http = try #require(
      McpServerRow(
        config: jsonValue(
          #"{"name": "calendar", "transport": "http", "url": "https://c.example.test/mcp", "auth": "oauth", "oauth_tokens_present": false, "enabled": false, "tools": null}"#
        )))

    #expect(stdio.address == "npx -y server-fs /tmp")
    #expect(stdio.isHTTP == false)
    #expect(stdio.env == ["KEY"])
    #expect(stdio.toolCount == 2)
    #expect(http.address == "https://c.example.test/mcp")
    #expect(http.isHTTP)
    #expect(http.auth == "oauth")
    #expect(http.oauthTokensPresent == false)
    #expect(http.enabled == false)
    #expect(http.toolCount == 0, "a server never started has no tool count")
  }

  @Test func aRowWithNoNameIsDropped() {
    #expect(McpServerRow(config: jsonValue(#"{"transport": "http"}"#)) == nil)
    #expect(McpServerRow(config: jsonValue("[]")) == nil)
  }

  @Test func theRuntimeRowIsJoinedByNameAndNoRowIsUnknownNotFailed() throws {
    let row = try #require(McpServerRow(config: jsonValue(#"{"name": "files", "tools": 1}"#)))
    let connected = row.merged(runtime: ["status": "connected", "tools": 4])

    #expect(connected.runtime == .connected)
    #expect(connected.toolCount == 4)
    #expect(row.merged(runtime: nil).runtime == .unknown, "defined but never started")
    #expect(row.merged(runtime: ["status": "something-new"]).runtime == .unknown)
    #expect(row.merged(runtime: ["status": "lazy"]).runtime == .lazy)
  }

  // MARK: Probes

  @Test func aProbeThatConnectedHasItsTools() {
    let probe = McpProbe(
      jsonValue(#"{"ok": true, "tools": [{"name": "read_file", "description": "Read."}], "oauth_needed": false}"#))

    #expect(probe.ok)
    #expect(probe.needsAuth == false)
    #expect(probe.error == nil)
    #expect(probe.tools.map(\.name) == ["read_file"])
  }

  @Test func aProbeThatFailedIsNotOkEvenThoughTheCallSucceeded() {
    let probe = McpProbe(jsonValue(#"{"ok": false, "error": "spawn weather-mcp ENOENT", "tools": [], "oauth_needed": false}"#))

    #expect(probe.ok == false)
    #expect(probe.error == "spawn weather-mcp ENOENT")
    #expect(probe.needsAuth == false)
  }

  @Test func oauthNeededIsOnlyNeedsAuthWhileNoTokenIsOnDisk() {
    let missing = McpProbe(
      jsonValue(#"{"ok": false, "error": "OAuth authentication required", "oauth_needed": true, "oauth_tokens_present": false}"#))
    let held = McpProbe(jsonValue(#"{"ok": true, "oauth_needed": true, "oauth_tokens_present": true, "tools": []}"#))

    #expect(missing.needsAuth)
    #expect(held.needsAuth == false, "also true on a server that is authorised")
  }

  @Test func aFailedProbeWithNoWordsHasSome() {
    #expect(McpProbe(jsonValue(#"{"ok": false}"#)).error?.isEmpty == false)
  }

  // MARK: The catalogue

  @Test func aCatalogueEntryReadsWhatItNeedsAndWhetherItIsInstalled() throws {
    let entry = try #require(
      McpCatalogEntry(
        jsonValue(
          #"{"name": "github", "description": "Issues.", "installed": true, "enabled": false, "requires": ["GITHUB_TOKEN"], "transport": "stdio"}"#
        )))

    #expect(entry.installed)
    #expect(entry.enabled == false)
    #expect(entry.requires == ["GITHUB_TOKEN"])
    #expect(McpCatalogEntry(jsonValue(#"{"description": "no name"}"#)) == nil)
  }

  // MARK: The draft

  @Test func anHttpDraftNeedsANameAndAWebAddress() {
    #expect(McpServerDraft().problems == [.nameMissing, .urlInvalid])
    #expect(McpServerDraft(name: "a b", url: "https://x.example.test").problems == [.nameHasSpaces])
    #expect(McpServerDraft(name: "notes", url: "ftp://x.example.test").problems == [.urlInvalid])
    #expect(McpServerDraft(name: "notes", url: "not a url").problems == [.urlInvalid])
    #expect(McpServerDraft(name: "notes", url: " https://notes.example.test/mcp ").problems.isEmpty)
  }

  @Test func aStdioDraftNeedsACommand() {
    #expect(McpServerDraft(name: "files", kind: .stdio).problems == [.commandMissing])
    #expect(McpServerDraft(name: "files", kind: .stdio, command: "npx").problems.isEmpty)
  }

  @Test func theConfigIsTheUrlOrTheCommandWithItsArgumentsAndNilWhileThereIsAProblem() {
    #expect(McpServerDraft(name: "n", url: " https://n.example.test/mcp ").config == ["url": "https://n.example.test/mcp"])
    #expect(
      McpServerDraft(name: "f", kind: .stdio, command: "npx", arguments: "-y server-fs").config
        == ["command": "npx", "args": ["-y", "server-fs"]])
    #expect(McpServerDraft(name: "", url: "https://n.example.test").config == nil)
  }

  @Test func argumentsAreSplitLikeAShellWithoutExpandingAnything() {
    #expect(McpServerDraft.split("-y  server-fs /tmp") == ["-y", "server-fs", "/tmp"])
    #expect(McpServerDraft.split(#"--root "/my files" 'a b' c\ d"#) == ["--root", "/my files", "a b", "c d"])
    #expect(McpServerDraft.split("") == [])
    #expect(McpServerDraft.split("   ") == [])
    #expect(McpServerDraft.split(#"echo "" x"#) == ["echo", "", "x"], "an empty quoted word is a word")
    #expect(McpServerDraft.split("$HOME `x` $(y)") == ["$HOME", "`x`", "$(y)"], "nothing is expanded")
    #expect(McpServerDraft.split(#"it\'s"#) == ["it's"])
  }
}
