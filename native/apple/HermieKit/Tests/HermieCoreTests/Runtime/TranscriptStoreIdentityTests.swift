import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// One frame as the socket carries it, with the turn id on the envelope beside `seq`.
private func frame(
  _ type: String,
  seq: Int,
  turnID: JSONValue? = nil,
  payload: JSONObject = [:]
) -> JSONValue {
  var json: JSONObject = [
    "type": .string(type), "session_id": .string(Fixture.runtime), "seq": .number(Double(seq)),
    "payload": .object(payload)
  ]

  if let turnID {
    json["turn_id"] = turnID
  }

  return .object(json)
}

private func live(_ value: JSONValue) -> GatewayEvent {
  GatewayEvent(json: value.objectValue ?? [:])
}

/// What the store hands the transcript engine, and what the engine makes of it: the row, call and
/// turn identity a gateway sends has to survive the store's narrowing, on the replayed path, the
/// live one and the resume (`chat-controller.test.ts`, the same cases).
@Suite(.timeLimit(.minutes(1))) struct TranscriptStoreIdentityTests {
  // MARK: Replayed frames

  @Test func aReplayedFrameKeepsItsTurnIDAndNothingTheEngineDoesNotRead() async throws {
    let harness = StoreHarness()
    let store = harness.store

    let named = await store.transcriptEvent(
      of: frame("message.delta", seq: 4, turnID: "turn-1", payload: ["text": "Hel"])
    )
    #expect(named?.turnID == "turn-1")
    #expect(named?.seq == 4)
    #expect(named?.sessionID == Fixture.runtime)

    // By name, not spread: a field the engine never reads does not ride along.
    var extra = frame("message.delta", seq: 5, turnID: "turn-1").objectValue ?? [:]
    extra["gateway_noise"] = "x"
    let narrowed = await store.transcriptEvent(of: .object(extra))
    #expect(narrowed?.json["gateway_noise"] == nil)

    // Absent, empty or not a string: no turn id, and the engine takes its old path.
    #expect(await store.transcriptEvent(of: frame("message.delta", seq: 6))?.turnID == nil)
    #expect(await store.transcriptEvent(of: frame("message.delta", seq: 7, turnID: ""))?.turnID == nil)
    #expect(await store.transcriptEvent(of: frame("message.delta", seq: 8, turnID: 12))?.turnID == nil)
    await harness.shutdown()
  }

  @Test func aReplayAfterAReconnectHandsTheEngineTheTurnID() async throws {
    let harness = StoreHarness()
    await harness.attach()
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    try await harness.open(since: Fixture.since(latest: 7))
    #expect(await harness.state().turn.id == nil)

    await harness.store.connectionChanged(ConnectionStatus(.reconnecting))
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    try await harness.link.answerNext(
      RPC.ProfilesList.name,
      ["profiles": [["name": .string(bot), "canonical_session": ["id": .string(Fixture.stored), "message_count": 2]]]]
    )
    try await harness.link.answerNext(RPC.SessionResume.name, Fixture.resume())
    let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name)
    #expect(since.params["last_seen"] == 7)
    harness.link.answer(
      since,
      Fixture.since(
        latest: 9,
        events: [
          frame("message.start", seq: 8, turnID: "turn-replayed"),
          frame("message.delta", seq: 9, turnID: "turn-replayed", payload: ["text": "Hal"])
        ]
      )
    )

    try await eventually("the recovery") {
      let tasks = await harness.store.liveTaskCount
      let hydration = await harness.store.state(of: bot)?.hydration
      return tasks == 0 && hydration == .live
    }

    let state = await harness.state()
    #expect(state.turn.id == "turn-replayed")
    #expect(state.turn.active)
    await harness.shutdown()
  }

  // MARK: Live frames

  @Test func aLiveFrameReachesTheEngineWithItsTurnID() async throws {
    let harness = StoreHarness()
    await harness.attach()
    try await harness.open()
    #expect(await harness.state().turn.id == nil)

    harness.link.emit(live(frame("message.start", seq: 1, turnID: "turn-live")))
    harness.link.emit(live(frame("message.delta", seq: 2, turnID: "turn-live", payload: ["text": "Hi"])))
    await harness.settle()

    let state = await harness.state()
    #expect(state.turn.id == "turn-live")
    #expect(state.turn.active)
    #expect(state.orderedItems.compactMap(\.asAssistant).last?.text == "Hi")
    await harness.shutdown()
  }

  @Test func aLiveFrameWithoutATurnIDLeavesTheTurnUnnamed() async throws {
    let harness = StoreHarness()
    await harness.attach()
    try await harness.open()

    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    await harness.settle()

    let state = await harness.state()
    #expect(state.turn.active)
    #expect(state.turn.id == nil)
    await harness.shutdown()
  }

  // MARK: The resume

  @Test func theResumeSnapshotKeepsTheUnsealedTextAndTheTurnsMetadata() async throws {
    let harness = StoreHarness()
    let inflight: JSONValue = [
      "user": "hi",
      "assistant": "A note. And the rest",
      "assistant_unsealed": " And the rest",
      "streaming": true,
      "display_metadata": ["turn_id": "turn-resumed", "author": ["id": "someone"]]
    ]
    let result = SessionResumeResult(json: Fixture.resume(extra: ["running": true, "inflight": inflight]).objectValue!)
    let snapshot = await harness.store.resumeSnapshot(of: result)

    #expect(snapshot.json["inflight"]?["assistant_unsealed"] == " And the rest")
    #expect(snapshot.json["inflight"]?["display_metadata"]?["turn_id"] == "turn-resumed")
    #expect(snapshot.json["inflight"]?["display_metadata"]?["author"]?["id"] == "someone")
    await harness.shutdown()
  }

  @Test func aResumedTurnNamesItselfAndPaintsOnlyTheUnsealedText() async throws {
    let harness = StoreHarness()
    await harness.attach()
    try await harness.open(
      resume: Fixture.resume(
        extra: [
          "running": true,
          "inflight": [
            "user": "hi",
            "assistant": "A note. And the rest",
            "assistant_unsealed": " And the rest",
            "streaming": true,
            "display_metadata": ["turn_id": "turn-resumed"]
          ]
        ]
      )
    )

    let state = await harness.state()
    #expect(state.turn.active)
    #expect(state.turn.id == "turn-resumed")
    let bubble = try #require(state.orderedItems.compactMap(\.asAssistant).last { $0.rowID == nil })
    #expect(bubble.text == " And the rest", "the note above is on screen already; the bubble is only what no note shows")
    await harness.shutdown()
  }

  // MARK: A turn the cache restored

  /// A chat cached while a turn named `turn-cut` was writing `Hal`.
  private func cutTurn(cache: MemoryChatCache) async throws {
    let first = StoreHarness(cache: cache)
    await first.attach()
    try await first.open(since: Fixture.since(latest: 7))
    first.link.emit(live(frame("message.start", seq: 8, turnID: "turn-cut")))
    first.link.emit(live(frame("message.delta", seq: 9, turnID: "turn-cut", payload: ["text": "Hal"])))
    await first.settle()
    await first.store.persistAll()
    await first.shutdown()
  }

  @Test func aRestartedGatewayThatReplaysNothingLetsGoOfTheRestoredTurn() async throws {
    let cache = MemoryChatCache()
    try await cutTurn(cache: cache)

    let harness = StoreHarness(cache: cache)
    await harness.attach()
    await harness.store.restoreFromCache([Fixture.bot()])

    let painted = await harness.state()
    #expect(painted.turn.id == "turn-cut", "painted from the cache with the turn it was writing")
    #expect(painted.turn.assistantID != nil)
    #expect(painted.turn.active == false)

    // The replay comes from another process: nothing will continue that bubble.
    try await harness.open(since: Fixture.since(latest: 3, epoch: "epoch-2"))

    let opened = await harness.state()
    #expect(opened.epoch == "epoch-2")
    #expect(opened.turn.id == nil)
    #expect(opened.turn.assistantID == nil)
    #expect(opened.turn.reasoningID == nil)
    await harness.shutdown()
  }

  @Test func aResumeThatSaysTheTurnStillRunsKeepsTheRestoredTurn() async throws {
    let cache = MemoryChatCache()
    try await cutTurn(cache: cache)

    let harness = StoreHarness(cache: cache)
    await harness.attach()
    await harness.store.restoreFromCache([Fixture.bot()])

    try await harness.open(
      resume: Fixture.resume(
        extra: [
          "running": true,
          "inflight": ["user": "hi", "assistant": "Hal", "streaming": true, "display_metadata": ["turn_id": "turn-cut"]]
        ]
      ),
      since: Fixture.since(latest: 3, epoch: "epoch-2")
    )

    let opened = await harness.state()
    #expect(opened.turn.active)
    #expect(opened.turn.id == "turn-cut", "the live turn's own state, not a leftover")
    await harness.shutdown()
  }
}
