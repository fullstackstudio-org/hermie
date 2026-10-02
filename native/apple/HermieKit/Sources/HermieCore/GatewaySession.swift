import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript
import Observation

/// Connectivity reports, for `GatewayConnection.setOnline`. The app wires
/// `NWPathMonitor` (or nothing); a test hands in a stream it drives.
public protocol Reachability: Sendable {
  /// Every report, starting with the current one: `true` when the device says
  /// it has a network. Advice about timing, never permission to dial.
  var updates: AsyncStream<Bool> { get }
}

/// One gateway, alive: its connection, its roster, its chats and the models a
/// view reads. One per registry entry, keyed by the gateway id (ADR-0024); the
/// app keeps one live at a time and shuts the previous one down.
///
/// # Why a main-actor facade over two actors
///
/// The work (reducing events, resolving chats, the network) happens in
/// `TranscriptStore` and `BotRoster`, actors off the main thread (D10). What a
/// view reads — the connection status, the chat list, one chat — has to live
/// on the main actor to be `@Observable` by SwiftUI without hops, and has to
/// change in one place per frame. So the session is `@MainActor`: it owns the
/// actors, receives their frames (one hop per frame from the store, one per
/// roster change), fans them out to the models, and forwards the reader's
/// actions back. Making the session itself an actor would put every property a
/// view reads one `await` away.
///
/// Only this type touches `GatewayConnection`, through `ConnectionLink`;
/// everything else sees `GatewayLink`.
@MainActor
@Observable
public final class GatewaySession {
  public struct Options: Sendable {
    public var store = TranscriptStore.Options()
    public var connection = GatewayConnection.Options()
    /// The visibility a chat screen starts at until the reader's settings arrive.
    public var defaultVisibility = VisibilityOptions(level: .normal, showBotToBot: true, showThinking: true)
    public var secureInput = SecureInputCenter.Options()

    public init() {}
  }

  public let gatewayID: String
  /// The connection's status, or `incompatible` when a resume refused the gateway.
  public private(set) var status = ConnectionStatus(.disconnected)
  /// Set when a resume reported a desktop contract below the floor (`DesktopContract`).
  public private(set) var incompatibility: GatewayError?
  public let chatList = ChatListModel()
  /// The one-string prompts (`secret`, `sudo`, `vault.*`): a consumer of the
  /// server requests of its own, so a typed secret never reaches the store.
  @ObservationIgnored public let secureInput: SecureInputCenter
  /// The gateway's out-of-band notices (`notification.show` / `.clear`).
  public let notices: GatewayNoticesModel
  /// The connector authorisation cards the chats' agents are waiting on.
  public let connectionRequests: ConnectionRequestsModel
  /// Who the gateway says this client is. Read after every connect and on
  /// `refreshIdentity()`; see `GatewayIdentityState`.
  public internal(set) var identityState = GatewayIdentityState.unknownYet
  /// Why the last identity read failed, while an identity is still held from
  /// before (or `nil`). For the developer detail.
  public internal(set) var identityFailure: String?
  /// `gateway.capabilities`, read after every connect; `nil` until it answers,
  /// and on a gateway that does not have the method.
  public internal(set) var capabilities: GatewayCapabilitiesResult?
  /// Told once per finished `/background` task, with the chat it ran in. The
  /// transcript shows the result as well; this is the seam for a local
  /// notification.
  @ObservationIgnored public var onBackgroundTaskFinished: (@MainActor (BackgroundTaskFinished) -> Void)?

  @ObservationIgnored public let store: TranscriptStore
  @ObservationIgnored public let roster: BotRoster
  @ObservationIgnored let link: any GatewayLink
  @ObservationIgnored let reachability: (any Reachability)?
  @ObservationIgnored let defaultVisibility: VisibilityOptions
  @ObservationIgnored var models: [String: ChatModel] = [:]
  @ObservationIgnored private var tasks: [Task<Void, Never>] = []
  @ObservationIgnored private var started = false
  @ObservationIgnored var isShutDown = false
  @ObservationIgnored private var connectionStatus = ConnectionStatus(.disconnected)
  /// The roster read started by the last transition to `ready`.
  @ObservationIgnored private var readyRefresh: Task<Void, Never>?
  /// The number of the last contract check heard (`contractChecked`).
  @ObservationIgnored private var lastContractCheck: UInt64 = 0
  /// What the views ask of the store (observe, stop, which bots remain),
  /// forwarded by one task so it arrives in order.
  @ObservationIgnored private let commands: AsyncStream<StoreCommand>
  @ObservationIgnored private let commandSink: AsyncStream<StoreCommand>.Continuation
  /// The reads of who this is and what the gateway can do, started by the last
  /// transition to `ready` (apart from the roster's, so neither waits on the other).
  @ObservationIgnored private var factsRefresh: Task<Void, Never>?
  /// The own author the store stamps a turn with, kept by `adopt(_:)`.
  @ObservationIgnored let ownAuthorCell: OwnAuthorCell
  @ObservationIgnored let keyValues: KeyValueStore?
  /// Numbers the identity reads, so a late answer never replaces a newer one.
  @ObservationIgnored var identityReads: UInt64 = 0
  /// The latest `session.resume_progress` per chat, for a model made later.
  @ObservationIgnored var resumeProgress: [String: ResumeProgress] = [:]
  /// Background tasks already reported, oldest first, bounded.
  @ObservationIgnored var reportedBackgroundTasks: [String] = []

  private enum StoreCommand: Sendable {
    case observe(String, VisibilityOptions)
    case stopObserving(String)
    case retain(Set<String>)
  }

  /// A session over a real connection to one registry entry.
  ///
  /// The credential provider is built by the caller from the secret store
  /// (`GatewayCredentials.provider` with the session token or the token
  /// coordinator); signing in is another screen's business. The chat cache
  /// and the read watermarks are built here from `database`, scoped to the
  /// record's id (ADR-0024), so one gateway can never read another's chats.
  public convenience init(
    record: GatewayRecord,
    credentials: any CredentialProvider,
    extraHeaders: [String: String]? = nil,
    transport: any WebSocketTransport = URLSessionTransport(),
    database: SQLiteStore? = nil,
    reachability: (any Reachability)? = nil,
    options: Options = Options()
  ) throws {
    let cache = database.map { SQLiteChatCache(store: $0, gatewayId: record.id) }
    let keyValues = database.map { KeyValueStore(store: $0) }
    let link = try ConnectionLink(
      baseURL: record.address,
      extraHeaders: extraHeaders,
      credentials: credentials,
      transport: transport,
      clock: options.store.clock,
      options: options.connection
    )

    self.init(
      gatewayID: record.id,
      name: record.name,
      link: link,
      cache: cache,
      keyValues: keyValues,
      reachability: reachability,
      options: options
    )
  }

  /// A session over any link: production goes through the other initialiser,
  /// a test hands in a scripted one.
  public init(
    gatewayID: String,
    name: String? = nil,
    link: any GatewayLink,
    cache: (any ChatCaching)? = nil,
    keyValues: KeyValueStore? = nil,
    reachability: (any Reachability)? = nil,
    options: Options = Options()
  ) {
    self.gatewayID = gatewayID
    self.link = link
    self.reachability = reachability
    self.keyValues = keyValues
    self.defaultVisibility = options.defaultVisibility
    self.roster = BotRoster(
      link: link,
      gatewayID: gatewayID,
      cache: cache,
      keyValues: keyValues,
      clock: options.store.clock
    )

    // The identity the gateway confirms comes first; the caller's own answer
    // (a test's, or nobody's) only while there is none.
    let cell = OwnAuthorCell()
    var storeOptions = options.store
    let fallback = storeOptions.ownAuthor
    storeOptions.ownAuthor = { cell.get() ?? fallback() }
    self.ownAuthorCell = cell
    self.store = TranscriptStore(link: link, roster: roster, cache: cache, options: storeOptions)
    self.notices = GatewayNoticesModel(clock: options.store.clock)
    self.connectionRequests = ConnectionRequestsModel(clock: options.store.clock) { method, params in
      try await link.requestReply(method, params: params)
    }
    self.secureInput = SecureInputCenter(
      link: link,
      store: store,
      clock: options.store.clock,
      gatewayName: name ?? gatewayID,
      options: options.secureInput
    )
    (commands, commandSink) = AsyncStream.makeStream()
  }

  // MARK: - Lifecycle

  /// Paint from disk, subscribe, then dial. The streams are subscribed BEFORE
  /// the connection starts, so the requests a first resume re-delivers reach
  /// the store. A cold start shows the cached roster before the socket is up.
  public func start() async {
    guard !started, !isShutDown else {
      return
    }

    started = true

    let store = self.store
    let roster = self.roster

    await store.setSink { [weak self] batch in self?.receive(batch) }
    await roster.setSink { [weak self] snapshot in self?.receive(snapshot) }
    // Weak: the roster outlives nothing, but a strong store here would be a
    // cycle (store → roster → this closure → store) that leaks every gateway.
    await roster.setSessionIDSource { [weak store] in await store?.sessionIDs() ?? [:] }
    await store.setContractSink { [weak self] number, error in self?.contractChecked(number, error) }
    await store.attach()
    secureInput.attach()

    let commands = self.commands
    tasks.append(
      Task { [weak store] in
        for await command in commands {
          switch command {
          case .observe(let key, let visibility): await store?.observe(key, options: visibility)
          case .stopObserving(let key): await store?.stopObserving(key)
          case .retain(let names): await store?.retain(only: names)
          }
        }
      }
    )

    let signals = store.signals
    tasks.append(
      Task { [weak self] in
        for await signal in signals {
          self?.receive(signal)
        }
      }
    )

    let statuses = link.statuses
    tasks.append(
      Task { [weak self, weak store] in
        for await status in statuses {
          await store?.connectionChanged(status)
          self?.connectionChanged(status)
        }
      }
    )

    if let reachability {
      let link = self.link
      let updates = reachability.updates
      tasks.append(
        Task {
          for await online in updates {
            await link.setOnline(online)
          }
        }
      )
    }

    await roster.loadWatermarks()
    // Unread counts start where the reader left each chat, not at the beginning.
    await store.seedSeen(await roster.current.lastSeen)
    await roster.paintFromCache()
    await store.restoreFromCache(await roster.bots)
    await loadRememberedIdentity()
    await link.start()
  }

  /// The app went to the background: write every live chat, stop the polls,
  /// close the socket cleanly.
  public func enterBackground() async {
    guard started, !isShutDown else {
      return
    }

    await store.enterBackground()
    await link.pause()
  }

  /// Back in front: dial straight away; the `ready` that follows re-resumes every
  /// live chat (the ladder goes back through recovery), and open approvals are
  /// re-read.
  public func enterForeground() async {
    guard started, !isShutDown else {
      return
    }

    await link.resume()
    await store.enterForeground()
  }

  /// "Try now".
  public func retryNow() async {
    await link.retryNow()
  }

  /// Tear everything down: the connection and its streams, the store, the
  /// roster, every task this session started. Nothing outlives it.
  public func shutdown() async {
    guard !isShutDown else {
      return
    }

    isShutDown = true
    commandSink.finish()

    // Every prompt still open is answered `''` while the socket is still there.
    await secureInput.shutdown()
    await store.persistAll()
    await link.shutdown()

    let running = tasks + [readyRefresh, factsRefresh].compactMap { $0 }

    for task in running {
      task.cancel()
    }

    for task in running {
      await task.value
    }

    tasks.removeAll()
    readyRefresh = nil
    factsRefresh = nil
    notices.removeAll()
    connectionRequests.removeAll()
    await store.shutdown()
    await roster.shutdown()
  }

  /// Whether every task this session, its store and its roster started is gone.
  public func hasNoLiveTasks() async -> Bool {
    let storeTasks = await store.liveTaskCount
    let storeAttached = await store.isAttached
    let rosterTasks = await roster.liveTaskCount

    return tasks.isEmpty && readyRefresh == nil && factsRefresh == nil && storeTasks == 0 && !storeAttached
      && rosterTasks == 0
  }

  // MARK: - Chats

  /// The model one chat screen reads. One per bot, kept for the session's life.
  public func chat(_ name: String) -> ChatModel {
    if let model = models[name] {
      return model
    }

    let sink = commandSink
    let model = ChatModel(key: name, store: store, visibility: defaultVisibility) { key, visibility in
      sink.yield(.observe(key, visibility))
    }
    model.connectionReady = connectionStatus.phase == .ready
    model.resumeProgress = resumeProgress[name]
    models[name] = model
    sink.yield(.observe(name, model.visibility))

    return model
  }

  /// The screen is gone for good: the chat stays live, but its transcript is no
  /// longer projected every frame. `chat(_:)` makes a fresh model.
  public func release(_ name: String) {
    guard models.removeValue(forKey: name) != nil else {
      return
    }

    commandSink.yield(.stopObserving(name))
  }

  /// Open a bot's chat (ADR-0007 resolution, resume, history, replay) and mark
  /// it read. A gateway below the contract floor is reported as `incompatible`.
  public func open(_ name: String) async throws {
    guard let bot = await roster.bot(named: name) else {
      throw ChatRuntimeError(message: "\(name) is not on this gateway.")
    }

    do {
      try await store.open(bot)
    } catch let error as GatewayError where error.kind == .incompatible {
      incompatibility = error
      status = ConnectionStatus(.incompatible, error: error)
      throw error
    }

    await markRead(name)
  }

  /// The reader left the chat screen: it stays live, its watermark moves and
  /// its cache is written.
  public func close(_ name: String) async {
    await markRead(name)
    await store.persistAll()
  }

  /// The reader has seen the chat up to now: its watermark moves and its unread count clears.
  /// The chat screen calls it while the newest row is on screen and the window is in front.
  public func markRead(_ name: String) async {
    let seconds = await roster.markSeen(name, at: (Date().timeIntervalSince1970).rounded(.down))
    await store.markSeen(name, at: seconds)
  }

  /// Start (and stop) polling running state while the list is on screen.
  public func watchRunning() async {
    await roster.watchRunning()
  }

  public func unwatchRunning() async {
    await roster.unwatchRunning()
  }

  // MARK: - Receiving

  /// How long each frame held the main actor, wall and this thread's CPU time
  /// (for the performance test: a frame must never block the main actor for 8 ms).
  @ObservationIgnored var frameTimings: ((FrameTiming) -> Void)?

  private func receive(_ batch: FrameBatch) {
    let wallStart = ContinuousClock.now
    let cpuStart = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)

    chatList.apply(batch.summaries, removed: batch.removed)

    for (key, snapshot) in batch.chats {
      models[key]?.apply(snapshot)
    }

    secureInput.storeChanged()

    if let frameTimings {
      let cpu = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - cpuStart
      frameTimings(FrameTiming(wall: ContinuousClock.now - wallStart, cpu: .nanoseconds(Int64(cpu))))
    }
  }

  private func receive(_ snapshot: BotRoster.Snapshot) {
    chatList.apply(snapshot)

    // A bot the gateway no longer lists takes its chat with it: its transcript,
    // its routes, its model. Only an answer from the gateway says so, never the cache.
    guard snapshot.refreshed, !snapshot.loading else {
      return
    }

    let names = Set(snapshot.bots.map(\.name))
    secureInput.storeChanged()

    for name in models.keys where !names.contains(name) {
      release(name)
    }

    commandSink.yield(.retain(names))
  }

  /// The outcome of one resume's desktop contract check, in the order the
  /// checks ran. Only a resume clears an incompatibility: a chat that was
  /// already live, and so opened without one, proves nothing.
  private func contractChecked(_ number: UInt64, _ error: GatewayError?) {
    guard number > lastContractCheck else {
      return
    }

    lastContractCheck = number

    if let error {
      incompatibility = error
      status = ConnectionStatus(.incompatible, error: error)
    } else if incompatibility != nil {
      incompatibility = nil
      status = connectionStatus
    }
  }

  private func connectionChanged(_ status: ConnectionStatus) {
    let wasReady = connectionStatus.phase == .ready
    connectionStatus = status

    // `ChatRuntime`: read the roster when the connection becomes usable, and
    // again after every reconnect. A call on a socket still dialling fails with
    // "gateway not connected", and nothing would ask again.
    if status.phase == .ready, !wasReady, !isShutDown {
      let roster = self.roster
      let previous = readyRefresh
      readyRefresh = Task {
        await previous?.value
        _ = try? await roster.refresh()
      }

      // Who this is and what the gateway can do, after every connect: a
      // reconnect can be another gateway process, and a sign-in another person.
      let facts = factsRefresh
      factsRefresh = Task { [weak self] in
        await facts?.value

        guard let self else {
          return
        }

        // Neither waits on the other: an old gateway may never answer the capabilities.
        async let capabilities: Void = self.readCapabilities()
        await self.refreshIdentity()
        await capabilities
      }
    }

    for model in models.values {
      model.connectionReady = status.phase == .ready
    }

    // An incompatible gateway stays reported as such until a resume succeeds.
    if incompatibility == nil, self.status != status {
      self.status = status
    }
  }
}

/// One frame's hold on the main actor.
struct FrameTiming: Sendable {
  var wall: Duration
  var cpu: Duration
}

extension TranscriptStore {
  /// The session ids each open chat is known under, for the roster's attribution.
  func sessionIDs() -> [String: BotRoster.SessionIDs] {
    chats.mapValues { record in
      BotRoster.SessionIDs(
        stored: record.state.storedSessionID,
        resolved: record.state.resolvedSessionID,
        runtime: record.state.runtimeSessionID
      )
    }
  }
}

/// `chatGatewayFor`: the real connection and the REST client behind `GatewayLink`.
public struct ConnectionLink: GatewayLink {
  public let connection: GatewayConnection
  public let http: HTTPClient
  let credentials: any CredentialProvider
  let extraHeaders: [String: String]
  let clock: any ConnectionClock

  public init(
    baseURL: String,
    extraHeaders: [String: String]? = nil,
    credentials: any CredentialProvider,
    transport: any WebSocketTransport,
    clock: any ConnectionClock = SystemConnectionClock(),
    options: GatewayConnection.Options = GatewayConnection.Options()
  ) throws {
    connection = try GatewayConnection(
      baseURL: baseURL,
      extraHeaders: extraHeaders,
      credentials: credentials,
      transport: transport,
      clock: clock,
      options: options
    )
    http = try HTTPClient(baseURL: baseURL, credentials: credentials, extraHeaders: extraHeaders ?? [:])
    self.credentials = credentials
    self.extraHeaders = extraHeaders ?? [:]
    self.clock = clock
  }

  public var events: AsyncStream<WireEvent> { connection.events }

  public var serverRequests: any AsyncSequence<InboundRequest, Never> & Sendable {
    // Mapped in place, with no task in between: the store's consumer is resumed
    // straight from the connection's yield, which the ordering rests on.
    connection.serverRequests.map { @Sendable delivery in InboundRequest(delivery) }
  }

  public var statuses: AsyncStream<ConnectionStatus> { connection.statuses }

  public func requestReply(_ method: String, params: JSONValue) async throws -> RPCReply<JSONValue> {
    try await connection.requestReply(method, params: params)
  }

  public func fetchMessages(_ resolvedSessionID: String, _ window: MessageWindow) async -> [TranscriptRow]? {
    let path = RESTPath.sessionMessages(resolvedSessionID) + "?" + window.query

    do {
      let body = try await http.get(path)
      let rows = body?["messages"]?.arrayValue ?? body?["rows"]?.arrayValue ?? []
      return rows.compactMap { $0.objectValue.map(TranscriptRow.init(json:)) }
    } catch {
      // A gateway without the REST transcript is a supported gateway; the
      // caller falls back to `session.history`.
      return nil
    }
  }

  public func seqWatermarks() async -> [String: Double] { await connection.seqWatermarks }

  public var replayGaps: AsyncStream<ReplayGap> { connection.replayGaps }

  /// Through this link's HTTP client, the one place its credentials are loaded (`IdentityProbe.read`).
  public func probeIdentity() async -> IdentityProbe {
    await IdentityProbe.read(http)
  }

  public func claimTurn(_ runtimeSessionID: String) async {
    let baseURL = http.baseURL
    let credentials = self.credentials
    let extraHeaders = self.extraHeaders
    let limit = ChatRuntimeLimits.turnClaimTimeoutMs

    // A courtesy, never a dependency: the whole claim, the auth headers
    // included, gets `limit`, and whatever it answers is ignored. It goes out
    // without `HTTPClient`'s 401 retry on purpose: a refused claim is never a
    // reason to ask the credential provider for a new token, let alone to
    // push the session towards signing in again.
    await Self.bounded(.milliseconds(limit), clock: clock) {
      guard let url = try? GatewayAddress.apiURL(baseURL, path: RESTPath.pluginContextTurn),
        let auth = try? await credentials.httpAuthHeaders(AuthHeaderOptions())
      else {
        return
      }

      let request = JSONRequest(
        method: "POST",
        headers: extraHeaders.merging(auth) { _, auth in auth },
        body: ["session_id": .string(runtimeSessionID)],
        timeoutMs: limit
      )
      _ = try? await HTTPTransport().requestText(url, request)
    }
  }

  /// Run `operation`, and return once it finishes or `limit` has passed on
  /// `clock`, whichever comes first; a late operation is cancelled.
  static func bounded(
    _ limit: Duration,
    clock: any ConnectionClock,
    _ operation: @escaping @Sendable () async -> Void
  ) async {
    let (done, finish) = AsyncStream<Void>.makeStream()
    let work = Task {
      await operation()
      finish.yield()
    }
    let timer = clock.schedule(after: limit) {
      finish.yield()
    }

    for await _ in done {
      break
    }

    work.cancel()
    timer.cancel()
    finish.finish()
  }

  public func start() async { await connection.start() }
  public func stop() async { await connection.stop() }
  public func pause() async { await connection.pause() }
  public func resume() async { await connection.resume() }
  public func retryNow() async { await connection.retryNow() }
  public func setOnline(_ online: Bool) async { await connection.setOnline(online) }
  public func shutdown() async { await connection.shutdown() }
}
