import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

extension TranscriptStore {
  /// The texts parked behind the running turn (for tests).
  func queuedTexts(_ key: String) -> [String] {
    chats[key]?.queue.map(\.text) ?? []
  }
}

/// A replay that cannot vouch for itself makes the chat read again: resume and
/// history through the hydration path, the in-flight turn and open requests
/// restored, nothing doubled, the queue left alone.
@Suite(.timeLimit(.minutes(1))) struct RefetchTests {
  /// Open the fixture chat with its watermark at `seq` and the socket ready.
  private func opened(seq: Int = 7, history: [JSONValue] = Fixture.rows(2)) async throws -> StoreHarness {
    let harness = StoreHarness()
    await harness.attach()
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    try await harness.open(history: history, since: Fixture.since(latest: seq))
    return harness
  }

  /// Drop the socket and bring it back; answer the roster read and the recovery's resume.
  private func reconnect(_ harness: StoreHarness, resume: JSONValue = Fixture.resume()) async throws {
    await harness.store.connectionChanged(ConnectionStatus(.reconnecting))
    await harness.store.connectionChanged(ConnectionStatus(.ready))
    try await harness.link.answerNext(
      RPC.ProfilesList.name,
      ["profiles": [["name": .string(bot), "canonical_session": ["id": .string(Fixture.stored), "message_count": 2]]]]
    )
    try await harness.link.answerNext(RPC.SessionResume.name, resume)
  }

  /// Answer the re-fetch: resume, history, replay.
  private func answerRefetch(
    _ harness: StoreHarness,
    resume: JSONValue = Fixture.resume(),
    history: [JSONValue],
    since: JSONValue
  ) async throws {
    try await harness.link.answerNext(RPC.SessionResume.name, resume)
    try await harness.link.answerNext(
      RPC.SessionHistory.name,
      ["count": .number(Double(history.count)), "messages": .array(history)]
    )
    try await harness.link.answerNext(RPC.SessionEventsSince.name, since)
  }

  private func settled(_ harness: StoreHarness) async throws {
    try await eventually("the re-fetch to finish") {
      let tasks = await harness.store.liveTaskCount
      let refetching = await harness.store.isRefetching(bot)
      let hydration = await harness.store.state(of: bot)?.hydration
      return tasks == 0 && !refetching && hydration == .live
    }
    await harness.settle()
  }

  private func truncated(latest: Int) -> JSONValue {
    var since = Fixture.since(latest: latest).objectValue ?? [:]
    since["truncated"] = true
    return .object(since)
  }

  @Test func aTruncatedReplayAfterAReconnectReadsAnIdleChatAgain() async throws {
    let harness = try await opened()
    #expect(await harness.state().order.count == 2)

    try await reconnect(harness)
    let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name)
    #expect(since.params["last_seen"] == 7)
    // Two turns happened while the socket was down, and the ring has lost them.
    harness.link.answer(since, truncated(latest: 40))

    try await answerRefetch(harness, history: Fixture.rows(4), since: Fixture.since(latest: 40))
    try await settled(harness)

    let state = await harness.state()
    let rows = state.orderedItems.compactMap(\.rowID)
    #expect(rows == [1, 2, 3, 4], "the turns the replay lost are read back")
    #expect(Set(state.order).count == state.order.count)
    #expect(state.lastSeq == 40)
    #expect(harness.link.calls(RPC.SessionResume.name).count == 3, "open, recovery, re-fetch")
    #expect(harness.link.calls(RPC.SessionHistory.name).count == 2, "open and re-fetch")
    await harness.shutdown()
  }

  @Test func aTruncatedReplayMidTurnRestoresTheTurnOnceAndKeepsTheQueue() async throws {
    let harness = try await opened(seq: 0)
    let sending = Task { try await harness.store.send(bot, text: "hi") }
    try await harness.link.answerNext(RPC.PromptSubmit.name, ["status": "streaming"])
    _ = try await sending.value
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    harness.link.emit("message.delta", session: Fixture.runtime, seq: 2, payload: ["text": "Hel"])
    await harness.settle()

    // A second message while the turn runs is parked, not sent.
    _ = try await harness.store.send(bot, text: "and then?")
    #expect(await harness.store.queuedTexts(bot) == ["and then?"])

    let inflight: JSONObject = [
      "running": true, "inflight": ["user": "hi", "assistant": "Hello wor", "streaming": true]
    ]
    try await reconnect(harness, resume: Fixture.resume(extra: inflight))
    let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name)
    #expect(since.params["last_seen"] == 2)
    harness.link.answer(since, truncated(latest: 30))

    try await answerRefetch(
      harness,
      resume: Fixture.resume(extra: inflight),
      history: Fixture.rows(2),
      since: Fixture.since(latest: 30)
    )
    try await settled(harness)

    let state = await harness.state()
    let users = state.orderedItems.compactMap(\.asUser).filter { $0.text == "hi" }
    let live = state.orderedItems.compactMap(\.asAssistant).filter { $0.rowID == nil }
    #expect(users.count == 1)
    #expect(live.count == 1)
    #expect(live.first?.text == "Hello wor", "the resume's in-flight turn, once")
    #expect(state.turn.active)
    #expect(Set(state.order).count == state.order.count)
    #expect(await harness.store.queuedTexts(bot) == ["and then?"], "the queue is the reader's, not the chat's")

    // The turn goes on from the watermark the re-fetch left.
    harness.link.emit("message.delta", session: Fixture.runtime, seq: 31, payload: ["text": "ld"])
    harness.link.emit("message.complete", session: Fixture.runtime, seq: 32, payload: ["text": "Hello world"])
    try await harness.link.answerNext(RPC.PromptSubmit.name, ["status": "streaming"])
    await harness.settle()
    let finished = await harness.state().orderedItems.compactMap(\.asAssistant).filter { $0.rowID == nil }
    #expect(finished.first?.text == "Hello world")
    await harness.shutdown()
  }

  @Test func aTruncatedReplayKeepsAnOpenApprovalAsOneCard() async throws {
    let harness = try await opened()
    let params: JSONObject = ["session_id": .string(Fixture.runtime), "request_id": "appr-1", "command": "deploy"]
    harness.link.raise(id: "srq-1", method: "approval", params: params)
    await harness.settle()
    #expect(await harness.state().orderedItems.compactMap(\.asApproval).map(\.state) == [.open])

    let open: JSONObject = [
      "running": true,
      "open_requests": [["id": "srq-1", "method": "approval", "params": .object(params)]]
    ]
    try await reconnect(harness, resume: Fixture.resume(extra: open))
    let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name)
    harness.link.answer(since, truncated(latest: 50))

    try await answerRefetch(harness, resume: Fixture.resume(extra: open), history: Fixture.rows(2), since: Fixture.since(latest: 50))
    try await settled(harness)

    let cards = await harness.state().orderedItems.compactMap(\.asApproval)
    #expect(cards.count == 1, "one question, one card")
    #expect(cards.first?.state == .open)
    #expect(cards.first?.requestID == "srq-1")

    // Still answerable on the reply that delivered it.
    #expect(try await harness.store.respondApproval(bot, requestID: "srq-1", choice: "once"))
    #expect(harness.link.answers.map(\.id) == ["srq-1"])
    await harness.shutdown()
  }

  @Test func aGapTheConnectionReportsReadsALiveChatAgain() async throws {
    let harness = try await opened()
    #expect(harness.link.calls(RPC.SessionResume.name).count == 1)

    harness.link.gap(Fixture.runtime, .truncated)
    try await answerRefetch(harness, history: Fixture.rows(6), since: Fixture.since(latest: 9))
    try await settled(harness)

    #expect(await harness.state().orderedItems.compactMap(\.rowID) == [1, 2, 3, 4, 5, 6])
    #expect(await harness.state().hydration == .live)
    await harness.shutdown()
  }

  @Test func aGapForASessionNoChatHoldsIsIgnored() async throws {
    let harness = try await opened()
    harness.link.gap("rt-somebody-else", .truncated)
    await harness.settle()
    try await Task.sleep(for: .milliseconds(20))
    #expect(harness.link.calls(RPC.SessionResume.name).count == 1)
    #expect(await harness.store.isRefetching(bot) == false)
    await harness.shutdown()
  }

  @Test func gapsWhileARefetchRunsCostOneMoreReadNotOneEach() async throws {
    let harness = try await opened()
    harness.link.gap(Fixture.runtime)
    let first = try await harness.link.pendingCall(RPC.SessionResume.name) { $0.id > 2 }

    harness.link.gap(Fixture.runtime)
    harness.link.gap(Fixture.runtime)
    try await eventually("the later gaps to be taken in") { await harness.store.isRefetchQueued(bot) }
    // Both of them, and not only the first that queued the read: one taken in after the refetch ended would cost a read.
    await harness.settle()
    harness.link.answer(first, Fixture.resume())
    try await harness.link.answerNext(RPC.SessionHistory.name, ["count": 2, "messages": .array(Fixture.rows(2))])
    try await harness.link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 7))

    try await answerRefetch(harness, history: Fixture.rows(3), since: Fixture.since(latest: 8))
    try await settled(harness)

    #expect(harness.link.calls(RPC.SessionResume.name).count == 3, "open, then two reads for three gaps")
    #expect(await harness.state().orderedItems.compactMap(\.rowID) == [1, 2, 3])
    await harness.shutdown()
  }

  @Test func aTruncatedReplayRightAfterTheHistoryReadNeedsNothingMore() async throws {
    let harness = StoreHarness()
    await harness.attach()
    try await harness.open(since: truncated(latest: 12))
    await harness.settle()
    try await Task.sleep(for: .milliseconds(20))

    #expect(harness.link.calls(RPC.SessionResume.name).count == 1)
    #expect(await harness.state().lastSeq == 12)
    #expect(await harness.state().hydration == .live)
    await harness.shutdown()
  }

  @Test func aReplayFromAnotherGatewayProcessAfterAReconnectReadsTheChatAgain() async throws {
    let harness = try await opened()
    try await reconnect(harness)
    let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name)
    harness.link.answer(since, Fixture.since(latest: 3, epoch: "epoch-2"))

    try await answerRefetch(harness, history: Fixture.rows(3), since: Fixture.since(latest: 3, epoch: "epoch-2"))
    try await settled(harness)

    #expect(await harness.state().orderedItems.compactMap(\.rowID) == [1, 2, 3])
    #expect(await harness.state().epoch == "epoch-2")
    await harness.shutdown()
  }

  @Test func aWholeReplayAfterAReconnectReadsNothingAgain() async throws {
    let harness = try await opened()
    try await reconnect(harness)
    let since = try await harness.link.pendingCall(RPC.SessionEventsSince.name)
    harness.link.answer(since, Fixture.since(latest: 7))

    try await eventually("the recovery") {
      let tasks = await harness.store.liveTaskCount
      let hydration = await harness.store.state(of: bot)?.hydration
      return tasks == 0 && hydration == .live
    }

    #expect(harness.link.calls(RPC.SessionResume.name).count == 2, "open and recovery only")
    #expect(harness.link.calls(RPC.SessionHistory.name).count == 1)
    await harness.shutdown()
  }
}
