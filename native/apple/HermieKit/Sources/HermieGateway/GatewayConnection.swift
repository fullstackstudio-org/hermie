import Foundation
import HermieProtocol

/// The connection state machine of `packages/gateway-client/src/connection.ts`,
/// ported behaviour for behaviour: one long-lived JSON-RPC client over a socket
/// this actor dials, drops and redials.
///
/// The TypeScript splits the work over three objects: `GatewayConnection` (the
/// dial loop and the status), the vendored `JsonRpcGatewayClient` (the socket
/// generation, events, the reconnect replay) and its `JsonRpcRequestChannel`
/// (request ids, pending calls, server requests, the heartbeat). Here one actor
/// owns all of it, so the socket, every timer and every piece of mutable state
/// have one owner; the three layers are three files:
///
/// - `GatewayConnection.swift`: the dial loop (`connection.ts`).
/// - `GatewayConnection+Socket.swift`: socket generations, frames, events and
///   replay (`json-rpc-gateway.ts`).
/// - `GatewayConnection+Channel.swift`: calls, server requests and the
///   heartbeat (`json-rpc-channel.ts`).
///
/// The replay watermarks live as long as the actor does, never per socket: they
/// are what make `session.events.since` work across a reconnect, which is why
/// the reference keeps one client instance for the connection's whole life.
///
/// **Reentrancy.** The reference is single-threaded JavaScript, where nothing
/// runs between two statements unless there is an `await`. An actor gives the
/// same guarantee between suspension points, and the code keeps the reference's
/// shape: work the reference does synchronously stays synchronous here, and
/// each place that awaits re-checks its state afterwards, as the reference
/// re-checks `running` / `paused` / the dial token. Every such re-check carries
/// a comment starting "Re-check after the suspension".
///
/// **Streams.** `statuses`, `events` and `serverRequests` hand out a new,
/// unbounded subscription on every access, and any number may be live at once.
/// `statuses` starts with the current status, as `onStatus` calls a new handler
/// once. `serverRequests` is meant for one consumer (the session); with none
/// subscribed, `approval` and `clarify` are answered `-32601` like every other
/// server request, as the reference does when no handler is registered.
///
/// Call `stop()` before releasing the connection: a live socket's reader keeps
/// the actor alive until the socket closes.
public actor GatewayConnection {
  public struct Options: Sendable {
    /// After the socket opens, how long to wait for the first `gateway.ready`.
    public var readyTimeout: Duration = .milliseconds(GatewayTimeouts.readyMs)
    /// The dial and upgrade; zero disables it.
    public var connectTimeout: Duration = .milliseconds(GatewayTimeouts.handshakeMs)
    /// `gateway.ping` interval when the gateway advertises it; zero disables it.
    public var heartbeatInterval: Duration = HeartbeatState.defaultInterval
    /// How long the socket may show no sign of life; zero disables the heartbeat.
    public var heartbeatDeadline: Duration = HeartbeatState.defaultDeadline
    /// How long an offline report must hold before a live socket comes down.
    public var offlineGrace: Duration = .milliseconds(GatewayTimeouts.offlineGraceMs)
    /// The window of a call the connection makes on its own (`client.capabilities`).
    public var requestTimeout: Duration = .milliseconds(GatewayTimeouts.defaultRPCMs)
    /// The reconnect ladder; `nil` for the default bounded-jitter ladder drawing from `random`.
    public var backoff: (@Sendable (Int) -> Duration)?
    /// A draw from `[0, 1)` for the default ladder's jitter.
    public var random: @Sendable () -> Double = { Double.random(in: 0..<1) }
    /// Fetch `session.events.since` after a reconnect.
    public var replay = true

    public init() {}
  }

  // MARK: Configuration

  let credentials: any CredentialProvider
  let transport: any WebSocketTransport
  let clock: any ConnectionClock
  let timeline: any AuthTimelineSink
  let options: Options
  let backoff: @Sendable (Int) -> Duration
  /// The WebSocket URL dial plans are minted for.
  let wsURL: String
  let extraHeaders: [String: String]

  let statusHub = Broadcast<ConnectionStatus>(latest: ConnectionStatus(.disconnected), replaysLatest: true)
  let eventHub = Broadcast<GatewayEvent>()
  let requestHub = Broadcast<ServerRequestDelivery>()

  // MARK: State of the dial loop (connection.ts)

  var currentPhase: ConnectionPhase = .disconnected
  var currentError: GatewayError?
  var running = false
  var paused = false
  var online = true
  var attempt = 0
  var consecutiveAuthFailures = 0
  /// WebSocket 4401 closes since the last healthy dial. Counted apart from
  /// `consecutiveAuthFailures`: a 4401 is always a ticket that was expired,
  /// spent or unknown, and the first one deserves a fresh ticket rather than a
  /// refresh-token rotation.
  var consecutiveTicketRejections = 0
  var dialToken = 0
  var retryTimer: TimerSlot?
  var offlineTimer: TimerSlot?
  var lastDialFailureAt: Duration?
  var lastCloseCode: Int?
  var readyWaiter: ReadyWaiter?
  var currentReplayEpoch: String?
  var currentLastReadyAt: Date?
  var firstSessionCallDone = false

  // MARK: State of the socket layer (json-rpc-gateway.ts)

  var socket: SocketGeneration?
  var clientState: ClientState = .idle
  var handshake: Handshake?
  var replay = ReplayState()
  var nextGeneration: UInt64 = 0

  // MARK: State of the call layer (json-rpc-channel.ts)

  var requestIDs = RequestIDSequence()
  var pending: [JSONRPCID: PendingCall] = [:]
  var attachedGeneration: UInt64?
  var attachedOutbox: AsyncStream<String>.Continuation?
  var heartbeat = HeartbeatState()
  var heartbeatTimer: TimerSlot?
  var openDeliveries: Set<UInt64> = []
  var nextDeliveryToken: UInt64 = 0

  // MARK: Bookkeeping

  var tasks: [UInt64: Task<Void, Never>] = [:]
  var nextTaskID: UInt64 = 0
  var nextTimerID: UInt64 = 0

  /// - Parameters:
  ///   - baseURL: the gateway address; normalised as the reference does, and
  ///     a `config` error when it cannot be.
  ///   - extraHeaders: headers for every dial (Cloudflare Access and friends).
  public init(
    baseURL: String,
    extraHeaders: [String: String]? = nil,
    credentials: any CredentialProvider,
    transport: any WebSocketTransport,
    clock: any ConnectionClock = SystemConnectionClock(),
    timeline: any AuthTimelineSink = NullAuthTimeline(),
    options: Options = Options()
  ) throws(GatewayError) {
    let base = try GatewayAddress.normalizeBaseURL(baseURL)
    self.wsURL = try GatewayAddress.webSocketURL(for: base)
    self.extraHeaders = try GatewayAddress.normalizeHeaders(extraHeaders)
    self.credentials = credentials
    self.transport = transport
    self.clock = clock
    self.timeline = timeline
    self.options = options

    let random = options.random
    self.backoff =
      options.backoff ?? { attempt in GatewayConnection.defaultBackoffDelay(attempt: attempt, random: random) }
  }

  deinit {
    statusHub.finish()
    eventHub.finish()
    requestHub.finish()
  }

  /// `defaultBackoffDelayMs`: the reconnect ladder with bounded jitter, so a
  /// wait is never less than half its rung.
  public static func defaultBackoffDelay(attempt: Int, random: () -> Double) -> Duration {
    .milliseconds(ReconnectBackoff.defaultDelayMs(attempt: Double(attempt), random: random))
  }

  // MARK: - Observing

  /// The current phase and the error that explains it.
  public var status: ConnectionStatus { ConnectionStatus(currentPhase, error: currentError) }

  public var phase: ConnectionPhase { currentPhase }

  public var lastError: GatewayError? { currentError }

  /// `replay_epoch` from the most recent `gateway.ready`; a change means the backend restarted.
  public var replayEpoch: String? { currentReplayEpoch }

  /// When the most recent `gateway.ready` arrived.
  public var lastReadyAt: Date? { currentLastReadyAt }

  /// The last event `seq` seen per session (`getSeqWatermarks`).
  public var seqWatermarks: [String: Double] {
    Dictionary(uniqueKeysWithValues: replay.watermarks.elements)
  }

  /// Every status transition, starting with the current status.
  public nonisolated var statuses: AsyncStream<ConnectionStatus> { statusHub.subscribe() }

  /// Every gateway event, live and replayed, in dispatch order.
  public nonisolated var events: AsyncStream<GatewayEvent> { eventHub.subscribe() }

  /// The `approval` and `clarify` requests the app is asked to answer.
  public nonisolated var serverRequests: AsyncStream<ServerRequestDelivery> { requestHub.subscribe() }

  // MARK: - Driving

  /// Begin dialling and keep the connection up until `stop()`.
  public func start() {
    if running {
      return
    }

    running = true
    paused = false
    attempt = 0
    consecutiveAuthFailures = 0
    consecutiveTicketRejections = 0

    // Dialled even when the device says there is no network: its answer is a
    // hint, and a cold start that believed a wrong one would never dial at all.
    dial()
  }

  /// Tear the connection down for good (sign-out, gateway change, app shutdown).
  public func stop() {
    running = false
    paused = false
    teardown()
    setStatus(.disconnected, .set(nil))
  }

  /// Close the socket cleanly and stop every timer: the app went to the background.
  ///
  /// A connection that is not running has already stopped for a reason it can
  /// explain (`needs_signin`, a rejected certificate, a gateway that refused
  /// the address); overwriting that with `paused` would lose the only account
  /// of why there is no connection.
  public func pause() {
    if paused || !running {
      return
    }

    paused = true
    teardown()
    setStatus(.paused, .set(nil))
  }

  /// Come back from the background: dial straight away, no backoff.
  public func resume() {
    if !paused && running {
      return
    }

    paused = false
    running = true
    attempt = 0
    // A resume follows a fresh sign-in as often as it follows a foreground;
    // keeping the old tally would send the next single rejection straight to
    // `needs_signin` with the new credential barely tried.
    consecutiveAuthFailures = 0
    consecutiveTicketRejections = 0
    clearOfflineTimer()

    dial()
  }

  /// Dial now, skipping whatever backoff is pending: the "Try now" button, and
  /// the one thing a connectivity report may do to the loop. Harmless at any
  /// time: a connection that has stopped for a reason it can explain is not
  /// restarted by it.
  public func retryNow() {
    if !running || paused {
      return
    }

    attempt = 0
    consecutiveAuthFailures = 0
    consecutiveTicketRejections = 0
    dial()
  }

  /// The device says it has (no) connectivity.
  ///
  /// This is advice about timing, never permission to dial: a report of "no
  /// network" that never comes back, or one that flaps around a real drop,
  /// used to leave the connection unrecoverable. So the ladder runs regardless.
  /// Offline labels the status ("Offline" rather than "Reconnecting…") and
  /// delays the teardown of a live socket by `offlineGrace`, so a handover does
  /// not rebuild every session. Online collapses the pending backoff when the
  /// last dial did not fail recently.
  public func setOnline(_ online: Bool) {
    // True while the grace is still running: the socket is still up, and coming
    // back online is a no-op rather than a redial.
    let withinGrace = offlineTimer != nil

    if online {
      clearOfflineTimer()
    }

    if self.online == online {
      return
    }

    self.online = online

    if !online {
      if currentPhase != .ready {
        // No live socket to protect. The ladder keeps its timer; only the word
        // the header shows while it climbs changes.
        if running && !paused {
          setStatus(.offline)
        }

        return
      }

      offlineTimer = schedule(after: options.offlineGrace) { connection, id in
        await connection.offlineGraceElapsed(id)
      }

      return
    }

    if withinGrace || !running || paused || currentPhase == .ready {
      // The flap ended before the socket came down; there is nothing to redial.
      return
    }

    // A dial that failed moments ago means the gateway, not the radio, is what
    // is unreachable; collapsing the backoff would hammer it once per flap.
    if let failedAt = lastDialFailureAt,
      clock.now - failedAt <= .milliseconds(GatewayTimeouts.dialFailureRecentMs)
    {
      setStatus(.reconnecting)
      return
    }

    retryNow()
  }

  func offlineGraceElapsed(_ id: UInt64) {
    guard offlineTimer?.id == id else {
      return
    }

    offlineTimer = nil
    teardownSocket()
    scheduleReconnect(GatewayError(.network, "This device reports no network connection."))
  }

  // MARK: - Calls

  /// One JSON-RPC call, typed from the method catalogue. Timeouts follow the
  /// method unless `timeout` is given: a prompt may run for half an hour, the
  /// first session call after a connect rebuilds an agent, everything else
  /// gets 30 seconds. Cancelling the calling task abandons the call.
  public func request<M: RPCMethod>(_ method: M.Type, _ params: M.Params, timeout: Duration? = nil) async throws
    -> M.Result
  {
    let value = try await request(M.name, params: params.jsonValue, timeout: timeout)

    guard let result = M.Result(jsonValue: value) else {
      throw GatewayRPCError(.unexpectedResult, "The gateway answered \(M.name) with a result of another shape.")
    }

    return result
  }

  /// One JSON-RPC call by method name.
  public func request(_ method: String, params: JSONValue = .object([:]), timeout: Duration? = nil) async throws
    -> JSONValue
  {
    let window =
      timeout ?? .milliseconds(GatewayTimeouts.rpcTimeoutMs(method: method, firstSessionCallDone: firstSessionCallDone))

    if Self.isFirstSessionMethod(method) {
      firstSessionCallDone = true
    }

    // An already-cancelled caller is refused before an id is spent, as an
    // aborted signal is.
    try Task.checkCancellation()

    let (id, promise) = try clientCall(method, params: params, timeout: window)

    return try await withTaskCancellationHandler {
      try await promise.value()
    } onCancel: {
      Task { await self.abandonCall(id) }
    }
  }

  static func isFirstSessionMethod(_ method: String) -> Bool {
    JSText.same(method, RPC.SessionResume.name) || JSText.same(method, RPC.SessionCreate.name)
  }

  // MARK: - The dial loop

  /// `void this.runDial()`: the synchronous start of a dial, then the rest in a task.
  ///
  /// The reference runs everything up to the first `await` before `start()` or
  /// a timer callback returns, so the status is `authenticating` by then and a
  /// `stop()` right after is ordered behind it. Splitting the dial here keeps
  /// that ordering.
  func dial() {
    dialToken += 1
    let token = dialToken

    clearRetryTimer()
    lastCloseCode = nil
    timeline.record(AuthEvent(.dialStart))
    setStatus(.authenticating)

    spawn { await self.completeDial(token) }
  }

  /// Deliberately without `online`: a connectivity report is not allowed to
  /// abandon a dial in flight, because the dial is the better evidence.
  private func isAlive(_ token: Int) -> Bool {
    token == dialToken && running && !paused
  }

  private func completeDial(_ token: Int) async {
    let plan: DialPlan

    do {
      plan = try await credentials.dialPlan(wsURL: wsURL, extraHeaders: extraHeaders)
    } catch {
      // Re-check after the suspension: a stop, a pause or a newer dial may have
      // happened while the credential was being minted.
      guard isAlive(token) else {
        return
      }

      handleFailure(error)
      return
    }

    // Re-check after the suspension: as above, the plan may belong to a dial
    // nobody wants any more.
    guard isAlive(token) else {
      return
    }

    // Register the waiter before connecting: `gateway.ready` can land in the
    // same turn the socket opens, and a gateway that refuses the credential
    // closes the socket instead of ever sending it.
    let ready = waitForReady()
    setStatus(.connecting)

    do {
      try await connectSocket(plan)
      try await ready.value()
    } catch {
      // Re-check after the suspension: the socket or the waiter may have been
      // torn down by a stop, a pause or a newer dial rather than by the gateway.
      guard isAlive(token) else {
        return
      }

      handleFailure(error)
      return
    }

    // Re-check after the suspension: `gateway.ready` may have arrived for a
    // dial that has since been replaced.
    guard isAlive(token) else {
      return
    }

    attempt = 0
    consecutiveAuthFailures = 0
    consecutiveTicketRejections = 0
    firstSessionCallDone = false
    lastDialFailureAt = nil
    currentLastReadyAt = clock.date
    timeline.record(AuthEvent(.dialReady))
    setStatus(.ready, .set(nil))
  }

  func waitForReady() -> Promise<Void> {
    rejectReadyWaiter(GatewayError(.network, "A newer dial replaced this one."))

    let promise = Promise<Void>()
    let timer = schedule(after: options.readyTimeout) { connection, id in
      await connection.readyTimedOut(id)
    }

    readyWaiter = ReadyWaiter(promise: promise, timer: timer)
    return promise
  }

  func readyTimedOut(_ id: UInt64) {
    guard let waiter = readyWaiter, waiter.timer.id == id else {
      return
    }

    readyWaiter = nil
    let seconds = JSText.numberString(options.readyTimeout.milliseconds / 1000)
    waiter.promise.reject(
      GatewayError(.timeout, "The gateway accepted the socket but sent no gateway.ready within \(seconds) seconds.")
    )
  }

  func rejectReadyWaiter(_ error: GatewayError) {
    guard let waiter = readyWaiter else {
      return
    }

    readyWaiter = nil
    waiter.timer.timer.cancel()
    waiter.promise.reject(error)
  }

  /// The connection's own `gateway.ready` handler, the first one registered.
  func onGatewayReady(_ event: GatewayEvent) {
    if let epoch = event.payload?["replay_epoch"]?.stringValue, !epoch.isEmpty {
      currentReplayEpoch = epoch
    }

    currentLastReadyAt = clock.date

    if let waiter = readyWaiter {
      readyWaiter = nil
      waiter.timer.timer.cancel()
      waiter.promise.resolve(())
    }
  }

  /// The socket layer moved to `closed` or `error`.
  func onTransportClosed() {
    if !running || paused {
      return
    }

    // A gated gateway accepts the upgrade and then closes with 4401/4403, so
    // the socket opens and no `gateway.ready` ever arrives. Fail the waiting
    // dial straight away instead of sitting out the ready timeout.
    if readyWaiter != nil {
      rejectReadyWaiter(
        GatewayError(.network, "The gateway closed the connection during the handshake.", closeCode: lastCloseCode)
      )
      return
    }

    // A drop mid-dial is already the dial loop's problem; only a live
    // connection losing its socket has to re-enter the loop from here.
    if currentPhase != .ready {
      return
    }

    handleFailure(GatewayError(.network, "The gateway connection dropped.", closeCode: lastCloseCode))
  }

  /// Synchronous up to the one place the reference awaits (`onRejected`),
  /// which `askForFreshCredential` runs in a task.
  func handleFailure(_ raw: any Error) {
    let error = Self.gatewayError(raw, .network, "The gateway connection failed.")
    let closeCode = error.closeCode ?? lastCloseCode
    lastDialFailureAt = clock.now

    if let configError = CloseCodeVerdict.configError(for: closeCode) {
      running = false
      teardown()
      setStatus(.disconnected, .set(configError))
      return
    }

    if error.kind == .tls || error.kind == .config {
      // Retrying a rejected certificate or a refused configuration just fails
      // the same way; stop and explain.
      running = false
      teardown()
      setStatus(.disconnected, .set(error))
      return
    }

    // A 4401 is the gateway refusing the TICKET (no access token is inspected
    // on the upgrade path); an `auth` error means the ticket MINT was refused,
    // which is where an expired bearer token actually shows up.
    if closeCode == 4401 {
      handleTicketRejection(error)
      return
    }

    if error.kind == .auth {
      handleAuthFailure(error)
      return
    }

    scheduleReconnect(error)
  }

  /// A 4401 close: the ticket was expired, already consumed, or unknown, and a
  /// fresh ticket is the answer to all three. A second one in a row makes the
  /// credential the ticket was minted with the suspect.
  func handleTicketRejection(_ error: GatewayError) {
    consecutiveTicketRejections += 1
    timeline.record(AuthEvent(.wsClosed, closeCode: 4401))

    if consecutiveTicketRejections == 1 {
      teardownSocket()

      if !running || paused {
        return
      }

      currentError = error
      dial()
      return
    }

    handleAuthFailure(error)
  }

  func handleAuthFailure(_ error: GatewayError) {
    consecutiveAuthFailures += 1
    teardownSocket()

    if consecutiveAuthFailures > 1 {
      running = false
      teardown()
      timeline.signOut(.rejectedAfterRefresh)
      setStatus(
        .needsSignin,
        .set(
          GatewayError(
            .auth,
            "The gateway rejected the credentials twice in a row. Sign in again.",
            closeCode: error.closeCode
          )
        )
      )
      return
    }

    spawn { await self.askForFreshCredential(after: error) }
  }

  /// The awaiting half of `handleAuthFailure`. Never cancelled: a refresh that
  /// rotated a token has to reach the store whatever the connection does next.
  private func askForFreshCredential(after error: GatewayError) async {
    let verdict: RejectionVerdict

    do {
      verdict = try await credentials.onRejected(rejectedToken: nil)
    } catch {
      scheduleReconnect(Self.gatewayError(error, .network, "Refreshing the credentials failed."))
      return
    }

    // Re-check after the suspension: the app may have stopped or paused the
    // connection while the credential was being refreshed.
    if !running || paused {
      return
    }

    if verdict == .reauth {
      running = false
      teardown()
      // The verdict only says the provider has nothing left to offer; why was
      // recorded by the coordinator a moment ago, and the timeline reads back to it.
      timeline.signOut(.refreshRejected)
      setStatus(.needsSignin, .set(GatewayError(.auth, "Your session has expired. Sign in again.")))
      return
    }

    currentError = error
    dial()
  }

  func scheduleReconnect(_ error: GatewayError) {
    teardownSocket()

    // "Consecutive" has to mean it: an outcome that is not an auth failure
    // breaks the streak, so two auth failures with an outage between them are
    // not "twice in a row".
    consecutiveAuthFailures = 0
    consecutiveTicketRejections = 0

    if !running || paused {
      return
    }

    // An answer that is not a gateway starts part-way up the ladder;
    // everything else climbs from wherever it was.
    let rung = ReconnectBackoff.rung(attempt: attempt, failure: error.kind)
    let delay = backoff(rung)
    attempt = rung + 1
    // The ladder climbs either way; `offline` is only the word for it while
    // the device says there is no network to climb over.
    setStatus(online ? .reconnecting : .offline, .set(error))
    clearRetryTimer()
    retryTimer = schedule(after: delay) { connection, id in
      await connection.retryTimerFired(id)
    }
  }

  func retryTimerFired(_ id: UInt64) {
    guard retryTimer?.id == id else {
      return
    }

    retryTimer = nil
    dial()
  }

  func teardown() {
    dialToken += 1
    clearRetryTimer()
    clearOfflineTimer()
    teardownSocket()
  }

  func teardownSocket() {
    rejectReadyWaiter(GatewayError(.network, "The gateway connection was closed."))
    invalidate(GatewayRPCError.closedMessage)
  }

  func clearRetryTimer() {
    retryTimer?.timer.cancel()
    retryTimer = nil
  }

  func clearOfflineTimer() {
    offlineTimer?.timer.cancel()
    offlineTimer = nil
  }

  enum ErrorUpdate {
    case keep
    case set(GatewayError?)
  }

  /// The error is updated even when the phase does not change, but only a
  /// change of phase is published, exactly as the reference's `setStatus`.
  func setStatus(_ phase: ConnectionPhase, _ error: ErrorUpdate = .keep) {
    if case .set(let error) = error {
      currentError = error
    }

    if currentPhase == phase {
      return
    }

    currentPhase = phase
    statusHub.publish(ConnectionStatus(phase, error: currentError))
  }

  /// `asGatewayError`, without the message of a foreign error: a Swift error's
  /// description is not known to be free of credentials, so the fallback
  /// sentence stands in for it.
  static func gatewayError(_ error: any Error, _ kind: GatewayErrorKind, _ message: String) -> GatewayError {
    (error as? GatewayError) ?? GatewayError(kind, message)
  }

  // MARK: - Tasks and timers

  /// Every task the connection starts is tracked, so a test can see that
  /// nothing outlives `stop()`.
  @discardableResult
  func spawn(_ operation: @escaping @Sendable () async -> Void) -> UInt64 {
    let id = nextTaskID
    nextTaskID += 1
    // The task inherits the actor's isolation; only `operation` runs off it.
    tasks[id] = Task {
      await operation()
      self.taskFinished(id)
    }
    return id
  }

  private func taskFinished(_ id: UInt64) {
    tasks[id] = nil
  }

  /// How many of the connection's tasks are still running.
  var liveTaskCount: Int { tasks.count }

  func schedule(
    after delay: Duration,
    _ fire: @escaping @Sendable (GatewayConnection, UInt64) async -> Void
  ) -> TimerSlot {
    let id = nextTimerID
    nextTimerID += 1
    let timer = clock.schedule(after: delay) { [weak self] in
      guard let self else {
        return
      }

      await fire(self, id)
    }
    return TimerSlot(id: id, timer: timer)
  }
}

/// A scheduled timer and the id its action checks against.
struct TimerSlot {
  let id: UInt64
  let timer: ScheduledTimer
}

struct ReadyWaiter {
  let promise: Promise<Void>
  let timer: TimerSlot
}
