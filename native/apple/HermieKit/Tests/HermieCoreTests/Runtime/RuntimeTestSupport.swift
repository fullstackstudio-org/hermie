import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Synchronization
import Testing

@testable import HermieCore

// A scripted gateway link, a clock and a frame scheduler that move only when a
// test says so, and the waits that let a test follow the store without a
// real-time deadline (a generous cap only turns a hang into a failure).

/// How long any wait may take before the test fails instead of hanging.
let generousWait: Duration = .seconds(60)

struct TimedOut: Error, CustomStringConvertible {
  var what: String
  var description: String { "Timed out waiting for \(what)" }
}

/// Poll `condition` (yielding between looks) until it holds.
func eventually(
  _ what: String,
  _ condition: @escaping @Sendable () async -> Bool
) async throws {
  let deadline = ContinuousClock.now + generousWait

  while !(await condition()) {
    guard ContinuousClock.now < deadline else {
      throw TimedOut(what: what)
    }

    try await Task.sleep(for: .milliseconds(2))
  }
}

// MARK: - Clocks

/// A `ConnectionClock` whose timers fire only on `advance(by:)`.
final class ManualClock: ConnectionClock, Sendable {
  private struct Entry {
    let id: UInt64
    let deadline: Duration
    let action: @Sendable () async -> Void
  }

  private struct State {
    var now: Duration = .zero
    var entries: [Entry] = []
    var nextID: UInt64 = 0
  }

  private let state = Mutex(State())

  var now: Duration { state.withLock { $0.now } }
  var date: Date { Date(timeIntervalSince1970: 1_790_000_000 + Double(now.components.seconds)) }

  func schedule(after delay: Duration, _ action: @escaping @Sendable () async -> Void) -> ScheduledTimer {
    let id = state.withLock { state in
      defer { state.nextID += 1 }
      state.entries.append(Entry(id: state.nextID, deadline: state.now + max(delay, .zero), action: action))
      return state.nextID
    }

    return ScheduledTimer { [weak self] in
      self?.state.withLock { $0.entries.removeAll { $0.id == id } }
    }
  }

  var pendingCount: Int { state.withLock { $0.entries.count } }

  func advance(by step: Duration) async {
    let target = state.withLock { $0.now + step }

    while let entry = takeNextDue(by: target) {
      await entry.action()
    }

    state.withLock { $0.now = max($0.now, target) }
  }

  private func takeNextDue(by target: Duration) -> Entry? {
    state.withLock { state in
      let due = state.entries.enumerated()
        .filter { $0.element.deadline <= target }
        .min { ($0.element.deadline, $0.element.id) < ($1.element.deadline, $1.element.id) }

      guard let due else {
        return nil
      }

      state.entries.remove(at: due.offset)
      state.now = max(state.now, due.element.deadline)
      return due.element
    }
  }
}

/// Frames fire only on `tick()`.
final class ManualFrameScheduler: FrameScheduler, Sendable {
  private let pending = Mutex<[@Sendable () async -> Void]>([])
  private let requests = Mutex(0)

  func requestFrame(_ fire: @escaping @Sendable () async -> Void) {
    pending.withLock { $0.append(fire) }
    requests.withLock { $0 += 1 }
  }

  var requestCount: Int { requests.withLock { $0 } }
  var hasPendingFrame: Bool { pending.withLock { !$0.isEmpty } }

  /// Run the frame that is pending, if any. Answers whether one ran.
  @discardableResult
  func tick() async -> Bool {
    let fires = pending.withLock { pending in
      defer { pending.removeAll() }
      return pending
    }

    for fire in fires {
      await fire()
    }

    return !fires.isEmpty
  }
}

/// Engine `now` values handed out in order, for replays that must stamp items
/// exactly as the recording did; past the end it repeats the last one.
final class SequenceNow: Sendable {
  private let state: Mutex<(values: [Double], next: Int)>

  init(_ values: [Double]) {
    state = Mutex((values, 0))
  }

  func next() -> Double {
    state.withLock { state in
      defer { state.next += 1 }
      return state.values.isEmpty ? 0 : state.values[min(state.next, state.values.count - 1)]
    }
  }

  var used: Int { state.withLock { $0.next } }
}

// MARK: - The scripted link

/// A `GatewayLink` a test drives: it emits frames with the wire indices it
/// chooses, answers calls when told to (or through a responder), and records
/// everything the store asked for.
final class ScriptedLink: GatewayLink, Sendable {
  struct Call: Sendable {
    var id: Int
    var method: String
    var params: JSONValue
  }

  struct Answer: Sendable {
    var reply: Result<RPCReply<JSONValue>, any Error>
  }

  private struct State {
    var wireIndex: UInt64 = 0
    var calls: [Call] = []
    var waiting: [Int: CheckedContinuation<RPCReply<JSONValue>, any Error>] = [:]
    var responders: [String: @Sendable (JSONValue) -> JSONValue] = [:]
    var restRows: (@Sendable (String, MessageWindow) -> [TranscriptRow]?)?
    var restCalls: [(String, MessageWindow)] = []
    var lifecycle: [String] = []
    var answers: [(id: String, result: JSONObject)] = []
    var socketOpen = true
    var isShutDown = false
    var emitted = 0
    var watermarks: [String: Double] = [:]
  }

  private let state = Mutex(State())
  let eventStream: AsyncStream<WireEvent>
  let eventSink: AsyncStream<WireEvent>.Continuation
  let requestStream: AsyncStream<InboundRequest>
  let requestSink: AsyncStream<InboundRequest>.Continuation
  let statusStream: AsyncStream<ConnectionStatus>
  let statusSink: AsyncStream<ConnectionStatus>.Continuation

  init() {
    (eventStream, eventSink) = AsyncStream.makeStream()
    (requestStream, requestSink) = AsyncStream.makeStream()
    (statusStream, statusSink) = AsyncStream.makeStream()
  }

  var events: AsyncStream<WireEvent> {
    record("subscribe events")
    return eventStream
  }

  var serverRequests: any AsyncSequence<InboundRequest, Never> & Sendable {
    record("subscribe requests")
    return requestStream
  }
  var statuses: AsyncStream<ConnectionStatus> { statusStream }

  // MARK: Frames

  /// The next wire index, as the connection would number the next frame.
  func nextIndex() -> UInt64 {
    state.withLock { state in
      state.wireIndex += 1
      return state.wireIndex
    }
  }

  /// Emit an event; answers the wire index it was given.
  @discardableResult
  func emit(_ event: GatewayEvent, index: UInt64? = nil) -> UInt64 {
    let index = index ?? nextIndex()
    state.withLock { state in
      state.wireIndex = max(state.wireIndex, index)
      state.emitted += 1

      if let session = event.sessionID, let seq = event.json["seq"]?.doubleValue {
        state.watermarks[session] = max(state.watermarks[session] ?? 0, seq)
      }
    }
    eventSink.yield(WireEvent(index: index, event: event))
    return index
  }

  /// Events and requests yielded so far.
  var emittedFrames: Int { state.withLock { $0.emitted } }

  func seqWatermarks() async -> [String: Double] {
    state.withLock { $0.watermarks }
  }

  @discardableResult
  func emit(
    _ type: String,
    session: String?,
    seq: Int? = nil,
    payload: JSONObject = [:],
    index: UInt64? = nil
  ) -> UInt64 {
    var json: JSONObject = ["type": .string(type), "payload": .object(payload)]

    if let session {
      json["session_id"] = .string(session)
    }

    if let seq {
      json["seq"] = .number(Double(seq))
    }

    return emit(GatewayEvent(json: json), index: index)
  }

  /// Raise a server request whose answer is recorded (and goes out only while
  /// `socketOpen`); answers the wire index.
  @discardableResult
  func raise(
    id: String,
    method: String,
    params: JSONObject,
    replayed: Bool = false,
    index: UInt64? = nil
  ) -> UInt64 {
    let index = index ?? nextIndex()
    state.withLock { state in
      state.wireIndex = max(state.wireIndex, index)
      state.emitted += 1
    }

    let request = ServerRequest(id: id, method: method, params: params)
    let inbound = InboundRequest(
      request: request,
      replayed: replayed,
      index: index,
      respond: { [weak self] result in self?.recordAnswer(id, result) ?? false },
      fail: { _, _ in true }
    )

    requestSink.yield(inbound)
    return index
  }

  private func recordAnswer(_ id: String, _ result: JSONObject) -> Bool {
    state.withLock { state in
      guard state.socketOpen else {
        return false
      }

      state.answers.append((id, result))
      return true
    }
  }

  /// Answers that went out on a live reply, in order.
  var answers: [(id: String, result: JSONObject)] { state.withLock { $0.answers } }

  /// While false, a live reply's `respond` answers `false`, as for a dropped socket.
  func setSocketOpen(_ open: Bool) {
    state.withLock { $0.socketOpen = open }
  }

  func status(_ phase: ConnectionPhase) {
    statusSink.yield(ConnectionStatus(phase))
  }

  // MARK: Calls

  /// Answer every call to `method` at once, with a fresh wire index each time.
  func respond(to method: String, with responder: @escaping @Sendable (JSONValue) -> JSONValue) {
    state.withLock { $0.responders[method] = responder }
  }

  func respond(to method: String, with result: JSONValue) {
    respond(to: method) { _ in result }
  }

  func setREST(_ rows: (@Sendable (String, MessageWindow) -> [TranscriptRow]?)?) {
    state.withLock { $0.restRows = rows }
  }

  var calls: [Call] { state.withLock { $0.calls } }
  var restCalls: [(String, MessageWindow)] { state.withLock { $0.restCalls } }
  var lifecycle: [String] { state.withLock { $0.lifecycle } }

  func calls(_ method: String) -> [Call] {
    calls.filter { $0.method == method }
  }

  func requestReply(_ method: String, params: JSONValue) async throws -> RPCReply<JSONValue> {
    if state.withLock({ $0.isShutDown }) {
      throw GatewayRPCError(.notConnected, "gateway not connected")
    }

    let (id, responder) = state.withLock { state -> (Int, (@Sendable (JSONValue) -> JSONValue)?) in
      let id = state.calls.count
      state.calls.append(Call(id: id, method: method, params: params))
      return (id, state.responders[method])
    }

    if let responder {
      return RPCReply(index: nextIndex(), result: responder(params))
    }

    return try await withCheckedThrowingContinuation { continuation in
      state.withLock { $0.waiting[id] = continuation }
    }
  }

  /// Wait until the store has made a call to `method` that is still unanswered.
  func pendingCall(_ method: String) async throws -> Call {
    let deadline = ContinuousClock.now + generousWait

    while true {
      let found = state.withLock { state in
        state.calls.first { $0.method == method && state.waiting[$0.id] != nil }
      }

      if let found {
        return found
      }

      guard ContinuousClock.now < deadline else {
        throw TimedOut(what: "a call to \(method)")
      }

      try await Task.sleep(for: .milliseconds(2))
    }
  }

  /// Answer a pending call; answers the wire index it was given.
  @discardableResult
  func answer(_ call: Call, _ result: JSONValue, index: UInt64? = nil) -> UInt64 {
    let index = index ?? nextIndex()
    state.withLock { $0.wireIndex = max($0.wireIndex, index) }
    let continuation = state.withLock { $0.waiting.removeValue(forKey: call.id) }
    continuation?.resume(returning: RPCReply(index: index, result: result))
    return index
  }

  func fail(_ call: Call, _ error: any Error) {
    let continuation = state.withLock { $0.waiting.removeValue(forKey: call.id) }
    continuation?.resume(throwing: error)
  }

  /// Wait for the next call to `method` and answer it.
  @discardableResult
  func answerNext(_ method: String, _ result: JSONValue, index: UInt64? = nil) async throws -> UInt64 {
    let call = try await pendingCall(method)
    return answer(call, result, index: index)
  }

  func fetchMessages(_ resolvedSessionID: String, _ window: MessageWindow) async -> [TranscriptRow]? {
    let rows = state.withLock { state in
      state.restCalls.append((resolvedSessionID, window))
      return state.restRows
    }

    return rows?(resolvedSessionID, window)
  }

  // MARK: Lifecycle

  private func record(_ name: String) {
    state.withLock { $0.lifecycle.append(name) }
  }

  func start() async { record("start") }
  func stop() async { record("stop") }
  func pause() async { record("pause") }
  func resume() async { record("resume") }
  func retryNow() async { record("retryNow") }
  func setOnline(_ online: Bool) async { record("setOnline(\(online))") }

  func shutdown() async {
    record("shutdown")
    eventSink.finish()
    requestSink.finish()
    statusSink.finish()

    let waiting = state.withLock { state in
      state.isShutDown = true
      defer { state.waiting.removeAll() }
      return state.waiting
    }

    for continuation in waiting.values {
      continuation.resume(throwing: GatewayRPCError(.closed, "WebSocket closed"))
    }
  }
}

// MARK: - Fixtures

enum Fixture {
  static let profile = "researcher"
  static let stored = "stored-1"
  static let runtime = "rt-1"

  static func bot(_ name: String = profile, stored: String = stored, messageCount: Int = 2) -> Bot {
    Bot(
      name: name,
      canonical: CanonicalSession(id: stored, resolvedID: stored, preview: "", lastActive: 100, messageCount: messageCount)
    )
  }

  static func rows(_ count: Int, from start: Int = 1) -> [JSONValue] {
    (start..<(start + count)).map { id in
      [
        "role": .string(id % 2 == 1 ? "user" : "assistant"),
        "text": .string("row \(id)"),
        "row_id": .number(Double(id)),
        "timestamp": .number(Double(1_789_999_000 + id))
      ]
    }
  }

  static func resume(runtime: String = runtime, stored: String = stored, messageCount: Int = 2, extra: JSONObject = [:])
    -> JSONValue
  {
    var object: JSONObject = [
      "session_id": .string(runtime),
      "stored_session_id": .string(stored),
      "message_count": .number(Double(messageCount)),
      "info": ["desktop_contract": 7, "model": "example-model"],
      "open_requests": []
    ]

    for (key, value) in extra {
      object[key] = value
    }

    return .object(object)
  }

  static func since(latest: Int, epoch: String = "epoch-1", events: [JSONValue] = []) -> JSONValue {
    ["events": .array(events), "latest_seq": .number(Double(latest)), "epoch": .string(epoch), "open_requests": []]
  }
}

/// A store over a scripted link, with every clock manual.
struct StoreHarness {
  let link: ScriptedLink
  let clock: ManualClock
  let frames: ManualFrameScheduler
  let roster: BotRoster
  let store: TranscriptStore

  init(cache: (any ChatCaching)? = nil, now: @escaping @Sendable () -> Double = { 1_790_000_000_000 }) {
    link = ScriptedLink()
    clock = ManualClock()
    frames = ManualFrameScheduler()
    roster = BotRoster(link: link, gatewayID: "g1", cache: cache, clock: clock, wallMilliseconds: now)

    var options = TranscriptStore.Options()
    options.now = now
    options.clock = clock
    options.frames = frames
    store = TranscriptStore(link: link, roster: roster, cache: cache, options: options)
  }

  /// Subscribe and answer the calls a test does not care about.
  func attach() async {
    await store.attach()
    link.respond(to: RPC.SubagentList.name, with: ["subagents": []])
    link.respond(to: RPC.ApprovalReceived.name, with: ["received": true])
    link.respond(to: RPC.ProfilesGetAsset.name, with: ["found": false])
  }

  /// Everything down, the link's pending calls failed, every task awaited.
  func shutdown() async {
    await link.shutdown()
    await store.shutdown()
    await roster.shutdown()
  }

  /// Open the bot's chat: resume, history and replay answered with these values.
  func open(
    _ bot: Bot = Fixture.bot(),
    resume: JSONValue = Fixture.resume(),
    history: [JSONValue] = Fixture.rows(2),
    since: JSONValue = Fixture.since(latest: 0)
  ) async throws {
    let opening = Task { try await store.open(bot) }
    try await link.answerNext(RPC.SessionResume.name, resume)
    try await link.answerNext(RPC.SessionHistory.name, ["count": .number(Double(history.count)), "messages": .array(history)])
    try await link.answerNext(RPC.SessionEventsSince.name, since)
    try await opening.value
    await settle()
  }

  func state(_ key: String = Fixture.profile) async -> ChatState {
    await store.state(of: key)!
  }

  /// Wait until the store has taken in every frame the link sent, then apply it all.
  func settle() async {
    let sent = link.emittedFrames
    let store = self.store
    try? await eventually("the store to take in \(sent) frames") { await store.ingestedFrames >= sent }
    await store.quiesce()
  }
}

/// A transcript as canonical JSON text, for comparing whole states.
func canonical(_ value: some TranscriptJSONCodable) -> String {
  value.canonicalJSON
}
