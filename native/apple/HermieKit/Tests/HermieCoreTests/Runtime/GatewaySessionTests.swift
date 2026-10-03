import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

/// A session over a scripted link with manual clocks.
@MainActor
struct SessionHarness {
  let link = ScriptedLink()
  let clock = ManualClock()
  let frames = ManualFrameScheduler()
  let session: GatewaySession

  init(cache: (any ChatCaching)? = nil, keyValues: KeyValueStore? = nil, reachability: (any Reachability)? = nil) {
    var options = GatewaySession.Options()
    options.store.clock = clock
    options.store.frames = frames
    options.store.now = { 1_790_000_000_000 }
    options.store.summaryInterval = .zero
    session = GatewaySession(
      gatewayID: "g1",
      link: link,
      cache: cache,
      keyValues: keyValues,
      reachability: reachability,
      options: options
    )
    link.respond(to: RPC.SubagentList.name, with: ["subagents": []])
    link.respond(to: RPC.ProfilesGetAsset.name, with: ["found": false])
  }

  static let roster: JSONValue = [
    "profiles": [
      [
        "name": .string(bot),
        "canonical_session": ["id": .string(Fixture.stored), "message_count": 2, "preview": "row 2", "last_active": 100]
      ]
    ]
  ]

  func start(roster: JSONValue = Self.roster) async throws {
    await session.start()
    // The roster is read when the connection becomes usable.
    link.status(.ready)
    try await link.answerNext(RPC.ProfilesList.name, roster)
    try await eventually("the roster") { await self.session.roster.bot(named: bot) != nil }
  }

  func open(_ name: String = bot, resume: JSONValue = Fixture.resume()) async throws {
    let session = self.session
    let opening = Task { @MainActor in try await session.open(name) }
    try await link.answerNext(RPC.SessionResume.name, resume)
    try await link.answerNext(RPC.SessionHistory.name, ["count": 2, "messages": .array(Fixture.rows(2))])
    try await link.answerNext(RPC.SessionEventsSince.name, Fixture.since(latest: 0))
    try await opening.value
  }

  /// Wait for the store to take in what was sent, then run frames until none is pending.
  func frame() async throws {
    let store = session.store
    let sent = link.emittedFrames
    try await eventually("the store to take in \(sent) frames") { await store.ingestedFrames >= sent }
    await store.quiesce()

    while await frames.tick() {}
  }
}

final class ScriptedReachability: Reachability {
  let updates: AsyncStream<Bool>
  let sink: AsyncStream<Bool>.Continuation

  init() {
    (updates, sink) = AsyncStream.makeStream()
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct GatewaySessionTests {
  @Test func aChatStartsQuietWithoutReasoning() async throws {
    // One built-in default: the session's is the synced settings' (`quiet`, no reasoning).
    #expect(GatewaySession.Options().defaultVisibility == SyncedSettings.defaultChatView)
    #expect(SyncedSettings.defaultChatView == VisibilityOptions(level: .quiet, showBotToBot: true, showThinking: false))

    let harness = SessionHarness()
    #expect(harness.session.chat(bot).visibility == SyncedSettings.defaultChatView)
    await harness.session.shutdown()
  }

  @Test func theStreamsAreSubscribedBeforeTheConnectionDials() async throws {
    let harness = SessionHarness()
    try await harness.start()

    let lifecycle = harness.link.lifecycle
    let start = try #require(lifecycle.firstIndex(of: "start"))
    #expect(lifecycle.firstIndex(of: "subscribe events").map { $0 < start } == true)
    #expect(lifecycle.firstIndex(of: "subscribe requests").map { $0 < start } == true)
    await harness.session.shutdown()
  }

  @Test func aColdStartShowsTheCachedRosterAndChatsBeforeTheSocketAnswers() async throws {
    let cache = MemoryChatCache()
    let earlier = SessionHarness(cache: cache)
    try await earlier.start()
    try await earlier.open()
    await earlier.session.shutdown()

    let harness = SessionHarness(cache: cache)
    await harness.session.start()
    try await harness.frame()
    #expect(harness.link.calls.isEmpty, "nothing has been asked of the gateway yet")

    let row = try #require(harness.session.chatList.rows[bot])
    #expect(row.hydration == .cached)
    #expect(row.preview?.text == "row 2")
    #expect(await harness.session.store.state(of: bot)?.order.count == 2)
    #expect(harness.link.calls(RPC.SessionResume.name).isEmpty)
    await harness.session.shutdown()
  }

  @Test func aChatScreenSeesOneSnapshotPerFrame() async throws {
    let harness = SessionHarness()
    try await harness.start()
    let model = harness.session.chat(bot)
    try await harness.open()
    try await harness.frame()

    #expect(model.hydration == .live)
    #expect(model.items.count == 2)
    #expect(model.canSend)
    let revision = model.snapshot?.revision ?? 0

    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)

    for seq in 2...41 {
      harness.link.emit("message.delta", session: Fixture.runtime, seq: seq, payload: ["text": "ab"])
    }

    try await harness.frame()
    #expect(model.snapshot?.revision == revision + 1)
    #expect(model.items.last?.item.asAssistant?.text.count == 80)
    #expect(model.turnActive)
    #expect(harness.session.chatList.rows[bot]?.working == true)

    model.setVisibility(VisibilityOptions(level: .verbose, showBotToBot: true, showThinking: true))
    try await eventually("the new options") {
      await harness.session.store.observed[bot]?.level == .verbose
    }
    await harness.session.shutdown()
  }

  @Test func theAppGoingToTheBackgroundPausesAndComingBackResumes() async throws {
    let harness = SessionHarness()
    try await harness.start()
    await harness.session.enterBackground()
    await harness.session.enterForeground()

    let lifecycle = harness.link.lifecycle.filter { ["pause", "resume"].contains($0) }
    #expect(lifecycle == ["pause", "resume"])
    await harness.session.shutdown()
  }

  @Test func reachabilityReportsReachTheConnection() async throws {
    let reachability = ScriptedReachability()
    let harness = SessionHarness(reachability: reachability)
    try await harness.start()

    reachability.sink.yield(false)
    reachability.sink.yield(true)
    try await eventually("both reports") { harness.link.lifecycle.contains("setOnline(true)") }
    #expect(harness.link.lifecycle.filter { $0.hasPrefix("setOnline") } == ["setOnline(false)", "setOnline(true)"])
    await harness.session.shutdown()
  }

  @Test func aGatewayBelowTheContractFloorIsReportedIncompatible() async throws {
    let harness = SessionHarness()
    try await harness.start()

    let session = harness.session
    let opening = Task { @MainActor in try await session.open(bot) }
    var resume = Fixture.resume().objectValue!
    resume["info"] = ["desktop_contract": 5]
    try await harness.link.answerNext(RPC.SessionResume.name, .object(resume))

    await #expect(throws: GatewayError.self) { try await opening.value }
    #expect(session.status.phase == .incompatible)
    #expect(session.incompatibility?.kind == .incompatible)
    await session.shutdown()
  }

  @Test func theConnectionStatusIsForwarded() async throws {
    let harness = SessionHarness()
    try await harness.start()
    harness.link.status(.ready)
    try await eventually("ready") { await harness.session.status.phase == .ready }
    harness.link.status(.reconnecting)
    try await eventually("reconnecting") { await harness.session.status.phase == .reconnecting }
    await harness.session.shutdown()
  }

  @Test func shutdownLeavesNoTaskBehind() async throws {
    let harness = SessionHarness()
    try await harness.start()
    harness.link.status(.ready)
    try await harness.open()
    await harness.session.watchRunning()
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    try await harness.frame()

    await harness.session.shutdown()
    #expect(await harness.session.hasNoLiveTasks())
    #expect(harness.link.lifecycle.contains("shutdown"))
  }
}
