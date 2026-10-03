#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

/// Wait for a condition the session reaches on its own; a cap only turns a hang into a failure.
@MainActor
private func mcpWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// `FakeGateway.with` a gateway of these options, with a body on the main actor, where the models live.
private func withMCPGateway(
  _ options: FakeGateway.Options,
  _ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void
) async throws {
  try await FakeGateway.with(options) { gateway in try await body(gateway) }
}

/// A session on a fake gateway, ready, as the app holds one: its MCP model reads and listens.
@MainActor
private struct MCPApp {
  let gateway: FakeGateway
  let session: GatewaySession
  let model: MCPSettingsModel
  /// The routes a second device of the same person would use.
  let other: MCPClient
  /// The REST client of that same sign-in.
  let http: HTTPClient

  static let withMCP = FakeGateway.Options(auth: .native, extraArguments: ["--mcp"])

  /// A native PKCE sign-in (so the gateway knows the person), and a session over it.
  static func open(_ gateway: FakeGateway, storedID: String = "g-mcp") async throws -> MCPApp {
    let native = try await NativeSession(gateway: gateway)
    try await native.signIn()

    let session = try await ready(
      gateway,
      credentials: native.credentials,
      authKind: .nativePKCE,
      storedID: storedID
    )
    let model = try #require(session.mcp)

    return MCPApp(gateway: gateway, session: session, model: model, other: MCPClient(http: native.http), http: native.http)
  }

  private static func ready(
    _ gateway: FakeGateway,
    credentials: any CredentialProvider,
    authKind: GatewayAuthKind,
    storedID: String
  ) async throws -> GatewaySession {
    var options = GatewaySession.Options()
    options.connection.backoff = { _ in .milliseconds(100) }
    let record = GatewayRecord(id: storedID, name: "fake", address: gateway.baseURL, authKind: authKind, addedAt: 0)
    let session = try GatewaySession(
      record: record,
      credentials: credentials,
      database: try SQLiteStore(.inMemory),
      options: options
    )

    await session.start()
    try await mcpWait("the socket and the roster") {
      session.status.phase == .ready && session.chatList.rows["researcher"] != nil
    }
    return session
  }

  /// A consent, as the fake plays one: the grant's id.
  @discardableResult
  func seed(
    _ name: String = "Example Agent",
    announce: Bool = false,
    createdAt: Double? = nil,
    lastUsed: Double? = nil,
    ip: String? = "203.0.113.7"
  ) async throws -> String {
    var body: JSONObject = ["client_name": .string(name), "announce": .bool(announce)]
    // Relative to now, so a grant never expires under the test (the gateway ends one after 90 days).
    body["created_at"] = createdAt.map(JSONValue.number)
    body["created_ip"] = ip.map(JSONValue.string) ?? .null
    body["last_used_at"] = lastUsed.map(JSONValue.number) ?? .null
    body["last_used_ip"] = lastUsed == nil ? .null : "198.51.100.9"

    let answer = try await gateway.control("POST", "/__fake/mcp/grants", body: .object(body))
    return try #require(answer["grant"]?["id"]?.stringValue)
  }

  /// `GET /__fake/mcp/grants`: every grant the gateway holds, revoked ones too.
  func held() async throws -> [JSONValue] {
    try await gateway.control("GET", "/__fake/mcp/grants")["grants"]?.arrayValue ?? []
  }
}

extension Integration {
  /// Settings › MCP against the fake gateway, over real sockets and REST.
  @Suite("MCP settings") @MainActor
  struct MCPIntegrationTests {
    @Test("the page reads the endpoint, the command to copy and the person's own clients, newest first")
    func readsThePage() async throws {
      try await withMCPGateway(MCPApp.withMCP) { gateway in
        let app = try await MCPApp.open(gateway)
        let now = Date().timeIntervalSince1970.rounded()
        let first = try await app.seed("First Agent", createdAt: now - 200)
        let second = try await app.seed("Second Agent", createdAt: now - 100, lastUsed: 1_790_000_000)

        await app.model.refresh()

        #expect(app.model.phase == .ready)
        let settings = try #require(app.model.settings)
        #expect(settings.v == 1)
        #expect(settings.endpointURL?.hasSuffix("/mcp") == true)
        #expect(settings.claudeCommand?.hasPrefix("claude mcp add --transport http ") == true)
        #expect(settings.claudeCommand?.hasSuffix(settings.endpointURL ?? "?") == true)
        #expect(settings.configJSON?.contains(settings.endpointURL ?? "?") == true)
        #expect(settings.instructions?.isEmpty == false)

        let grants = settings.grants ?? []
        #expect(grants.map(\.id) == [second, first])
        #expect(grants.map(\.clientName) == ["Second Agent", "First Agent"])
        #expect(grants[0].lastUsedAt == 1_790_000_000)
        #expect(grants[0].lastUsedIP == "198.51.100.9")
        #expect(grants[1].lastUsedAt == nil)
        #expect(grants[1].createdIP == "203.0.113.7")
        #expect(grants[1].expiresAt != nil)

        await app.session.shutdown()
      }
    }

    @Test("a revoke ends the grant on the gateway and takes it off the page; revoking it again is not an error")
    func revokes() async throws {
      try await withMCPGateway(MCPApp.withMCP) { gateway in
        let app = try await MCPApp.open(gateway)
        let keep = try await app.seed("Keeper")
        let drop = try await app.seed("Dropped")
        await app.model.refresh()
        #expect(app.model.settings?.grants?.count == 2)

        let gone = await app.model.revoke(grantID: drop)

        #expect(gone)
        #expect(app.model.settings?.grants?.map(\.id) == [keep])
        let held = try await app.held()
        let revoked = try #require(held.first { $0["id"]?.stringValue == drop })
        #expect(revoked["revoked_by"]?.stringValue == "user")
        #expect(held.first { $0["id"]?.stringValue == keep }?["revoked_at"] == .null)

        // The gateway answers 404 for a grant that is gone: it is gone, which is what was asked.
        #expect(await app.model.revoke(grantID: drop))
        #expect(!app.model.revokeFailed)
        #expect(await app.model.revoke(grantID: "mcg_nobody"))
        #expect(app.model.settings?.grants?.map(\.id) == [keep])

        await app.session.shutdown()
      }
    }

    @Test("mcp.changed reloads the open page without being asked, and names the client as plain text")
    func reloadsOnTheFrame() async throws {
      try await withMCPGateway(MCPApp.withMCP) { gateway in
        let app = try await MCPApp.open(gateway)
        await app.model.refresh()
        #expect(app.model.settings?.grants?.isEmpty == true)

        // A consent in a browser: the gateway announces it to every live connection of the person.
        let id = try await app.seed("Late Agent", announce: true)
        try await mcpWait("the page to reload") { app.model.settings?.grants?.map(\.id) == [id] }

        let granted = try #require(app.model.notice)
        #expect(granted.change == .granted)
        #expect(granted.clientName == "Late Agent")
        app.model.dismissNotice()

        // A revoke from another device of the same person.
        try await app.other.revoke(grantID: id)
        try await mcpWait("the revoke to show") { app.model.settings?.grants?.isEmpty == true }
        #expect(app.model.notice?.change == .revoked)
        #expect(app.model.notice?.clientName == "Late Agent")

        await app.session.shutdown()
      }
    }

    @Test("a revoke made on this device is not announced back to it as news")
    func ownRevokeIsNoNews() async throws {
      try await withMCPGateway(MCPApp.withMCP) { gateway in
        let app = try await MCPApp.open(gateway)
        let id = try await app.seed("Example Agent")
        await app.model.refresh()

        #expect(await app.model.revoke(grantID: id))

        // The frame has gone out by now: seeding another announced grant orders it behind it.
        try await app.seed("Marker Agent", announce: true)
        try await mcpWait("the marker's notice") { app.model.notice?.clientName == "Marker Agent" }
        #expect(app.model.notice?.change == .granted)

        await app.session.shutdown()
      }
    }

    @Test("a gateway without MCP says so and shows nothing else")
    func withoutMCP() async throws {
      try await withMCPGateway(FakeGateway.Options(auth: .native)) { gateway in
        let app = try await MCPApp.open(gateway)
        await app.model.refresh()

        #expect(app.model.phase == .notOffered)
        #expect(app.model.settings == nil)
        await app.session.shutdown()
      }
    }

    @Test("the gateway advertises per_message_author_via, and a row an agent sent keeps its marker")
    func theViaMarkerReachesTheTranscript() async throws {
      try await withMCPGateway(MCPApp.withMCP) { gateway in
        let app = try await MCPApp.open(gateway)
        try await mcpWait("the capabilities") { app.session.capabilities != nil }
        #expect(app.session.capabilities?.perMessageAuthorVia == true)

        let injected = try await gateway.control(
          "POST",
          "/__fake/inject",
          body: .object([
            "profile": "researcher",
            "user": "Ship it.",
            "assistant": "On it.",
            "author": ["id": "oidc:me", "name": "Robin", "via": ["kind": "mcp", "client": "Example Agent", "extra": 1]],
            "replayed_by": ["id": "oidc:you", "name": "Sam", "via": ["kind": "mcp", "client": "Other Agent"]]
          ])
        )
        let stored = try #require(injected["stored_session_id"]?.stringValue)

        // The history as the app reads it: through REST, then the engine.
        let page = try #require(try await app.http.get(RESTPath.sessionMessages(stored)))
        let rows = (page["messages"]?.arrayValue ?? []).compactMap(TranscriptRow.init(jsonValue:))
        let user = try #require(rowsToItems(rows, .rest).compactMap(\.asUser).first { $0.text == "Ship it." })

        #expect(user.author == MessageAuthor(id: "oidc:me", name: "Robin", via: AuthorVia(kind: "mcp", client: "Example Agent")))
        #expect(user.replayedBy?.id == "oidc:you")
        #expect(user.replayedBy?.via?.client == "Other Agent")
        #expect(authorLabel(user.author, "Robin") == "Robin via Example Agent")

        await app.session.shutdown()
      }
    }
  }
}
#endif
