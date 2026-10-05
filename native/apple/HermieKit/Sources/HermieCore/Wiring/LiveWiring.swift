import Foundation
import HermieShared
import HermieStore
import Synchronization

/**
 What runs against the live session besides the screens (PG-6): push's session seams, the ui_meta
 bridge with this installation's push row, and the system surfaces (share sheet, widgets,
 Spotlight, Shortcuts) behind `SystemSurfaceLock`.

 Built by the app shell beside `LiveGateway`, and started once. It only follows: which gateway is
 live is `LiveGateway`'s, who is signed in where is `GatewayAccounts`'s, and push's own state is
 `PushController`'s.

 - **Push.** `pendingApprovals` and `respond` go to the live session, and only for the gateway
   it is (`PushController` already answers nothing elsewhere); a tap from a cold start waits for
   the socket. `canonicalSessionIds` reads the live chat list. A changed relay address rewrites
   the live gateway's row (`onAddressesChanged`); another gateway's row is written the next time
   it is the live one.
 - **Sign-out and removal.** Before the session ends (`GatewayAccounts.endSession`), the surfaces
   stop publishing for that gateway and, when it is the live one, the row is withdrawn from its
   push section while the credentials still work (another gateway's row stays there: only the live
   gateway has a socket to write it through). The surfaces purge what they hold for it once the
   sign-out, or the removal, went through (`GatewayAccounts.purgeSurfaces`). The relay registration
   is retired by `GatewayAccounts` itself.
 - **Notification actions** answer only while the app lock is open; locked, they open the chat.
 - **The surface lock** opens only while the launch is ready, the app lock is open and the live
   gateway has a signed-in session (`LiveGateway.phase == .live`), and closes again on a sign-out.
   The drains run on every opening and every `ready` edge.
 */
@MainActor
public final class LiveWiring {
  public let launch: AppLaunch
  public let live: LiveGateway
  public let surfaces: SystemSurfaces?
  /// The live gateway's ui_meta bridge, while it has a session.
  public private(set) var meta: GatewayMetaBridge?
  /// The local notifications for open requests, when the shell has them (`RequestAlerts`).
  public let alerts: RequestAlerts?
  /// Everything waiting for the person, across bots (NX-17), when the shell has it.
  public let inbox: NeedsYouInbox?
  /// The emergency stop (NX-16): every running turn of the connected gateways, on request.
  public let emergencyStop: EmergencyStopModel

  /// How long a notification action waits for the socket before it gives up and only opens.
  var readyWait: Duration = .seconds(15)
  /// Bridges built here wait this long before they send an edit.
  var metaDebounce: Duration? = .milliseconds(600)
  /// Whether the app lock is open, in place of `launch.lock` (tests).
  var appLockState: (@MainActor () -> Bool)?

  private weak var accounts: GatewayAccounts?
  private var started = false
  private var tasks: [Task<Void, Never>] = []
  /// Follows the live session's chat list for the surfaces; one at a time.
  private var surfaceTask: Task<Void, Never>?
  /// Follows the live session's open requests for `alerts` and `inbox`; one at a time.
  private var requestTask: Task<Void, Never>?
  private var retryTask: Task<Void, Never>?
  private weak var alertedSession: GatewaySession?
  private var foreground = true
  private var foregroundWindows: Set<UUID> = []
  private var openChat: ChatTarget?
  private var installation: String?
  private let gate = SurfaceGate()

  private let installLock: (@escaping @Sendable () -> Bool) -> Void

  /// - Parameters:
  ///   - installLock: where the surfaces' lock state is installed; `SystemSurfaceLock` in
  ///     the app. A test passes its own, so the process-wide lock other tests read stays untouched.
  ///   - alerts: the local notifications for what the bots ask while the app is not in front; the
  ///     live session's open requests are handed to it. `nil`: none (a test, a preview).
  ///   - inbox: the "Needs you" list; the live session's open requests and connector cards are
  ///     handed to it, and its count is the app icon's badge while the app is in the background.
  ///     `nil`: none.
  public init(
    launch: AppLaunch,
    accounts: GatewayAccounts?,
    live: LiveGateway,
    surfaces: SystemSurfaces?,
    installLock: @escaping (@escaping @Sendable () -> Bool) -> Void = { SystemSurfaceLock.install($0) },
    alerts: RequestAlerts? = nil,
    inbox: NeedsYouInbox? = nil
  ) {
    self.launch = launch
    self.accounts = accounts
    self.live = live
    self.surfaces = surfaces
    self.installLock = installLock
    self.alerts = alerts
    self.inbox = inbox

    let directory = launch.gateways

    self.emergencyStop = EmergencyStopModel(
      gateways: { [weak live, weak directory] in
        guard let live, let session = live.session, live.gatewayID == session.gatewayID else {
          return []
        }

        return [SessionStopGateway(session: session, name: directory?.entry(id: session.gatewayID)?.displayLabel)]
      },
      notConnected: { [weak live, weak directory] in
        // One socket at a time: every other gateway is out of reach, and the summary says so.
        guard let directory else {
          return []
        }

        let held = live?.session?.gatewayID
        return directory.entries.filter { $0.id != held }.map(\.displayLabel)
      }
    )
  }

  /// Install the seams and start following. Idempotent.
  public func start() {
    guard !started else {
      return
    }

    started = true
    installPushSeams()
    installSignOutHook()
    installSurfaceLock()
    followSession()
  }

  // MARK: The app

  /// One window came to the front or went to the background. The app is in front while ANY of its
  /// windows is: a second window minimised on the Mac does not stop the `seen` heartbeat of the one
  /// still in front.
  public func setForeground(_ foreground: Bool, window: UUID) {
    if foreground {
      foregroundWindows.insert(window)
    } else {
      foregroundWindows.remove(window)
    }

    setForeground(!foregroundWindows.isEmpty)
  }

  /// A window closed: it no longer keeps the app in front.
  public func windowClosed(_ window: UUID) {
    alerts?.presence.windowClosed(window)

    guard foregroundWindows.contains(window) else {
      return
    }

    setForeground(false, window: window)
  }

  /**
   What one window shows, for the local notifications (`AppPresence`): whether the app is active in
   it, whether it is the key window, and the chat on screen in it. Not the same as `setForeground`: a
   window that is merely visible keeps the `seen` heartbeat going but is not looked at.
   */
  public func setPresence(window: UUID, active: Bool, key: Bool, gatewayId: String?, bot: String?) {
    alerts?.presence.report(
      window: window,
      active: active,
      key: key,
      chat: bot.map { AppPresence.Chat(gatewayId: gatewayId ?? "", bot: $0) }
    )
  }

  /// Whether the app is in front, as the windows reported it.
  var isForeground: Bool {
    foreground
  }

  /// The app came to the front or left it.
  public func setForeground(_ foreground: Bool) {
    self.foreground = foreground
    meta?.setForeground(foreground)

    if foreground {
      drainSoon()
    } else {
      showBadge()
    }
  }

  /**
   The app icon says how many things wait for the person (`NeedsYouInbox.count`), while the app is in
   the background and notifications are allowed: the system's permission is granted and the reader's
   switch is on. In front the badge is zero (`PushController.becameActive`), because the list is
   one tap away.
   */
  private func showBadge() {
    guard let inbox, !foreground, launch.push.permission == .granted, launch.push.enabled else {
      return
    }

    let count = inbox.count
    let push = launch.push

    Task { await push.system.setBadgeCount(count) }
  }

  /// The chat on screen in the window in front, or nil: the `seen` heartbeat names it.
  public func setOpenChat(gatewayId: String?, bot: String?) {
    openChat = bot.map { ChatTarget(gatewayId: gatewayId ?? "", bot: $0) }
    meta?.setOpenChat(openChat?.gatewayId == meta?.gatewayID ? openChat?.bot : nil)
  }

  /**
   A `hermie://share/…` or `hermie://intent/…` link arrived: drain now, through the live session
   and for ITS gateway only. The directory's active gateway can already be the next one while the
   live session is still the last one (the switch settles first); what is queued for the next one
   waits for its own session.
   */
  @discardableResult
  public func drainSoon() -> Task<Void, Never>? {
    guard let session = live.session, let surfaces, isUnlocked,
      let gatewayKey = launch.gateways.entry(id: session.gatewayID)?.key
    else {
      return nil
    }

    let known = Set(launch.gateways.entries.map(\.key))

    return Task { [weak self] in
      guard await surfaces.drain(session: session, gatewayKey: gatewayKey, known: known) else {
        return
      }

      // A share written a moment ago is the share extension's for now: look again after its grace.
      try? await Task.sleep(for: .seconds(AppGroupShareOutbox.leaseGrace))
      self?.drainSoon()
    }
  }

  /// Whether the system surfaces may act now (what `SystemSurfaceLock` reads).
  public var isUnlocked: Bool {
    gate.isOpen
  }

  // MARK: Push

  private func installPushSeams() {
    let push = launch.push

    // An action answers only while the app lock is open: a banner's Allow on an unattended device
    // whose Hermie is locked must not pass the lock. Locked, the tap only opens the chat, where the
    // card waits behind the plate.
    push.pendingApprovals = { [weak self] scope in
      guard let self, let session = self.session(for: scope.gatewayId) else {
        throw PushSessionUnavailable()
      }

      let deadline = ContinuousClock.now + self.readyWait

      try await session.waitUntilReady(within: self.readyWait)
      try await self.waitUntilAppLockOpen(until: deadline)
      return try await session.pushOpenApprovals(bot: scope.bot)
    }

    push.respond = { [weak self] answer in
      guard let self, self.appLockOpen, let session = self.session(for: answer.gatewayId) else {
        throw PushSessionUnavailable()
      }

      try await session.pushRespond(answer)
    }

    push.canonicalSessionIds = { [weak self] gatewayId, bot in
      self?.session(for: gatewayId)?.canonicalSessionIDs(bot: bot) ?? []
    }

    // A muted chat's notification is not shown in front (the notifier holds it back otherwise).
    push.isMuted = { [weak self] gatewayId, bot in
      self?.session(for: gatewayId)?.arrangement.isMuted(bot) ?? false
    }

    push.onAddressesChanged = { [weak self] ids in
      guard let meta = self?.meta else {
        return
      }

      Task { await meta.addressesChanged(ids) }
    }

    // The kinds of notification the reader switched, the preview and "Urgent requests break through
    // Focus": written into this device's row.
    push.onPreferencesChanged = { [weak self] in
      guard let self, let meta = self.meta else {
        return
      }

      meta.apply(
        self.launch.push.preferences, urgentBreaksThroughFocus: self.launch.push.urgentBreaksThroughFocus)
    }
  }

  /// Whether the app lock is open: read, and open (a lock not read yet counts as closed).
  var appLockOpen: Bool {
    appLockState?() ?? (launch.lock.ready && !launch.lock.machine.locked)
  }

  /// Wait for the app lock to open, until `deadline`; throws `PushSessionUnavailable` when it does not.
  private func waitUntilAppLockOpen(until deadline: ContinuousClock.Instant) async throws {
    while !appLockOpen {
      guard ContinuousClock.now < deadline else {
        throw PushSessionUnavailable()
      }

      try await Task.sleep(for: .milliseconds(50))
    }
  }

  private func session(for gatewayId: String) -> GatewaySession? {
    guard live.gatewayID == gatewayId, let session = live.session, session.gatewayID == gatewayId else {
      return nil
    }

    return session
  }

  /// Before the session to a gateway ends because this device stops using its credentials: stop
  /// publishing for it and take the row off it, then let the session end. The surfaces are purged
  /// once the sign-out or the removal went through (`GatewayAccounts.purgeSurfaces`).
  private func installSignOutHook() {
    guard let accounts else {
      return
    }

    let ending = accounts.endSession

    accounts.endSession = { [weak self] id in
      await self?.leaving(id)
      await ending?(id)
    }

    accounts.purgeSurfaces = { [weak self] key in
      self?.surfaces?.purge(gatewayKey: key)
    }
  }

  func leaving(_ gatewayId: String) async {
    // Nothing it still says, while it ends, may bring a notification back.
    if alertedSession?.gatewayID == gatewayId {
      requestTask?.cancel()
      requestTask = nil
      retryTask?.cancel()
      retryTask = nil
      alertedSession = nil
    }

    alerts?.sessionEnded(gatewayId: gatewayId)
    inbox?.sessionEnded(gatewayId: gatewayId)
    showBadge()

    if let meta, meta.gatewayID == gatewayId {
      self.meta = nil
      // Nothing is written for this gateway any more: a purge after this stays purged.
      surfaceTask?.cancel()
      surfaceTask = nil
      await meta.withdrawRow()
    }

    updateLock()
  }

  // MARK: The session

  private func followSession() {
    let live = self.live
    let changes = Observations { () -> SessionMark in
      SessionMark(session: live.session.map(ObjectIdentifier.init), gatewayId: live.gatewayID)
    }

    tasks.append(
      Task { [weak self] in
        for await _ in changes {
          guard let self else {
            return
          }

          await self.sessionChanged()
        }
      }
    )
  }

  private func sessionChanged() async {
    let session = live.session

    followRequests(of: session)

    // A session rebuilt for the same gateway (new credentials) gets a bridge of its own.
    if let meta, session.map(meta.follows) != true {
      meta.stop()
      self.meta = nil
      surfaceTask?.cancel()
      surfaceTask = nil
    }

    guard let session, meta == nil, let entry = launch.gateways.entry(id: session.gatewayID) else {
      return
    }

    guard let installation = await installationID(), live.session === session else {
      return
    }

    let bridge = GatewayMetaBridge(
      session: session,
      gatewayKey: entry.key,
      installation: installation,
      push: launch.push,
      settings: launch.settings,
      persistence: KeyValueUIMetaPersistence(store: launch.keyValues, namespace: GatewayNamespace(session.gatewayID)),
      debounce: metaDebounce
    )

    meta = bridge
    bridge.writer.apply(launch.push.preferences)
    bridge.writer.urgentBreakthrough = launch.push.urgentBreaksThroughFocus
    bridge.setForeground(foreground)
    bridge.setOpenChat(openChat?.gatewayId == session.gatewayID ? openChat?.bot : nil)
    bridge.start()
    followSurfaces(session, gatewayKey: entry.key)
  }

  // MARK: Open requests

  /**
   A tap on the notification of a request: the request comes up again even if the person had put it
   away (Later, Esc, or leaving the chat while its sheet was up), because they asked for it. Only on
   the live gateway, and only by an id that names a request there; the chat's own screen raises the
   sheet once nothing holds it back, and shows nothing for a request that is no longer open.
   */
  public func bringBack(gatewayKey: String, bot: String, requestId: String) {
    guard !requestId.isEmpty, let session = live.session,
      launch.gateways.entry(id: session.gatewayID)?.key == gatewayKey
    else {
      return
    }

    for kind in [RequestShelf.Kind.answer, .secure, .interactive] {
      session.requestShelf.bringBack(requestId, chat: bot, kind: kind)
    }
  }

  /**
   Hand the live session's open requests to `alerts`, now and whenever they change. A new session
   (another gateway, or the same one with new credentials) replaces the old one: the requests of the
   old one can no longer be answered from here, so its notifications are taken away first.
   */
  private func followRequests(of session: GatewaySession?) {
    guard alerts != nil || inbox != nil else {
      return
    }

    if let session, session === alertedSession {
      return
    }

    requestTask?.cancel()
    requestTask = nil
    retryTask?.cancel()
    retryTask = nil

    if let previous = alertedSession {
      alerts?.sessionEnded(gatewayId: previous.gatewayID)
      inbox?.sessionEnded(gatewayId: previous.gatewayID)
      showBadge()
    }

    alertedSession = session

    guard let session else {
      return
    }

    let gatewayKey = launch.gateways.entry(id: session.gatewayID)?.key ?? ""

    requestTask = Task { [weak self, weak session] in
      guard let session else {
        return
      }

      let samples = Observations { session.openRequestSample() }

      for await sample in samples {
        guard let self, !Task.isCancelled else {
          return
        }

        await self.alert(session, gatewayKey: gatewayKey, sample: sample)
      }
    }
  }

  /// Hand one pass over the session's open requests to the inbox and then to the notifications, in
  /// that order: a notification's badge reads the inbox's count, which then already has the request.
  private func deliver(
    _ session: GatewaySession, gatewayKey: String, sample: OpenRequestSample, requests: [OpenRequest]
  ) {
    inbox?.update(
      gatewayId: session.gatewayID,
      gatewayName: launch.gateways.entry(id: session.gatewayID)?.displayLabel ?? session.gatewayID,
      gatewayKey: gatewayKey,
      requests: requests,
      connections: sample.connections,
      chatName: { session.chatName($0) },
      authoritative: sample.ready
    )
    alerts?.update(gatewayId: session.gatewayID, gatewayKey: gatewayKey, requests: requests, authoritative: sample.ready)
    showBadge()
  }

  private func alert(_ session: GatewaySession, gatewayKey: String, sample: OpenRequestSample) async {
    let (requests, unresolved) = await session.openRequests(from: sample)

    // A session that is no longer the live one has nothing left to say.
    guard alertedSession === session, !Task.isCancelled else {
      return
    }

    retryTask?.cancel()
    retryTask = nil

    deliver(session, gatewayKey: gatewayKey, sample: sample, requests: requests)

    // A confirmation whose chat the store cannot name yet is not lost: ask again for a few seconds.
    guard unresolved > 0 else {
      return
    }

    retryTask = Task { [weak self, weak session] in
      for _ in 0..<5 {
        try? await Task.sleep(for: .seconds(1))

        guard !Task.isCancelled, let self, let session, self.alertedSession === session else {
          return
        }

        let sample = session.openRequestSample()
        let (requests, unresolved) = await session.openRequests(from: sample)

        guard self.alertedSession === session, !Task.isCancelled else {
          return
        }

        self.deliver(session, gatewayKey: gatewayKey, sample: sample, requests: requests)

        if unresolved == 0 {
          return
        }
      }
    }
  }

  private func installationID() async -> String? {
    if let installation {
      return installation
    }

    installation = try? await PushInstallation.id(in: launch.keyValues)
    return installation
  }

  // MARK: The surfaces

  private func installSurfaceLock() {
    let gate = self.gate

    installLock { !gate.isOpen }

    let launch = self.launch
    let live = self.live
    let changes = Observations { () -> Bool in
      launch.ready && launch.lock.ready && !launch.lock.machine.locked && live.phase == .live
    }

    tasks.append(
      Task { [weak self] in
        for await open in changes {
          guard let self else {
            return
          }

          self.setUnlocked(open)
        }
      }
    )
  }

  private func updateLock() {
    setUnlocked(launch.ready && launch.lock.ready && !launch.lock.machine.locked && live.phase == .live)
  }

  private func setUnlocked(_ open: Bool) {
    let was = gate.set(open)

    if open, !was {
      drainSoon()
    }
  }

  /// Write the snapshot when the chat list or the lock setting changes, and drain on `ready`.
  private func followSurfaces(_ session: GatewaySession, gatewayKey: String) {
    guard let surfaces else {
      return
    }

    let lock = launch.lock
    let changes = Observations { [weak session] () -> SurfaceMark in
      SurfaceMark(
        rows: session?.chatList.rows ?? [:],
        ready: session?.status.phase == .ready,
        hidePreviews: lock.machine.threshold != .off || lock.machine.locked
      )
    }

    surfaceTask?.cancel()
    surfaceTask = (
      Task { [weak self, weak session] in
        var wasReady = false

        for await mark in changes {
          guard !Task.isCancelled, let self, let session, self.live.session === session else {
            return
          }

          surfaces.publish(session: session, gatewayKey: gatewayKey, hidePreviews: mark.hidePreviews)

          if mark.ready, !wasReady {
            self.drainSoon()
          }

          wasReady = mark.ready
          // Streaming moves the rows every frame; what changes meanwhile is coalesced.
          try? await Task.sleep(for: .milliseconds(500))
        }
      }
    )
  }

  private struct SessionMark: Sendable, Equatable {
    var session: ObjectIdentifier?
    var gatewayId: String?
  }

  private struct SurfaceMark: Sendable, Equatable {
    var rows: [String: ChatListRow]
    var ready: Bool
    var hidePreviews: Bool
  }

  private struct ChatTarget: Sendable, Equatable {
    var gatewayId: String
    var bot: String
  }
}

/// Whether the system surfaces may act, readable from any thread (`SystemSurfaceLock`).
final class SurfaceGate: Sendable {
  private let state = Mutex(false)

  var isOpen: Bool {
    state.withLock { $0 }
  }

  /// Set it, and answer what it was.
  func set(_ open: Bool) -> Bool {
    state.withLock { state in
      defer { state = open }
      return state
    }
  }
}
