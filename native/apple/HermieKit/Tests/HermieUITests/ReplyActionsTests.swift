import CoreGraphics
import Foundation
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieUI

private func base(_ id: String, version: Int = 1) -> ItemBase {
  ItemBase(id: id, seq: 0, ts: nil, origin: .history, version: version)
}

private func user(_ id: String) -> VisibleItem {
  VisibleItem(item: .user(UserItem(base: base(id), text: "hello")), presentation: .full)
}

private func reply(
  _ id: String, _ text: String = "ok", streaming: Bool = false, interim: Bool = false,
  presentation: Presentation = .full
) -> VisibleItem {
  VisibleItem(
    item: .assistant(AssistantItem(base: base(id), text: text, streaming: streaming, interim: interim)),
    presentation: presentation)
}

private func assistant(_ visible: VisibleItem) -> AssistantItem {
  guard case .assistant(let item) = visible.item else { fatalError("not a reply") }
  return item
}


/// The action row under a bot turn: when it is there, how loud it is, and when it has Retry.
@MainActor
@Suite struct ReplyActionsPlanTests {
  private func turn(latest: Bool = true) -> TurnReply {
    TurnReply(text: "ok", latest: latest, stamp: [1])
  }

  private func plan(
    _ visible: VisibleItem, turn: TurnReply? = nil, canRegenerate: Bool = true
  ) -> ReplyActionsPlan? {
    ReplyActionsPlan.make(
      for: assistant(visible), presentation: visible.presentation, turn: turn ?? self.turn(),
      canRegenerate: canRegenerate)
  }

  @Test func aFinishedTurnHasTheRowAndTheNewestHasItAtFullStrengthWithRetry() {
    #expect(plan(reply("a1")) == ReplyActionsPlan(emphasis: .latest, retry: true))
  }

  @Test func anOlderTurnHasTheRowQuieterAndNeverRetry() {
    #expect(plan(reply("a1"), turn: turn(latest: false)) == ReplyActionsPlan(emphasis: .earlier, retry: false))
  }

  @Test func aRowThatClosesNoTurnHasNoRow() {
    let visible = reply("a1")
    #expect(
      ReplyActionsPlan.make(for: assistant(visible), presentation: .full, turn: nil, canRegenerate: true) == nil)
  }

  @Test func retryNeedsTheChatToOfferRegenerate() {
    #expect(plan(reply("a1"), canRegenerate: false) == ReplyActionsPlan(emphasis: .latest, retry: false))
  }

  @Test func noRowWhileTheReplyIsStillBeingWritten() {
    #expect(plan(reply("a1", "so far", streaming: true)) == nil)
  }

  @Test func noRowUnderAnInterimNoteAChipOrAReplyWithoutWords() {
    #expect(plan(reply("a1", "let me look", interim: true)) == nil)
    #expect(plan(reply("a1", presentation: .chip)) == nil)
    #expect(plan(reply("a1", presentation: .hiddenPlaceholder)) == nil)
    #expect(plan(reply("a1", " \n ")) == nil)
  }

  @Test func noRowUnderAFailedReply() {
    var failed = assistant(reply("a1", "partial"))
    failed.error = AssistantFailure(message: "boom", partial: false)
    #expect(ReplyActionsPlan.make(for: failed, presentation: .full, turn: turn(), canRegenerate: true) == nil)
  }
}

/// Which row closes each bot turn, what it acts on, and how loud it is.
@MainActor
@Suite struct TurnReplyTests {
  private func turns(_ items: [VisibleItem]) -> [(id: String, turn: TurnReply)] {
    var builder = TranscriptRowBuilder()
    return builder.rows(for: items).compactMap { row in row.turnReply.map { (row.id, $0) } }
  }

  @Test func aTurnOfSeveralRepliesHasOneRowUnderItsLastReply() {
    let found = turns([user("u1"), reply("a1", "Answer."), reply("a2", "Here is the shape:"), reply("a3", "That is all.")])
    #expect(found.map(\.id) == ["a3"])
  }

  @Test func eachTurnHasItsOwnRowAndOnlyTheNewestIsTheLatest() {
    let found = turns([user("u1"), reply("a1"), reply("a2"), user("u2"), reply("a3")])
    #expect(found.map(\.id) == ["a2", "a3"])
    #expect(found.map(\.turn.latest) == [false, true])
  }

  @Test func theRowActsOnAllTheTurnsWordsJoinedByABlankLine() {
    let found = turns([user("u1"), reply("a1", "First."), reply("a2", "Second."), user("u2"), reply("a3", "Other.")])
    #expect(found[0].turn.text == "First.\n\nSecond.")
    #expect(found[1].turn.text == "Other.", "another turn's words are not in it")
  }

  @Test func interimNotesAndEmptyRepliesAreNoPartOfTheTurn() {
    let found = turns([user("u1"), reply("a1", "Looking…", interim: true), reply("a2", "Done."), reply("a3", "")])
    #expect(found.map(\.id) == ["a2"])
    #expect(found[0].turn.text == "Done.")
  }

  @Test func aTurnNotAnsweredYetHasNoRowAndTheTurnBeforeItIsHistory() {
    let found = turns([user("u1"), reply("a1"), user("u2")])
    #expect(found.map(\.id) == ["a1"])
    #expect(found[0].turn.latest == false)
  }

  @Test func aRowIsComparedOnWhatWentIntoItsTurn() {
    var builder = TranscriptRowBuilder()
    let one = builder.rows(for: [user("u1"), reply("a1", "First.")])
    let two = builder.rows(for: [user("u1"), reply("a1", "First."), reply("a2", "Second.")])
    let after = builder.rows(for: [user("u1"), reply("a1", "First."), reply("a2", "Second."), user("u2")])
    #expect(one[1].turnReply?.latest == true)
    #expect(two[2].turnReply?.text == "First.\n\nSecond.")
    #expect(one[1] != two[1], "the first reply no longer closes the turn")
    #expect(two[2] != after[2], "the turn is history once a prompt follows it")
  }
}

/// The prose rhythm: the bot's replies take the large gap.
@MainActor
@Suite struct ChatProseGapTests {
  @Test func theBotsRepliesAlwaysTakeTheGroupGapBecauseTheyAreProseNotBubbles() {
    var builder = TranscriptRowBuilder()
    let rows = builder.rows(for: [user("u1"), reply("a1"), reply("a2")])
    let gaps = rows.map { TranscriptItemView.gap(above: $0, gaps: .chat) }
    #expect(gaps[1] == ChatSpacing.betweenGroups)
    #expect(gaps[2] == ChatSpacing.betweenGroups, "a second reply of the bot's is no bubble to hug the first")
  }
}
