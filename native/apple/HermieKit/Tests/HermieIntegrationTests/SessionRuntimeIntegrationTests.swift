#if os(macOS)
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

private let researcher = "researcher"

/// A transport whose live socket a test can cut, the way a network drop would.
final class SessionDroppableTransport: WebSocketTransport {
  private let base = URLSessionTransport()
  private let current = Mutex<(any WebSocketChannel)?>(nil)

  func connect(_ request: URLRequest, subprotocols: [String]) async throws -> any WebSocketChannel {
    let channel = try await base.connect(request, subprotocols: subprotocols)
    current.withLock { $0 = channel }
    return channel
  }

  func drop() async {
    let channel = current.withLock { $0 }
    await channel?.close(code: 4000, reason: "dropped by the test")
  }
}

/// Wait for a condition the runtime reaches on its own, polling; a cap only
/// turns a hang into a failure.
@MainActor
private func sessionWait(
  _ what: String,
  _ condition: @MainActor () async -> Bool
) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

@MainActor
private func makeSession(
  _ gateway: FakeGateway,
  cache: (any ChatCaching)? = nil,
  transport: any WebSocketTransport = URLSessionTransport()
) throws -> GatewaySession {
  var options = GatewaySession.Options()
  options.connection.backoff = { _ in .milliseconds(100) }

  let record = GatewayRecord(id: "g-session", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)

  return try GatewaySession(
    record: record,
    credentials: SessionTokenCredentials(token: ""),
    transport: transport,
    cache: cache,
    options: options
  )
}

/// Start, wait for the socket and the roster, open the researcher's chat.
@MainActor
private func startAndOpen(_ session: GatewaySession) async throws {
  await session.start()
  try await sessionWait("the socket") { session.status.phase == .ready }
  try await sessionWait("the roster") { session.chatList.refreshed && session.chatList.rows[researcher] != nil }
  try await session.open(researcher)
}

/// `FakeGateway.with`, with a body that runs on the main actor, where the models live.
private func withGateway(
  _ options: FakeGateway.Options = FakeGateway.Options(),
  _ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void
) async throws {
  try await FakeGateway.with(options) { gateway in try await body(gateway) }
}

@MainActor
private func items(_ session: GatewaySession) async -> [TranscriptItem] {
  await session.store.state(of: researcher)?.orderedItems ?? []
}

extension Integration {
  /// The session runtime against the real fake gateway, over real sockets:
  /// `GatewaySession`, `TranscriptStore` and `BotRoster` on a `GatewayConnection`.
  @Suite("Session runtime") @MainActor
  struct SessionRuntimeIntegrationTests {
    @Test("a cold start paints the cached chat before the socket, then goes live without doubling it")
    func coldStartFromCache() async throws {
      try await withGateway { gateway in
        let cache = MemoryChatCache()
        let first = try makeSession(gateway, cache: cache)
        try await startAndOpen(first)
        let painted = await items(first).map(\.id)
        #expect(!painted.isEmpty)
        await first.shutdown()

        let second = try makeSession(gateway, cache: cache)
        await second.start()
        let cached = try #require(await second.store.state(of: researcher))
        #expect(cached.hydration == .cached)
        #expect(cached.orderedItems.map(\.id) == painted)

        try await sessionWait("the socket") { second.status.phase == .ready }
        try await second.open(researcher)
        let live = await items(second)
        #expect(await second.store.state(of: researcher)?.hydration == .live)
        #expect(live.map(\.id) == painted, "the reconcile keeps the ids it painted")
        await second.shutdown()
        #expect(await second.hasNoLiveTasks())
      }
    }

    @Test("a streamed turn reaches the chat screen as snapshots that only grow")
    func streamedTurn() async throws {
      try await withGateway(FakeGateway.Options(streamDelayMs: 15)) { gateway in
        let session = try makeSession(gateway)
        let model = session.chat(researcher)
        let lengths = Mutex<[(id: String, length: Int)]>([])
        let counts = Mutex<[Int]>([])
        session.frameTimings = { _ in
          MainActor.assumeIsolated {
            if let reply = model.items.last(where: { $0.item.asAssistant != nil })?.item.asAssistant {
              lengths.withLock { $0.append((reply.id, reply.text.count)) }
            }
            counts.withLock { $0.append(model.items.count) }
          }
        }

        try await startAndOpen(session)
        let before = model.items.count
        await model.send("explain the math behind the retry budget")
        try await sessionWait("the reply to finish") {
          !model.turnActive && model.items.count > before
            && (model.items.last?.item.asAssistant?.streaming == false)
        }

        let replyID = try #require(model.items.last { $0.item.asAssistant != nil }?.item.id)
        let grown = lengths.withLock { $0 }.filter { $0.id == replyID }.map(\.length)
        #expect(grown == grown.sorted(), "a snapshot never shows less of the reply than the one before")
        #expect(Set(grown).count > 1, "the reply arrived over several frames: \(grown)")
        #expect(counts.withLock { $0 } == counts.withLock { $0 }.sorted())
        #expect(model.lastError == nil)
        await session.shutdown()
        #expect(await session.hasNoLiveTasks())
      }
    }

    @Test("an approval is answered on its own reply and the turn goes on")
    func approvalAnswered() async throws {
      try await withGateway { gateway in
        let session = try makeSession(gateway)
        let model = session.chat(researcher)
        try await startAndOpen(session)

        await model.send("please approve this cleanup")
        try await sessionWait("the approval card") { !model.openRequests.isEmpty }
        let card = try #require(model.openRequests.first?.asApproval)

        await model.respondApproval(card.requestID, choice: "once")
        try await sessionWait("the turn to finish") { model.openRequests.isEmpty && !model.turnActive }

        let answered = await items(session).compactMap(\.asApproval).first { $0.requestID == card.requestID }
        #expect(answered?.state == .answered)
        #expect(answered?.answer == "once")
        #expect(model.lastError == nil)
        await session.shutdown()
      }
    }

    /// The kinds of the items a turn left after its prompt, counted.
    static func turnShape(_ items: [TranscriptItem], prompt: String) -> [String: Int] {
      guard let start = items.lastIndex(where: { $0.asUser?.text == prompt }) else {
        return [:]
      }

      return items[start...].reduce(into: [:]) { counts, item in counts[item.kind.rawValue, default: 0] += 1 }
    }

    /// Run one turn to its end, cutting the socket once the reply is streaming
    /// when `drop` is set. Answers the transcript once it has settled.
    static func runTurn(_ prompt: String, drop: Bool) async throws -> [TranscriptItem] {
      var settled: [TranscriptItem] = []

      try await withGateway(FakeGateway.Options(streamDelayMs: 40)) { gateway in
        let transport = SessionDroppableTransport()
        let session = try makeSession(gateway, transport: transport)
        let model = session.chat(researcher)
        try await startAndOpen(session)

        await model.send(prompt)
        try await sessionWait("the reply to start streaming") {
          (await items(session).last?.asAssistant?.text.isEmpty) == false
        }

        if drop {
          await transport.drop()
          try await sessionWait("the drop") { session.status.phase != .ready }
          try await sessionWait("the recovery") {
            let hydration = await session.store.state(of: researcher)?.hydration
            return session.status.phase == .ready && hydration == .live
          }
        }

        try await sessionWait("the turn to finish") {
          let state = await session.store.state(of: researcher)
          return state?.turn.active == false && state?.hydration == .live
        }

        // The `sessions.changed` sweep after the turn folds the persisted rows in:
        // settled once every message of the turn carries its row.
        try await sessionWait("the persisted rows") {
          let all = await items(session)

          guard let start = all.lastIndex(where: { $0.asUser?.text == prompt }) else {
            return false
          }

          return all[start...].allSatisfy { ($0.asUser == nil && $0.asAssistant == nil) || $0.rowID != nil }
        }

        settled = await items(session)
        await session.shutdown()
        #expect(await session.hasNoLiveTasks())
      }

      return settled
    }

    @Test("a socket dropped mid-turn recovers without duplicating a single item")
    func reconnectMidTurn() async throws {
      let prompt = "summarise the notes"
      let baseline = try await Self.runTurn(prompt, drop: false)
      let recovered = try await Self.runTurn(prompt, drop: true)

      #expect(Set(recovered.map(\.id)).count == recovered.count)
      #expect(recovered.compactMap(\.asUser).filter { $0.text == prompt }.count == 1)
      #expect(
        Self.turnShape(recovered, prompt: prompt) == Self.turnShape(baseline, prompt: prompt),
        "the same items as a turn nobody interrupted"
      )
      #expect(recovered.count == baseline.count)

      let tools = recovered.compactMap(\.asTool)
      #expect(Set(tools.map(\.toolID)).count == tools.count)
    }

    @Test("a long chat loads its newest rows and pages back over REST")
    func historyPaging() async throws {
      try await withGateway(FakeGateway.Options(extraArguments: ["--history-rows", "600"])) { gateway in
        let session = try makeSession(gateway)
        try await startAndOpen(session)

        let first = await items(session)
        let oldest = try #require(first.compactMap(\.rowID).min())

        #expect(await session.store.loadOlder(researcher) == .grew)
        let paged = await items(session)
        #expect(paged.count > first.count)
        #expect(try #require(paged.compactMap(\.rowID).min()) < oldest)
        #expect(Array(paged.suffix(first.count)).map(\.id) == first.map(\.id), "what was on screen stays put")
        await session.shutdown()
      }
    }
  }
}
#endif
