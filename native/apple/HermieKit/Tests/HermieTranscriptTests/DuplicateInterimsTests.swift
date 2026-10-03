import Foundation
import HermieProtocol
import Testing

@testable import HermieTranscript

/// Mid-turn notes on screen twice, against the Swift engine directly.
///
/// The same behaviour is replayed call for call from `duplicate-interims.test.ts`
/// (the `duplicate-interims` golden suite) and end to end from the
/// `interim-reopen` stream scenario; these cases restate the owner's report of
/// 2026-10-03 (native 0.2.2, iPad) in Swift, so a regression reads as the bug it
/// is rather than as a JSON difference.
///
/// The gateway's side (`agent/turn_tool_round.py`, `tui_gateway/prompt_turn.py`):
/// a tool round streams its words as `message.delta`, PERSISTS the assistant row,
/// then sends `message.interim {text, already_streamed}` with no row id. History
/// later returns the row with a `row_id`; a chat opened from its cache replays the
/// frames after the cached watermark on top of those rows.
@Suite struct DuplicateInterimsTests {
  static let now = 1_790_000_000_000.0
  static let prompt = "doe wat je moet doen"
  static let first = "Entry 90 staat op Betaald. Nu de € 0,01 op Nog te betalen kosten: eerst kijken hoe die erop staat."
  static let second = "Ik zoek de mutatie zelf op via de API: de Mollie-uitbetaling van 16-09."
  static let final = "Ik heb alles nagelopen en niets ingediend."

  static func event(_ type: String, _ seq: Int, _ payload: JSONObject = [:]) -> GatewayEvent {
    GatewayEvent(json: ["type": .string(type), "seq": .number(Double(seq)), "payload": .object(payload)])
  }

  static func round(_ seq: Int, _ text: String, _ toolID: String) -> [GatewayEvent] {
    [
      event("message.delta", seq, ["text": .string(text)]),
      event("message.interim", seq + 1, ["text": .string(text), "already_streamed": true]),
      event("tool.start", seq + 2, ["tool_id": .string(toolID), "name": "terminal", "context": "curl"]),
      event("tool.complete", seq + 3, ["tool_id": .string(toolID), "name": "terminal", "result": "ok"])
    ]
  }

  static let turn: [GatewayEvent] =
    [event("message.start", 1)] + round(2, first, "call_1") + round(6, second, "call_2") + [
      event("message.delta", 10, ["text": .string(final)]),
      event("message.complete", 11, ["text": .string(final), "status": "complete"])
    ]

  static func row(_ json: JSONObject) -> TranscriptRow { TranscriptRow(json: json) }

  /// The rows `session.history` answers for that turn, stamped by the gateway's clock.
  static let rows: [TranscriptRow] = [
    row(["role": "user", "row_id": 1, "text": .string(prompt), "timestamp": 1_790_000_000]),
    row(["role": "assistant", "row_id": 2, "text": .string(first), "timestamp": 1_790_000_001]),
    row(["role": "tool", "name": "terminal", "context": "curl", "tool_call_id": "call_1", "timestamp": 1_790_000_002]),
    row(["role": "assistant", "row_id": 4, "text": .string(second), "timestamp": 1_790_000_003]),
    row(["role": "tool", "name": "terminal", "context": "curl", "tool_call_id": "call_2", "timestamp": 1_790_000_004]),
    row(["role": "assistant", "row_id": 6, "text": .string(final), "timestamp": 1_790_000_005])
  ]

  static func sent(_ text: String = prompt) -> ChatState {
    confirmSubmit(
      beginLocalTurn(createChatState("boekhouder", "stored-1", "resolved-1"), text, nil, now),
      PromptSubmitResult(json: ["status": "streaming"]),
      now
    )
  }

  static func apply(_ state: ChatState, _ events: some Sequence<GatewayEvent>) -> ChatState {
    events.reduce(state) { applyEvent($0, $1, now) }
  }

  static func assistants(_ state: ChatState) -> [AssistantItem] {
    state.orderedItems.compactMap(\.asAssistant)
  }

  static func shown(_ state: ChatState) -> [String] {
    assistants(state).map(\.text)
  }

  @Test("a chat opened from its mid-turn cache shows every note once, as its row")
  func reopenedFromTheCache() {
    var away = Self.apply(Self.sent(), Self.turn.prefix(5))
    away.lastSeqSessionID = "runtime-1"
    let cached = stateFromCache(
      "boekhouder", SessionIDs(storedSessionID: "stored-1", resolvedSessionID: "resolved-1"),
      snapshotForCache(away, now: Self.now)
    )
    let hydrated = reconcile(cached, rowsToItems(Self.rows, .rpc))
    let reopened = Self.apply(hydrated, Self.turn.dropFirst(5))

    #expect(Self.shown(reopened) == [Self.first, Self.second, Self.final])
    #expect(Self.assistants(reopened).map(\.rowID) == [2, 4, 6])
    #expect(!Self.assistants(reopened).contains { $0.interim })
    #expect(reopened.orderedItems.compactMap(\.asTool).map(\.toolID) == ["call_1", "call_2"])
  }

  @Test("a re-hydration folds a grey copy a 0.2.2 cache kept into its row")
  func foldsAKeptCopy() {
    let live = Self.apply(Self.sent(), Self.turn.prefix(5))
    var doubled = reconcile(live, rowsToItems(Array(Self.rows.prefix(4)), .rpc))
    let copy = AssistantItem(
      base: ItemBase(id: "a:99000", seq: 99_000, ts: 1_790_000_010, origin: .live, version: 0),
      text: Self.second,
      streaming: false,
      interim: true
    )
    doubled.items[copy.id] = .assistant(copy)
    doubled.order.append(copy.id)

    #expect(Self.shown(reconcile(doubled, rowsToItems(Self.rows, .rpc))) == [Self.first, Self.second, Self.final])
    #expect(
      Self.shown(reconcileTail(doubled, rowsToItems(Array(Self.rows.dropFirst(2)), .rest)))
        == [Self.first, Self.second, Self.final]
    )
  }

  @Test("two identical notes in one turn both stay")
  func identicalNotesInOneTurn() {
    let live = Self.apply(
      Self.sent("check both"),
      [
        Self.event("message.start", 1),
        Self.event("message.delta", 2, ["text": "Checking."]),
        Self.event("message.interim", 3, ["text": "Checking.", "already_streamed": true]),
        Self.event("tool.start", 4, ["tool_id": "call_a", "name": "terminal"]),
        Self.event("tool.complete", 5, ["tool_id": "call_a", "name": "terminal"]),
        Self.event("message.delta", 6, ["text": "Checking."]),
        Self.event("tool.start", 7, ["tool_id": "call_b", "name": "terminal"])
      ]
    )
    let firstRowOnly = rowsToItems(
      [
        Self.row(["role": "user", "row_id": 1, "text": "check both"]),
        Self.row(["role": "assistant", "row_id": 2, "text": "Checking."]),
        Self.row(["role": "tool", "name": "terminal", "tool_call_id": "call_a"])
      ],
      .rest
    )

    #expect(Self.shown(live) == ["Checking.", "Checking."])
    // A tail read before the second row was written must not swallow the second note.
    #expect(Self.shown(reconcileTail(live, firstRowOnly)) == ["Checking.", "Checking."])
  }

  @Test("a note repeating an earlier turn's words is not folded into that turn")
  func identicalNotesAcrossTurns() {
    let earlier = reconcile(
      createChatState("boekhouder", "stored-1", "resolved-1"),
      rowsToItems(
        [
          Self.row(["role": "user", "row_id": 1, "text": "first"]),
          Self.row(["role": "assistant", "row_id": 2, "text": "On it."])
        ],
        .rpc
      )
    )
    let next = confirmSubmit(
      beginLocalTurn(earlier, "second", nil, Self.now),
      PromptSubmitResult(json: ["status": "streaming"]),
      Self.now
    )
    let live = Self.apply(
      next,
      [Self.event("message.start", 1), Self.event("message.interim", 2, ["text": "On it.", "already_streamed": false])]
    )

    #expect(Self.shown(live) == ["On it.", "On it."])
  }

  @Test("a resume gives the reply only the words no note above already shows")
  func resumeSkipsTheNotes() {
    let loaded = reconcile(Self.sent(), rowsToItems(Array(Self.rows.prefix(5)), .rpc))
    let resumed = applyResumeSnapshot(
      loaded,
      SessionResumeResult(json: [
        "inflight": ["user": .string(Self.prompt), "assistant": .string(Self.first + Self.second + "Nu de"), "streaming": true],
        "running": true,
        "turn_started_at": 1_790_000_000
      ]),
      Self.now + 120_000
    )

    #expect(Self.shown(resumed) == [Self.first, Self.second, "Nu de"])
  }

  // MARK: - The review's cases

  /// What a chat opened again paints first: the cached transcript, with its watermark.
  static func fromCache(_ state: ChatState) -> ChatState {
    var watermarked = state
    watermarked.lastSeqSessionID = "runtime-1"
    return stateFromCache(
      "boekhouder", SessionIDs(storedSessionID: "stored-1", resolvedSessionID: "resolved-1"),
      snapshotForCache(watermarked, now: now)
    )
  }

  /// Opened again from what `away` cached: history first, then the frames after the watermark.
  static func reopen(_ away: ChatState, _ rows: [TranscriptRow], _ replay: [GatewayEvent]) -> ChatState {
    apply(reconcile(fromCache(away), rowsToItems(rows, .rpc)), replay)
  }

  static func call(_ seq: Int, _ toolID: String, _ result: String) -> [GatewayEvent] {
    [
      event("tool.start", seq, ["tool_id": .string(toolID), "name": "terminal", "context": .string(result)]),
      event("tool.complete", seq + 1, ["tool_id": .string(toolID), "name": "terminal", "result": .string(result)])
    ]
  }

  static func cards(_ state: ChatState) -> [String] {
    state.orderedItems.compactMap(\.asTool).map { "\($0.toolID)=\($0.result?.stringValue ?? "-")" }
  }

  static func submitted(_ state: ChatState, _ text: String) -> ChatState {
    confirmSubmit(beginLocalTurn(state, text, nil, now), PromptSubmitResult(json: ["status": "streaming"]), now)
  }

  @Test("a tool id used again in a later turn, or twice in one, gets a card of its own")
  func reusedToolIDs() {
    let one = Self.apply(
      Self.submitted(createChatState("boekhouder", "s", "s"), "one"),
      [Self.event("message.start", 1)] + Self.call(2, "call_0", "first")
        + [Self.event("message.complete", 4, ["text": "One done."])]
    )
    let two = Self.apply(
      Self.submitted(one, "two"),
      [Self.event("message.start", 5)] + Self.call(6, "call_0", "second") + Self.call(8, "call_0", "third")
    )

    #expect(Self.cards(two) == ["call_0=first", "call_0=second", "call_0=third"])
  }

  @Test("a reply that repeats the last note keeps its own bubble")
  func replyRepeatsTheNote() {
    let same = "Ik controleer het nog één keer."
    let noted = Self.reopen(
      Self.apply(Self.sent(), [Self.event("message.start", 1)]),
      [
        Self.row(["role": "user", "row_id": 1, "text": .string(Self.prompt)]),
        Self.row(["role": "assistant", "row_id": 2, "text": .string(same)])
      ],
      [
        Self.event("message.delta", 2, ["text": .string(same)]),
        Self.event("message.interim", 3, ["text": .string(same), "already_streamed": true])
      ]
    )
    let done = Self.apply(
      noted,
      [Self.event("message.delta", 4, ["text": .string(same)]), Self.event("message.complete", 5, ["text": .string(same)])]
    )

    #expect(Self.shown(done) == [same, same])
    #expect(Self.assistants(done).map(\.rowID) == [2, nil])
  }

  @Test("a replay that runs into the next turn settles each frame onto its own turn's row")
  func replaySpansTwoTurns() {
    let next = "en nu de verkoopkant"
    let rows =
      Self.rows + [
        Self.row(["role": "user", "row_id": 7, "text": .string(next), "timestamp": 1_790_000_006]),
        Self.row(["role": "assistant", "row_id": 8, "text": .string(Self.second), "timestamp": 1_790_000_007]),
        Self.row(["role": "tool", "name": "terminal", "context": "curl", "tool_call_id": "call_2", "timestamp": 1_790_000_008]),
        Self.row(["role": "assistant", "row_id": 10, "text": "Klaar.", "timestamp": 1_790_000_009])
      ]
    let replay: [GatewayEvent] =
      Array(Self.turn.dropFirst(5)) + [Self.event("message.start", 12)] + Self.round(13, Self.second, "call_2") + [
        Self.event("message.delta", 17, ["text": "Klaar."]), Self.event("message.complete", 18, ["text": "Klaar."])
      ]
    let state = Self.reopen(Self.apply(Self.sent(), Self.turn.prefix(5)), rows, replay)

    #expect(Self.shown(state) == [Self.first, Self.second, Self.final, Self.second, "Klaar."])
    #expect(Self.assistants(state).map(\.rowID) == [2, 4, 6, 8, 10])
    #expect(state.orderedItems.compactMap(\.asTool).count == 3)
    #expect(state.orderedItems.compactMap(\.asUser).map(\.text) == [Self.prompt, next])
  }

  @Test("a turn /retry starts keeps its note under its own placeholder")
  func retry() {
    let done = Self.reopen(Self.apply(Self.sent(), [Self.event("message.start", 1)]), Self.rows, Array(Self.turn.dropFirst()))
    let retried = Self.apply(
      done,
      [
        Self.event("message.start", 20), Self.event("message.delta", 21, ["text": .string(Self.first)]),
        Self.event("message.interim", 22, ["text": .string(Self.first), "already_streamed": true])
      ]
    )

    #expect(Self.shown(retried) == [Self.first, Self.second, Self.final, Self.first])
    #expect(retried.orderedItems.compactMap(\.asUser).filter { $0.unknownAuthor == true }.count == 1)
    #expect(Self.assistants(retried).last?.rowID == nil)
  }

  @Test("a second identical note is never folded into a row the replay settled onto")
  func secondNoteAfterAbsorption() {
    let checking = "Checking."
    let settled = Self.reopen(
      Self.apply(Self.sent("check both"), [Self.event("message.start", 1)]),
      [
        Self.row(["role": "user", "row_id": 1, "text": "check both"]),
        Self.row(["role": "assistant", "row_id": 2, "text": .string(checking)]),
        Self.row(["role": "tool", "name": "terminal", "tool_call_id": "call_a"])
      ],
      [
        Self.event("message.delta", 2, ["text": .string(checking)]),
        Self.event("message.interim", 3, ["text": .string(checking), "already_streamed": true]),
        Self.event("tool.start", 4, ["tool_id": "call_a", "name": "terminal"]),
        Self.event("tool.complete", 5, ["tool_id": "call_a", "name": "terminal"]),
        Self.event("message.delta", 6, ["text": .string(checking)]),
        Self.event("tool.start", 7, ["tool_id": "call_b", "name": "terminal"])
      ]
    )
    let tailed = reconcileTail(
      settled, rowsToItems([Self.row(["role": "assistant", "id": 2, "content": .string(checking)])], .rest)
    )

    #expect(Self.assistants(settled).first?.base.seenLive == true)
    #expect(Self.shown(tailed) == [checking, checking])
  }
}
