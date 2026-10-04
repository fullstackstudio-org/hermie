import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// A gateway's MCP servers for one profile: the config, an OAuth flow that is approved after a chosen
/// number of polls, and the writes.
private final class McpGateway: Sendable {
  struct State {
    var servers = ["files", "calendar"]
    var pollsBeforeApproval = 2
    var pollAnswer: String?
    var addRefusal: String?
    var secrets: [String: String] = [:]
    var reloadNeedsConfirmation = true
  }

  let rpc = ScriptedRPC()
  let state = Mutex(State())

  init() {
    rpc.handle("mcp.servers.list") { _ in
      let names = self.state.withLock { $0.servers }
      let rows = names.map { name -> JSONValue in
        .object(["name": .string(name), "transport": .string(name == "calendar" ? "http" : "stdio"), "enabled": true])
      }

      return .object(["servers": .array(rows)])
    }
    rpc.respond("mcp.servers.status", jsonValue(#"{"servers": [], "checked_at": 1}"#))
    rpc.handle("mcp.servers.test") { params in
      params["name"] == "calendar"
        ? jsonValue(#"{"ok": false, "error": "OAuth authentication required", "tools": [], "oauth_needed": true, "oauth_tokens_present": false}"#)
        : jsonValue(#"{"ok": true, "tools": [{"name": "read_file", "description": "Read."}], "oauth_needed": false}"#)
    }
    rpc.respond(
      "mcp.servers.oauth.start",
      jsonValue(#"{"ok": true, "session_id": "flow-1", "auth_url": "https://auth.example.test/authorize", "flow": "pkce"}"#))
    rpc.handle("mcp.servers.oauth.poll") { _ in
      let answer = self.state.withLock { state -> JSONValue in
        if let said = state.pollAnswer {
          return jsonValue(said)
        }

        if state.pollsBeforeApproval > 0 {
          state.pollsBeforeApproval -= 1

          return jsonValue(#"{"ok": true, "status": "pending"}"#)
        }

        return jsonValue(#"{"ok": true, "status": "approved", "tools": [{"name": "list_events"}]}"#)
      }

      return answer
    }
    rpc.respond("mcp.servers.oauth.cancel", jsonValue(#"{"ok": true, "status": "cancelled"}"#))
    rpc.handle("mcp.servers.add") { params in
      if let refusal = self.state.withLock({ $0.addRefusal }) {
        throw GatewayRPCError(.rejected, refusal, code: 4090)
      }

      let name = params["name"]?.stringValue ?? ""

      self.state.withLock { $0.servers.append(name) }

      return .object(["ok": true, "name": .string(name), "server": .object(["name": .string(name)])])
    }
    rpc.handle("mcp.servers.remove") { params in
      let name = params["name"]?.stringValue ?? ""

      guard self.state.withLock({ $0.servers.contains(name) }) else {
        throw GatewayRPCError(.rejected, "server '\(name)' not found", code: 4064)
      }

      self.state.withLock { $0.servers.removeAll { $0 == name } }

      return .object(["ok": true, "removed": true])
    }
    rpc.handle("mcp.servers.set_api_key") { params in
      self.state.withLock { $0.secrets[params["name"]?.stringValue ?? ""] = params["value"]?.stringValue }

      return .object(["ok": true, "name": params["name"] ?? "", "env_var": "MCP_KEY"])
    }
    rpc.handle("mcp.catalog") { _ in
      let have = self.state.withLock { $0.servers }
      let entries = ["github", "fetch"].map { name -> JSONValue in
        .object([
          "name": .string(name), "description": .string("Does \(name)."), "installed": .bool(have.contains(name)),
          "enabled": .bool(have.contains(name)), "requires": .array([]), "transport": "stdio"
        ])
      }

      return .object(["servers": .array(entries)])
    }
    rpc.handle("reload.mcp") { params in
      let confirmed = params["confirm"] == true || params["always"] == true

      return self.state.withLock { $0.reloadNeedsConfirmation } && !confirmed
        ? jsonValue(#"{"status": "confirm_required", "message": "This invalidates the prompt cache."}"#)
        : jsonValue(#"{"status": "reloaded"}"#)
    }
  }
}

/// How an OAuth walk opens the link: records it, and says whether it was opened.
@MainActor
private final class Browser {
  var opened: [URL] = []
  var accepts = true

  func open(_ url: URL) -> Bool {
    opened.append(url)

    return accepts
  }
}

@MainActor
private func opened(profile: String? = "writer", maxPolls: Int = 10) async -> (McpServersModel, McpGateway) {
  let gateway = McpGateway()
  let model = McpServersModel(
    service: McpServersService(gateway: gateway.rpc.gateway), profile: profile, pause: { _ in }, pollInterval: .zero,
    maxPolls: maxPolls)
  await model.load()

  return (model, gateway)
}

@MainActor
@Suite(.timeLimit(.minutes(1))) struct McpServersModelTests {
  // MARK: Reading

  @Test func startsLoadingAndThenHoldsTheServers() async {
    let gateway = McpGateway()
    let model = McpServersModel(service: McpServersService(gateway: gateway.rpc.gateway), profile: "writer")

    #expect(model.phase == .loading)
    await model.load()

    #expect(model.phase == .ready)
    #expect(model.servers.map(\.name) == ["files", "calendar"])
    #expect(model.server(named: "calendar")?.isHTTP == true)
  }

  @Test func aFailedFirstReadIsAFailureAndAFailedRefreshKeepsTheList() async {
    let (model, gateway) = await opened()
    gateway.rpc.refuse("mcp.servers.list", "gateway busy", code: 5000)

    await model.load()

    #expect(model.phase == .ready)
    #expect(model.servers.count == 2)
    #expect(model.notice == .failure("gateway busy"))

    let fresh = McpServersModel(service: McpServersService(gateway: gateway.rpc.gateway), profile: nil)
    await fresh.load()

    #expect(fresh.phase == .failed("gateway busy"))
  }

  @Test func anotherBotClearsTheProbesAndReadsAgain() async {
    let (model, gateway) = await opened()
    await model.test("files")

    await model.setProfile("researcher")

    #expect(model.probes.isEmpty)
    #expect(gateway.rpc.calls("mcp.servers.list").last?["profile"] == "researcher")
  }

  // MARK: Probing

  @Test func aProbeIsAButtonAndItsResultIsKept() async {
    let (model, gateway) = await opened()

    #expect(gateway.rpc.calls("mcp.servers.test").isEmpty, "nothing is probed on the person's behalf")
    await model.test("files")

    if case .done(let probe) = model.probes["files"] {
      #expect(probe.ok)
      #expect(probe.tools.map(\.name) == ["read_file"])
    } else {
      Issue.record("expected a probe, got \(String(describing: model.probes["files"]))")
    }

    await model.test("calendar")

    if case .done(let probe) = model.probes["calendar"] {
      #expect(probe.ok == false)
      #expect(probe.needsAuth)
    } else {
      Issue.record("expected a probe")
    }
  }

  @Test func aProbeThatCouldNotBeMadeIsToldAsThat() async {
    let (model, gateway) = await opened()
    gateway.rpc.refuse("mcp.servers.test", "server 'files' not found", code: 4064)

    await model.test("files")

    #expect(model.probes["files"] == .failed("server 'files' not found"))
  }

  @Test func oneProbeOfAServerRunsAtATime() async {
    let (model, gateway) = await opened()
    gateway.rpc.hold("mcp.servers.test")

    let first = Task { await model.test("files") }
    await eventually { gateway.rpc.isHolding }

    #expect(model.probes["files"] == .testing)
    await model.test("files")
    #expect(gateway.rpc.calls("mcp.servers.test").count == 1)

    gateway.rpc.release()
    await first.value
  }

  // MARK: Authorising

  @Test func anOAuthWalkOpensTheLinkPollsUntilApprovedAndReadsTheListAgain() async {
    let (model, gateway) = await opened()
    let browser = Browser()

    let done = await model.authorise("calendar", open: browser.open)

    #expect(done)
    #expect(browser.opened == [URL(string: "https://auth.example.test/authorize")!])
    #expect(gateway.rpc.calls("mcp.servers.oauth.poll").count == 3, "two pending answers and the approval")
    #expect(model.notice == .authorised("calendar"))
    #expect(model.authorising == nil)

    if case .done(let probe) = model.probes["calendar"] {
      #expect(probe.ok && probe.needsAuth == false)
      #expect(probe.tools.map(\.name) == ["list_events"])
    } else {
      Issue.record("an approved flow is a probe that connected")
    }

    #expect(gateway.rpc.calls("mcp.servers.oauth.cancel").isEmpty, "an approved flow needs no cancelling")
  }

  @Test func aRefusedAuthorisationIsToldAndTheFlowIsCancelled() async {
    let (model, gateway) = await opened()
    gateway.state.withLock { $0.pollAnswer = #"{"ok": true, "status": "error", "error_message": "access_denied"}"# }

    let done = await model.authorise("calendar", open: Browser().open)

    #expect(done == false)
    #expect(model.notice == .authoriseFailed("access_denied"))
    #expect(gateway.rpc.calls("mcp.servers.oauth.cancel").count == 1)
  }

  @Test func aWalkThatNeverSettlesTimesOutAndCancelsTheFlow() async {
    let (model, gateway) = await opened(maxPolls: 3)
    gateway.state.withLock { $0.pollsBeforeApproval = 100 }

    let done = await model.authorise("calendar", open: Browser().open)

    #expect(done == false)
    #expect(gateway.rpc.calls("mcp.servers.oauth.poll").count == 3)
    #expect(model.notice == .authoriseFailed("Timed out waiting for the authorisation to finish."))
    #expect(gateway.rpc.calls("mcp.servers.oauth.cancel").count == 1)
  }

  @Test func aLinkThatIsNotHttpsIsNeverOpenedAndTheFlowIsCancelled() async {
    let (model, gateway) = await opened()
    gateway.rpc.respond(
      "mcp.servers.oauth.start", jsonValue(#"{"ok": true, "session_id": "flow-1", "auth_url": "http://auth.example.test/x", "flow": "pkce"}"#))
    let browser = Browser()

    #expect(await model.authorise("calendar", open: browser.open) == false)

    #expect(browser.opened.isEmpty)
    #expect(model.notice == .linkRefused)
    #expect(gateway.rpc.calls("mcp.servers.oauth.cancel").count == 1)
  }

  @Test func aLinkWithAUserBeforeTheHostIsNeverOpened() async {
    let gateway = McpGateway()
    gateway.rpc.respond(
      "mcp.servers.oauth.start",
      jsonValue(#"{"ok": true, "session_id": "f", "auth_url": "https://trusted.example@elsewhere.example/x", "flow": "pkce"}"#))
    let other = McpServersModel(service: McpServersService(gateway: gateway.rpc.gateway), profile: nil, pause: { _ in })
    let browser = Browser()

    #expect(await other.authorise("calendar", open: browser.open) == false)
    #expect(browser.opened.isEmpty)
  }

  @Test func aBrowserThatWillNotOpenTheLinkIsToldAsThat() async {
    let (model, gateway) = await opened()
    let browser = Browser()
    browser.accepts = false

    #expect(await model.authorise("calendar", open: browser.open) == false)
    #expect(model.notice == .linkRefused)
    #expect(gateway.rpc.calls("mcp.servers.oauth.cancel").count == 1)
  }

  @Test func aServerThatCannotStartAFlowSaysWhy() async {
    let (model, gateway) = await opened()
    gateway.rpc.refuse("mcp.servers.oauth.start", "stdio servers authenticate via env keys, not OAuth", code: 4001)

    #expect(await model.authorise("files", open: Browser().open) == false)
    #expect(model.notice == .authoriseFailed("stdio servers authenticate via env keys, not OAuth"))
    #expect(gateway.rpc.calls("mcp.servers.oauth.cancel").isEmpty, "there was no flow to cancel")
  }

  @Test func leavingThePageMidWalkCancelsTheFlow() async {
    let (model, gateway) = await opened()
    gateway.state.withLock { $0.pollsBeforeApproval = 1_000 }
    let browser = Browser()

    let walk = Task { await model.authorise("calendar", open: browser.open) }
    await eventually { gateway.rpc.calls("mcp.servers.oauth.poll").count >= 2 }

    walk.cancel()

    #expect(await walk.value == false)
    #expect(gateway.rpc.calls("mcp.servers.oauth.cancel").count == 1)
    #expect(model.authorising == nil)
  }

  // MARK: Adding

  @Test func aCustomServerIsAddedAndTheListReadAgain() async {
    let (model, gateway) = await opened()

    let done = await model.add(McpServerDraft(name: "notes", url: "https://n.example.test/mcp"))

    #expect(done)
    #expect(model.notice == .added("notes"))
    #expect(model.servers.map(\.name).contains("notes"))
    #expect(gateway.rpc.calls("mcp.servers.add").first?["profile"] == "writer")
    #expect(model.addError == nil)
  }

  @Test func aDraftWithProblemsIsNotSent() async {
    let (model, gateway) = await opened()

    #expect(await model.add(McpServerDraft(name: "", url: "")) == false)
    #expect(gateway.rpc.calls("mcp.servers.add").isEmpty)
  }

  @Test func aRefusedAddKeepsTheSheetsErrorInTheGatewaysWords() async {
    let (model, gateway) = await opened()
    gateway.state.withLock { $0.addRefusal = "server 'notes' already exists" }

    #expect(await model.add(McpServerDraft(name: "notes", url: "https://n.example.test/mcp")) == false)
    #expect(model.addError == "server 'notes' already exists")
    #expect(model.notice == nil)

    model.beginAdding()
    #expect(model.addError == nil)
  }

  @Test func aPresetIsAddedByNameAndTheCatalogueShowsItInstalled() async {
    let (model, _) = await opened()
    await model.loadCatalog()

    guard case .loaded(let entries) = model.catalog, let github = entries.first(where: { $0.name == "github" }) else {
      Issue.record("expected the catalogue, got \(model.catalog)")
      return
    }

    #expect(github.installed == false)
    #expect(await model.addPreset(github))
    #expect(model.servers.map(\.name).contains("github"))

    if case .loaded(let after) = model.catalog {
      #expect(after.first { $0.name == "github" }?.installed == true)
    } else {
      Issue.record("expected the catalogue to be read again")
    }

    #expect(await model.addPreset(github) == false, "an installed preset is not added again")
  }

  @Test func aCatalogueThatCannotBeReadSaysSo() async {
    let (model, gateway) = await opened()
    gateway.rpc.refuse("mcp.catalog", "unknown method", code: -32601)

    await model.loadCatalog()

    #expect(model.catalog == .failed("unknown method"))
  }

  // MARK: Removing and keys

  @Test func aServerIsRemovedAndLeavesTheListAndItsProbe() async {
    let (model, _) = await opened()
    await model.test("files")

    #expect(await model.remove("files"))

    #expect(model.servers.map(\.name) == ["calendar"])
    #expect(model.probes["files"] == nil)
    #expect(model.notice == .removed("files"))
  }

  @Test func aRemoveTheGatewayRefusesIsAFailureAndTheListIsKept() async {
    let (model, _) = await opened()

    #expect(await model.remove("ghost") == false)
    #expect(model.notice == .failure("server 'ghost' not found"))
    #expect(model.servers.count == 2)
  }

  @Test func anApiKeyGoesToTheGatewayAndIsNeverPartOfANotice() async {
    let (model, gateway) = await opened()
    await model.test("files")

    #expect(await model.setAPIKey("files", value: "  s3cret  ", envVar: "FILES_KEY"))

    #expect(gateway.state.withLock { $0.secrets["files"] } == "s3cret")
    #expect(gateway.rpc.calls("mcp.servers.set_api_key").first?["env_var"] == "FILES_KEY")
    #expect(model.notice == .keySaved("files"))
    #expect(model.probes["files"] == nil, "an earlier probe says nothing about a server whose key changed")
  }

  @Test func aBlankKeyIsNotSent() async {
    let (model, gateway) = await opened()

    #expect(await model.setAPIKey("files", value: "   ") == false)
    #expect(gateway.rpc.calls("mcp.servers.set_api_key").isEmpty)
  }

  // MARK: Reloading

  @Test func aReloadThatNeedsConfirmationAsksAndTheAnswerGoesBack() async {
    let (model, gateway) = await opened()

    await model.reload()
    #expect(model.reloadPrompt == McpServersModel.ReloadPrompt(message: "This invalidates the prompt cache."))
    #expect(model.notice == nil, "asking is not reloading")

    await model.confirmReload(always: false)
    #expect(model.reloadPrompt == nil)
    #expect(model.notice == .reloaded)
    #expect(gateway.rpc.calls("reload.mcp").last?["confirm"] == true)
    #expect(gateway.rpc.calls("reload.mcp").last?["always"] == nil)
  }

  @Test func alwaysIsSentAsTheGatewaysOwnSetting() async {
    let (model, gateway) = await opened()

    await model.reload()
    await model.confirmReload(always: true)

    #expect(gateway.rpc.calls("reload.mcp").last?["always"] == true)
  }

  @Test func decliningTheQuestionReloadsNothing() async {
    let (model, gateway) = await opened()

    await model.reload()
    model.declineReload()

    #expect(model.reloadPrompt == nil)
    #expect(gateway.rpc.calls("reload.mcp").count == 1)
  }

  @Test func aReloadThatIsNotAskedAboutJustReloads() async {
    let (model, gateway) = await opened()
    gateway.state.withLock { $0.reloadNeedsConfirmation = false }

    await model.reload()

    #expect(model.notice == .reloaded)
    #expect(model.reloadPrompt == nil)
  }
}
