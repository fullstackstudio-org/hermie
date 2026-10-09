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

/// The action row under a reply: when it is there, how loud it is, and when it has Retry.
@MainActor
@Suite struct ReplyActionsPlanTests {
  private func plan(
    _ visible: VisibleItem, latest: Bool = true, canRegenerate: Bool = true
  ) -> ReplyActionsPlan? {
    ReplyActionsPlan.make(
      for: assistant(visible), presentation: visible.presentation, latest: latest, canRegenerate: canRegenerate)
  }

  @Test func aFinishedReplyHasTheRowAndTheNewestHasItAtFullStrengthWithRetry() {
    #expect(plan(reply("a1")) == ReplyActionsPlan(emphasis: .latest, retry: true))
  }

  @Test func anOlderReplyHasTheRowQuieterAndNeverRetry() {
    #expect(plan(reply("a1"), latest: false) == ReplyActionsPlan(emphasis: .earlier, retry: false))
    #expect(plan(reply("a1"), latest: false, canRegenerate: true)?.retry == false)
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
    #expect(ReplyActionsPlan.make(for: failed, presentation: .full, latest: true, canRegenerate: true) == nil)
  }
}

/// Which row is the chat's newest reply, so the action row's strength follows the conversation.
@MainActor
@Suite struct LatestReplyTests {
  private func latest(_ items: [VisibleItem]) -> [String] {
    var builder = TranscriptRowBuilder()
    return builder.rows(for: items).filter(\.latestReply).map(\.id)
  }

  @Test func theNewestReplyOfAnAnsweredTurnIsTheLatest() {
    #expect(latest([user("u1"), reply("a1"), user("u2"), reply("a2")]) == ["a2"])
  }

  @Test func aTurnNotAnsweredYetLeavesNoLatestReply() {
    #expect(latest([user("u1"), reply("a1"), user("u2")]).isEmpty)
  }

  @Test func anInterimNoteOrAReplyWithoutWordsIsNotTheLatest() {
    #expect(latest([user("u1"), reply("a1"), reply("a2", "looking", interim: true)]) == ["a1"])
    #expect(latest([user("u1"), reply("a1"), reply("a2", "")]) == ["a1"])
  }

  @Test func theLatestFlagIsPartOfWhatARowIsComparedOn() {
    var builder = TranscriptRowBuilder()
    let before = builder.rows(for: [user("u1"), reply("a1")])
    let after = builder.rows(for: [user("u1"), reply("a1"), user("u2")])
    #expect(before[1].latestReply)
    #expect(!after[1].latestReply)
    #expect(before[1] != after[1], "the row is drawn again when a prompt takes its place as the newest")
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
