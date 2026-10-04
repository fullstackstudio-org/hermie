#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// What an OAuth walk opens the link with: records it. A class, because a closure that mutates a local
/// across the walk's suspensions is what the Swift 6.4 runtime crashes on.
@MainActor
private final class Browser {
  var opened: [URL] = []

  func open(_ url: URL) -> Bool {
    opened.append(url)

    return true
  }
}

extension Integration {
  /// The MCP servers page's model against the real fake gateway, over a real socket: the config joined with
  /// the cached runtime, a probe of each outcome, the OAuth walk, the catalogue, and every write.
  @Suite("MCP servers") @MainActor
  struct McpServersIntegrationTests {
    private func withModel(
      profile: String? = "researcher",
      _ body: @escaping @MainActor @Sendable (GatewaySession, McpServersModel, FakeGateway) async throws -> Void
    ) async throws {
      try await withCapabilitySession { session, gateway in
        let model = McpServersModel(
          service: McpServersService(gateway: .link(session.link)), profile: profile, pollInterval: .milliseconds(10))
        await model.load()

        try await body(session, model, gateway)
      }
    }

    @Test("the servers are listed with the cached runtime state and what each needs")
    func lists() async throws {
      try await withModel { _, model, _ in
        #expect(model.phase == .ready)
        #expect(model.servers.map(\.name) == ["files", "calendar", "weather"])
        #expect(model.server(named: "files")?.runtime == .connected)
        #expect(model.server(named: "files")?.address == "npx -y @modelcontextprotocol/server-filesystem /tmp")
        #expect(model.server(named: "calendar")?.isHTTP == true)
        #expect(model.server(named: "calendar")?.auth == "oauth")
        #expect(model.server(named: "weather")?.runtime == .failed)
        #expect(model.server(named: "weather")?.env == ["WEATHER_API_KEY"], "key names only, never values")
      }
    }

    @Test("a probe finds a server that works, one that needs authorising and one that cannot start")
    func probes() async throws {
      try await withModel { _, model, _ in
        await model.test("files")
        await model.test("calendar")
        await model.test("weather")

        guard case .done(let files) = model.probes["files"], case .done(let calendar) = model.probes["calendar"],
          case .done(let weather) = model.probes["weather"]
        else {
          Issue.record("expected three probes, got \(model.probes)")
          return
        }

        #expect(files.ok)
        #expect(files.tools.map(\.name) == ["read_file", "write_file"])
        #expect(calendar.ok == false && calendar.needsAuth, "an anonymous tools/list is still not authorised")
        #expect(weather.ok == false && weather.needsAuth == false)
        #expect(weather.error == "spawn weather-mcp ENOENT")
      }
    }

    @Test("the OAuth walk opens the link, polls until approved, and the probe is clean afterwards")
    func authorises() async throws {
      try await withModel { _, model, _ in
        let browser = Browser()

        let done = await model.authorise("calendar", open: browser.open)

        #expect(done)
        #expect(browser.opened.count == 1)
        #expect(browser.opened.first?.host == "calendar.example.test")
        #expect(model.notice == .authorised("calendar"))

        await model.test("calendar")

        if case .done(let probe) = model.probes["calendar"] {
          #expect(probe.ok && probe.needsAuth == false)
        } else {
          Issue.record("expected a probe")
        }
      }
    }

    @Test("a stdio server cannot be walked through OAuth, and the gateway says so")
    func stdioHasNoOAuth() async throws {
      try await withModel { _, model, _ in
        #expect(await model.authorise("files") { _ in true } == false)
        #expect(model.notice == .authoriseFailed("stdio servers authenticate via env keys, not OAuth"))
      }
    }

    @Test("the catalogue lists the presets, and adding one installs it")
    func catalogue() async throws {
      try await withModel { _, model, _ in
        await model.loadCatalog()

        guard case .loaded(let entries) = model.catalog else {
          Issue.record("expected the catalogue, got \(model.catalog)")
          return
        }

        #expect(entries.map(\.name) == ["github", "fetch", "linear"])
        #expect(entries.first?.requires == ["GITHUB_TOKEN"])

        #expect(await model.addPreset(entries[0]))
        #expect(model.server(named: "github")?.env == ["GITHUB_TOKEN"])

        if case .loaded(let after) = model.catalog {
          #expect(after.first { $0.name == "github" }?.installed == true)
        }
      }
    }

    @Test("a custom http server is added with its bearer token, which no answer carries back")
    func addsWithABearerToken() async throws {
      try await withModel { _, model, gateway in
        #expect(await model.add(McpServerDraft(name: "notes", url: "https://notes.example.test/mcp", bearerToken: "sekret-token")))

        #expect(model.server(named: "notes")?.isHTTP == true)
        #expect(model.server(named: "notes")?.auth == "bearer")

        let state = try await gateway.control("GET", "/__fake/state")

        #expect(state["mcpSecrets"]?["notes"]?["value"] == "sekret-token", "it arrived on the gateway")
        #expect(model.servers.map(\.address).joined().contains("sekret-token") == false)
      }
    }

    @Test("a stdio server is added from a command and its arguments")
    func addsAStdioServer() async throws {
      try await withModel { _, model, _ in
        #expect(await model.add(McpServerDraft(name: "fs", kind: .stdio, command: "npx", arguments: #"-y server-fs "/my files""#)))
        #expect(model.server(named: "fs")?.address == "npx -y server-fs /my files")
      }
    }

    @Test("a name that is already configured is refused in the gateway's words")
    func refusesADuplicate() async throws {
      try await withModel { _, model, _ in
        #expect(await model.add(McpServerDraft(name: "files", kind: .stdio, command: "npx")) == false)
        #expect(model.addError == "server 'files' already exists")
        #expect(model.servers.count == 3)
      }
    }

    @Test("a command the gateway screens out is refused and nothing is added")
    func refusesASuspiciousCommand() async throws {
      try await withModel { _, model, _ in
        #expect(await model.add(McpServerDraft(name: "bad", kind: .stdio, command: "sh", arguments: "-c 'a; b'")) == false)
        #expect(model.addError?.contains("suspicious command") == true)
        #expect(model.server(named: "bad") == nil)
      }
    }

    @Test("an API key reaches the gateway under the variable named and the server keeps only a reference")
    func setsAnApiKey() async throws {
      try await withModel { _, model, gateway in
        #expect(await model.setAPIKey("weather", value: "abc123", envVar: "WEATHER_API_KEY"))
        #expect(model.notice == .keySaved("weather"))

        let state = try await gateway.control("GET", "/__fake/state")

        #expect(state["mcpSecrets"]?["weather"]?["envVar"] == "WEATHER_API_KEY")
        #expect(state["mcpSecrets"]?["weather"]?["value"] == "abc123")
      }
    }

    @Test("a server is removed, and the same name again is refused")
    func removes() async throws {
      try await withModel { _, model, _ in
        #expect(await model.remove("weather"))
        #expect(model.servers.map(\.name) == ["files", "calendar"])

        #expect(await model.remove("weather") == false)
        #expect(model.notice == .failure("server 'weather' not found"))
      }
    }

    @Test("a reload asks first, and the answer goes back")
    func reloads() async throws {
      try await withModel { _, model, _ in
        await model.reload()
        #expect(model.reloadPrompt != nil)
        #expect(model.reloadPrompt?.message.contains("prompt cache") == true)

        await model.confirmReload(always: false)
        #expect(model.notice == .reloaded)
        #expect(model.reloadPrompt == nil)
      }
    }
  }
}
#endif
