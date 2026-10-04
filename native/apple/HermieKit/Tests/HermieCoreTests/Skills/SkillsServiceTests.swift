import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

@Suite(.timeLimit(.minutes(1))) struct SkillsServiceTests {
  private let rpc = ScriptedRPC()
  private var service: SkillsService { SkillsService(gateway: rpc.gateway) }

  private func armList() {
    rpc.respond(
      "skills.manage",
      jsonValue(#"{"skills": {"bundled": ["web-search", "pdf"], "installed": ["xlsx"]}}"#))
  }

  // MARK: The installed list

  @Test func theCategoryMapIsFlattenedIntoRowsSortedByName() async throws {
    armList()

    let rows = try await service.installed(profile: nil)

    #expect(rows.map(\.name) == ["pdf", "web-search", "xlsx"])
    #expect(rows.map(\.category) == ["bundled", "bundled", "installed"])
    #expect(rows.allSatisfy { $0.enabled == nil }, "nobody was asked about, so no row says it is on")
    #expect(rpc.calls("profiles.describe").isEmpty)
  }

  @Test func theBotsSwitchesComeFromProfilesDescribeAndAnAbsentSkillIsOn() async throws {
    armList()
    rpc.respond(
      "profiles.describe",
      jsonValue(#"{"skills": [{"name": "pdf", "enabled": false}, {"name": "xlsx", "enabled": true}]}"#))

    let rows = try await service.installed(profile: "writer")

    #expect(rows.first { $0.name == "pdf" }?.enabled == false)
    #expect(rows.first { $0.name == "xlsx" }?.enabled == true)
    #expect(rows.first { $0.name == "web-search" }?.enabled == true, "not in the stored disabled set")
    #expect(rpc.calls("skills.manage").first?["profile"] == "writer", "the list is scoped to the bot")
    #expect(rpc.calls("profiles.describe").first?["name"] == "writer")
  }

  @Test func aGatewayWithoutProfilesDescribeStillListsTheSkillsWithoutSwitches() async throws {
    armList()
    rpc.refuse("profiles.describe", "unknown method", code: -32601)

    let rows = try await service.installed(profile: "writer")

    #expect(rows.count == 3)
    #expect(rows.allSatisfy { $0.enabled == nil })
  }

  @Test func aListThatIsNotACategoryMapIsEmptyNotAnError() async throws {
    rpc.respond("skills.manage", jsonValue(#"{"skills": ["pdf"]}"#))

    #expect(try await service.installed(profile: nil).isEmpty)
  }

  @Test func aRefusedListThrows() async {
    rpc.refuse("skills.manage", "profile not found", code: 4001)

    await #expect(throws: GatewayRPCError.self) { try await service.installed(profile: "ghost") }
  }

  // MARK: The hub

  @Test func browseAsksForAPageAndReadsItemsAndPaging() async throws {
    rpc.respond(
      "skills.manage",
      jsonValue(
        """
        {"items": [{"name": "xlsx", "description": "Spreadsheets.", "source": "hub", "trust": "community", "identifier": "hub/xlsx"},
                   {"name": "pdf", "description": "PDFs.", "source": "bundled"}],
         "page": 2, "total_pages": 3, "total": 41}
        """))

    let page = try await service.browse(page: 2)

    #expect(page.items.map(\.identifier) == ["hub/xlsx", "pdf"], "the identifier where there is one, the name where not")
    #expect(page.items.first?.trust == "community")
    #expect(page.page == 2 && page.totalPages == 3 && page.total == 41)
    #expect(page.hasMore)

    let call = try #require(rpc.calls("skills.manage").first)

    #expect(call["action"] == "browse")
    #expect(call["page"] == 2)
    #expect(call["page_size"] == 20)
  }

  @Test func aSearchReadsResultsWhichCarryOnlyANameAndADescription() async throws {
    rpc.respond(
      "skills.manage", jsonValue(#"{"results": [{"name": "xlsx", "description": "Spreadsheets."}, {"description": "no name"}]}"#))

    let hits = try await service.search("sheet")

    #expect(hits.map(\.name) == ["xlsx"], "a row with no name cannot be installed and is dropped")
    #expect(hits.first?.source == nil)
    #expect(rpc.calls("skills.manage").first?["query"] == "sheet")
    #expect(rpc.calls("skills.manage").first?["action"] == "search")
  }

  @Test func inspectReadsWhatTheHubSaysAndAMissIsNil() async throws {
    rpc.respond(
      "skills.manage",
      jsonValue(
        ##"{"info": {"name": "xlsx", "description": "Spreadsheets.", "source": "hub", "tags": ["community"], "skill_md_preview": "# xlsx"}}"##
      ))

    let info = try #require(try await service.inspect("xlsx"))

    #expect(info.name == "xlsx")
    #expect(info.tags == ["community"])
    #expect(info.preview == "# xlsx")

    rpc.respond("skills.manage", jsonValue(#"{"info": {}}"#))

    #expect(try await service.inspect("nowhere") == nil)
  }

  // MARK: Installing

  @Test func anInstallNamesTheSkillAndTheBotAndAnswersTheInstalledName() async throws {
    rpc.respond("skills.manage", jsonValue(#"{"installed": true, "name": "xlsx"}"#))

    let name = try await service.install("hub/xlsx", profile: "writer")

    #expect(name == "xlsx")

    let call = try #require(rpc.calls("skills.manage").first)

    #expect(call["action"] == "install")
    #expect(call["query"] == "hub/xlsx")
    #expect(call["profile"] == "writer")
  }

  @Test func anInstallTheGatewayAnswersWithoutInstallingIsAFailure() async {
    rpc.respond("skills.manage", jsonValue(#"{"installed": false}"#))

    await #expect(throws: GatewayRPCError.self) { try await service.install("xlsx", profile: nil) }
  }

  @Test func theInstallCommandIsWhatTheGatewaysOwnMachineRuns() {
    #expect(SkillsService.installCommand("xlsx", profile: nil) == "hermes skills install xlsx")
    #expect(SkillsService.installCommand("xlsx", profile: "writer") == "hermes --profile writer skills install xlsx")
  }

  @Test func theSocketHasNoUninstallSoTheCommandIsWhatTheGatewaysMachineRuns() {
    #expect(SkillsService.uninstallCommand("xlsx", profile: nil) == "hermes skills uninstall xlsx")
    #expect(SkillsService.uninstallCommand("xlsx", profile: "writer") == "hermes --profile writer skills uninstall xlsx")
  }

  @Test func anUnknownActionIsRecognisedByItsCodeAndByItsWords() {
    #expect(SkillsService.isUnknownAction(GatewayRPCError(.rejected, "unknown skills action: install", code: 4017)))
    #expect(SkillsService.isUnknownAction(GatewayRPCError(.rejected, "Unknown skills action", code: nil)))
    #expect(!SkillsService.isUnknownAction(GatewayRPCError(.rejected, "skill not found", code: 5024)))
    #expect(!SkillsService.isUnknownAction(GatewayError(.network, "no connection")))
  }
}
