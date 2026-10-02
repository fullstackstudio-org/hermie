import Foundation
import HermieGateway
import HermieProtocol
import HermieStore

/// The bot roster of one gateway: `features/bots/bots-controller.ts` with the
/// state of `store/bots.ts`.
///
/// A bot is a Hermes profile. The roster comes from `profiles.list`, is cached
/// so the list paints on launch, and is re-read on demand, after a reconnect
/// and on every `sessions.changed` sweep. Avatars are fetched once per
/// `name + ui_meta revision`. Running state comes from ONE
/// `session.active_list`, which answers for the whole gateway process, so a
/// busy row is attributed to a bot only through the session ids this app holds
/// for it. Ordering is left to the list.
public actor BotRoster {
  /// What the list draws from the roster, handed to the main actor whole.
  public struct Snapshot: Sendable, Equatable {
    public var bots: [Bot] = []
    /// Name → the avatar's base64 data, as the gateway ships it.
    public var avatars: [String: String] = [:]
    /// Bots the last `session.active_list` could place a busy session on.
    public var running: Set<String> = []
    /// Name → the `last_active` (unix seconds) the reader has already looked at.
    public var lastSeen: [String: Double] = [:]
    public var loading = false
    public var error: String?
    /// False while only the cache is painted.
    public var refreshed = false

    public init() {}

    /// `isUnread`: the chat moved after the reader last looked at it.
    public func isUnread(_ name: String) -> Bool {
        guard let lastActive = bots.first(where: { $0.name == name })?.canonical?.lastActive else {
          return false
        }

        return lastActive > 0 && lastActive > (lastSeen[name] ?? 0)
    }
  }

  /// The three session ids a chat is known under (`ChatSessionIds`).
  public struct SessionIDs: Sendable, Equatable {
    public var stored: String?
    public var resolved: String?
    public var runtime: String?

    public init(stored: String? = nil, resolved: String? = nil, runtime: String? = nil) {
      self.stored = stored
      self.resolved = resolved
      self.runtime = runtime
    }
  }

  /// `BUSY_SESSION_STATUS`: `waiting` is in, because a bot parked on an
  /// approval is working.
  static let busyStatuses: Set<String> = ["starting", "waiting", "working", "streaming", "resuming"]

  let link: any GatewayLink
  let cache: (any ChatCaching)?
  let keyValues: KeyValueStore?
  let namespace: GatewayNamespace
  let clock: any ConnectionClock
  let wallMilliseconds: @Sendable () -> Double
  public let resolver: ChatResolver

  private var snapshot = Snapshot()
  private var avatarsFetched: Set<String> = []
  /// Canonical chats this app switched a bot onto, until the roster catches up (`canonicalPins`).
  private var pins: [String: CanonicalSession] = [:]
  private var refreshInFlight: Task<[Bot], any Error>?
  private var sink: (@MainActor @Sendable (Snapshot) -> Void)?
  private var watchers = 0
  private var pollTimer: ScheduledTimer?
  private var sessionIDs: @Sendable () async -> [String: SessionIDs] = { [:] }
  private var tasks: [UInt64: Task<Void, Never>] = [:]
  private var nextTaskID: UInt64 = 0
  private var isShutDown = false

  public init(
    link: any GatewayLink,
    gatewayID: String,
    cache: (any ChatCaching)? = nil,
    keyValues: KeyValueStore? = nil,
    clock: any ConnectionClock = SystemConnectionClock(),
    wallMilliseconds: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 }
  ) {
    self.link = link
    self.cache = cache
    self.keyValues = keyValues
    self.namespace = GatewayNamespace(gatewayID)
    self.clock = clock
    self.wallMilliseconds = wallMilliseconds
    self.resolver = ChatResolver(link: link)
  }

  // MARK: - Observing

  public var current: Snapshot { snapshot }

  public var bots: [Bot] { snapshot.bots }

  public func bot(named name: String) -> Bot? {
    snapshot.bots.first { $0.name == name }
  }

  /// Where snapshots go: one main-actor call per change.
  public func setSink(_ sink: @escaping @MainActor @Sendable (Snapshot) -> Void) {
    self.sink = sink
    publish()
  }

  /// Where `refreshRunning` reads the session ids of the open chats from.
  public func setSessionIDSource(_ source: @escaping @Sendable () async -> [String: SessionIDs]) {
    sessionIDs = source
  }

  private var publishDirty = false
  private var publisherRunning = false
  private var watermarksDirty = false
  private var writerRunning = false

  /// Hand the latest snapshot to the main actor, in order: one publisher at a
  /// time, and what changed while it was away goes out on its next lap.
  private func publish() {
    guard sink != nil, !isShutDown else {
      return
    }

    publishDirty = true

    guard !publisherRunning else {
      return
    }

    publisherRunning = true
    spawn { await $0.runPublisher() }
  }

  private func runPublisher() async {
    while publishDirty, let sink, !isShutDown {
      publishDirty = false
      let value = snapshot
      await sink(value)
    }

    publisherRunning = false
  }

  // MARK: - Loading

  /// `paintFromCache`: the roster from disk. Safe before the socket is up.
  public func paintFromCache() async {
    guard let cache, snapshot.bots.isEmpty else {
      return
    }

    guard let rows = try? await cache.readBots() else {
      return
    }

    // One unreadable row does not invalidate the rest of the list.
    let bots = rows.compactMap { row in (try? JSONValue(parsing: row.json)).flatMap(Bot.init(jsonValue:)) }

    // Re-check after the suspension: the gateway may have answered meanwhile.
    if !bots.isEmpty, snapshot.bots.isEmpty {
      setBots(bots, fromCache: true)
    }
  }

  /// `refresh`: re-read the roster. Concurrent callers share one round trip.
  @discardableResult
  public func refresh() async throws -> [Bot] {
    if let refreshInFlight {
      return try await refreshInFlight.value
    }

    let task = Task { try await self.load() }
    refreshInFlight = task

    defer {
      refreshInFlight = nil
    }

    return try await task.value
  }

  private func load() async throws -> [Bot] {
    snapshot.loading = true
    publish()

    defer {
      snapshot.loading = false
      publish()
    }

    let rows: [JSONValue]

    do {
      let reply = try await link.requestReply(RPC.ProfilesList.name, params: ["include_sessions": true])
      rows = reply.result["profiles"]?.arrayValue ?? []
    } catch {
      snapshot.error = ChatResolver.describe(error)
      throw error
    }

    // The name is the bot's identity everywhere; a row without one is not a bot.
    let bots = rows.compactMap { $0.objectValue }.map { Bot(row: ProfileRow(json: $0)) }.filter { !$0.name.isEmpty }

    setBots(bots, fromCache: false)

    // What the roster settled on, pins included, not what the wire said.
    let placed = snapshot.bots

    spawn { await $0.persist(placed) }
    spawn { await $0.loadAvatars(placed) }

    return placed
  }

  /// `setBots`, with `canonicalPins`: a pin holds until the roster reports the
  /// id it pinned, so a poll that left before a switch cannot reverse it.
  private func setBots(_ bots: [Bot], fromCache: Bool) {
    var kept: [String: CanonicalSession] = [:]
    var placed: [Bot] = []

    for var bot in bots {
      if let pinned = pins[bot.name], bot.canonical?.id != pinned.id {
        bot.canonical = pinned
        kept[bot.name] = pinned
      }

      placed.append(bot)
    }

    // A pin whose bot this answer does not mention is kept.
    for (name, pinned) in pins where !placed.contains(where: { $0.name == name }) {
      kept[name] = pinned
    }

    pins = kept
    snapshot.bots = placed

    if !fromCache {
      snapshot.refreshed = true
      snapshot.error = nil
    }

    publish()
  }

  /// `setCanonical`: point a bot at another canonical chat and pin it there.
  public func setCanonical(_ name: String, _ canonical: CanonicalSession) {
    guard let index = snapshot.bots.firstIndex(where: { $0.name == name }) else {
      return
    }

    snapshot.bots[index].canonical = canonical
    pins[name] = canonical
    publish()
  }

  private func persist(_ bots: [Bot]) async {
    guard let cache else {
      return
    }

    let updatedAt = Int64(wallMilliseconds())
    let rows = bots.compactMap { bot -> CachedBot? in
      guard let json = try? bot.jsonValue.canonicalString() else {
        return nil
      }

      return CachedBot(name: bot.name, json: json, avatarRevision: Int64(bot.uiMetaRevision), updatedAt: updatedAt)
    }

    // The roster is a convenience on disk; losing it costs one round trip.
    try? await cache.writeBots(rows)
  }

  /// `loadAvatars`: once per `name + revision`; a failed fetch is not recorded,
  /// so the next refresh tries again.
  public func loadAvatars(_ bots: [Bot]) async {
    let pending = bots.filter { $0.hasAvatar && !avatarsFetched.contains("\($0.name):\($0.uiMetaRevision)") }

    for bot in pending {
      guard
        let reply = try? await link.requestReply(
          RPC.ProfilesGetAsset.name,
          params: ["name": .string(bot.name), "asset": "avatar"]
        )
      else {
        continue
      }

      avatarsFetched.insert("\(bot.name):\(bot.uiMetaRevision)")

      if reply.result["found"] == .bool(true), let data = reply.result["data"]?.stringValue {
        snapshot.avatars[bot.name] = data
      } else {
        snapshot.avatars[bot.name] = nil
      }

      publish()
    }
  }

  // MARK: - Canonical chats

  /// `resolveCanonical`, through the resolver (ADR-0007).
  public func resolveCanonical(_ bot: Bot) async throws -> CanonicalSession {
    try await resolver.resolveCanonical(snapshot.bots.first { $0.name == bot.name } ?? bot)
  }

  // MARK: - Running

  /// `refreshRunning`: every bot's running state in ONE `session.active_list`.
  /// A failed call reads as nothing running: a spinner that will not go away is
  /// worse than a missing one.
  public func refreshRunning() async {
    guard !snapshot.bots.isEmpty else {
      setRunning([])
      return
    }

    let ids = await sessionIDs()
    let rows: [JSONValue]

    do {
      rows = try await link.requestReply(RPC.SessionActiveList.name, params: [:]).result["sessions"]?.arrayValue ?? []
    } catch {
      setRunning([])
      return
    }

    setRunning(Self.runningBots(in: rows, owners: Self.sessionOwners(snapshot.bots, ids)))
  }

  private func setRunning(_ names: Set<String>) {
    guard snapshot.running != names else {
      return
    }

    snapshot.running = names
    publish()
  }

  /// `watchRunning`: poll while somebody watches; reference counted. Answers a
  /// token to hand to `unwatchRunning`.
  public func watchRunning() {
    watchers += 1

    if watchers == 1 {
      spawn { await $0.refreshRunning() }
      schedulePoll()
    }
  }

  public func unwatchRunning() {
    guard watchers > 0 else {
      return
    }

    watchers -= 1

    if watchers == 0 {
      pollTimer?.cancel()
      pollTimer = nil
    }
  }

  private func schedulePoll() {
    pollTimer = clock.schedule(after: ChatRuntimeLimits.activeListPoll) { [weak self] in
      await self?.pollFired()
    }
  }

  private func pollFired() async {
    guard pollTimer != nil, watchers > 0 else {
      return
    }

    schedulePoll()
    await refreshRunning()
  }

  /// `sessionOwnerIndex`: every session id that can be attributed to a bot. The
  /// first claim on an id wins.
  static func sessionOwners(_ bots: [Bot], _ chats: [String: SessionIDs]) -> [String: String] {
    var owners: [String: String] = [:]

    func claim(_ id: String?, _ name: String) {
      if let id, !id.isEmpty, owners[id] == nil {
        owners[id] = name
      }
    }

    for bot in bots {
      let chat = chats[bot.name]
      claim(bot.canonical?.id, bot.name)
      claim(bot.canonical?.resolvedID, bot.name)
      claim(chat?.stored, bot.name)
      claim(chat?.resolved, bot.name)
      claim(chat?.runtime, bot.name)
    }

    return owners
  }

  /// `runningBotsIn`: the bots that own a busy row. A busy session no bot owns
  /// lights up nobody.
  static func runningBots(in rows: [JSONValue], owners: [String: String]) -> Set<String> {
    var running: Set<String> = []

    for row in rows where busyStatuses.contains(Self.text(row["status"])) {
      if let owner = owners[Self.text(row["id"])] ?? owners[Self.text(row["session_key"])] {
        running.insert(owner)
      }
    }

    return running
  }

  /// `String(value ?? '')` for the fields a row carries.
  private static func text(_ value: JSONValue?) -> String {
    switch value {
    case .string(let text)?: text
    case .number(let number)?: number.rounded() == number ? String(Int(number)) : String(number)
    default: ""
    }
  }

  // MARK: - Read watermarks

  /// Read this gateway's watermarks back from the key-value store.
  public func loadWatermarks() async {
    guard let keyValues, let stored = try? await keyValues.string(forKey: namespace.key(StoreKeys.botsLastSeen)),
      let object = (try? JSONValue(parsing: stored))?.objectValue
    else {
      return
    }

    for (name, value) in object {
      if case .number(let seconds) = value, seconds.isFinite {
        snapshot.lastSeen[name] = max(snapshot.lastSeen[name] ?? 0, seconds)
      }
    }

    publish()
  }

  /// `markSeen`: move a bot's watermark forward to `seconds`, or to the roster's
  /// own `last_active` for it, or to now. Never backwards.
  @discardableResult
  public func markSeen(_ name: String, at seconds: Double? = nil) -> Double {
    let at =
      seconds ?? bot(named: name)?.canonical?.lastActive.nonZero ?? (wallMilliseconds() / 1000).rounded(.down)
    let current = snapshot.lastSeen[name] ?? 0

    guard at > current else {
      return current
    }

    snapshot.lastSeen[name] = at
    publish()

    if keyValues != nil {
      watermarksDirty = true

      if !writerRunning {
        writerRunning = true
        spawn { await $0.runWatermarkWriter() }
      }
    }

    return at
  }

  /// One writer, so a later map is never overtaken by an earlier one.
  private func runWatermarkWriter() async {
    let key = namespace.key(StoreKeys.botsLastSeen)

    while watermarksDirty, let keyValues {
      watermarksDirty = false
      let object = JSONObject(uniqueKeysWithValues: snapshot.lastSeen.map { ($0.key, JSONValue.number($0.value)) })

      if let text = try? JSONValue.object(object).canonicalString() {
        // A lost watermark shows one chat as unread again; not worth an error.
        try? await keyValues.setString(text, forKey: key)
      }
    }

    writerRunning = false
  }

  // MARK: - Tasks

  @discardableResult
  private func spawn(_ operation: @escaping @Sendable (isolated BotRoster) async -> Void) -> UInt64 {
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

  public var liveTaskCount: Int { tasks.count }

  /// `dispose`: stop every timer and wait for every task.
  public func shutdown() async {
    isShutDown = true
    pollTimer?.cancel()
    pollTimer = nil
    watchers = 0
    refreshInFlight?.cancel()

    let running = Array(tasks.values)

    for task in running {
      task.cancel()
    }

    for task in running {
      await task.value
    }

    tasks.removeAll()
  }
}

extension Double {
  fileprivate var nonZero: Double? { self > 0 ? self : nil }
}
