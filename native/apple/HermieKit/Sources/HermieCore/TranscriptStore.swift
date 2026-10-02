import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript

/// Every chat of one gateway, and the one ordered path into them.
///
/// The port of `store/chats.ts` plus the transcript half of
/// `features/chats/chat-controller.ts`: the chats keyed by bot, the routing of
/// runtime session ids onto them, hydration, history, the reconnect recovery
/// and the tail sweep. The submit and answer paths are `SubmitPipeline.swift`;
/// hydration is `TranscriptStore+Hydration.swift`.
///
/// # The single ingest path
///
/// Three things change a chat besides the reader: gateway events, server
/// requests and RPC results. They reach this actor from three places (two
/// stream consumers and whichever task awaited the call), so their arrival
/// order is not the wire's. Everything therefore goes through one queue per
/// chat (a *lane*) and is applied by `flush()` in wire order:
///
/// - Events keep the order the connection dispatched them in; a server request
///   or an RPC result is placed among them by its wire index (`WireOrder.swift`).
/// - A call whose result is applied to a chat is an *ordered call*. While one
///   is in flight, nothing in that chat's lane with a wire index above the
///   highest index ingested when the call went out is applied: the answer will
///   be placed among those frames once it is here. Other chats are not held.
/// - An event or request for a runtime session no chat is bound to waits in the
///   unbound lane while a resume is in flight (it may be the session that
///   resume binds); when the resume binds it, the frames with an index above the
///   resume's are applied after it, the ones below are contained in its
///   snapshot and dropped. With no resume in flight it is dropped, as the
///   reference drops it, and a request is parked (`park`).
/// - A *snapshot read* (`subagent.list`, `approval.pending`) holds nothing: its
///   answer is placed at its wire index and dropped if the chat has applied a
///   newer frame meanwhile (`appliedThrough`); the next read fixes it.
/// - A server request is never held: its card goes up at once. One that comes
///   in after its own end (a `request.cancel` that overtook it, the
///   `message.complete` of its turn, or the answer that bound its session) draws
///   no card.
/// - A frame for a bound session below the answer that bound it (`boundAt`) is
///   contained in that answer and dropped, also when it turns up late.
/// - Work for a chat carries the chat's generation; `forget` bumps it, so an
///   answer meant for a replaced conversation is never applied to its successor.
/// - Every engine call happens inside `flush()` or a step it runs, with no
///   `await` between taking an item and applying it.
///
/// # Catching up before a result is placed
///
/// A result can reach this actor before every event that preceded it on the
/// wire has been taken out of the event stream: an `AsyncStream` hands its
/// consumer one element per hop, so an answer's caller can run between two of
/// them. So before a result (or a step of the reader's own) is placed, the
/// store catches up: it reads the connection's per-session `seq` watermarks,
/// the highest `seq` the connection has dispatched for each session, and waits
/// until it has taken in that far for the chat's runtime session and for the
/// session the result names. Every session event dispatched before the answer
/// was handed over is then in a lane, and placing by wire index is exact.
/// (Session events carry a `seq`; server requests do not. A request that comes
/// in after a result it preceded is still delivered, and since cards are keyed
/// by request id, the order does not change what they show.) The wait is
/// bounded by `catchUpLimit`, so a watermark the stream never reaches cannot
/// hold a chat for good.
///
/// # Memory
///
/// Every chat that was opened stays resident and live, as in the reference:
/// leaving the screen does not detach, because bot-to-bot traffic into a chat
/// nobody looks at is what the app exists to show. A chat painted from the
/// cache at a cold start stays `cached` until it is opened. `forget` drops one.
///
/// # Publishing
///
/// A change marks its chat dirty. At most once per frame (`FrameScheduler`)
/// the dirty chats are summarised (and, for chats a screen observes, projected
/// with `visibleItems`) here, off the main actor, and handed to the main actor
/// in a single hop. A published value never shares storage with the state the
/// next delta mutates.
public actor TranscriptStore {
  public struct Options: Sendable {
    /// Wall-clock milliseconds, passed to every engine call that takes `now`.
    /// Called exactly once per such call, in the order the calls are made.
    public var now: @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
    /// Timers: the cache debounce, the `sessions.changed` debounce, the polls.
    public var clock: any ConnectionClock = SystemConnectionClock()
    /// When to publish.
    public var frames: any FrameScheduler = ClockFrameScheduler()
    /// How long a chat may stay changed before its snapshot is written to the cache.
    public var cacheDebounce: Duration = .seconds(1)
    public var sessionsChangedDebounce: Duration = ChatRuntimeLimits.sessionsChangedDebounce
    public var approvalPoll: Duration = ChatRuntimeLimits.approvalPoll
    public var subagentPoll: Duration = ChatRuntimeLimits.subagentPoll
    /// The reader's own author, read when a turn begins (`ownAuthor`).
    public var ownAuthor: @Sendable () -> MessageAuthor? = { nil }
    /// The longest a result waits for the events dispatched before it (`catchUp`).
    public var catchUpLimit: Duration = .seconds(2)
    /// How often the chat list's summaries are recomputed at most: the list
    /// does not need every frame a streaming chat screen does.
    public var summaryInterval: Duration = .milliseconds(250)

    public init() {}
  }

  // MARK: Configuration

  let link: any GatewayLink
  let cache: (any ChatCaching)?
  let roster: BotRoster
  let options: Options

  // MARK: Chats

  var chats: [String: ChatRecord] = [:]
  /// Runtime `session_id` → chat key (`runtimeToBot`).
  var routes: [String: String] = [:]
  /// Server requests for a session no chat is bound to yet, per runtime id.
  var parked: [String: [InboundRequest]] = [:]
  /// Live reply handles, by the card id that shows them (`pending`).
  var deliveries: [String: Delivery] = [:]
  /// Approval request ids already acknowledged (`acknowledged`).
  var acknowledged: Set<String> = []
  /// One hydration per chat at a time (`opening`).
  var opening: [String: Opening] = [:]
  /// Chats with a `/new` in progress: nothing is sent or steered into them
  /// until the successor is open.
  var retiring: Set<String> = []
  /// Steers whose `session.steer` has not answered yet, per chat.
  var steering: [String: Int] = [:]
  /// Told after every desktop contract check of a resume, numbered so a late
  /// report never overrides a newer one: `nil` when it passed.
  var contractSink: (@MainActor @Sendable (UInt64, GatewayError?) -> Void)?
  var contractChecks: UInt64 = 0
  /// The desktop contract this gateway last reported (`knownContract`).
  var knownContract: Double?
  var sawReady = false
  var foregrounded = true
  var queueSeq = 0

  // MARK: The ingest path

  var lanes: [String: Lane] = [:]
  var unbound: [LaneItem] = []
  var outstanding: [UInt64: OrderedCall] = [:]
  var nextCallID: UInt64 = 0
  var nextArrival: UInt64 = 0
  /// The highest wire index this actor has taken in, from any source.
  var highestIngested: UInt64 = 0
  var flushScheduled = false
  var consumers: [Task<Void, Never>] = []
  /// The highest `seq` taken in per session, and who waits for one.
  var ingestedSeq: [String: Double] = [:]
  var seqWaiters: [SeqWaiter] = []
  var nextWaiterID: UInt64 = 0
  /// Bumped whenever a chat is forgotten, so an answer meant for the chat that
  /// was there is not applied to the one that replaced it.
  var generations: [String: UInt64] = [:]

  /// Which chat is under a key: bumped by `forget`.
  func generation(of key: String) -> UInt64 {
    generations[key] ?? 0
  }
  /// Frames taken in from the two streams, for tests that know how many they sent.
  var ingestedFrames = 0
  /// The highest wire index applied to each chat. A snapshot read older than it is stale.
  var appliedThrough: [String: UInt64] = [:]
  /// The wire index of the answer that bound each chat's runtime session: a frame
  /// for that session below it is contained in that answer.
  var boundAt: [String: UInt64] = [:]
  /// Request ids the gateway already closed for each chat (cancelled, or ended by
  /// the turn), so a request that comes in after its own end draws no card.
  var closedRequests: [String: Set<String>] = [:]
  /// The wire index of the last frame that ended a turn in each chat.
  var turnEndedAt: [String: UInt64] = [:]
  /// Request ids with an answer on its way, so a second tap sends nothing.
  var answering: Set<String> = []
  /// The `replay_epoch` of the last `gateway.ready`.
  var replayEpoch: String?

  // MARK: Publishing

  var sink: (@MainActor @Sendable (FrameBatch) -> Void)?
  var observed: [String: VisibilityOptions] = [:]
  var dirty: Set<String> = []
  var removedSinceFrame: Set<String> = []
  var frameRequested = false
  var publishing = false
  var revisions: [String: Int] = [:]
  /// Read watermarks (unix seconds) the list's unread counts are measured from.
  var seenAt: [String: Double] = [:]
  /// Chats whose list summary is due, and when summaries last went out.
  var summaryDirty: Set<String> = []
  var lastSummaryAt: Duration?
  var summaryTimer: ScheduledTimer?

  // MARK: Timers and tasks

  var cacheDirty: Set<String> = []
  var cacheTimer: ScheduledTimer?
  var sessionsChangedTimer: ScheduledTimer?
  var approvalPollTimer: ScheduledTimer?
  var subagentPollTimer: ScheduledTimer?
  var tasks: [UInt64: Task<Void, Never>] = [:]
  var nextTaskID: UInt64 = 0
  var isShutDown = false

  public init(link: any GatewayLink, roster: BotRoster, cache: (any ChatCaching)? = nil, options: Options = Options()) {
    self.link = link
    self.roster = roster
    self.cache = cache
    self.options = options
  }

  // MARK: - Lifecycle

  /// Subscribe to the link's events and server requests. Call before the
  /// connection starts: nothing is buffered for a subscriber that comes later.
  public func attach() {
    guard consumers.isEmpty, !isShutDown else {
      return
    }

    let events = link.events
    let requests = link.serverRequests

    consumers.append(
      Task {
        for await wire in events {
          self.ingest(wire)
        }
      }
    )
    consumers.append(
      Task {
        for await request in requests {
          self.ingest(request)
        }
      }
    )
  }

  /// Where frames go: one main-actor call per frame.
  public func setSink(_ sink: @escaping @MainActor @Sendable (FrameBatch) -> Void) {
    self.sink = sink
    dirty.formUnion(chats.keys)
    requestFrame()
  }

  /// Stop everything this store started: the consumers, the timers, every task.
  /// Pending ordered calls are abandoned with `CancellationError`. Idempotent.
  public func shutdown() async {
    if isShutDown {
      return
    }

    isShutDown = true

    for consumer in consumers {
      consumer.cancel()
    }

    consumers.removeAll()
    clearTimers()

    let hydrations = opening.values.map(\.task)

    for task in hydrations {
      task.cancel()
    }

    for item in lanes.values.flatMap(\.pending) + unbound {
      if case .step(let step) = item.payload {
        step.abandon()
      }
    }

    for waiter in seqWaiters {
      waiter.timer?.cancel()
      waiter.continuation.resume()
    }

    seqWaiters.removeAll()
    lanes.removeAll()
    unbound.removeAll()
    outstanding.removeAll()
    parked.removeAll()
    deliveries.removeAll()

    let running = Array(tasks.values)

    for task in running {
      task.cancel()
    }

    for task in running {
      await task.value
    }

    // A hydration in flight sees its calls fail and its steps abandoned; it is
    // awaited so nothing it does outlives the store.
    for task in hydrations {
      _ = await task.result
    }

    opening.removeAll()
    tasks.removeAll()
  }

  /// How many tasks the store is running besides its two stream consumers.
  public var liveTaskCount: Int { tasks.count }

  /// Apply everything taken in so far. For tests, which first wait until
  /// `ingestedFrames` counts every frame they sent.
  func quiesce() {
    flush()
  }

  /// Whether the stream consumers are still subscribed.
  public var isAttached: Bool { !consumers.isEmpty }

  func clearTimers() {
    for timer in [cacheTimer, sessionsChangedTimer, approvalPollTimer, subagentPollTimer, summaryTimer] {
      timer?.cancel()
    }

    summaryTimer = nil
    cacheTimer = nil
    sessionsChangedTimer = nil
    approvalPollTimer = nil
    subagentPollTimer = nil
  }

  /// Run `operation` as a tracked task: `shutdown()` cancels and awaits it.
  @discardableResult
  func spawn(_ operation: @escaping @Sendable (isolated TranscriptStore) async -> Void) -> UInt64 {
    let id = nextTaskID
    nextTaskID += 1

    guard !isShutDown else {
      return id
    }

    tasks[id] = Task {
      await operation(self)
      self.tasks[id] = nil
    }

    return id
  }

  // MARK: - Reading

  /// A chat's whole state, for the rare reader that needs it (export, tests).
  public func state(of key: String) -> ChatState? {
    chats[key]?.state
  }

  public var chatKeys: [String] { chats.keys.sorted() }

  /// The chat a runtime session id is bound to.
  public func chatKey(forRuntime runtimeID: String) -> String? {
    routes[runtimeID]
  }

  // MARK: - Ingest

  func ingest(_ wire: WireEvent) {
    guard !isShutDown else {
      return
    }

    highestIngested = max(highestIngested, wire.index)
    ingestedFrames += 1

    let event = wire.event

    if let sessionID = event.sessionID, !sessionID.isEmpty, let seq = event.json["seq"]?.doubleValue {
      noteIngested(sessionID, seq)
    }

    if event.type == GatewayEventType.gatewayReady {
      noteReady(event)
      return
    }

    // `onEvent`: two broadcasts are not about a transcript at all.
    if event.type == GatewayEventType.sessionsChanged {
      scheduleSessionsChanged()
      return
    }

    guard let sessionID = event.sessionID, !sessionID.isEmpty else {
      return
    }

    let item = LaneItem(index: wire.index, rank: .event, arrival: arrival(), payload: .event(event))

    if let key = routes[sessionID] {
      lanes[key, default: Lane()].append(item)
    } else if hasBindingInFlight {
      unbound.append(item)
    } else {
      // No chat holds this session and no resume can claim it: not ours.
      return
    }

    scheduleFlush()
  }

  func ingest(_ inbound: InboundRequest) {
    guard !isShutDown else {
      return
    }

    highestIngested = max(highestIngested, inbound.index)
    ingestedFrames += 1

    guard inbound.method == "approval" || inbound.method == "clarify" else {
      // The one-string prompts never enter the transcript: `SecureInputCenter`,
      // a consumer of its own, answers them.
      if inbound.body.isSecureInput {
        return
      }

      // Everything else belongs to a surface this app does not have.
      spawn { _ in _ = await inbound.decline() }
      return
    }

    let sessionID = inbound.params["session_id"]?.stringValue ?? ""
    let item = LaneItem(index: inbound.index, rank: .request, arrival: arrival(), payload: .request(inbound))

    if let key = routes[sessionID] {
      insert(item, into: key)
      scheduleFlush()
    } else if !sessionID.isEmpty {
      park(sessionID, inbound)
    } else {
      spawn { _ in _ = await inbound.decline() }
    }
  }

  /// `park`: hold a request until its session is bound. Declining is not a
  /// neutral "not mine" — the gateway withdraws the question — so only a full
  /// parking lot declines.
  func park(_ sessionID: String, _ inbound: InboundRequest) {
    var held = parked[sessionID] ?? []

    guard held.count < ChatRuntimeLimits.maxParkedRequests else {
      spawn { _ in _ = await inbound.decline() }
      return
    }

    held.append(inbound)
    parked[sessionID] = held
  }

  func arrival() -> UInt64 {
    nextArrival += 1
    return nextArrival
  }

  /// Place a request or a step among a lane's items by wire index; events keep
  /// the order they were dispatched in and are only ever appended.
  func insert(_ item: LaneItem, into key: String) {
    lanes[key, default: Lane()].insert(item)
  }

  /// Frames waiting for a resume to claim their session (for tests).
  var unboundCount: Int { unbound.count }

  var hasBindingInFlight: Bool {
    outstanding.values.contains { $0.binding }
  }

  /// The highest wire index a lane may apply up to: everything below the
  /// earliest unanswered ordered call on it.
  func bound(of key: String) -> UInt64 {
    outstanding.values.reduce(UInt64.max) { bound, call in
      call.lane == key && !call.answered ? min(bound, call.issueIndex) : bound
    }
  }

  var unboundBound: UInt64 {
    outstanding.values.reduce(UInt64.max) { bound, call in
      call.binding ? min(bound, call.issueIndex) : bound
    }
  }

  func scheduleFlush() {
    guard !flushScheduled, !isShutDown else {
      return
    }

    flushScheduled = true

    // A job of its own, behind every job already queued (see the header).
    Task {
      self.flush()
    }
  }

  /// Apply everything that may be applied, lane by lane, in wire order.
  func flush() {
    flushScheduled = false

    for key in Array(lanes.keys) {
      drain(key)
    }

    drainUnbound()
  }

  func drain(_ key: String) {
    while let first = lanes[key]?.first, first.index <= bound(of: key) {
      lanes[key]?.removeFirst()
      apply(first, in: key)
    }

    // A question is never held behind a call in flight: its card goes up now.
    // (Cards are keyed by request id, so its place among the deltas does not
    // change what it shows; a withdrawal that overtook it is in `closedRequests`.)
    for request in lanes[key]?.takeRequests() ?? [] {
      apply(request, in: key)
    }

    if lanes[key]?.isEmpty == true {
      lanes[key] = nil
    }
  }

  func apply(_ item: LaneItem, in key: String) {
    if item.rank != .local {
      appliedThrough[key] = max(appliedThrough[key] ?? 0, item.index)
    }

    switch item.payload {
    case .event(let event):
      applyLive(event, at: item.index, in: key)
    case .request(let inbound):
      deliver(inbound, to: key, at: item.index)
    case .step(let step):
      step.run()
    }
  }

  func drainUnbound() {
    let limit = unboundBound
    var kept: [LaneItem] = []

    for item in unbound {
      guard case .event(let event) = item.payload, let sessionID = event.sessionID else {
        continue
      }

      if let key = routes[sessionID] {
        // Bound since it came in; it belongs to that chat's lane.
        insert(item, into: key)
        scheduleFlush()
      } else if item.index > limit {
        kept.append(item)
      }
      // Otherwise no resume in flight can claim it: dropped, as the reference drops it.
    }

    unbound = kept
  }

  // MARK: - Catching up

  /// A `gateway.ready` with another `replay_epoch` is another gateway process,
  /// which numbers every session from 1 again; the seqs taken in so far mean
  /// nothing against its watermarks.
  func noteReady(_ event: GatewayEvent) {
    guard let epoch = event.payload?["replay_epoch"]?.stringValue, !epoch.isEmpty else {
      return
    }

    if let replayEpoch, replayEpoch != epoch {
      ingestedSeq.removeAll()
    }

    replayEpoch = epoch
  }

  func noteIngested(_ sessionID: String, _ seq: Double) {
    guard seq > (ingestedSeq[sessionID] ?? 0) else {
      return
    }

    ingestedSeq[sessionID] = seq

    guard seqWaiters.contains(where: { $0.session == sessionID }) else {
      return
    }

    var waiting: [SeqWaiter] = []

    for waiter in seqWaiters {
      if waiter.session == sessionID, waiter.seq <= seq {
        waiter.timer?.cancel()
        waiter.continuation.resume()
      } else {
        waiting.append(waiter)
      }
    }

    seqWaiters = waiting
  }

  /// The safety valve of `catchUp`: a watermark the stream never reaches (it
  /// should not happen) holds the chat for `catchUpLimit`, not for good.
  func releaseWaiter(_ id: UInt64) {
    guard let index = seqWaiters.firstIndex(where: { $0.id == id }) else {
      return
    }

    seqWaiters.remove(at: index).continuation.resume()
  }

  /// Wait until every event the connection has dispatched for these sessions
  /// has been taken in (see the header). Returns at once on shutdown.
  func catchUp(_ sessions: [String?]) async {
    let wanted = Set(sessions.compactMap { $0 }.filter { !$0.isEmpty })

    guard !wanted.isEmpty, !isShutDown else {
      return
    }

    let marks = await link.seqWatermarks()

    for session in wanted.sorted() {
      guard let mark = marks[session], mark > (ingestedSeq[session] ?? 0), !isShutDown else {
        continue
      }

      let id = nextWaiterID
      nextWaiterID += 1

      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let timer = options.clock.schedule(after: options.catchUpLimit) { [weak self] in
          await self?.releaseWaiter(id)
        }
        seqWaiters.append(SeqWaiter(id: id, session: session, seq: mark, continuation: continuation, timer: timer))
      }
    }
  }

  // MARK: - Ordered calls

  /// One call whose result is applied to a chat in wire order.
  ///
  /// `apply` runs inside the flush, at the result's place among the chat's
  /// frames, with no suspension between taking the result and applying it.
  /// `binding` marks a call that may bind a runtime session (a resume): frames
  /// for sessions nobody holds wait for it.
  ///
  /// `generation` names the chat the work belongs to, when it started before
  /// this call (a hydration): the answer is not applied to a chat that has
  /// replaced it.
  func ordered<T>(
    _ key: String,
    binding: Bool = false,
    generation expected: UInt64? = nil,
    _ perform: @escaping @Sendable () async throws -> RPCReply<JSONValue>,
    apply: @escaping (RPCReply<JSONValue>) throws -> T
  ) async throws -> T {
    let id = nextCallID
    nextCallID += 1
    let ticket = expected ?? generation(of: key)
    outstanding[id] = OrderedCall(lane: key, binding: binding, issueIndex: highestIngested)

    let reply: RPCReply<JSONValue>

    do {
      reply = try await perform()
    } catch {
      outstanding[id] = nil
      scheduleFlush()
      throw error
    }

    // Everything the connection dispatched before this answer comes first.
    await catchUp([chats[key]?.state.runtimeSessionID, reply.result["session_id"]?.stringValue])

    guard !isShutDown else {
      outstanding[id] = nil
      throw CancellationError()
    }

    highestIngested = max(highestIngested, reply.index)
    outstanding[id]?.answered = true

    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, any Error>) in
      let step = Step(
        run: {
          self.outstanding[id] = nil

          // The chat was forgotten (and maybe opened again) while this was in the air.
          guard self.generation(of: key) == ticket else {
            continuation.resume(throwing: CancellationError())
            return
          }

          do {
            continuation.resume(returning: try apply(reply))
          } catch {
            continuation.resume(throwing: error)
          }
        },
        abandon: {
          self.outstanding[id] = nil
          continuation.resume(throwing: CancellationError())
        }
      )

      insert(LaneItem(index: reply.index, rank: .result, arrival: arrival(), payload: .step(step)), into: key)
      scheduleFlush()
    }
  }

  /// A read whose answer is a snapshot (`subagent.list`, `approval.pending`):
  /// it holds nothing while it is in the air. Its answer is placed at its wire
  /// index and applied there if nothing newer has been applied to the chat;
  /// otherwise it is stale and dropped (`nil`), and the next read fixes it.
  func snapshotRead<T: Sendable>(
    _ key: String,
    _ perform: @escaping @Sendable () async throws -> RPCReply<JSONValue>,
    apply: @escaping (RPCReply<JSONValue>) throws -> T
  ) async throws -> T? {
    let ticket = generation(of: key)
    let reply = try await perform()

    guard !isShutDown else {
      throw CancellationError()
    }

    highestIngested = max(highestIngested, reply.index)

    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T?, any Error>) in
      let step = Step(
        run: {
          guard self.generation(of: key) == ticket else {
            continuation.resume(throwing: CancellationError())
            return
          }

          guard reply.index >= (self.appliedThrough[key] ?? 0) else {
            continuation.resume(returning: nil)
            return
          }

          do {
            continuation.resume(returning: try apply(reply))
          } catch {
            continuation.resume(throwing: error)
          }
        },
        abandon: {
          continuation.resume(throwing: CancellationError())
        }
      )

      insert(LaneItem(index: reply.index, rank: .result, arrival: arrival(), payload: .step(step)), into: key)
      scheduleFlush()
    }
  }

  /// A mutation that is not a wire frame (a REST answer, the reader's own
  /// send): applied after everything this chat has taken in so far, and before
  /// anything that comes in later.
  ///
  /// Bound to the chat that is there when it is asked for (or, with
  /// `generation`, when the caller started the work it applies, such as a
  /// fetch): if that chat is forgotten (a `/new`, a switch) before it runs, it
  /// throws `CancellationError`.
  func local<T>(
    _ key: String,
    generation expected: UInt64? = nil,
    _ apply: @escaping () throws -> T
  ) async throws -> T {
    let ticket = expected ?? generation(of: key)
    await catchUp([chats[key]?.state.runtimeSessionID])

    guard !isShutDown, generation(of: key) == ticket else {
      throw CancellationError()
    }

    drain(key)

    if lanes[key]?.isEmpty ?? true {
      return try apply()
    }

    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, any Error>) in
      let step = Step(
        run: {
          guard self.generation(of: key) == ticket else {
            continuation.resume(throwing: CancellationError())
            return
          }

          do {
            continuation.resume(returning: try apply())
          } catch {
            continuation.resume(throwing: error)
          }
        },
        abandon: {
          continuation.resume(throwing: CancellationError())
        }
      )

      insert(LaneItem(index: highestIngested, rank: .local, arrival: arrival(), payload: .step(step)), into: key)
      scheduleFlush()
    }
  }

  // MARK: - Routing

  /// `bindRuntime`: bind a runtime id to a chat, restart the watermark if the
  /// session changed, and hand over whatever was waiting on that id.
  ///
  /// `index` is the wire index of the answer that named the session: frames for
  /// it with a lower index are contained in that answer and dropped; the ones
  /// above it are applied after it, in order.
  func bindRuntime(_ key: String, _ runtimeID: String, at index: UInt64) {
    guard chats[key] != nil else {
      return
    }

    let previous = chats[key]?.state.runtimeSessionID

    if let previous, previous != runtimeID {
      parked[previous] = nil
      // A new session numbers its requests afresh.
      closedRequests[key] = nil
    }

    for (id, owner) in routes where owner == key && id != runtimeID {
      routes[id] = nil
      parked[id] = nil
    }

    // One runtime session belongs to one chat: another chat that held it lets go.
    if let other = routes[runtimeID], other != key {
      dropRuntime(other)
    }

    routes[runtimeID] = key
    boundAt[key] = index

    mutateState(key) { state in
      // The gateway numbers events per runtime session and starts each one at 1,
      // so a watermark from the previous session is a number from another counter.
      if state.lastSeqSessionID != runtimeID {
        state.lastSeq = 0
        state.lastSeqSessionID = runtimeID
        state.epoch = nil
      }

      state.runtimeSessionID = runtimeID
    }

    var stillUnbound: [LaneItem] = []

    for item in unbound {
      if case .event(let event) = item.payload, event.sessionID == runtimeID {
        if item.index > index {
          insert(item, into: key)
        }
      } else {
        stillUnbound.append(item)
      }
    }

    unbound = stillUnbound

    if let waiting = parked.removeValue(forKey: runtimeID) {
      for inbound in waiting {
        if inbound.index > index {
          insert(
            LaneItem(index: inbound.index, rank: .request, arrival: arrival(), payload: .request(inbound)),
            into: key
          )
        } else {
          deliver(inbound, to: key, at: nil)
        }
      }
    }

    scheduleFlush()
  }

  /// `dropRuntime`: `session.reclaimed` — the runtime id is gone, the transcript is not.
  func dropRuntime(_ key: String) {
    for (id, owner) in routes where owner == key {
      routes[id] = nil
    }

    mutateState(key) { state in
      state.runtimeSessionID = nil
    }
  }

  // MARK: - Mutating

  /// Run one change on a chat's state in place and mark it for the next frame.
  func mutateState(_ key: String, _ change: (inout ChatState) -> Void) {
    guard chats[key] != nil else {
      return
    }

    change(&chats[key]!.state)
    markDirty(key)
  }

  /// Move a chat along the ladder. With `generation`, only if the chat under
  /// the key is still the one the caller worked for.
  func setHydration(_ key: String, _ hydration: HydrationState, generation ticket: UInt64? = nil) {
    if let ticket, generation(of: key) != ticket {
      return
    }

    guard let current = chats[key]?.state.hydration, current != hydration else {
      return
    }

    mutateState(key) { $0.hydration = hydration }
  }

  func now() -> Double {
    options.now()
  }

  // MARK: - Publishing

  /// Observe one chat at these visibility options: its snapshots are part of
  /// every frame in which it changed. Observing again replaces the options.
  public func observe(_ key: String, options visibility: VisibilityOptions) {
    observed[key] = visibility
    markDirty(key)
  }

  public func stopObserving(_ key: String) {
    observed[key] = nil
  }

  /// Seed the read watermarks the roster loaded, so a cached chat counts unread
  /// from where the reader left it rather than from the beginning.
  public func seedSeen(_ watermarks: [String: Double]) {
    for (key, seconds) in watermarks {
      markSeen(key, at: seconds)
    }
  }

  /// Move a chat's read watermark (unix seconds); never backwards.
  public func markSeen(_ key: String, at seconds: Double) {
    guard seconds > (seenAt[key] ?? 0) else {
      return
    }

    seenAt[key] = seconds
    markDirty(key)
  }

  func markDirty(_ key: String) {
    dirty.insert(key)
    summaryDirty.insert(key)
    requestFrame()
  }

  func requestFrame() {
    let pending = !dirty.isEmpty || !removedSinceFrame.isEmpty || (!summaryDirty.isEmpty && summaryTimer == nil)

    guard sink != nil, !frameRequested, !publishing, !isShutDown, pending else {
      return
    }

    frameRequested = true
    options.frames.requestFrame { [weak self] in
      await self?.publishFrame()
    }
  }

  /// One frame: summarise what changed, project what is observed, one hop to main.
  func publishFrame() async {
    frameRequested = false

    guard let sink, !isShutDown else {
      return
    }

    let batch = makeBatch()

    guard !batch.isEmpty else {
      return
    }

    publishing = true
    await sink(batch)
    publishing = false

    // What changed while the main actor was busy goes out on the next frame.
    requestFrame()
  }

  func makeBatch() -> FrameBatch {
    var batch = FrameBatch()

    for key in dirty {
      guard let record = chats[key], let visibility = observed[key] else {
        continue
      }

      batch.chats[key] = snapshot(of: key, record, visibility)
    }

    dirty.removeAll()

    // The list's summaries at most every `summaryInterval`; what is due later
    // goes out when the interval has passed, even if nothing else changes.
    if !summaryDirty.isEmpty {
      let now = options.clock.now
      let elapsed = lastSummaryAt.map { now - $0 } ?? options.summaryInterval

      if elapsed >= options.summaryInterval {
        for key in summaryDirty {
          if let record = chats[key] {
            batch.summaries[key] = summary(of: key, record)
          }
        }

        summaryDirty.removeAll()
        lastSummaryAt = now
      } else if summaryTimer == nil {
        summaryTimer = options.clock.schedule(after: options.summaryInterval - elapsed) { [weak self] in
          await self?.summaryTimerFired()
        }
      }
    }

    batch.removed = Array(removedSinceFrame)
    removedSinceFrame.removeAll()

    return batch
  }

  func summaryTimerFired() {
    summaryTimer = nil
    requestFrame()
  }

  func summary(of key: String, _ record: ChatRecord) -> ChatSummary {
    let state = record.state
    let author = options.ownAuthor()

    return ChatSummary(
      key: key,
      preview: previewFromChat(state, ChatPreviewOptions(groupChat: true, ownAuthorID: author?.id)),
      unread: unreadCountSince(state, seenAt[key] ?? 0),
      needsInput: hasOpenRequest(state),
      busy: isBusy(state),
      hydration: state.hydration,
      attached: !(state.runtimeSessionID ?? "").isEmpty,
      lastMessageAt: lastMessageAt(state)
    )
  }

  func snapshot(of key: String, _ record: ChatRecord, _ visibility: VisibilityOptions) -> ChatSnapshot {
    let state = record.state
    let revision = (revisions[key] ?? 0) + 1
    revisions[key] = revision

    return ChatSnapshot(
      key: key,
      items: visibleItems(state, visibility),
      hydration: state.hydration,
      busy: isBusy(state),
      turnActive: state.turn.active,
      activity: turnActivity(state),
      openRequests: openRequests(state),
      queue: record.queue,
      attached: !(state.runtimeSessionID ?? "").isEmpty,
      canLoadOlder: !(record.window?.reachedStart ?? false),
      revision: revision
    )
  }
}

// MARK: - Internal types

/// One chat as the store holds it: the engine's state and the client's own facts about it.
struct ChatRecord {
  var state: ChatState
  /// Opened at least once; stays subscribed after the reader leaves (`live`).
  var live = false
  /// Messages parked behind the running turn (`queues`).
  var queue: [QueuedMessage] = []
  /// How far back history has been loaded (`windows`).
  var window: HistoryWindow?
  var loadingOlder = false
  /// Sends under this key whose `prompt.submit` has not answered yet (`sending`).
  var sending = 0

  init(state: ChatState) {
    self.state = state
  }
}

/// `HistoryWindow`: how far back one chat has loaded, in rows, and whether the start is in sight.
struct HistoryWindow: Equatable {
  var rows: Int
  var reachedStart: Bool
}

/// A hydration in flight, and the conversation it opens.
struct Opening {
  var task: Task<Void, any Error>
  var storedID: String?
}

/// Somebody waiting for a session's events to be taken in up to `seq`.
struct SeqWaiter {
  var id: UInt64
  var session: String
  var seq: Double
  var continuation: CheckedContinuation<Void, Never>
  var timer: ScheduledTimer?
}

/// A live reply handle, filed under the card that shows it.
struct Delivery {
  var key: String
  var inbound: InboundRequest
}

/// An RPC in flight whose result a chat is waiting to apply.
struct OrderedCall {
  /// The chat whose lane it holds.
  var lane: String
  /// It may bind a runtime session.
  var binding: Bool
  /// The highest wire index taken in when it went out. Its answer's index is above it.
  var issueIndex: UInt64
  /// The answer is here and placed in the lane.
  var answered = false
}

/// A closure applied at its place in a lane; `abandon` resumes its waiter on shutdown.
final class Step {
  private var runAction: (() -> Void)?
  private var abandonAction: (() -> Void)?

  init(run: @escaping () -> Void, abandon: @escaping () -> Void) {
    runAction = run
    abandonAction = abandon
  }

  func run() {
    let action = runAction
    runAction = nil
    abandonAction = nil
    action?()
  }

  func abandon() {
    let action = abandonAction
    runAction = nil
    abandonAction = nil
    action?()
  }
}

/// One chat's queue of frames and steps waiting to be applied, in apply order.
struct Lane {
  private var items: [LaneItem] = []
  private var head = 0

  var isEmpty: Bool { head == items.count }
  var first: LaneItem? { isEmpty ? nil : items[head] }
  var pending: ArraySlice<LaneItem> { items[head...] }

  /// An event: dispatch order is kept as it came.
  mutating func append(_ item: LaneItem) {
    items.append(item)
  }

  /// A request or a step, placed by wire index among what is waiting.
  mutating func insert(_ item: LaneItem) {
    var position = items.endIndex

    while position > head, items[position - 1].follows(item) {
      position -= 1
    }

    items.insert(item, at: position)
  }

  /// Take every request still waiting, wherever it stands.
  mutating func takeRequests() -> [LaneItem] {
    guard items[head...].contains(where: { $0.rank == .request }) else {
      return []
    }

    let requests = items[head...].filter { $0.rank == .request }
    items = items[head...].filter { $0.rank != .request }
    head = 0
    return requests
  }

  /// O(1); the consumed prefix is dropped once it is most of the storage.
  mutating func removeFirst() {
    head += 1

    if head == items.count {
      items.removeAll(keepingCapacity: true)
      head = 0
    } else if head > 1_024, head * 2 > items.count {
      items.removeFirst(head)
      head = 0
    }
  }
}

struct LaneItem {
  enum Rank: UInt8, Comparable {
    /// A server request re-delivered from a result's `open_requests` precedes the result.
    case request = 0
    case result = 1
    case event = 2
    /// Something this client did, after every frame taken in at that index.
    case local = 3

    static func < (lhs: Rank, rhs: Rank) -> Bool { lhs.rawValue < rhs.rawValue }
  }

  enum Payload {
    case event(GatewayEvent)
    case request(InboundRequest)
    case step(Step)
  }

  var index: UInt64
  var rank: Rank
  var arrival: UInt64
  var payload: Payload

  /// True when this item must come after `other` (wire index, then rank, then arrival).
  func follows(_ other: LaneItem) -> Bool {
    if index != other.index {
      return index > other.index
    }

    if rank != other.rank {
      return rank > other.rank
    }

    return arrival > other.arrival
  }
}
