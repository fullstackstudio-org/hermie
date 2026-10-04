import Foundation
import HermieMarkdown
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore
@testable import HermieUI

#if os(macOS)
  import AppKit
  import SwiftUI
#endif

private func base(_ id: String, ts: Double? = nil, version: Int = 1) -> ItemBase {
  ItemBase(id: id, seq: 0, ts: ts, origin: .history, version: version)
}

private func user(_ id: String, ts: Double? = nil) -> VisibleItem {
  VisibleItem(item: .user(UserItem(base: base(id, ts: ts), text: "hello")), presentation: .full)
}

private func reply(
  _ id: String, _ text: String = "ok", streaming: Bool = false, interim: Bool = false,
  presentation: Presentation = .full
) -> VisibleItem {
  VisibleItem(
    item: .assistant(AssistantItem(base: base(id), text: text, streaming: streaming, interim: interim)),
    presentation: presentation)
}

private func runningTool(_ id: String, presentation: Presentation = .hiddenPlaceholder) -> VisibleItem {
  VisibleItem(
    item: .tool(ToolItem(base: base(id), toolID: id, name: "terminal", status: .running, resultKnown: false)),
    presentation: presentation)
}

/// When the typing row is wanted (from the turn's activity and the rows), the debounce between that
/// and the row, the row as the transcript lays it out, and how the dots move.
@Suite struct TypingIndicatorTests {
  // MARK: Wanted

  @Test func theBotWorkingWithNothingWritingIsWanted() {
    // After the send, before the first delta: the turn runs, there is the reader's own message.
    #expect(TypingIndicator.wanted(activity: .working, items: [user("u1")]))
    // Thinking: the reply row exists but has no words (at normal and quiet it is not even listed).
    #expect(TypingIndicator.wanted(activity: .thinking, items: [user("u1"), reply("a1", "", streaming: true)]))
    #expect(TypingIndicator.wanted(activity: .delegating, items: [user("u1")]))
  }

  @Test func aToolPhaseAtQuietIsWantedThoughItsOwnRowIsHidden() {
    // Quiet keeps one hidden stand-in row for the running call: nothing on screen says the bot works.
    let items = [user("u1"), runningTool("t1")]
    #expect(TypingIndicator.wanted(activity: .tool("terminal"), items: items))
    // After an earlier note of the reply, too.
    #expect(TypingIndicator.wanted(activity: .tool("terminal"), items: [user("u1"), reply("a1", "Let me look", interim: true), runningTool("t1")]))
  }

  @Test func wordsArrivingOrNoTurnOrAQuestionOpenIsNotWanted() {
    let writing = [user("u1"), reply("a1", "Sure, here is", streaming: true)]
    #expect(!TypingIndicator.wanted(activity: .typing, items: writing), "the reply bubble stands on screen")
    #expect(!TypingIndicator.wanted(activity: .idle, items: [user("u1"), reply("a1", "Done.")]), "the turn is over")
    #expect(!TypingIndicator.wanted(activity: .waiting, items: [user("u1")]), "blocked on a person: a card says so")
  }

  @Test func aToolAnnouncedWhileTheReplyIsStillWritingWordsIsNotWanted() {
    // The activity names the tool, the bubble is still growing: no dots under a bubble that writes.
    let items = [user("u1"), reply("a1", "I will run", streaming: true)]
    #expect(!TypingIndicator.wanted(activity: .tool("terminal"), items: items))
    // An earlier turn's streaming reply (it cannot be; a stale flag) does not count past the reader's turn.
    #expect(TypingIndicator.wanted(activity: .working, items: [reply("a0", "old", streaming: true), user("u1")]))
  }

  @Test func aReplyDemotedToAChipDoesNotCountAsABubble() {
    let items = [user("u1"), reply("a1", "words", streaming: true, presentation: .chip)]
    #expect(TypingIndicator.wanted(activity: .working, items: items))
  }

  // MARK: Gate

  @Test func theRowAppearsOnlyAfterTheBotHasWorkedForTheDelay() {
    var gate = TypingIndicatorGate()
    var changed = gate.update(wanted: true, now: 10.0)
    #expect(!changed)
    #expect(!gate.visible)
    #expect(gate.showDeadline == 10.0 + TypingIndicatorGate.showDelay)

    // A streamed frame meanwhile changes nothing, and does not restart the wait.
    changed = gate.update(wanted: true, now: 10.1)
    #expect(!changed)
    #expect(gate.showDeadline == 10.0 + TypingIndicatorGate.showDelay)

    changed = gate.update(wanted: true, now: 10.0 + TypingIndicatorGate.showDelay)
    #expect(changed)
    #expect(gate.visible)
    #expect(gate.showDeadline == nil, "nothing left to wait for")
  }

  @Test func theRowGoesTheMomentTheFirstDeltaStartsStreaming() {
    var gate = TypingIndicatorGate()
    gate.update(wanted: true, now: 0)
    gate.update(wanted: true, now: 0.2)
    #expect(gate.visible)

    // The snapshot with the first words: not wanted (`typing`), gone with no delay.
    let changed = gate.update(wanted: false, now: 0.2)
    #expect(changed)
    #expect(!gate.visible)
  }

  @Test func theRowGoesTheMomentTheTurnEnds() {
    var gate = TypingIndicatorGate()
    gate.update(wanted: true, now: 0)
    gate.update(wanted: true, now: 1)
    #expect(gate.visible)
    let changed = gate.update(wanted: false, now: 1.001)
    #expect(changed)
    #expect(!gate.visible)
  }

  @Test func aStateThatComesAndGoesWithinTheDelayNeverShowsTheRow() {
    // A tool that runs and ends, a reply's words that follow within frames: no flash of the bubble.
    var gate = TypingIndicatorGate()
    var shown = false
    for (now, wanted) in [(0.00, true), (0.05, true), (0.08, false), (0.10, true), (0.15, true), (0.20, false)] {
      shown = gate.update(wanted: wanted, now: now) || shown
    }
    #expect(!shown)
    #expect(!gate.visible)
  }

  @Test func aStateThatWentAndCameBackWaitsAgainFromTheReturn() {
    var gate = TypingIndicatorGate()
    gate.update(wanted: true, now: 0)
    gate.update(wanted: false, now: 0.1)
    gate.update(wanted: true, now: 0.12)
    // 0.2 is past the first stretch's delay, not the second's.
    var changed = gate.update(wanted: true, now: 0.2)
    #expect(!changed)
    #expect(gate.showDeadline == 0.12 + TypingIndicatorGate.showDelay)
    changed = gate.update(wanted: true, now: 0.28)
    #expect(changed)
  }

  @Test func aLateTimerStillShowsTheRow() {
    var gate = TypingIndicatorGate()
    gate.update(wanted: true, now: 5)
    // The timer fired long after its deadline (a busy main actor): the row shows then.
    let changed = gate.update(wanted: true, now: 7)
    #expect(changed)
    #expect(gate.visible)
  }

  @Test func nothingWantedMeansNoDeadline() {
    var gate = TypingIndicatorGate()
    #expect(gate.showDeadline == nil)
    gate.update(wanted: false, now: 3)
    #expect(gate.showDeadline == nil)
    #expect(!gate.visible)
  }

  // MARK: The row in the transcript

  @Test func theTypingRowIsLastAndTheBotsBubbleInAGroupOfItsOwn() async {
    let pipeline = ChatRowPipeline()
    let items = [user("u1", ts: 1000)]

    let without = await pipeline.rows(for: items, typing: false)
    #expect(without.rows.map(\.id) == ["u1"])

    let with = await pipeline.rows(for: items, typing: true)
    #expect(with.rows.map(\.id) == ["u1", TranscriptRow.typingIndicatorID])
    let row = with.rows[1]
    #expect(row.isTypingIndicator)
    #expect(row.bubble == BubbleLayout(sender: .bot, opensGroup: true, closesGroup: true))
    // The room above it is a group's, as every bot bubble that follows the reader's turn has.
    #expect(TranscriptItemView.gap(above: row, gaps: .chat) == ChatSpacing.betweenGroups)
    #expect(!TranscriptRowBuilder.drawsNothing(row))
    // The reader's bubble is unchanged by it: it is the same row, equal.
    #expect(with.rows[0] == without.rows[0])
  }

  @Test func theTypingRowIsNoArrivalAndHidesNoLaterOne() async {
    let pipeline = ChatRowPipeline()
    _ = await pipeline.rows(for: [user("u1")], typing: true)

    // The reply's first words come in while the row is still in the rows the list was handed.
    let output = await pipeline.rows(for: [user("u1"), reply("a1", "Hi", streaming: true)], typing: false)
    #expect(output.rows.map(\.id) == ["u1", "a1"], "the typing row went with the words")
    #expect(output.arrived == 1, "the reply counts, measured from the last row of the transcript")

    let again = await pipeline.rows(for: [user("u1"), reply("a1", "Hi there", streaming: true)], typing: true)
    #expect(again.arrived == 0, "the typing row is not an arrival")
  }

  @Test func aReplyWithNoWordsYetIsNoBubbleAndDoesNotPartTheGroup() {
    var builder = TranscriptRowBuilder()
    let rows = builder.rows(for: [reply("a1", "Looking."), reply("a2", "", streaming: true), reply("a3", "Found it.")])
    #expect(rows[1].bubble == nil, "the typing row stands for it")
    #expect(rows[0].bubble?.closesGroup == true)
  }

  @Test func theTypingRowComparesEqualToItselfSoItIsNeverDrawnAgain() {
    #expect(TranscriptRowBuilder.typingIndicatorRow() == TranscriptRowBuilder.typingIndicatorRow())
  }

  // MARK: The dots

  @Test func oneWaveTakesTwelveTenthsOfASecondAndRepeats() {
    #expect(TypingDotsMotion.cycle == 1.2)
    for dot in 0..<TypingDotsMotion.dotCount {
      for elapsed in stride(from: 0.0, to: 1.2, by: 0.05) {
        let now = TypingDotsMotion.pulse(elapsed: elapsed, dot: dot)
        let later = TypingDotsMotion.pulse(elapsed: elapsed + TypingDotsMotion.cycle * 3, dot: dot)
        #expect(abs(now - later) < 1e-9)
      }
    }
  }

  @Test func eachDotSwellsAfterThePreviousOneAndRestsBetween() {
    // Each dot peaks once per cycle, the next one a stagger later.
    func peak(_ dot: Int) -> Double {
      stride(from: 0.0, to: TypingDotsMotion.cycle, by: 0.005).max { a, b in
        TypingDotsMotion.pulse(elapsed: a, dot: dot) < TypingDotsMotion.pulse(elapsed: b, dot: dot)
      } ?? -1
    }
    let peaks = (0..<3).map(peak)
    for (first, second) in zip(peaks, peaks.dropFirst()) {
      let gap = second - first
      #expect(abs(gap - TypingDotsMotion.stagger * TypingDotsMotion.cycle) < 0.02, "\(peaks)")
    }
    // At its peak a dot is full, and past its swell it is at rest.
    #expect(abs(TypingDotsMotion.pulse(elapsed: peaks[0], dot: 0) - 1) < 0.01)
    #expect(TypingDotsMotion.pulse(elapsed: TypingDotsMotion.span * TypingDotsMotion.cycle + 0.01, dot: 0) == 0)
  }

  @Test func theDotsFadeAndScaleTogetherAndStayVisibleAtRest() {
    let rest = TypingDotsMotion.frame(elapsed: TypingDotsMotion.cycle * 0.99, dot: 0)
    let peak = TypingDotsMotion.frame(elapsed: TypingDotsMotion.cycle * TypingDotsMotion.span / 2, dot: 0)
    #expect(rest.opacity < peak.opacity)
    #expect(rest.scale < peak.scale)
    #expect(rest.opacity > 0.2, "the three dots are always there")
    #expect(peak.opacity == 1 && abs(peak.scale - 1) < 1e-9)
  }

  @Test func underReduceMotionNothingChangesSizeAndTheWaveIsSlower() {
    for elapsed in stride(from: 0.0, to: 5.0, by: 0.1) {
      for dot in 0..<3 {
        let frame = TypingDotsMotion.frame(elapsed: elapsed, dot: dot, reduceMotion: true)
        #expect(frame.scale == 1)
        #expect(frame.opacity >= 0.4 && frame.opacity <= 0.9)
      }
    }
    #expect(TypingDotsMotion.reducedCycle > TypingDotsMotion.cycle)
  }
}

/// The typing row on a feed, over a model the tests hand snapshots.
@MainActor
@Suite struct TypingIndicatorFeedTests {
  let session = GatewaySession(gatewayID: "typing-under-test", link: UnreachableLink())

  private func feedOf(_ owner: ChatFeedOwner<ChatFeed>) -> ChatFeed? {
    let session = self.session
    owner.appeared {
      ChatFeed(chat: ChatRef(gatewayId: "typing-under-test", bot: "writer"), session: session) { _ in .none }
    }
    return owner.feed
  }

  private func apply(
    _ model: ChatModel, revision: Int, items: [VisibleItem], activity: TurnActivity, hydration: HydrationState = .live
  ) {
    model.apply(
      ChatSnapshot(
        key: model.key, items: items, hydration: hydration, busy: activity != .idle, turnActive: activity != .idle,
        activity: activity, openRequests: [], queue: [], attached: true, canLoadOlder: false, revision: revision))
  }

  @Test func theRowShowsAfterTheDelayAndGoesWithTheFirstWords() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(feedOf(owner))

    let applied = ContinuousClock.now
    apply(feed.model, revision: 1, items: [user("u1")], activity: .working)
    // Not `count == 1`: the delay is 150 ms and the poll 10 ms, so a loaded runner can first look
    // when the typing row is already there, and would then wait for a state that has gone by.
    await eventually("the reader's row") { !feed.rows.isEmpty }

    // Only a look inside the delay (with half of it to spare) says anything about "not yet".
    if ContinuousClock.now - applied < .seconds(TypingIndicatorGate.showDelay / 2) {
      #expect(feed.rows.last?.isTypingIndicator == false, "not yet: the delay")
    }

    await eventually("the typing row") { feed.rows.last?.isTypingIndicator == true }
    #expect(feed.rows.map(\.id) == ["u1", TranscriptRow.typingIndicatorID])

    apply(feed.model, revision: 2, items: [user("u1"), reply("a1", "Sure", streaming: true)], activity: .typing)
    await eventually("the reply's row in the typing row's place") { feed.rows.map(\.id) == ["u1", "a1"] }
  }

  @Test func aTurnThatEndsBeforeTheDelayNeverShowsIt() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(feedOf(owner))

    apply(feed.model, revision: 1, items: [user("u1")], activity: .working)
    apply(feed.model, revision: 2, items: [user("u1"), reply("a1", "Quick one.")], activity: .idle)
    await eventually("the reply") { feed.rows.map(\.id) == ["u1", "a1"] }
    try await Task.sleep(for: .milliseconds(400))
    #expect(feed.rows.map(\.id) == ["u1", "a1"], "the delay's timer found nothing to show")
  }

  @Test func aToolPhaseAtQuietShowsItAndTheSettledTurnTakesItAway() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(feedOf(owner))
    let items = [user("u1"), runningTool("t1")]

    apply(feed.model, revision: 1, items: items, activity: .tool("terminal"))
    await eventually("the typing row after the hidden tool row") { feed.rows.last?.isTypingIndicator == true }

    apply(feed.model, revision: 2, items: [user("u1"), reply("a1", "Done.")], activity: .idle)
    await eventually("the typing row gone") { feed.rows.last?.isTypingIndicator == false }
  }

  @Test func aCachedChatShowsNoDotsWhateverItsStoredTurnSays() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(feedOf(owner))

    apply(feed.model, revision: 1, items: [user("u1")], activity: .working, hydration: .cached)
    await eventually("the rows") { feed.rows.count == 1 }
    try await Task.sleep(for: .milliseconds(400))
    #expect(feed.rows.map(\.id) == ["u1"])
  }
}

#if os(macOS)
  /// The typing bubble is the assistant's bubble: the same chrome, the height of a one-line reply.
  @MainActor
  @Suite struct TypingIndicatorLayoutTests {
    private func size<Content: View>(_ view: Content, width: CGFloat = 390) -> CGSize {
      let host = NSHostingController(rootView: view.environment(\.markdownFillsWidth, false))
      return host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    /// A one-line reply's bubble, as `AssistantItemView` makes it.
    private struct OneLineReply: View {
      var body: some View {
        BubbleColumn(side: .incoming, width: .text) {
          MessageBubble(side: .incoming, tail: true, fill: BubblePalette.incoming) {
            MarkdownView(MarkdownDocument("Ok")).environment(\.markdownFillsWidth, false)
          }
        }
      }
    }

    @Test func theBubbleIsAsTallAsAOneLineReply() {
      let typing = size(TypingIndicatorRow())
      let words = size(OneLineReply())
      #expect(abs(typing.height - words.height) <= 1, "typing \(typing.height), a reply \(words.height)")
    }

    @Test func theBubbleHugsItsThreeDotsWithTheAssistantsPadding() {
      // The column gives its row the whole width; the bubble inside it is what hugs the dots.
      let width = size(
        MessageBubble(side: .incoming, tail: true, fill: BubblePalette.incoming) { TypingDots() }
      ).width
      let dots = CGFloat(TypingDotsMotion.dotCount) * TypingDots.diameter
        + CGFloat(TypingDotsMotion.dotCount - 1) * TypingDots.spacing
      #expect(abs(width - (dots + 2 * ChatSpacing.bubbleInsetH)) <= 1, "\(width)")
    }

    @Test func theLabelIsTheTypingWordTheHeaderUses() {
      #expect(!Strings.App.Chat.Subtitle.typing.isEmpty)
      #expect(Strings.App.Chat.Subtitle.typing.hasSuffix("…"))
    }
  }
#endif
