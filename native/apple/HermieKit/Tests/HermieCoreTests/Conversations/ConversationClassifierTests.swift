import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

private func row(
  _ id: String, title: String? = nil, started: Double? = nil, count: Int? = nil, preview: String? = nil,
  resolved: String? = nil
) -> SessionListRow {
  var json: JSONObject = ["id": .string(id)]

  if let title { json["title"] = .string(title) }
  if let started { json["started_at"] = .number(started) }
  if let count { json["message_count"] = .number(Double(count)) }
  if let preview { json["preview"] = .string(preview) }
  if let resolved { json["resolved_id"] = .string(resolved) }

  return SessionListRow(json: json)
}

@Suite struct ConversationClassifierTests {
  @Test func theCanonicalRowIsFoundByTheRostersIDAndNeverListedTwice() {
    let groups = ConversationClassifier.classify(
      rows: [
        row("s-old", title: "Bot Chat · 2026-09-21 23:16", started: 10),
        row("s-now", title: "Whatever it was renamed to", started: 30),
        row("s-branch", title: "Branch · the idea", started: 20)
      ],
      canonicalID: "s-now"
    )

    #expect(groups.canonical?.id == "s-now")
    #expect(groups.branches.map(\.id) == ["s-branch"])
    #expect(groups.past.map(\.id) == ["s-old"])
    #expect(groups.all.map(\.id).sorted() == ["s-branch", "s-now", "s-old"])
  }

  @Test func theLineageTipOfTheRostersRowIsTheCanonicalRowToo() {
    let groups = ConversationClassifier.classify(
      rows: [row("s-1", title: "x", resolved: "s-tip")],
      canonicalID: "s-other",
      canonicalResolvedID: "s-tip"
    )

    #expect(groups.canonical?.id == "s-1")
    #expect(groups.canonical?.resolvedID == "s-tip")
  }

  @Test func withoutAnIDTheTitleIsTheRegistryKey() {
    let groups = ConversationClassifier.classify(
      rows: [row("s-1", title: "Bot Chat"), row("s-2", title: "Bot Chat · 2026-09-21 23:16")])

    #expect(groups.canonical?.id == "s-1")
    #expect(groups.past.map(\.id) == ["s-2"])
  }

  /// A person naming a past conversation `Bot Chat` must not move the one chat that may never be deleted.
  @Test func aTitleTypedByHandCannotStealTheCanonicalRowWhileTheRosterKnowsAnID() {
    let groups = ConversationClassifier.classify(
      rows: [row("s-real", title: "Whatever"), row("s-fake", title: "Bot Chat")], canonicalID: "s-real")

    #expect(groups.canonical?.id == "s-real")
    #expect(groups.past.map(\.id) == ["s-fake"])
    #expect(groups.past.first?.actions.contains(.delete) == true)
  }

  @Test func theFirstOfTwoCanonicalRowsWins() {
    let groups = ConversationClassifier.classify(
      rows: [row("a", title: "Bot Chat"), row("b", title: "Bot Chat")])

    #expect(groups.canonical?.id == "a")
    #expect(groups.past.isEmpty)
  }

  @Test func branchesAreRecognisedByTheirPrefixAndNotByALookalike() {
    #expect(ConversationClassifier.isBranchTitle("Branch"))
    #expect(ConversationClassifier.isBranchTitle("Branch · six words of it"))
    #expect(!ConversationClassifier.isBranchTitle("Branches of a tree"))
    #expect(!ConversationClassifier.isBranchTitle("branch · lower case"))
    #expect(ConversationClassifier.isRetiredTitle("Bot Chat · 2026-09-21 23:16"))
    #expect(!ConversationClassifier.isRetiredTitle("Bot Chat"))
  }

  @Test func eachGroupIsNewestFirstWithTheTitleAsTheTieBreak() {
    let groups = ConversationClassifier.classify(
      rows: [
        row("c", title: "Charlie", started: 5),
        row("a", title: "Alpha", started: 5),
        row("n", title: "Newest", started: 50),
        row("u", title: "No time at all")
      ],
      canonicalID: "nothing-matches"
    )

    #expect(groups.past.map(\.id) == ["n", "a", "c", "u"])
  }

  @Test func aRowWithNoIDIsDroppedAndAMissingTitleFallsBackToTheID() {
    let groups = ConversationClassifier.classify(
      rows: [SessionListRow(json: ["title": "No id"]), row("s-9"), row("s-8", title: "")])

    #expect(groups.past.map(\.id).sorted() == ["s-8", "s-9"])
    #expect(groups.past.allSatisfy { $0.title == $0.id })
  }

  @Test func theCountsAndTheTimeAreTheGatewaysWhereItSaidAndZeroWhereItDidNot() {
    let groups = ConversationClassifier.classify(
      rows: [row("s-1", title: "One", started: 1_790_000_000, count: 12, preview: "hello"), row("s-2", title: "Two")],
      canonicalID: "x"
    )
    let one = groups.past.first { $0.id == "s-1" }
    let two = groups.past.first { $0.id == "s-2" }

    #expect(one?.messageCount == 12)
    #expect(one?.lastActive == 1_790_000_000)
    #expect(one?.preview == "hello")
    #expect(two?.messageCount == 0)
    #expect(two?.lastActive == 0)
  }

  // MARK: What may be done

  @Test func theCanonicalConversationHasNoActionsAtAll() {
    let groups = ConversationClassifier.classify(rows: [row("s-1", title: "Bot Chat")])

    #expect(groups.canonical?.actions == [])
    #expect(groups.canonical?.allows(.delete) == false)
  }

  @Test func branchesAndPastConversationsCarryTheSameFourActions() {
    let groups = ConversationClassifier.classify(
      rows: [row("b", title: "Branch · x"), row("p", title: "Past")], canonicalID: "none")

    #expect(groups.branches.first?.actions == [.open, .rename, .delete, .adopt])
    #expect(groups.past.first?.actions == [.open, .rename, .delete, .adopt])
  }

  // MARK: Gateway text

  @Test func titlesAndPreviewsAreCleanedBoundedAndOnOneLine() {
    let conversation = Conversation(
      id: "s-1",
      title: "Line one\nline two \u{202E}reversed",
      preview: String(repeating: "word ", count: 100),
      kind: .past
    )

    #expect(!conversation.displayTitle.contains("\n"))
    #expect(!conversation.displayTitle.unicodeScalars.contains("\u{202E}"))
    #expect(conversation.displayPreview.count <= Conversation.previewLimit + 1)
  }

  @Test func aTitleThatCleansAwayToNothingIsDrawnAsItsID() {
    let conversation = Conversation(id: "s-77", title: "\u{200B}\u{202E}", kind: .past)

    #expect(conversation.displayTitle == "s-77")
  }
}
