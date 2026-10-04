import Foundation
import HermieCore
import Testing

@testable import HermieUI

/// The parts of the capability pages (Memory, Skills, MCP servers, Connectors, Boards) that are plain
/// functions: where they sit in Settings, their words in all three languages, and how the models' cases
/// are said. (The views themselves are not driven by UI tests.)
@MainActor
struct CapabilityPagesTests {
  // MARK: Where they are

  @Test func eachPageIsOneRowOfSettingsAndSitsInTheGroupAfterMemoryAndNotifications() {
    let pages: [SettingsCategory] = [.skills, .mcpServers, .connectors, .kanban]
    let group = SettingsCategory.groups.first { $0.contains(.skills) }

    #expect(group == pages, "the four pages are one group, in the order a person reads them")
    let all = SettingsCategory.groups.flatMap { $0 }

    #expect(all.contains(.memory))
    #expect(all.contains(.mcp), "the gateway's own MCP endpoint")
    #expect(all.contains(.mcpServers), "the servers a bot reaches: another page")
  }

  @Test func everyPageHasATitleABlurbAndASymbolAndTheTwoMCPPagesAreToldApart() {
    for category in [SettingsCategory.memory, .skills, .mcpServers, .connectors, .kanban] {
      #expect(!category.title.isEmpty)
      #expect(!category.blurb.isEmpty)
      #expect(!category.systemImage.isEmpty)
      #expect(!category.title.hasPrefix("native."))
    }

    #expect(SettingsCategory.mcp.title != SettingsCategory.mcpServers.title)
    #expect(SettingsCategory.mcpServers.title == "MCP servers")
  }

  // MARK: Their words

  /// Every sentence of the pages is in the Native table in English, Dutch and German.
  @Test func everyNativeSentenceOfThePagesIsInAllThreeLanguages() throws {
    let prefixes = ["native.capability.", "native.skills.", "native.mcpServers.", "native.connectors.", "native.kanban."]
    let english = try table("en")
    let keys = english.keys.filter { key in prefixes.contains { key.hasPrefix($0) } }.sorted()

    #expect(keys.count >= 40, "the pages have their own sentences")

    for language in ["nl", "de"] {
      let translated = try table(language)

      for key in keys {
        let text = translated[key] ?? ""

        #expect(!text.isEmpty, "\(key) is missing in \(language)")
        #expect(!text.hasPrefix("native."), "\(key) is untranslated in \(language)")
      }
    }
  }

  @Test func theSentencesThatNameAThingKeepItsNameInEveryLanguage() throws {
    for language in ["en", "nl", "de"] {
      let path = try #require(HermieStringsLookup.bundle.path(forResource: language, ofType: "lproj"))
      let bundle = try #require(Bundle(path: path))

      for key in ["native.mcpServers.added", "native.mcpServers.removed", "native.mcpServers.keySaved", "native.mcpServers.removeTitle", "native.skills.openBotSettings", "native.mcpServers.openBotSettings"] {
        let text = bundle.localizedString(forKey: key, value: "MISSING", table: "Native")

        #expect(text.contains("%@"), "\(key) in \(language) lost its argument")
      }
    }
  }

  private func table(_ language: String) throws -> [String: String] {
    let path = try #require(HermieStringsLookup.bundle.path(forResource: language, ofType: "lproj"))
    let dictionary = try #require(NSDictionary(contentsOfFile: path + "/Native.strings") as? [String: String])

    return dictionary
  }

  // MARK: Saying what the models hold

  @Test func aServerIsSaidByWhatTheGatewayLastKnewAndByWhatAProbeFoundSince() {
    let server = McpServerRow(name: "files", runtime: .connected)

    let unknown = McpServerRow(name: "x", runtime: .unknown)
    let switchedOff = McpServerRow(name: "x", enabled: false, runtime: .connected)
    let needsAuth = McpServersModel.ProbeState.done(McpProbe(ok: false, needsAuth: true))
    let connected = McpServersModel.ProbeState.done(McpProbe(ok: true, tools: [McpTool(name: "a")]))

    let fromRuntime = McpServersText.status(of: server, probe: nil)
    let fromUnknown = McpServersText.status(of: unknown, probe: nil)
    let fromConfig = McpServersText.status(of: switchedOff, probe: nil)
    let fromAuthProbe = McpServersText.status(of: server, probe: needsAuth)
    let fromGoodProbe = McpServersText.status(of: server, probe: connected)
    let whileTesting = McpServersText.status(of: server, probe: .testing)

    #expect(fromRuntime == Strings.Mcp.Runtime.connected)
    #expect(fromUnknown == Strings.Mcp.Runtime.unknown)
    #expect(fromConfig == Strings.Mcp.Runtime.disabled)
    #expect(fromAuthProbe == Strings.Mcp.needsAuth)
    #expect(fromGoodProbe == Strings.Mcp.testOk(count: 1))
    #expect(whileTesting == Strings.Mcp.Runtime.connected, "a probe in flight says nothing yet")
  }

  @Test func everyNoticeOfEveryPageIsASentenceAndNeverACodeOrAKey() {
    let mcp: [McpServersModel.Notice] = [
      .authorised("a"), .authoriseFailed("denied"), .added("a"), .removed("a"), .keySaved("a"), .reloaded, .linkRefused,
      .failure("down")
    ]
    let connectors: [ConnectorsModel.Notice] = [
      .connected("Gmail"), .failed("refused"), .expired, .skipped, .noLink, .linkRefused, .readFailed("down")
    ]
    let board: [KanbanBoardModel.Notice] = [
      .moved(column: "ready"), .movedElsewhere(asked: "ready", got: "review"), .lockedTarget(column: "running"),
      .words("blocked by a parent"), .archived
    ]

    for notice in mcp {
      #expect(McpServersText.notice(notice)?.isEmpty == false)
      #expect(McpServersText.notice(notice)?.hasPrefix("native.") == false)
    }

    for notice in connectors {
      #expect(ConnectorsText.notice(notice)?.isEmpty == false)
      #expect(ConnectorsText.notice(notice)?.hasPrefix("native.") == false)
    }

    for notice in board {
      #expect(KanbanText.notice(notice)?.isEmpty == false)
      #expect(KanbanText.notice(notice)?.hasPrefix("native.") == false)
    }

    #expect(McpServersText.notice(nil) == nil)
    #expect(ConnectorsText.notice(nil) == nil)
    #expect(KanbanText.notice(nil) == nil)
  }

  @Test func aNoticeCarriesTheGatewaysWordsAndTheConnectorsOwnName() {
    #expect(McpServersText.notice(.authoriseFailed("access_denied"))?.contains("access_denied") == true)
    #expect(ConnectorsText.notice(.connected("Gmail"))?.contains("Gmail") == true)
    #expect(KanbanText.notice(.words("blocked by parent(s) not done"))?.contains("blocked by parent(s) not done") == true)
    #expect(KanbanText.notice(.moved(column: "ready"))?.contains(Strings.Kanban.Columns.ready) == true)
  }

  @Test func aConnectorIsConnectedSwitchedOffOrNotConnectedInThatOrder() {
    let connected = ConnectorsText.state(of: ConnectorItem(slug: "a", connected: true, enabled: false))
    let off = ConnectorsText.state(of: ConnectorItem(slug: "a", enabled: false))
    let idle = ConnectorsText.state(of: ConnectorItem(slug: "a", enabled: true))
    let unsaid = ConnectorsText.state(of: ConnectorItem(slug: "a"))

    #expect(connected == Strings.Connectors.State.connected)
    #expect(off == Strings.Connectors.State.disabled)
    #expect(idle == Strings.Connectors.State.notConnected)
    #expect(unsaid == Strings.Connectors.State.notConnected, "an absent flag is not off")
  }

  @Test func aColumnIsNamedByThePluginsWordWhereThisBuildHasNone() {
    #expect(KanbanText.column("ready") == Strings.Kanban.Columns.ready)
    #expect(KanbanText.column("icebox") == "icebox")
  }

  @Test func aCardIsSpokenByWhereItIsAndWhatItCarries() {
    let card = KanbanCard(id: "t_1", title: "Ship", status: "todo", assignee: "writer", priority: 2, commentCount: 3)
    let spoken = KanbanText.spoken(card)

    #expect(spoken.contains(Strings.Kanban.Columns.todo))
    #expect(spoken.contains("writer"))
    #expect(spoken.contains("2"))
    let bare = KanbanText.spoken(KanbanCard(id: "t_2", status: "done"))

    #expect(bare == Strings.Kanban.Columns.done, "nothing to add")
  }

  @Test func eachProblemOfAnMCPDraftIsASentence() {
    for problem in [McpServerDraft.Problem.nameMissing, .nameHasSpaces, .urlInvalid, .commandMissing] {
      #expect(!McpServersText.problem(problem).isEmpty)
      #expect(!McpServersText.problem(problem).hasPrefix("native."))
    }
  }
}
