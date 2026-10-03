import Foundation
import HermieProtocol
import Testing

@testable import HermieGateway

/// The two MCP routes through a real `HTTPClient` over a stubbed transport: what they send, and what
/// each answer of `contract/gateway/mcp.md` becomes.
@Suite struct MCPClientTests {
  static let base = "http://gateway.test"

  static func client(_ server: StubServer, credentials: any CredentialProvider = AnonymousCredentials()) throws -> MCPClient {
    MCPClient(http: try HTTPClient(baseURL: base, credentials: credentials, transport: server.transport()))
  }

  static let page = """
    {"v":1,"enabled":true,"endpoint_url":"https://gateway.example/mcp","issuer":"https://gateway.example/mcp",\
    "label":"hermie-example","claude_command":"claude mcp add --transport http hermie-example https://gateway.example/mcp",\
    "config_json":"{\\n  \\"mcpServers\\": {}\\n}","instructions":"Add it to your client.","unknown":{"later":1},\
    "grants":[{"id":"mcg_1","client_name":"Example Agent","client_id":"c1","scopes":["mcp"],"created_at":1790000000,\
    "created_ip":"203.0.113.7","created_user_agent":null,"last_used_at":null,"last_used_ip":null,\
    "expires_at":1797776000,"extra":true}]}
    """

  static func failure(_ result: @autoclosure () async throws -> some Any) async -> MCPRouteError? {
    do {
      _ = try await result()
      return nil
    } catch let error as MCPRouteError {
      return error
    } catch {
      Issue.record("threw \(error), not an MCPRouteError")
      return nil
    }
  }

  // MARK: The read

  @Test("GET /api/auth/mcp reads the page, keeps every string as sent and ignores keys it does not know")
  func read() async throws {
    let server = StubServer { _ in .json(Self.page, headers: ["content-type": "application/json"]) }
    let settings = try await Self.client(server).settings()
    let request = try #require(server.requests.first)

    #expect(request.method == "GET")
    #expect(request.path == "/api/auth/mcp")
    #expect(request.header("origin") == nil, "a bearer sends no Origin")
    #expect(settings.v == 1)
    #expect(settings.enabled == true)
    #expect(settings.endpointURL == "https://gateway.example/mcp")
    #expect(settings.label == "hermie-example")
    #expect(settings.claudeCommand == "claude mcp add --transport http hermie-example https://gateway.example/mcp")
    #expect(settings.configJSON == "{\n  \"mcpServers\": {}\n}")
    #expect(settings.instructions == "Add it to your client.")

    let grant = try #require(settings.grants?.first)
    #expect(grant.id == "mcg_1")
    #expect(grant.clientName == "Example Agent")
    #expect(grant.scopes == ["mcp"])
    #expect(grant.createdAt == 1_790_000_000)
    #expect(grant.createdIP == "203.0.113.7")
    #expect(grant.createdUserAgent == nil)
    #expect(grant.lastUsedAt == nil)
    #expect(grant.expiresAt == 1_797_776_000)
  }

  @Test("a 404 is a gateway without MCP, a 403 no_identity is no person, a 401 is signed out")
  func readRefusals() async throws {
    let notOffered = StubServer { _ in .json("{\"detail\":\"No such API endpoint: /api/auth/mcp\"}", status: 404) }
    #expect(await Self.failure(try await Self.client(notOffered).settings())?.kind == .notOffered)

    let noIdentity = StubServer { _ in .json("{\"error\":\"no_identity\",\"detail\":\"No person.\"}", status: 403) }
    let identity = await Self.failure(try await Self.client(noIdentity).settings())
    #expect(identity?.kind == .noIdentity)
    #expect(identity?.error == "no_identity")

    let signedOut = StubServer { _ in .json("{\"detail\":\"Not authenticated\"}", status: 401) }
    #expect(await Self.failure(try await Self.client(signedOut).settings())?.kind == .signedOut)

    let origin = StubServer { _ in .json("{\"error\":\"origin_not_listed\"}", status: 403) }
    #expect(await Self.failure(try await Self.client(origin).settings())?.kind == .originNotListed)

    let broken = StubServer { _ in .json("{\"detail\":\"boom\"}", status: 500) }
    #expect(await Self.failure(try await Self.client(broken).settings())?.kind == .refused)
  }

  @Test("an unreachable gateway and an answer that is not the page are told apart")
  func readFailures() async throws {
    let down = StubServer { _ in .urlError(.cannotConnectToHost) }
    #expect(await Self.failure(try await Self.client(down).settings())?.kind == .unreachable)

    let array = StubServer { _ in .json("[]") }
    #expect(await Self.failure(try await Self.client(array).settings())?.kind == .unexpectedAnswer)

    let empty = StubServer { _ in .status(200) }
    #expect(await Self.failure(try await Self.client(empty).settings())?.kind == .unexpectedAnswer)

    // A 200 that says it is off is not trusted as a page: the gateway answers 404 for that.
    let off = StubServer { _ in .json("{\"v\":1,\"enabled\":false}") }
    #expect(await Self.failure(try await Self.client(off).settings())?.kind == .notOffered)
  }

  // MARK: The revoke

  @Test("a revoke posts an empty object to the grant's own path and takes any 2xx")
  func revoke() async throws {
    let server = StubServer { _ in .json("{\"ok\":true}") }
    try await Self.client(server).revoke(grantID: "mcg_1")
    let request = try #require(server.requests.first)

    #expect(request.method == "POST")
    #expect(request.path == "/api/auth/mcp/grants/mcg_1/revoke")
    #expect(request.bodyText == "{}")
    #expect(request.header("origin") == nil)
  }

  @Test("an id is one path segment, whatever it holds")
  func revokePathSegment() throws {
    #expect(RESTPath.mcpGrantRevoke("mcg_1-A") == "/api/auth/mcp/grants/mcg_1-A/revoke")
    #expect(RESTPath.mcpGrantRevoke("a/b?c#d") == "/api/auth/mcp/grants/a%2Fb%3Fc%23d/revoke")
  }

  @Test("a 404 not_found is 'it is gone'; any other 404, and a 405, is a gateway without MCP")
  func revokeRefusals() async throws {
    let gone = StubServer { _ in .json("{\"error\":\"not_found\",\"detail\":\"No such grant.\"}", status: 404) }
    #expect(await Self.failure(try await Self.client(gone).revoke(grantID: "mcg_1"))?.kind == .notFound)

    let unknown = StubServer { _ in .json("{\"detail\":\"No such API endpoint\"}", status: 404) }
    #expect(await Self.failure(try await Self.client(unknown).revoke(grantID: "mcg_1"))?.kind == .notOffered)

    let off = StubServer { _ in .json("{\"detail\":\"Method Not Allowed\"}", status: 405) }
    #expect(await Self.failure(try await Self.client(off).revoke(grantID: "mcg_1"))?.kind == .notOffered)

    let noIdentity = StubServer { _ in .json("{\"error\":\"no_identity\"}", status: 403) }
    #expect(await Self.failure(try await Self.client(noIdentity).revoke(grantID: "mcg_1"))?.kind == .noIdentity)

    let tooBig = StubServer { _ in .json("{\"error\":\"payload_too_large\"}", status: 413) }
    #expect(await Self.failure(try await Self.client(tooBig).revoke(grantID: "mcg_1"))?.kind == .refused)

    let down = StubServer { _ in .urlError(.timedOut) }
    #expect(await Self.failure(try await Self.client(down).revoke(grantID: "mcg_1"))?.kind == .unreachable)
  }
}
