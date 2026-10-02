import Foundation
import HermieProtocol
import Synchronization

/// A gateway's copy, taken in: the device's sections after it, and what arrived.
public struct UIMetaChange: Sendable, Hashable {
  public var documents: UIMetaDocuments
  public var snapshot: UIMetaSnapshot
}

/// ADR-0016's client: this device's settings in the gateway's `ui_meta`, per-key
/// compare-and-swap, last writer wins per section (`UiMetaSync` in
/// `packages/gateway-client/src/ui-meta.ts`, plus the part of
/// `expo/hermie/src/store/ui-meta-bridge.ts` that is not about one store).
///
/// One per gateway. It owns the device's copy of the sections
/// (`UIMetaDocuments`), which is what the app reads, so the app paints before the
/// socket has answered and works with no gateway at all. Edits go through
/// `updateApp` / `updateBot` / `setPushRow`, which mark the section, date a
/// choice and schedule the debounced send; a gateway's copy comes in through
/// `reconcile` and is handed to every `UIMetaContributor` and every `changes()`
/// stream.
///
/// The bookkeeping (`UIMetaState`) and the local copy sit behind ONE lock, and
/// every step the reference takes between two `await`s is one transaction under
/// it. So an edit and its dirty mark are one step, and a reconcile can never read
/// a change without also seeing it marked. The edit closures run under that lock
/// and must not call back into the sync.
///
/// Departures from the reference, each closing a hole it has: a write only
/// cleans what it carried (an edit made while it was out stays dirty, and the
/// run goes round again); a sign-out or a change of person fences off what is
/// still in flight; the app section belongs to one person and is dropped, not
/// published, when another one signs in.
public final class UIMetaSync: Sendable {
  public struct Options: Sendable {
    /// How often a conflicted section is re-sent before it is left dirty. One is
    /// the whole design: the conflict answer carries the revision that won, so the
    /// second attempt cannot fail for the same reason. A third writer landing in
    /// between leaves the section for the next reconcile rather than spinning.
    public var retries = 1
    /// How long edits have to stop before they go out (`UI_META_DEBOUNCE_MS`): a
    /// drag across a long list is many edits, and what goes out is where the
    /// reader stopped. `nil` sends only on `flush()` and `reconcile()`.
    public var debounce: Duration? = .milliseconds(600)
    /// Wall-clock seconds, for dating a choice.
    public var now: @Sendable () -> Double = { Date().timeIntervalSince1970 }
    /// The gateway this sync is for. A stored copy tagged with another one is
    /// not loaded.
    public var gatewayID: String?

    public init() {}
  }

  /// Held weakly: a contributor usually holds the sync, and whoever built it owns it.
  private struct Contributor: Sendable {
    weak var value: (any UIMetaContributor)?
  }

  private struct Core: Sendable {
    var state = UIMetaState()
    var documents: UIMetaDocuments
    /// Whose app section `documents.app` is; `nil` until somebody is named.
    var owner: String?
    /// This device's own push rows, folded into every copy taken in.
    var pushRows: [String: JSONObject?] = [:]
    /// This device's own `seen` entries, likewise.
    var pushSeen: [String: JSONValue?] = [:]
    var contributors: [Contributor] = []
    var flushing: Task<Void, Never>?
    var debounced: Task<Void, Never>?
    var debounceGeneration: UInt64 = 0
    var loading: Task<Void, Never>?
    var saving: Task<Void, Never>?
    var documentsVersion: UInt64 = 0
    var savedVersion: UInt64 = 0

    var live: [any UIMetaContributor] { contributors.compactMap(\.value) }

    /// The copy belongs to the person now named; a copy of somebody else's app
    /// section is dropped (with its pending write), never sent under this name.
    mutating func claim() {
      let user = state.userID

      guard !user.isEmpty, owner != user else {
        return
      }

      if owner != nil {
        documents.app = nil
      }

      owner = user
      documentsVersion += 1
    }
  }

  private let core: Mutex<Core>
  private let gateway: UIMetaGateway
  private let options: Options
  private let persistence: (any UIMetaPersistence)?
  private let feed = ChangeFeed()

  /// - Parameters:
  ///   - documents: what the device holds before anything is loaded.
  ///   - persistence: where the device's copy survives a relaunch; `load()`
  ///     reads it, every change writes it.
  public init(
    gateway: UIMetaGateway,
    documents: UIMetaDocuments = UIMetaDocuments(),
    persistence: (any UIMetaPersistence)? = nil,
    options: Options = Options()
  ) {
    self.gateway = gateway
    self.options = options
    self.persistence = persistence
    core = Mutex(Core(documents: documents))
  }

  // MARK: - Reading

  /// The device's copy of its sections.
  public var documents: UIMetaDocuments { core.withLock { $0.documents } }

  /// The app-wide section as the device holds it.
  public var app: JSONObject? { core.withLock { $0.documents.app } }

  /// One bot's section as the device holds it.
  public func bot(_ name: String) -> JSONObject? {
    core.withLock { $0.documents.bots[name] }
  }

  /// `synced` once a roster has been read and no write has been refused since.
  public var mode: UIMetaMode { core.withLock { $0.state.mode } }

  /// True while something written locally has not reached the gateway.
  public var pending: Bool { core.withLock { $0.state.pending } }

  /// This person's app-wide key, or `nil` while the gateway has named nobody.
  public var appKey: String? { core.withLock { $0.state.appKey } }

  /// The bookkeeping, for tests and diagnostics.
  public var state: UIMetaState { core.withLock { $0.state } }

  /// Every gateway copy taken in from now on (another device's change arriving).
  public func changes() -> AsyncStream<UIMetaChange> {
    feed.subscribe()
  }

  // MARK: - Setting up

  /// Read the device's stored copy, once. `reconcile` waits for it: whose copy is
  /// newer is a question about what this device holds, and a device whose read
  /// has not landed does not hold it yet.
  public func load() async {
    guard let persistence else {
      return
    }

    let task = core.withLock { core -> Task<Void, Never> in
      if let loading = core.loading {
        return loading
      }

      let task = Task { [persistence, options] in
        let stored = await persistence.load()
        self.core.withLock { core in
          guard let stored, stored.gateway == nil || options.gatewayID == nil || stored.gateway == options.gatewayID
          else {
            return
          }

          Self.adopt(stored, into: &core)
        }
      }

      core.loading = task
      return task
    }

    await task.value
  }

  /// The stored copy under what is held: an edit made before the disk answered
  /// is newer than the disk, and another person's app section is not taken.
  private static func adopt(_ stored: UIMetaStoredCopy, into core: inout Core) {
    let named = core.owner ?? (core.state.userID.isEmpty ? nil : core.state.userID)
    let theirs = stored.owner != nil && named != nil && stored.owner != named
    var app = theirs ? nil : stored.documents.app

    app?.removeValue(forKey: UIMeta.pushField)

    if let held = core.documents.app {
      app = (app ?? [:]).merging(held) { _, held in held }
    }

    core.documents = UIMetaDocuments(
      app: app,
      bots: stored.documents.bots.merging(core.documents.bots) { _, held in held }
    )
    core.owner = core.owner ?? (theirs ? nil : stored.owner)

    if stored.pendingApp, !theirs, core.documents.app != nil {
      core.state.markApp()
    }

    for name in stored.pendingBots {
      core.state.markBot(name)
    }

    core.documents.fold(pushRows: core.pushRows)
    core.documents.fold(pushSeen: core.pushSeen)
    core.claim()
  }

  /// Add a concern's part (settings, the chat list).
  public func register(_ contributor: any UIMetaContributor) {
    core.withLock { core in
      core.contributors.removeAll { $0.value == nil || $0.value === contributor }
      core.contributors.append(Contributor(value: contributor))
    }
  }

  /// Say who the gateway named, before the first reconcile: the app key carries
  /// that person's name. A different person drops the pending app write and,
  /// when the device's app section was somebody else's, that section: a person
  /// who arrives later starts from the defaults (ADR-0016), never from the
  /// previous reader's arrangement.
  public func setUser(_ userID: String) {
    core.withLock { core in
      core.state.setUser(userID)
      core.claim()
    }

    kickSave()
  }

  /// Sign-out on this gateway: forget the revisions, the dirty sections, the
  /// person, their app section and this device's push rows, and fence off
  /// anything still in flight. The bot sections stay (they are about the bots).
  /// A different gateway is a different `UIMetaSync`, not a reset.
  public func reset() {
    let debounced = core.withLock { core -> Task<Void, Never>? in
      core.state.reset()
      core.documents.app = nil
      core.owner = nil
      core.pushRows = [:]
      core.pushSeen = [:]
      core.documentsVersion += 1
      core.debounceGeneration += 1

      defer { core.debounced = nil }
      return core.debounced
    }

    debounced?.cancel()
    kickSave()
  }

  // MARK: - Local edits

  /// Edit the app-wide section. Answers whether anything changed.
  ///
  /// A `.choice` dates the section when its choices moved; a `.chore` is sent
  /// undated; a `.baseline` is what the device already held and is neither.
  @discardableResult
  public func updateApp(_ edit: UIMetaEdit = .choice, _ change: (inout JSONObject) -> Void) -> Bool {
    let now = options.now()
    let changed = core.withLock { core -> Bool in
      guard core.documents.editApp(edit, now: now, change) else {
        return false
      }

      core.documentsVersion += 1

      if edit != .baseline {
        core.state.markApp()
      }

      return true
    }

    afterEdit(changed: changed, edit: edit)
    return changed
  }

  /// Edit one bot's section. A section left with nothing but its version is
  /// removed (sent as `null`). Bot sections are never dated.
  @discardableResult
  public func updateBot(_ name: String, _ edit: UIMetaEdit = .choice, _ change: (inout JSONObject) -> Void) -> Bool {
    let changed = core.withLock { core -> Bool in
      guard core.documents.editBot(name, change) else {
        return false
      }

      core.documentsVersion += 1

      if edit != .baseline {
        core.state.markBot(name)
      }

      return true
    }

    afterEdit(changed: changed, edit: edit)
    return changed
  }

  /// This installation's push row in the app section, or `nil` to remove it. The
  /// only way into `push`: the writer reaches its own row and nothing else, the
  /// row is kept across every copy taken in, and it is never dated or stored on
  /// disk.
  public func setPushRow(_ row: UIMetaPushRow?, installation: String) {
    let changed = core.withLock { core -> Bool in
      core.pushRows[installation] = .some(row?.json)

      let before = core.documents.app
      core.documents.fold(pushRows: [installation: row?.json])

      guard core.documents.app != before else {
        return false
      }

      core.documentsVersion += 1
      core.state.markApp()
      return true
    }

    afterEdit(changed: changed, edit: .chore)
  }

  /// This installation's `seen` heartbeat in the app section, or `nil` to remove it: which chat it
  /// is reading, so the notifier holds back a notification for it. Every stale entry is swept
  /// and every entry written in the shape the gateway reads (`perChat`), as `pushSectionFor` does.
  /// Like the rows, kept across every copy taken in, never dated, never stored on disk.
  public func setPushSeen(_ entry: PushSeenEntry?, installation: String, now: Double, perChat: Bool) {
    let json = entry?.json(perChat: perChat)
    let changed = core.withLock { core -> Bool in
      core.pushSeen[installation] = .some(json)

      let before = core.documents.app
      core.documents.fold(pushSeen: [installation: json], sweep: (now, perChat))

      guard core.documents.app != before else {
        return false
      }

      core.documentsVersion += 1
      core.state.markApp()
      return true
    }

    afterEdit(changed: changed, edit: .chore)
  }

  /// Record that a section changed without editing it here (the reference's API).
  public func markBot(_ name: String) {
    core.withLock { $0.state.markBot(name) }
  }

  public func markApp() {
    core.withLock { $0.state.markApp() }
  }

  private func afterEdit(changed: Bool, edit: UIMetaEdit) {
    guard changed else {
      return
    }

    kickSave()

    if edit != .baseline {
      scheduleFlush()
    }
  }

  // MARK: - Reconciling

  /// Read the gateway's copy, take it in, then send whatever is dirty.
  ///
  /// Reading first is what gives a conflicted write the revision it needs;
  /// sending after is what stops the gateway's copy from erasing a change made
  /// while the socket was down, because that change is still dirty and goes out
  /// right behind it. `nil` when the roster could not be read.
  @discardableResult
  public func reconcile() async -> UIMetaSnapshot? {
    await load()

    guard let remote = await pull() else {
      return nil
    }

    let taken = core.withLock { core -> (UIMetaSnapshot, UIMetaDocuments, [any UIMetaContributor]) in
      core.state.noteNewerLocalApp(remote: remote, local: core.documents.snapshot)

      let snapshot = core.state.withPendingKept(remote: remote, local: core.documents.snapshot)

      Self.take(snapshot, into: &core)
      core.state.seedWhatTheGatewayLacks(remote: remote, local: core.documents.snapshot)

      // The inheritance is only half done until it is written back under this
      // person's name; marked between the take and the flush so both halves land
      // in one reconcile (`UiMetaSnapshot.migrated`).
      if remote.migrated {
        core.state.markApp()
      }

      return (snapshot, core.documents, core.live)
    }

    await announce(taken)
    await flush()
    return taken.0
  }

  /// Read `profiles.list` and project the two keys out of it. Internal: its
  /// answer is only safe to act on inside a reconcile.
  func pull() async -> UIMetaSnapshot? {
    let result: JSONValue

    do {
      result = try await gateway.request("profiles.list", [:])
    } catch {
      // A roster this client cannot read is a gateway it cannot sync with:
      // the local-only path, not an error to put in front of anybody.
      core.withLock { $0.state.rosterFailed() }
      return nil
    }

    return core.withLock { $0.state.ingest(roster: result) }
  }

  /// Send every dirty section, one request per profile. Concurrent callers share
  /// one flush, so a reconcile landing on a debounced send cannot send a section
  /// twice; a section marked while the flush is out goes in a further round of
  /// the same flush.
  public func flush() async {
    let task = core.withLock { core -> Task<Void, Never> in
      if let flushing = core.flushing {
        return flushing
      }

      // Created under the lock, so its own clean-up (also under the lock) cannot
      // run before the slot is filled.
      let task = Task {
        await self.run()
        self.core.withLock { $0.flushing = nil }
      }

      core.flushing = task
      return task
    }

    await task.value
  }

  /// Until nothing is scheduled, in flight or unsaved.
  public func settle() async {
    while let next = core.withLock({ $0.debounced ?? $0.flushing ?? $0.saving }) {
      await next.value
    }
  }

  /// Rounds of the outbox until a round ends with no mark made during it: a
  /// caller that joined this flush after it took its outbox (a debounced edit,
  /// a reconcile's seed) is sent by the next round rather than stranded.
  private func run() async {
    while true {
      let (writes, marks) = core.withLock { ($0.state.outbox(), $0.state.markCount) }

      for write in writes {
        await send(write)
      }

      let again = core.withLock { $0.state.markCount != marks && $0.state.pending }

      if !again {
        return
      }
    }
  }

  /// One `profiles.configure`, with the retry the compare-and-swap asks for.
  private func send(_ write: UIMetaWrite) async {
    for _ in 0...max(options.retries, 0) {
      // The bytes and the marks they carry, in one step; nothing for a write
      // taken out before a sign-out or a change of person.
      let attempt = core.withLock { core -> (JSONObject, UIMetaWrite)? in
        guard core.state.isCurrent(write) else {
          return nil
        }

        return (core.state.configureParams(for: write, local: core.documents.snapshot), core.state.stamped(write))
      }

      guard let (params, stamped) = attempt else {
        return
      }

      let result: JSONValue

      do {
        result = try await gateway.request("profiles.configure", params)
      } catch {
        core.withLock { core in
          if core.state.isCurrent(write) {
            core.state.refused()
          }
        }
        return
      }

      let absorbed = core.withLock { core -> UIMetaAbsorbed in
        let absorbed = core.state.absorb(result, for: stamped)
        core.documentsVersion += absorbed == .landed ? 1 : 0
        return absorbed
      }

      guard absorbed == .conflicted else {
        kickSave()
        return
      }

      // The value that won is READ before this device says its own again: in the
      // maps keyed by device and by person the winner is another device's row,
      // not a rival version of ours, and re-sending our bytes under the newer
      // revision would delete it. The next attempt builds its sections again,
      // from the copy this re-read just merged (ui-meta.ts, `send`).
      await reread()
    }

    // Out of retries with a conflict still standing: something else writes this
    // section as fast as we do. It stays dirty for the next reconcile.
  }

  /// Read the gateway again and take its copy in, keeping what is dirty. No
  /// flush: this runs inside one.
  private func reread() async {
    guard let remote = await pull() else {
      return
    }

    let taken = core.withLock { core -> (UIMetaSnapshot, UIMetaDocuments, [any UIMetaContributor]) in
      let snapshot = core.state.withPendingKept(remote: remote, local: core.documents.snapshot)
      Self.take(snapshot, into: &core)
      return (snapshot, core.documents, core.live)
    }

    await announce(taken)
  }

  /// The documents take the snapshot; then this device's push rows go back in
  /// and each contributor folds its own fields.
  private static func take(_ snapshot: UIMetaSnapshot, into core: inout Core) {
    core.documents.take(snapshot)
    core.documents.fold(pushRows: core.pushRows)
    core.documents.fold(pushSeen: core.pushSeen)

    let contributors = core.live

    if !contributors.isEmpty {
      var app = core.documents.app ?? [:]
      let held = core.documents.app

      for contributor in contributors {
        contributor.merge(app: &app, arriving: snapshot)
      }

      if held != nil || !app.isEmpty {
        app["v"] = .number(Double(UIMeta.appSectionVersion))
        core.documents.app = app
      }
    }

    core.documentsVersion += 1
  }

  /// Outside the lock: persist, hand the copy to each contributor, publish it.
  private func announce(_ taken: (UIMetaSnapshot, UIMetaDocuments, [any UIMetaContributor])) async {
    let (snapshot, documents, contributors) = taken

    kickSave()

    for contributor in contributors {
      await contributor.didApply(documents, snapshot: snapshot)
    }

    feed.publish(UIMetaChange(documents: documents, snapshot: snapshot))
  }

  // MARK: - Debounce and persistence

  private func scheduleFlush() {
    guard let delay = options.debounce else {
      return
    }

    let previous = core.withLock { core -> Task<Void, Never>? in
      let previous = core.debounced
      core.debounceGeneration += 1

      let generation = core.debounceGeneration
      core.debounced = Task {
        if delay > .zero {
          try? await Task.sleep(for: delay)
        }

        if !Task.isCancelled {
          await self.flush()
        }

        self.core.withLock { core in
          if core.debounceGeneration == generation {
            core.debounced = nil
          }
        }
      }

      return previous
    }

    previous?.cancel()
  }

  private func kickSave() {
    guard let persistence else {
      return
    }

    core.withLock { core in
      guard core.saving == nil, core.savedVersion < core.documentsVersion else {
        return
      }

      core.saving = Task { await self.saveLoop(persistence) }
    }
  }

  /// One save at a time, newest copy each round, so a slow disk coalesces rather
  /// than writing an older copy over a newer one. Never the push rows.
  private func saveLoop(_ persistence: any UIMetaPersistence) async {
    // Never before the stored copy has been read: a save made first (a person
    // named, a baseline written) would replace it before anybody looked at it.
    await load()

    while true {
      let next = core.withLock { core -> (UIMetaStoredCopy, UInt64)? in
        guard core.savedVersion < core.documentsVersion else {
          core.saving = nil
          return nil
        }

        let copy = UIMetaStoredCopy(
          documents: core.documents.persistable,
          owner: core.owner,
          gateway: options.gatewayID,
          pendingApp: core.state.dirtyApp,
          pendingBots: core.state.dirtyBots
        )
        return (copy, core.documentsVersion)
      }

      guard let (copy, version) = next else {
        return
      }

      await persistence.save(copy)
      core.withLock { $0.savedVersion = max($0.savedVersion, version) }
    }
  }
}

/// A fan-out of changes to any number of streams.
private final class ChangeFeed: Sendable {
  private struct Subscribers {
    var next: UInt64 = 0
    var all: [UInt64: AsyncStream<UIMetaChange>.Continuation] = [:]
  }

  private let subscribers = Mutex(Subscribers())

  func subscribe() -> AsyncStream<UIMetaChange> {
    let (stream, continuation) = AsyncStream<UIMetaChange>.makeStream(bufferingPolicy: .unbounded)
    let id = subscribers.withLock { subscribers -> UInt64 in
      defer { subscribers.next += 1 }
      subscribers.all[subscribers.next] = continuation
      return subscribers.next
    }

    continuation.onTermination = { [weak self] _ in
      _ = self?.subscribers.withLock { $0.all.removeValue(forKey: id) }
    }

    return stream
  }

  func publish(_ change: UIMetaChange) {
    let all = subscribers.withLock { Array($0.all.values) }

    for continuation in all {
      continuation.yield(change)
    }
  }

  deinit {
    for continuation in subscribers.withLock({ Array($0.all.values) }) {
      continuation.finish()
    }
  }
}
