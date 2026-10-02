import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let now: Double = 1_790_000_000_000
private let bot = Fixture.profile

private func event(_ type: String, _ session: String, seq: Int? = nil, _ payload: JSONObject = [:]) -> GatewayEvent {
  var json: JSONObject = ["type": .string(type), "session_id": .string(session), "payload": .object(payload)]

  if let seq {
    json["seq"] = .number(Double(seq))
  }

  return GatewayEvent(json: json)
}

private func historyItems(_ rows: [JSONValue]) -> [TranscriptItem] {
  rowsToItems(rows.map { TranscriptRow(json: $0.objectValue ?? [:]) }, .rpc)
}

/// What opening the fixture chat does, step by step, in the reference's order.
private func openedByHand(
  runtime: String = Fixture.runtime,
  resume: JSONValue = Fixture.resume(),
  history: [JSONValue] = Fixture.rows(2),
  latest: Int = 0,
  between: [GatewayEvent] = [],
  store: TranscriptStore
) async -> ChatState {
  var state = createChatState(bot, Fixture.stored, Fixture.stored)
  state.runtimeSessionID = runtime
  state.lastSeq = 0
  state.lastSeqSessionID = runtime
  state.epoch = nil
  state = applyEvent(state, GatewayEvent(json: ["type": "session.info", "session_id": .string(runtime), "payload": resume["info"]!]), now)

  for frame in between {
    state = applyEvent(state, frame, now)
  }

  state = reconcile(state, historyItems(history))
  state = applyResumeSnapshot(state, await store.resumeSnapshot(of: SessionResumeResult(json: resume.objectValue!)), now)

  if state.lastSeq == 0 {
    state.lastSeq = max(state.lastSeq, latest)
    state.lastSeqSessionID = runtime
  }

  state.epoch = "epoch-1"
  state.hydration = .live
  return state
}

@Suite(.timeLimit(.minutes(1))) struct TranscriptStoreTests {
  // MARK: Hydration

  @Test func openingMakesTheReferenceCallsInItsOrder() async throws {
    let harness = StoreHarness()
    await harness.attach()
    try await harness.open()

    let methods = harness.link.calls.map(\.method)
    #expect(methods == ["session.resume", "session.history", "session.events.since", "subagent.list"])
    #expect(harness.link.calls[0].params["session_id"] == .string(Fixture.stored))
    #expect(harness.link.calls[0].params["cols"] == 96)
    #expect(harness.link.calls[1].params["session_id"] == .string(Fixture.runtime))

    let expected = await openedByHand(store: harness.store)
    #expect(canonical(await harness.state()) == canonical(expected))
    #expect(await harness.store.chatKey(forRuntime: Fixture.runtime) == bot)
    await harness.shutdown()
  }

  @Test func theLadderGoesColdCachedHydratingLiveStale() async throws {
    let cache = MemoryChatCache()
    let first = StoreHarness(cache: cache)
    await first.attach()
    try await first.open()
    await first.store.persistAll()
    await first.shutdown()

    let harness = StoreHarness(cache: cache)
    await harness.attach()
    #expect(await harness.store.state(of: bot) == nil)

    await harness.store.restoreFromCache([Fixture.bot()])
    #expect(await harness.state().hydration == .cached)
    #expect(await harness.state().order.count == 2)
    #expect(harness.link.calls.isEmpty, "a cold start paints before the socket is asked anything")

    let opening = Task { try await harness.store.open(Fixture.bot()) }
    _ = try await harness.link.pendingCall(RPC.SessionResume.name)
    #expect(await harness.state().hydration == .hydrating)

    try await harness.link.answerNext(RPC.SessionResume.name, Fixture.resume())
    try await harness.link.answerNext(
      RPC.SessionHistory.name,
      ["count": 2, "messages": .array(Fixture.rows(2))]
    )
    try await harness.link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 0))
    try await opening.value
    #expect(await harness.state().hydration == .live)
    #expect(await harness.state().order.count == 2, "the reconcile keeps the painted ids; nothing doubles")

    await harness.store.connectionChanged(ConnectionStatus(.ready))
    await harness.store.connectionChanged(ConnectionStatus(.reconnecting))
    #expect(await harness.state().hydration == .stale)

    harness.link.emit("session.reclaimed", session: Fixture.runtime)
    await harness.settle()
    #expect(await harness.state().runtimeSessionID == nil)
    await harness.shutdown()
  }

  @Test func aResumeThatFailsLeavesTheChatInError() async throws {
    let harness = StoreHarness()
    await harness.attach()

    let opening = Task { try await harness.store.open(Fixture.bot()) }
    let call = try await harness.link.pendingCall(RPC.SessionResume.name)
    harness.link.fail(call, GatewayRPCError(.rejected, "Unknown session"))

    await #expect(throws: GatewayRPCError.self) { try await opening.value }
    #expect(await harness.state().hydration == .error)
    await harness.shutdown()
  }

  // MARK: Ordering

  /// One run of a resume racing two deltas: one the resume's snapshot already
  /// holds (a lower wire index), one that came after it (a higher one).
  private func resumeRace(eventsFirst: Bool) async throws -> (ChatState, ChatState) {
    let harness = StoreHarness()
    await harness.attach()

    let resume = Fixture.resume(extra: [
      "running": true,
      "inflight": ["user": "go", "assistant": "Hello", "streaming": true]
    ])
    let opening = Task { try await harness.store.open(Fixture.bot()) }
    let call = try await harness.link.pendingCall(RPC.SessionResume.name)
    let contained = event("message.delta", Fixture.runtime, seq: 1, ["text": "Hello"])
    let after = event("message.delta", Fixture.runtime, seq: 2, ["text": " world"])

    if eventsFirst {
      // Both reach the store before the resume's answer does.
      harness.link.emit(contained, index: 10)
      harness.link.emit(after, index: 30)
      await harness.settle()
      harness.link.answer(call, resume, index: 20)
    } else {
      harness.link.emit(contained, index: 10)
      await harness.settle()
      harness.link.answer(call, resume, index: 20)
      await harness.settle()
      harness.link.emit(after, index: 30)
      await harness.settle()
    }

    try await harness.link.answerNext(RPC.SessionHistory.name, ["count": 2, "messages": .array(Fixture.rows(2))], index: 40)
    try await harness.link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 2), index: 50)
    try await opening.value

    let expected = await openedByHand(resume: resume, between: [after], store: harness.store)
    let state = await harness.state()
    await harness.shutdown()
    return (state, expected)
  }

  @Test func aFrameBelowTheResumeIsContainedAndOneAboveItIsAppliedAfter() async throws {
    for eventsFirst in [true, false] {
      let (state, expected) = try await resumeRace(eventsFirst: eventsFirst)
      #expect(canonical(state) == canonical(expected), "events first: \(eventsFirst)")

      let assistants = state.orderedItems.compactMap(\.asAssistant)
      #expect(!assistants.contains { $0.text.contains("HelloHello") })
    }
  }

  @Test func anAnswerIsAppliedBeforeTheFramesThatFollowItOnTheWire() async throws {
    var states: [String] = []

    for eventFirst in [true, false] {
      let harness = StoreHarness()
      await harness.attach()
      try await harness.open()

      let sending = Task { try await harness.store.send(bot, text: "hi") }
      let call = try await harness.link.pendingCall(RPC.PromptSubmit.name)
      let start = event("message.start", Fixture.runtime, seq: 1)

      if eventFirst {
        harness.link.emit(start, index: 200)
        await harness.settle()
        #expect(await harness.state().lastSeq == 0, "the start waits for the answer it follows")
        harness.link.answer(call, ["status": "queued"], index: 100)
      } else {
        harness.link.answer(call, ["status": "queued"], index: 100)
        await harness.settle()
        harness.link.emit(start, index: 200)
      }

      _ = try await sending.value
      await harness.settle()
      states.append(canonical(await harness.state()))
      await harness.shutdown()
    }

    #expect(states[0] == states[1])
  }

  // MARK: Reconnects

  @Test func aReconnectMidTurnLeavesNoDuplicateItems() async throws {
    let harness = StoreHarness()
    await harness.attach()
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    try await harness.open()

    let sending = Task { try await harness.store.send(bot, text: "hi") }
    try await harness.link.answerNext(RPC.PromptSubmit.name, ["status": "streaming"])
    _ = try await sending.value
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    harness.link.emit("message.delta", session: Fixture.runtime, seq: 2, payload: ["text": "Hel"])
    harness.link.emit("message.delta", session: Fixture.runtime, seq: 3, payload: ["text": "lo"])
    await harness.settle()

    await harness.store.connectionChanged(ConnectionStatus(.reconnecting))
    #expect(await harness.state().hydration == .stale)

    // The connection's own replay re-delivers a frame the chat already has.
    harness.link.emit("message.delta", session: Fixture.runtime, seq: 3, payload: ["text": "lo"])
    await harness.store.connectionChanged(ConnectionStatus(.ready))

    try await harness.link.answerNext(
      RPC.ProfilesList.name,
      ["profiles": [["name": .string(bot), "canonical_session": ["id": .string(Fixture.stored), "message_count": 2]]]]
    )
    try await harness.link.answerNext(
      RPC.SessionResume.name,
      Fixture.resume(extra: ["running": true, "inflight": ["user": "hi", "assistant": "Hello", "streaming": true]])
    )
    let replayed: JSONValue = [
      "type": "message.delta", "session_id": .string(Fixture.runtime), "seq": 4, "payload": ["text": " there"]
    ]
    let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name)
    #expect(since.params["last_seen"] == 3)
    harness.link.answer(since, Fixture.since(latest: 4, events: [replayed]))

    try await eventually("the recovery") {
      let tasks = await harness.store.liveTaskCount
      let hydration = await harness.store.state(of: bot)?.hydration
      return tasks == 0 && hydration == .live
    }

    harness.link.emit("message.complete", session: Fixture.runtime, seq: 5, payload: ["text": "Hello there"])
    await harness.settle()

    let state = await harness.state()
    let users = state.orderedItems.compactMap(\.asUser).filter { $0.text == "hi" }
    let assistants = state.orderedItems.compactMap(\.asAssistant).filter { $0.rowID == nil }
    #expect(users.count == 1)
    #expect(assistants.count == 1)
    #expect(assistants.first?.text == "Hello there")
    #expect(state.turn.active == false)
    await harness.shutdown()
  }

  @Test func aNewRuntimeSessionRestartsTheWatermark() async throws {
    let harness = StoreHarness()
    await harness.attach()
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    try await harness.open(since: Fixture.since(latest: 7))
    #expect(await harness.state().lastSeq == 7)
    #expect(await harness.state().epoch == "epoch-1")

    await harness.store.connectionChanged(ConnectionStatus(.reconnecting))
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    try await harness.link.answerNext(RPC.ProfilesList.name, ["profiles": []])

    let resume = try await harness.link.pendingCall(RPC.SessionResume.name)
    harness.link.answer(resume, Fixture.resume(runtime: "rt-2"))
    let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name)
    #expect(since.params["session_id"] == "rt-2")
    #expect(since.params["last_seen"] == 0, "a watermark from rt-1 is a number from another counter")
    harness.link.answer(since, Fixture.since(latest: 0))

    // Whatever rt-1 did while the socket was down is in no replay: the chat is read again.
    try await harness.link.answerNext(RPC.SessionResume.name, Fixture.resume(runtime: "rt-2"))
    try await harness.link.answerNext(RPC.SessionHistory.name, ["count": 2, "messages": .array(Fixture.rows(2))])
    try await harness.link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 0))

    try await eventually("the recovery") {
      let tasks = await harness.store.liveTaskCount
      return tasks == 0
    }

    #expect(await harness.state().lastSeqSessionID == "rt-2")
    #expect(await harness.store.chatKey(forRuntime: Fixture.runtime) == nil)

    harness.link.emit("message.start", session: Fixture.runtime, seq: 8)
    await harness.settle()
    #expect(await harness.state().turn.active == false, "the old session routes to nobody")

    harness.link.emit("message.start", session: "rt-2", seq: 1)
    await harness.settle()
    #expect(await harness.state().turn.active == true)
    await harness.shutdown()
  }

  // MARK: Publishing

  @Test @MainActor func deltasBetweenTwoFramesArePublishedOnce() async throws {
    let harness = StoreHarness()
    await harness.attach()
    try await harness.open()

    let received = Received()
    await harness.store.setSink { batch in received.batches.append(batch) }
    await harness.store.observe(bot, options: VisibilityOptions(level: .normal, showBotToBot: true, showThinking: true))
    await harness.frames.tick()
    received.batches.removeAll()

    let requestsBefore = harness.frames.requestCount
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)

    for seq in 2...501 {
      harness.link.emit("message.delta", session: Fixture.runtime, seq: seq, payload: ["text": "x"])
    }

    await harness.settle()
    #expect(harness.frames.requestCount == requestsBefore + 1, "one frame asked for, however many deltas")
    #expect(received.batches.isEmpty)

    await harness.frames.tick()
    #expect(received.batches.count == 1)

    let snapshot = try #require(received.batches.first?.chats[bot])
    let texts = snapshot.items.compactMap { $0.item.asAssistant?.text }
    #expect(texts.last?.count == 500, "\(texts.map(\.count))")
    #expect(received.batches.first?.summaries[bot]?.busy == true)
    await harness.shutdown()
  }

  // MARK: The cache

  @Test func cacheWritesAreDebounced() async throws {
    let cache = CountingCache()
    let harness = StoreHarness(cache: cache)
    await harness.attach()
    // The foreign turns below ask for the tail; there is nothing new in it.
    harness.link.setREST { _, _ in [] }
    try await harness.open()
    #expect(await cache.writes == 0)

    for seq in 1...3 {
      harness.link.emit("message.start", session: Fixture.runtime, seq: seq * 2 - 1)
      harness.link.emit("message.complete", session: Fixture.runtime, seq: seq * 2, payload: ["text": .string("done \(seq)")])
    }

    await harness.settle()
    await harness.clock.advance(by: .milliseconds(999))
    #expect(await cache.writes == 0)

    await harness.clock.advance(by: .milliseconds(1))
    try await eventually("the debounced write") { await cache.writes == 1 }

    let row = try #require(await cache.read(bot: bot))
    let snapshot = try HermieTranscript.CachedTranscript(decoding: JSONValue(parsing: row.itemsJSON))
    #expect(snapshot.lastSeq == 6)
    let settled = snapshotForCache(await harness.state(), now: 0).items.map(\.id)
    #expect(snapshot.items.map(\.id) == settled)
    #expect(!settled.contains { $0.hasPrefix("f:") }, "a foreign placeholder describes a moment, not the chat")
    await harness.shutdown()
  }

  // MARK: History

  @Test func aLongChatLoadsItsTailOverRESTAndPagesBack() async throws {
    let harness = StoreHarness()
    await harness.attach()

    let all = Fixture.rows(450)
    harness.link.setREST { _, window in
      // Newest end, oldest first within the page.
      let end = all.count - window.offset
      let start = max(0, end - window.limit)
      return end <= 0 ? [] : all[start..<end].map { TranscriptRow(json: $0.objectValue ?? [:]) }
    }

    let opening = Task { try await harness.store.open(Fixture.bot(messageCount: 450)) }
    try await harness.link.answerNext(RPC.SessionResume.name, Fixture.resume(messageCount: 450))
    try await harness.link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 0))
    try await opening.value

    #expect(harness.link.calls(RPC.SessionHistory.name).isEmpty)
    #expect(await harness.state().order.count == 200)

    #expect(await harness.store.loadOlder(bot) == .grew)
    #expect(harness.link.restCalls.last?.1 == MessageWindow(limit: 200, offset: 200))
    #expect(await harness.state().order.count == 400)
    #expect(await harness.state().orderedItems.first?.rowID == 51)

    #expect(await harness.store.loadOlder(bot) == .grew)
    #expect(await harness.state().order.count == 450)
    #expect(await harness.store.loadOlder(bot) == .start)
    #expect(await harness.state().orderedItems.first?.rowID == 1)
    await harness.shutdown()
  }

  @Test func withoutARESTTranscriptPagingIsUnavailable() async throws {
    let harness = StoreHarness()
    await harness.attach()
    try await harness.open()
    #expect(await harness.store.loadOlder(bot) == .start, "session.history already handed over everything")
    await harness.shutdown()
  }

  // MARK: Teardown

  @Test func shutdownLeavesNothingRunning() async throws {
    let harness = StoreHarness()
    await harness.attach()
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    try await harness.open()
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    harness.link.emit("message.complete", session: Fixture.runtime, seq: 2, payload: ["text": "done"])
    await harness.settle()

    // A recovery waiting on a call that will never be answered.
    await harness.store.connectionChanged(ConnectionStatus(.reconnecting))
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    _ = try await harness.link.pendingCall(RPC.ProfilesList.name)

    await harness.shutdown()
    #expect(await harness.store.liveTaskCount == 0)
    #expect(await harness.store.isAttached == false)
    #expect(await harness.roster.liveTaskCount == 0)
  }
}

@MainActor
final class Received {
  var batches: [FrameBatch] = []
}

/// A chat cache that counts its writes.
actor CountingCache: ChatCaching {
  private let base = MemoryChatCache()
  private(set) var writes = 0

  func read(bot: String) async throws -> HermieStore.CachedTranscript? { await base.read(bot: bot) }

  func write(_ snapshot: HermieStore.CachedTranscript) async throws {
    writes += 1
    await base.write(snapshot)
  }

  func forget(bot: String) async throws { await base.forget(bot: bot) }
  func readBots() async throws -> [CachedBot] { await base.readBots() }
  func writeBots(_ rows: [CachedBot]) async throws { await base.writeBots(rows) }
  func clear() async throws { await base.clear() }
}
