import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// A gateway's skills: what is installed under a bot, a hub of 45 skills that browses 20 to a page, and
/// the three answers an install can get.
private final class SkillsGateway: Sendable {
  struct State {
    var installed = ["pdf", "web-search"]
    var disabled: Set<String> = ["pdf"]
    var installRefusal: GatewayRPCError?
  }

  let rpc = ScriptedRPC()
  let state = Mutex(State())
  static let hubNames = (1...45).map { "skill-\(String(format: "%02d", $0))" }

  init() {
    rpc.handle("skills.manage") { params in
      let action = params["action"]?.stringValue ?? "list"

      switch action {
      case "list":
        let names = self.state.withLock { $0.installed }.map { JSONValue.string($0) }

        return .object(["skills": .object(["bundled": .array(names)])])
      case "browse":
        let page = params["page"]?.intValue ?? 1
        let names = Array(Self.hubNames.dropFirst((page - 1) * 20).prefix(20))
        let items = names.map { name -> JSONValue in
          .object(["name": .string(name), "description": .string("Does \(name)."), "source": "hub"])
        }

        return .object(["items": .array(items), "page": .number(Double(page)), "total_pages": 3, "total": 45])
      case "search":
        let needle = params["query"]?.stringValue ?? ""
        let hits = Self.hubNames.filter { $0.contains(needle) }.map { name -> JSONValue in
          .object(["name": .string(name), "description": .string("Does \(name).")])
        }

        return .object(["results": .array(hits)])
      case "inspect":
        let name = params["query"]?.stringValue ?? ""

        return Self.hubNames.contains(name)
          ? .object(["info": .object(["name": .string(name), "skill_md_preview": .string("# \(name)")])])
          : .object(["info": .object([:])])
      case "install":
        let name = params["query"]?.stringValue ?? ""

        if let refusal = self.state.withLock({ $0.installRefusal }) {
          throw refusal
        }

        guard Self.hubNames.contains(name) else {
          throw GatewayRPCError(.rejected, "skill '\(name)' not found in the hub", code: 5024)
        }

        self.state.withLock { $0.installed.append(name) }

        return .object(["installed": true, "name": .string(name)])
      default:
        throw GatewayRPCError(.rejected, "unknown skills action: \(action)", code: 4017)
      }
    }

    rpc.handle("profiles.describe") { _ in
      let (installed, disabled) = self.state.withLock { ($0.installed, $0.disabled) }
      let skills = installed.map { name -> JSONValue in
        .object(["name": .string(name), "enabled": .bool(!disabled.contains(name))])
      }

      return .object(["name": "writer", "skills": .array(skills)])
    }
  }
}

@MainActor
private func opened(_ profile: String? = "writer") async -> (SkillsModel, SkillsGateway) {
  let gateway = SkillsGateway()
  let model = SkillsModel(service: SkillsService(gateway: gateway.rpc.gateway), profile: profile)
  await model.load()

  return (model, gateway)
}

@MainActor
@Suite(.timeLimit(.minutes(1))) struct SkillsModelTests {
  @Test func startsLoadingAndThenHoldsTheInstalledSkillsWithTheBotsSwitches() async {
    let gateway = SkillsGateway()
    let model = SkillsModel(service: SkillsService(gateway: gateway.rpc.gateway), profile: "writer")

    #expect(model.phase == .loading)
    await model.load()

    #expect(model.phase == .ready)
    #expect(model.installed.map(\.name) == ["pdf", "web-search"])
    #expect(model.installed.map(\.enabled) == [false, true])
  }

  @Test func aFailedFirstReadIsAFailureAndAFailedRefreshKeepsTheList() async {
    let gateway = SkillsGateway()
    gateway.rpc.refuse("skills.manage", "gateway busy", code: 5000)
    let model = SkillsModel(service: SkillsService(gateway: gateway.rpc.gateway), profile: nil)

    await model.load()
    #expect(model.phase == .failed("gateway busy"))

    gateway.rpc.respond("skills.manage", jsonValue(#"{"skills": {"bundled": ["pdf"]}}"#))
    await model.load()
    #expect(model.phase == .ready)

    gateway.rpc.refuse("skills.manage", "gateway busy", code: 5000)
    await model.load()

    #expect(model.phase == .ready)
    #expect(model.installed.map(\.name) == ["pdf"])
    #expect(model.notice == .failed("gateway busy"))
  }

  @Test func anotherBotReadsTheListAgainAndTheSameBotDoesNot() async {
    let (model, gateway) = await opened()

    await model.setProfile("writer")
    #expect(gateway.rpc.calls("skills.manage").count == 1)

    await model.setProfile("researcher")
    #expect(model.profile == "researcher")
    #expect(gateway.rpc.calls("skills.manage").count == 2)
    #expect(gateway.rpc.calls("skills.manage").last?["profile"] == "researcher")
  }

  // MARK: The hub

  @Test func theHubIsBrowsedAPageAtATimeAndTheNextPageIsAppended() async {
    let (model, _) = await opened()

    #expect(model.hubPhase == .idle)
    await model.searchHub("")

    #expect(model.hubPhase == .ready)
    #expect(model.hub.count == 20)
    #expect(model.canLoadMore)

    await model.loadMore()
    #expect(model.hub.count == 40)

    await model.loadMore()
    #expect(model.hub.count == 45)
    #expect(model.canLoadMore == false, "the last page has no next one")
    #expect(Set(model.hub.map(\.id)).count == 45)
  }

  @Test func aSearchReplacesTheBrowseListAndHasNoPaging() async {
    let (model, _) = await opened()
    await model.searchHub("")

    await model.searchHub("skill-1")

    #expect(model.query == "skill-1")
    #expect(model.hub.map(\.name) == (10...19).map { "skill-\($0)" })
    #expect(model.canLoadMore == false)

    await model.searchHub("  ")
    #expect(model.query == "")
    #expect(model.hub.count == 20, "an empty query browses again")
  }

  @Test func aSearchThatANewerOneOvertookIsDropped() async {
    let (model, gateway) = await opened()
    gateway.rpc.hold("skills.manage")

    let first = Task { await model.searchHub("skill-0") }
    await eventually { gateway.rpc.isHolding }

    await model.searchHub("skill-4")
    gateway.rpc.release()
    await first.value

    #expect(model.query == "skill-4")
    #expect(model.hub.map(\.name) == (40...45).map { "skill-\($0)" })
  }

  @Test func aHubThatCannotBeReadSaysSo() async {
    let (model, gateway) = await opened()
    gateway.rpc.refuse("skills.manage", "hub unreachable", code: 5000)

    await model.searchHub("")

    #expect(model.hubPhase == .failed("hub unreachable"))
  }

  @Test func inspectingASkillIsAskedOnceAndAMissIsNotAnError() async {
    let (model, gateway) = await opened()
    let known = HubSkill(name: "skill-01")
    let unknown = HubSkill(name: "nowhere")

    await model.inspect(known)
    await model.inspect(known)

    if case .loaded(let info) = model.inspected[known.id] {
      #expect(info.name == "skill-01")
    } else {
      Issue.record("expected the skill's details, got \(String(describing: model.inspected[known.id]))")
    }

    await model.inspect(unknown)

    #expect(model.inspected[unknown.id] == .unknown)
    #expect(gateway.rpc.calls("skills.manage").filter { $0["action"] == "inspect" }.count == 2)
  }

  // MARK: Installing

  @Test func anInstallPutsTheSkillInTheBotsListAndSaysSo() async {
    let (model, gateway) = await opened()
    let skill = HubSkill(name: "skill-07")

    #expect(model.isInstalled(skill) == false)
    #expect(await model.install(skill))

    #expect(model.notice == .installed("skill-07"))
    #expect(model.isInstalled(skill))
    #expect(model.installed.map(\.name).contains("skill-07"))
    #expect(model.installing.isEmpty)
    #expect(gateway.rpc.calls("skills.manage").filter { $0["action"] == "install" }.first?["profile"] == "writer")
  }

  @Test func anInstalledSkillIsNotInstalledAgain() async {
    let (model, gateway) = await opened()

    #expect(await model.install(HubSkill(name: "pdf")) == false)
    #expect(gateway.rpc.calls("skills.manage").filter { $0["action"] == "install" }.isEmpty)
  }

  @Test func aRefusedInstallIsToldInTheGatewaysWords() async {
    let (model, _) = await opened()

    #expect(await model.install(HubSkill(name: "ghost")) == false)
    #expect(model.notice == .installFailed("skill 'ghost' not found in the hub"))
  }

  @Test func aGatewayThatCannotInstallOverItsSocketGivesTheCommandToRunInstead() async {
    let (model, gateway) = await opened()
    gateway.state.withLock { $0.installRefusal = GatewayRPCError(.rejected, "unknown skills action: install", code: 4017) }

    #expect(await model.install(HubSkill(name: "skill-02")) == false)
    #expect(model.notice == .installCommand("hermes --profile writer skills install skill-02"))
  }

  @Test func oneInstallOfASkillRunsAtATime() async {
    let (model, gateway) = await opened()
    gateway.rpc.hold("skills.manage")
    let skill = HubSkill(name: "skill-03")

    let first = Task { await model.install(skill) }
    await eventually { gateway.rpc.isHolding }

    #expect(model.installing == [skill.id])
    #expect(await model.install(skill) == false)

    gateway.rpc.release()
    #expect(await first.value)
  }

  @Test func theNoticeCanBeDismissed() async {
    let (model, _) = await opened()
    _ = await model.install(HubSkill(name: "ghost"))

    model.dismissNotice()

    #expect(model.notice == nil)
  }
}
