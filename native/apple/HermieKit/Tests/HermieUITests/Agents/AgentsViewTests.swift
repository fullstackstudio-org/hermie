import Foundation
import HermieCore
import HermieMarkdown
import SwiftUI
import Testing

@testable import HermieUI

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// The agents overview's parts that are plain functions or lay out without a window: the sheet the router
/// opens, the lines under a bot, the words in three languages, and the chart block's labels. (The screen itself
/// is not driven by UI tests.)
@MainActor
@Suite("Agents overview: the shell's side")
struct AgentsViewTests {
  private static let now = Date(timeIntervalSince1970: 1_791_201_600)
  private static let bot = Bot(name: "researcher", displayName: "Researcher")

  private func rowView(_ row: AgentRow) -> AgentRowView {
    AgentRowView(row: row, avatar: nil, now: Self.now, action: {})
  }

  // MARK: The router's sheet

  @Test func theOverviewIsASheetOfTheRouter() {
    let router = AppRouter()

    router.present(.agents)
    #expect(router.sheet == .agents)
    router.dismissSheet(.needsYou)
    #expect(router.sheet == .agents, "another sheet's dismissal leaves it up")
    router.dismissSheet(.agents)
    #expect(router.sheet == nil)
  }

  // MARK: The lines under a bot

  @Test func aQuietBotShowsItsNextCronAndNothingAboutAnyTurn() {
    let next = AgentCron(id: "researcher/c", name: "Morning digest", nextRunAt: Self.now.addingTimeInterval(3 * 3600))
    let lines = rowView(AgentRow(bot: Self.bot, nextCron: next)).lines

    #expect(lines.count == 1)
    #expect(lines[0].contains("Morning digest"))
    #expect(!lines[0].hasPrefix("native."))
  }

  @Test func aQuietBotWithNothingScheduledHasNoLines() {
    #expect(rowView(AgentRow(bot: Self.bot)).lines.isEmpty)
  }

  @Test func aRunningBotNamesTheToolItUsesAndSinceWhen() {
    let row = AgentRow(
      bot: Self.bot, state: .running, tool: AgentTool(name: "web_search", context: "latest rates"),
      startedAt: Self.now.addingTimeInterval(-300))
    let lines = rowView(row).lines

    #expect(lines.count == 2)
    #expect(lines[0].contains("web_search") && lines[0].contains("latest rates"))
    #expect(!lines[1].isEmpty)
  }

  @Test func withoutAToolItShowsTheNewestLineAndAWaitingBotLeadsWithWhatWaits() {
    let row = AgentRow(
      bot: Self.bot, state: .waiting, waitingCount: 2, preview: "Which branch should I use?",
      subagents: [AgentSubagent(id: "s1")])
    let lines = rowView(row).lines

    #expect(lines.first == NativeStrings.NeedsYou.count(2))
    #expect(lines.contains("Which branch should I use?"))
    #expect(lines.contains(NativeStrings.Agents.subagentsRunning(1)))
  }

  @Test func aQuietBotDoesNotShowAStaleNewestLineOrANextCronWhileItRuns() {
    let next = AgentCron(id: "c", name: "Digest", nextRunAt: Self.now.addingTimeInterval(60))
    let idle = AgentRow(bot: Self.bot, state: .idle, preview: "an old line", nextCron: next)
    let running = AgentRow(bot: Self.bot, state: .running, preview: "now", nextCron: next)

    #expect(!rowView(idle).lines.contains("an old line"))
    #expect(rowView(running).lines.allSatisfy { !$0.contains("Digest") })
  }

  // MARK: Layout

  private func size(_ view: some View, _ type: DynamicTypeSize, width: CGFloat = 320) -> CGSize {
    let sized = view.environment(\.dynamicTypeSize, type).frame(width: width)
    #if os(macOS)
      return NSHostingController(rootView: sized).sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
    #else
      return UIHostingController(rootView: sized).sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
    #endif
  }

  @Test(arguments: [AgentState.waiting, .running, .idle])
  func everyStateLaysOutInANarrowColumnAtTheLargestTextSize(state: AgentState) {
    let row = AgentRow(
      bot: Bot(name: "researcher", displayName: "Researcher with a rather long display name"), state: state,
      waitingCount: state == .waiting ? 3 : 0, tool: AgentTool(name: "web_search", context: "a long preview of the call"),
      preview: "The newest line of the session, long enough to wrap", startedAt: Self.now.addingTimeInterval(-90),
      subagents: [AgentSubagent(id: "s1")],
      nextCron: AgentCron(id: "c", name: "Morning digest", nextRunAt: Self.now.addingTimeInterval(7200)))
    let large = size(rowView(row), .large)
    let huge = size(rowView(row), .accessibility5)

    #expect(huge.width <= 320.5, "\(state) is \(huge.width) wide")
    #expect(huge.height > 0 && huge.height >= large.height)
  }

  @Test func subagentAndCronRowsLayOut() {
    let sub = AgentSubagentRowView(
      owner: "Researcher", subagent: AgentSubagent(id: "s1", goal: "Audit the dependencies", toolCount: 4), now: Self.now)
    let cron = CronRowView(
      cron: AgentCron(id: "c", name: "Morning digest", schedule: "every 30m", nextRunAt: Self.now.addingTimeInterval(600)),
      owner: "Researcher", now: Self.now)

    #expect(size(sub, .accessibility5).width <= 320.5)
    #expect(size(cron, .accessibility5).width <= 320.5)
    #expect(size(sub, .large).height > 0 && size(cron, .large).height > 0)
  }

  // MARK: The words

  @Test func everyStateHasItsOwnWord() {
    let words = [AgentState.waiting, .running, .idle].map(NativeStrings.Agents.state)

    #expect(Set(words).count == 3)
    #expect(words.allSatisfy { !$0.hasPrefix("native.") })
  }

  @Test func thePluralsFollowTheNumber() {
    #expect(NativeStrings.Agents.otherRunning(1) != NativeStrings.Agents.otherRunning(3))
    #expect(NativeStrings.Agents.otherRunning(3).contains("3"))
    #expect(NativeStrings.Agents.subagentsRunning(1) != NativeStrings.Agents.subagentsRunning(2))
    #expect(NativeStrings.Agents.toolCalls(1) != NativeStrings.Agents.toolCalls(5))
  }

  @Test func theNamesAreInTheirSentences() {
    #expect(NativeStrings.Agents.using("web_search").contains("web_search"))
    #expect(NativeStrings.Agents.started("5 min ago").contains("5 min ago"))
    #expect(NativeStrings.Agents.nextCron("Digest", "in 2h").contains("Digest"))
    #expect(NativeStrings.Agents.nextCron("Digest", "in 2h").contains("in 2h"))
  }

  @Test(arguments: [
    "native.agents.command", "native.agents.subtitle", "native.agents.state.waiting", "native.agents.state.running",
    "native.agents.state.idle", "native.agents.section.crons", "native.agents.loading", "native.agents.offline",
    "native.agents.empty.title", "native.agents.empty.message", "native.agents.incomplete",
    "native.agents.row.using", "native.agents.row.started", "native.agents.row.nextCron", "native.agents.row.hint",
    "native.agents.subagent.queued", "native.agents.crons.none", "native.agents.crons.unknown"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }

  /// A plural lives in the `.stringsdict`, with a form for one and for the others, in every language.
  @Test(arguments: ["native.agents.otherRunning", "native.agents.row.subagents", "native.agents.subagent.toolCalls"])
  func aPluralHasItsFormsInEveryLanguage(_ key: String) throws {
    try expectPluralForms(key)
  }

  /// The same word in a language that borrows it.
  @Test(arguments: [
    "native.agents.title", "native.agents.section.bots", "native.agents.section.subagents",
    "native.agents.subagent.unnamed"
  ])
  func theSameWhereTheWordIsShared(_ key: String) throws {
    try expectTranslated(key, sameIn: ["nl", "de"])
  }

  @Test func theNextCronSentenceKeepsBothPlaceholdersInEveryLanguage() throws {
    for (language, text) in try nativeTexts("native.agents.row.nextCron") {
      #expect(text.contains("%1$@") && text.contains("%2$@"), "in \(language)")
    }
  }
}
