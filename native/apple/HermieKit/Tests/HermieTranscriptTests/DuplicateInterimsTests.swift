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
}
