import HermieCore
import Testing

@testable import HermieUI

/// The plain functions behind the bot settings' Toolsets, Skills and MCP servers rows and pages: what a row
/// says, when a page has a search field, and what the search lets through. (The views are not driven by UI
/// tests; the writes behind the switches are covered by `BotSettingsModelTests`.)
@MainActor
struct BotCapabilityRowsTests {
  private func details(
    toolsets: [BotToolset] = [], skills: [BotSwitch] = [], mcp: [BotSwitch] = []
  ) -> BotProfileDetails {
    BotProfileDetails(name: "ada", toolsets: toolsets, skills: skills, mcpServers: mcp)
  }

  private func summary(
    _ kind: BotCapabilityKind, _ details: BotProfileDetails?, loading: Bool = false, failed: Bool = false
  ) -> BotCapabilitySummary {
    BotCapabilityLogic.summary(kind, details: details, loading: loading, failed: failed)
  }

  // MARK: What a row says

  @Test func toolsetsSayHowManyAreOn() {
    let toolsets = (1...14).map { BotToolset(name: "t\($0)", enabled: $0 <= 8) }

    #expect(summary(.toolsets, details(toolsets: toolsets)) == .value(NativeStrings.BotSettings.summaryOfOn(8, of: 14), needsAttention: false))
    #expect(NativeStrings.BotSettings.summaryOfOn(8, of: 14).contains("8"))
    #expect(NativeStrings.BotSettings.summaryOfOn(8, of: 14).contains("14"))
  }

  @Test func allOnIsSaidWithoutTheTotalTwice() {
    let toolsets = (1...3).map { BotToolset(name: "t\($0)") }
    let servers = [BotSwitch(name: "a", transport: "stdio"), BotSwitch(name: "b", transport: "http")]

    #expect(summary(.toolsets, details(toolsets: toolsets)) == .value(NativeStrings.BotSettings.summaryOn(3), needsAttention: false))
    #expect(summary(.mcp, details(mcp: servers)) == .value(NativeStrings.BotSettings.summaryOn(2), needsAttention: false))
  }

  @Test func skillsAreJustCountedWhileNoneIsOff() {
    let all = (1...23).map { BotSwitch(name: "s\($0)") }
    var some = all
    some[0].enabled = false
    some[1].enabled = false

    #expect(summary(.skills, details(skills: all)) == .value("23", needsAttention: false))
    #expect(summary(.skills, details(skills: some)) == .value(NativeStrings.BotSettings.summaryOfOn(21, of: 23), needsAttention: false))
  }

  @Test func mcpServersAllOffSaysSoInNumbers() {
    let servers = [BotSwitch(name: "a", enabled: false), BotSwitch(name: "b", enabled: false)]

    #expect(summary(.mcp, details(mcp: servers)) == .value(NativeStrings.BotSettings.summaryOfOn(0, of: 2), needsAttention: false))
  }

  @Test func aFailedWriteIsWarnedOnTheRowOfItsKindOnly() {
    let servers = [BotSwitch(name: "a")]
    let loaded = details(skills: [BotSwitch(name: "s")], mcp: servers)

    #expect(summary(.mcp, loaded, failed: true) == .value(NativeStrings.BotSettings.summaryOn(1), needsAttention: true))
    #expect(summary(.skills, loaded, failed: false) == .value("1", needsAttention: false))
  }

  @Test func whileLoadingTheRowHasNoValue() {
    let loaded = details(toolsets: [BotToolset(name: "t")])

    for kind in BotCapabilityKind.allCases {
      #expect(summary(kind, loaded, loading: true) == .loading)
      #expect(summary(kind, nil, loading: true, failed: true) == .loading)
    }
  }

  @Test func nothingOfAKindIsNone() {
    for kind in BotCapabilityKind.allCases {
      #expect(summary(kind, details()) == .value(NativeStrings.BotSettings.summaryNone, needsAttention: false))
      #expect(summary(kind, nil) == .value(NativeStrings.BotSettings.summaryNone, needsAttention: false))
    }
  }

  @Test func everyKindHasItsOwnWordsAndSymbol() {
    #expect(Set(BotCapabilityKind.allCases.map(\.title)).count == 3)
    #expect(Set(BotCapabilityKind.allCases.map(\.about)).count == 3)
    #expect(Set(BotCapabilityKind.allCases.map(\.symbol)).count == 3)
    #expect(Set(BotCapabilityKind.allCases.map(\.key)).count == 3)

    for kind in BotCapabilityKind.allCases {
      #expect(!kind.title.isEmpty && !kind.title.hasPrefix("native."))
      #expect(!kind.about.isEmpty && !kind.about.hasPrefix("native."))
    }

    #expect(BotCapabilityKind.toolsets.field == .toolsets)
    #expect(BotCapabilityKind.skills.field == .skills)
    #expect(BotCapabilityKind.mcp.field == .mcp)
  }

  // MARK: The pages

  @Test func aLongListGetsASearchField() {
    #expect(!BotCapabilityLogic.showsSearch(itemCount: 0))
    #expect(!BotCapabilityLogic.showsSearch(itemCount: 8))
    #expect(BotCapabilityLogic.showsSearch(itemCount: 9))
  }

  @Test func aSearchNeedsEveryWordInAnyOrder() {
    let toolsets = [
      BotToolset(name: "web", label: "Web search", details: "Look things up online", toolCount: 3),
      BotToolset(name: "terminal", label: "Terminal", details: "Run commands", toolCount: 2)
    ]

    #expect(BotCapabilityLogic.toolsets(toolsets, matching: "").count == 2)
    #expect(BotCapabilityLogic.toolsets(toolsets, matching: "  ").count == 2)
    #expect(BotCapabilityLogic.toolsets(toolsets, matching: "SEARCH").map(\.name) == ["web"])
    #expect(BotCapabilityLogic.toolsets(toolsets, matching: "online web").map(\.name) == ["web"])
    #expect(BotCapabilityLogic.toolsets(toolsets, matching: "commands").map(\.name) == ["terminal"])
    #expect(BotCapabilityLogic.toolsets(toolsets, matching: "web terminal").isEmpty)
  }

  @Test func skillsMatchByNameAndMcpServersByNameOrTransport() {
    let skills = [BotSwitch(name: "pdf-tools"), BotSwitch(name: "git-helper")]
    let servers = [BotSwitch(name: "files", transport: "stdio"), BotSwitch(name: "docs", transport: "http")]

    #expect(BotCapabilityLogic.switches(skills, matching: "git").map(\.name) == ["git-helper"])
    #expect(BotCapabilityLogic.switches(skills, matching: "nope").isEmpty)
    #expect(BotCapabilityLogic.switches(servers, matching: "http").map(\.name) == ["docs"])
    #expect(BotCapabilityLogic.switches(servers, matching: "files").map(\.name) == ["files"])
    #expect(BotCapabilityLogic.switches(servers, matching: "").count == 2)
  }

  @Test func theNewSentencesAreInTheCatalogue() {
    let strings = [
      NativeStrings.BotSettings.capabilities, NativeStrings.BotSettings.summaryNone, NativeStrings.BotSettings.needsAttention,
      NativeStrings.BotSettings.noMatches, NativeStrings.BotSettings.summaryOn(5), NativeStrings.BotSettings.summaryOfOn(1, of: 2)
    ]

    for string in strings {
      #expect(!string.isEmpty)
      #expect(!string.hasPrefix("native."))
    }
  }
}
