import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// The routes as a test scripts them: what a read answers, what a revoke does, and every call made.
final class ScriptedMCP: MCPRouting, Sendable {
  private struct State {
    var read: Result<MCPSettings, MCPRouteError>
    var revokeError: MCPRouteError?
    /// A revoke that succeeds takes the grant off the list the next read answers.
    var grants: [MCPGrant]
    var reads = 0
    var revoked: [String] = []
    /// While set, a read waits for `release()`.
    var holding = false
    var waiting: [CheckedContinuation<Void, Never>] = []
  }

  private let state: Mutex<State>

  init(grants: [MCPGrant] = [], read: Result<MCPSettings, MCPRouteError>? = nil) {
    state = Mutex(State(read: read ?? .success(Self.settings(grants)), revokeError: nil, grants: grants))
  }

  static func settings(_ grants: [MCPGrant]) -> MCPSettings {
    var settings = MCPSettings()
    settings.v = 1
    settings.enabled = true
    settings.endpointURL = "https://gateway.example/mcp"
    settings.issuer = "https://gateway.example/mcp"
    settings.label = "hermie-example"
    settings.claudeCommand = "claude mcp add --transport http hermie-example https://gateway.example/mcp"
    settings.configJSON = "{\n  \"mcpServers\": {}\n}"
    settings.instructions = "Add it to your MCP client."
    settings.grants = grants
    return settings
  }

  static func grant(_ id: String, name: String = "Example Agent", createdAt: Double = 1_790_000_000) -> MCPGrant {
    MCPGrant(json: [
      "id": .string(id), "client_name": .string(name), "client_id": .string("client-\(id)"), "scopes": ["mcp"],
      "created_at": .number(createdAt), "created_ip": .null, "created_user_agent": .null, "last_used_at": .null,
      "last_used_ip": .null, "expires_at": .number(createdAt + 7_776_000)
    ])
  }

  var reads: Int { state.withLock { $0.reads } }
  var revoked: [String] { state.withLock { $0.revoked } }

  func answer(_ result: Result<MCPSettings, MCPRouteError>) {
    state.withLock { $0.read = result }
  }

  func setGrants(_ grants: [MCPGrant]) {
    state.withLock {
      $0.grants = grants
      $0.read = .success(Self.settings(grants))
    }
  }

  func failRevoke(_ error: MCPRouteError?) {
    state.withLock { $0.revokeError = error }
  }

  func hold() {
    state.withLock { $0.holding = true }
  }

  func release() {
    let waiting = state.withLock { state -> [CheckedContinuation<Void, Never>] in
      state.holding = false
      defer { state.waiting = [] }
      return state.waiting
    }

    for continuation in waiting {
      continuation.resume()
    }
  }

  func settings() async throws -> MCPSettings {
    await withCheckedContinuation { continuation in
      let held = state.withLock { state -> Bool in
        state.reads += 1

        if state.holding {
          state.waiting.append(continuation)
          return true
        }

        return false
      }

      if !held {
        continuation.resume()
      }
    }

    return try state.withLock { $0.read }.get()
  }

  func revoke(grantID: String) async throws {
    let failure = state.withLock { state -> MCPRouteError? in
      state.revoked.append(grantID)

      if state.revokeError == nil {
        state.grants.removeAll { $0.id == grantID }
        state.read = .success(Self.settings(state.grants))
      }

      return state.revokeError
    }

    if let failure {
      throw failure
    }
  }
}

/// `MCPSettingsModel` over scripted routes and a scripted link: how it reads, what each refusal
/// leaves on the page, how a revoke reaches the list, and what `mcp.changed` does.
@MainActor
@Suite struct MCPSettingsModelTests {
  struct Fixture {
    let model: MCPSettingsModel
    let routes: ScriptedMCP
    let link: ScriptedLink
  }

  static func fixture(grants: [MCPGrant] = [], read: Result<MCPSettings, MCPRouteError>? = nil) -> Fixture {
    let routes = ScriptedMCP(grants: grants, read: read)
    let link = ScriptedLink()
    let model = MCPSettingsModel(link: link, client: routes, now: { 1_790_000_100 })
    model.start()
    return Fixture(model: model, routes: routes, link: link)
  }

  static func refusal(_ kind: MCPRouteError.Kind, status: Int = 0) -> MCPRouteError {
    MCPRouteError(kind, status: status)
  }

  // MARK: Reading

  @Test("a read fills the page, newest grant first as the gateway sent them")
  func reading() async {
    let f = Self.fixture(grants: [ScriptedMCP.grant("mcg_2"), ScriptedMCP.grant("mcg_1")])
    #expect(f.model.phase == .loading)
    #expect(f.model.settings == nil)

    await f.model.refresh()

    #expect(f.model.phase == .ready)
    #expect(f.model.settings?.endpointURL == "https://gateway.example/mcp")
    #expect(f.model.settings?.grants?.map(\.id) == ["mcg_2", "mcg_1"])
    #expect(f.model.settings?.claudeCommand?.hasPrefix("claude mcp add --transport http") == true)
  }

  @Test("a 404 says the gateway does not offer MCP and shows nothing else")
  func notOffered() async {
    let f = Self.fixture(read: .failure(Self.refusal(.notOffered, status: 404)))
    await f.model.refresh()

    #expect(f.model.phase == .notOffered)
    #expect(f.model.settings == nil)
  }

  @Test("a 403 no_identity says to sign in as a person, and a 401 that this device is signed out")
  func identityRefusals() async {
    let f = Self.fixture(read: .failure(Self.refusal(.noIdentity, status: 403)))
    await f.model.refresh()
    #expect(f.model.phase == .noIdentity)
    #expect(f.model.settings == nil)

    f.routes.answer(.failure(Self.refusal(.signedOut, status: 401)))
    await f.model.refresh()
    #expect(f.model.phase == .signedOut)
  }

  @Test("a failed refresh keeps what was read before, and says it may be out of date")
  func staleKeepsTheOldAnswer() async {
    let f = Self.fixture(grants: [ScriptedMCP.grant("mcg_1")])
    await f.model.refresh()
    #expect(MCPSettingsModel.Phase.ready == f.model.phase)

    f.routes.answer(.failure(Self.refusal(.unreachable)))
    await f.model.refresh()

    #expect(f.model.phase == .unreadable)
    #expect(f.model.settings?.grants?.map(\.id) == ["mcg_1"])

    f.routes.setGrants([])
    await f.model.refresh()
    #expect(f.model.phase == .ready)
    #expect(f.model.settings?.grants?.isEmpty == true)
  }

  @Test("with nothing read before, a failed read is unreadable and shows no settings")
  func unreadable() async {
    let f = Self.fixture(read: .failure(Self.refusal(.refused, status: 500)))
    await f.model.refresh()

    #expect(f.model.phase == .unreadable)
    #expect(f.model.settings == nil)
  }

  @Test("a link without a REST side reads as unreadable")
  func noClient() async {
    let model = MCPSettingsModel(link: nil, client: nil)
    await model.refresh()

    #expect(model.phase == .unreadable)
  }

  @Test("a refresh asked for while one runs is made once more after it, and callers wait for the last")
  func coalescing() async throws {
    let f = Self.fixture(grants: [ScriptedMCP.grant("mcg_1")])
    f.routes.hold()

    let first = Task { @MainActor in await f.model.refresh() }
    try await eventually("the first read to start") { f.routes.reads == 1 }

    // Asked for twice more while the first is in flight: one more read, not two.
    let second = Task { @MainActor in await f.model.refresh() }
    let third = Task { @MainActor in await f.model.refresh() }
    try await Task.sleep(for: .milliseconds(20))

    f.routes.setGrants([ScriptedMCP.grant("mcg_1"), ScriptedMCP.grant("mcg_2")])
    f.routes.release()
    await first.value
    await second.value
    await third.value

    #expect(f.routes.reads == 2)
    #expect(f.model.settings?.grants?.count == 2)
  }

  // MARK: Revoking

  @Test("a revoke takes the grant off the list and reads the list again")
  func revoking() async {
    let f = Self.fixture(grants: [ScriptedMCP.grant("mcg_1"), ScriptedMCP.grant("mcg_2")])
    await f.model.refresh()
    let reads = f.routes.reads

    let gone = await f.model.revoke(grantID: "mcg_1")

    #expect(gone)
    #expect(f.routes.revoked == ["mcg_1"])
    #expect(f.model.settings?.grants?.map(\.id) == ["mcg_2"])
    #expect(f.routes.reads == reads + 1)
    #expect(f.model.revoking.isEmpty)
    #expect(!f.model.revokeFailed)
  }

  @Test("a 404 on a revoke means it is gone already: the list is read again, no error")
  func revokeNotFound() async {
    let f = Self.fixture(grants: [ScriptedMCP.grant("mcg_1")])
    await f.model.refresh()

    f.routes.failRevoke(Self.refusal(.notFound, status: 404))
    f.routes.setGrants([])
    let gone = await f.model.revoke(grantID: "mcg_1")

    #expect(gone)
    #expect(!f.model.revokeFailed)
    #expect(f.model.settings?.grants?.isEmpty == true)
  }

  @Test("a revoke that fails leaves the grant in the list and says so")
  func revokeFails() async {
    let f = Self.fixture(grants: [ScriptedMCP.grant("mcg_1")])
    await f.model.refresh()

    f.routes.failRevoke(Self.refusal(.unreachable))
    let gone = await f.model.revoke(grantID: "mcg_1")

    #expect(!gone)
    #expect(f.model.revokeFailed)
    #expect(f.model.settings?.grants?.map(\.id) == ["mcg_1"])
    #expect(f.model.revoking.isEmpty)

    f.model.dismissRevokeFailure()
    #expect(!f.model.revokeFailed)
  }

  @Test("a revoke the gateway answers as it answers a read for a gateway without MCP shows that instead")
  func revokeNotOffered() async {
    let f = Self.fixture(grants: [ScriptedMCP.grant("mcg_1")])
    await f.model.refresh()

    f.routes.failRevoke(Self.refusal(.notOffered, status: 405))
    let gone = await f.model.revoke(grantID: "mcg_1")

    #expect(!gone)
    #expect(f.model.phase == .notOffered)
    #expect(f.model.settings == nil)
  }

  // MARK: Events

  @Test("mcp.changed reads the list again and leaves a notice naming the client, as plain bounded text")
  func changedElsewhere() async throws {
    let f = Self.fixture(grants: [])
    await f.model.refresh()
    #expect(f.model.settings?.grants?.isEmpty == true)

    f.routes.setGrants([ScriptedMCP.grant("mcg_9", name: "Ex\u{202E}ample\nAgent")])
    f.link.emit(
      "mcp.changed",
      session: "",
      payload: [
        "change": "granted", "grant": ["id": "mcg_9", "client_name": "Ex\u{202E}ample\nAgent"], "at": 1_790_000_050
      ]
    )

    try await eventually("the list to be read again") { @MainActor in f.model.settings?.grants?.count == 1 }
    let notice = try #require(f.model.notice)
    #expect(notice.change == .granted)
    #expect(notice.clientName == "Example Agent")
    #expect(notice.at == 1_790_000_050)

    f.model.dismissNotice()
    #expect(f.model.notice == nil)
  }

  @Test("a revoke this device made leaves no notice when its frame arrives, and one from elsewhere does")
  func ownRevokeIsNoNews() async throws {
    let f = Self.fixture(grants: [ScriptedMCP.grant("mcg_1"), ScriptedMCP.grant("mcg_2")])
    await f.model.refresh()
    await f.model.revoke(grantID: "mcg_1")
    let reads = f.routes.reads

    f.link.emit(
      "mcp.changed", session: "",
      payload: ["change": "revoked", "grant": ["id": "mcg_1", "client_name": "Example Agent"], "at": 1])
    try await eventually("the frame's read") { @MainActor in f.routes.reads > reads }
    #expect(f.model.notice == nil)

    f.link.emit(
      "mcp.changed", session: "",
      payload: ["change": "revoked", "grant": ["id": "mcg_2", "client_name": "Example Agent"], "at": 2])
    try await eventually("the notice") { @MainActor in f.model.notice != nil }
    #expect(f.model.notice?.change == .revoked)
  }

  @Test("a change the model does not know is still 'something changed'")
  func unknownChange() async throws {
    let f = Self.fixture()
    await f.model.refresh()
    let reads = f.routes.reads

    f.link.emit("mcp.changed", session: "", payload: ["change": "renamed"])

    try await eventually("the read") { @MainActor in f.routes.reads > reads }
    #expect(f.model.notice?.change == .unknown("renamed"))
    #expect(f.model.notice?.clientName == "")
  }

  @Test("other events are not its business, and a shut-down model stops listening")
  func otherEvents() async throws {
    let f = Self.fixture()
    await f.model.refresh()
    let reads = f.routes.reads

    f.link.emit("passkey.changed", session: "", payload: ["change": "added"])
    f.link.emit("message.delta", session: "s", payload: [:])
    try await Task.sleep(for: .milliseconds(30))
    #expect(f.routes.reads == reads)

    f.model.shutdown()
    f.link.emit("mcp.changed", session: "", payload: ["change": "granted"])
    try await Task.sleep(for: .milliseconds(30))
    #expect(f.routes.reads == reads)
  }

  // MARK: Untrusted text

  @Test("a client's name and an address are one bounded line without control or direction characters")
  func displayText() {
    #expect(MCPSettingsModel.displayName("  Ex\u{202E}ample\u{200B}\nAgent\t ") == "Example Agent")
    #expect(MCPSettingsModel.displayName(nil) == "")
    #expect(MCPSettingsModel.displayName(String(repeating: "a", count: 500)).count == MCPSettingsModel.nameLimit + 1)
    #expect(MCPSettingsModel.displayAddress("203.0.113.7\n\u{2028}x") == "203.0.113.7 x")
    #expect(MCPSettingsModel.displayAddress(String(repeating: "9", count: 500)).count == MCPSettingsModel.addressLimit + 1)
    #expect(MCPSettingsModel.displayProse("One.\u{200B}\n\nTwo.") == "One.\nTwo.")
  }
}
