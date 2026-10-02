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

    public init() {}
  }

  public let gatewayID: String
  /// The connection's status, or `incompatible` when a resume refused the gateway.
  public private(set) var status = ConnectionStatus(.disconnected)
  /// Set when a resume reported a desktop contract below the floor (`DesktopContract`).
  public private(set) var incompatibility: GatewayError?
  public let chatList = ChatListModel()

  @ObservationIgnored public let store: TranscriptStore
  @ObservationIgnored public let roster: BotRoster
  @ObservationIgnored let link: any GatewayLink
  @ObservationIgnored let reachability: (any Reachability)?
  @ObservationIgnored let defaultVisibility: VisibilityOptions
  @ObservationIgnored private var models: [String: ChatModel] = [:]
  @ObservationIgnored private var tasks: [Task<Void, Never>] = []
  @ObservationIgnored private var started = false
  @ObservationIgnored private var isShutDown = false
  @ObservationIgnored private var connectionStatus = ConnectionStatus(.disconnected)
  /// The roster read started by the last transition to `ready`.
  @ObservationIgnored private var readyRefresh: Task<Void, Never>?
  /// What the views ask of the store (observe, stop, which bots remain),
  /// forwarded by one task so it arrives in order.
  @ObservationIgnored private let commands: AsyncStream<StoreCommand>
  @ObservationIgnored private let commandSink: AsyncStream<StoreCommand>.Continuation

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
    link: any GatewayLink,
    cache: (any ChatCaching)? = nil,
    keyValues: KeyValueStore? = nil,
    reachability: (any Reachability)? = nil,
    options: Options = Options()
  ) {
    self.gatewayID = gatewayID
    self.link = link
    self.reachability = reachability
    self.defaultVisibility = options.defaultVisibility
    self.roster = BotRoster(
      link: link,
      gatewayID: gatewayID,
      cache: cache,
      keyValues: keyValues,
      clock: options.store.clock
    )
    self.store = TranscriptStore(link: link, roster: roster, cache: cache, options: options.store)
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
    await store.attach()

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

    await store.persistAll()
    await link.shutdown()

    let running = tasks + [readyRefresh].compactMap { $0 }

    for task in running {
      task.cancel()
    }

    for task in running {
      await task.value
    }

    tasks.removeAll()
    readyRefresh = nil
    await store.shutdown()
    await roster.shutdown()
  }

  /// Whether every task this session, its store and its roster started is gone.
  public func hasNoLiveTasks() async -> Bool {
    let storeTasks = await store.liveTaskCount
    let storeAttached = await store.isAttached
    let rosterTasks = await roster.liveTaskCount

    return tasks.isEmpty && readyRefresh == nil && storeTasks == 0 && !storeAttached && rosterTasks == 0
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

    // A resume this gateway passed: whatever refused it before is history.
    if incompatibility != nil {
      incompatibility = nil
      status = connectionStatus
    }

    await markRead(name)
  }

  /// The reader left the chat screen: it stays live, its watermark moves and
  /// its cache is written.
  public func close(_ name: String) async {
    await markRead(name)
    await store.persistAll()
  }

  private func markRead(_ name: String) async {
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

    for name in models.keys where !names.contains(name) {
      release(name)
    }

    commandSink.yield(.retain(names))
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

  public func claimTurn(_ runtimeSessionID: String) async {
    // A courtesy, never a dependency: whatever goes wrong, the turn goes out.
    _ = try? await http.post(
      RESTPath.pluginContextTurn,
      body: ["session_id": .string(runtimeSessionID)],
      timeoutMs: ChatRuntimeLimits.turnClaimTimeoutMs
    )
  }

  public func start() async { await connection.start() }
  public func stop() async { await connection.stop() }
  public func pause() async { await connection.pause() }
  public func resume() async { await connection.resume() }
  public func retryNow() async { await connection.retryNow() }
  public func setOnline(_ online: Bool) async { await connection.setOnline(online) }
  public func shutdown() async { await connection.shutdown() }
}
