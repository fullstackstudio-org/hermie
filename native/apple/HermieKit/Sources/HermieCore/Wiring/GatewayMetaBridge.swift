import Foundation
import HermieProtocol
import HermieStore

/**
 The ui_meta bridge of the live gateway (M2a): one `UIMetaSync` over the session's own link, with
 this installation's push row (`PushRowWriter`) as its contributor.

 One per live session, built by `LiveWiring` when the session starts and stopped when it ends, so
 a sync only ever talks to the gateway it was built for (ADR-0024).

 - **Who.** The app-wide key is `hermie-app:<user>`, so nothing is reconciled before the session
   has read who this is (`GatewaySession.uiMetaUser`). A gateway that refused the read stays on
   the local-only path rather than writing under a name it never agreed to.
 - **When.** On every `ready` edge (a reconnect can be another gateway process), on every
   `sessions.changed` sweep, and whenever the app comes to the front. Reconciles never overlap.
 - **What.** The device's copy is kept per gateway in the key-value store; the push row is
   written from the registrar's address for THIS gateway only, and is withdrawn from the gateway
   before the session ends on a sign-out (`withdrawRow`), while the credentials still work.

 The chat list's archive, pins and mutes are read and written through this sync by the session's
 `ChatArrangementModel`, attached on `start()`. What the gateway's copy carries that this build does
 not draw (another device's rows, the folders and order, the plugin advert) is carried as it came;
 nothing taken in from the gateway is ever treated as this person's own choice or row.
 */
@MainActor
public final class GatewayMetaBridge {
  public let sync: UIMetaSync
  public let writer: PushRowWriter
  public let gatewayID: String

  private weak var session: GatewaySession?
  private var following: Task<Void, Never>?
  private var reconciling: Task<Void, Never>?
  private var again = false
  private var user: String?
  private let settings: AppSettings?
  /// The settings bridge (the sync holds its contributors weakly) and the tasks that feed it.
  private var settingsBridge: UIMetaSettingsBridge?
  private var settingsTasks: [Task<Void, Never>] = []

  /// - Parameters:
  ///   - gatewayKey: the gateway's link key, written into the push row.
  ///   - installation: this installation's id (`PushInstallation`).
  ///   - settings: the device's settings, bridged to this gateway's app section and followed by the
  ///     session's default chat view; nil leaves them out.
  ///   - persistence: where the device's copy survives a relaunch; nil keeps it in memory.
  ///   - debounce: how long edits wait before they are sent (`UIMetaSync.Options.debounce`).
  public init(
    session: GatewaySession,
    gatewayKey: String,
    installation: String,
    push: PushController,
    settings: AppSettings? = nil,
    persistence: (any UIMetaPersistence)?,
    debounce: Duration? = .milliseconds(600)
  ) {
    var options = UIMetaSync.Options()
    options.gatewayID = session.gatewayID
    options.debounce = debounce

    let sync = UIMetaSync(gateway: .link(session.link), persistence: persistence, options: options)

    self.sync = sync
    self.gatewayID = session.gatewayID
    self.session = session
    self.settings = settings
    self.writer = PushRowWriter(
      sync: sync,
      gatewayId: session.gatewayID,
      gatewayKey: gatewayKey,
      installation: installation,
      push: push
    )
    sync.register(writer)
  }

  /// Whether this bridge is the one for `session` (a rebuilt session to the same gateway is not).
  public func follows(_ session: GatewaySession) -> Bool {
    self.session === session
  }

  /// Follow the session: reconcile on each `ready` edge once the user is known, and on every
  /// `sessions.changed` sweep. Idempotent.
  public func start() {
    guard following == nil, let session else {
      return
    }

    session.arrangement.attach(sync)
    followSettings(session)

    session.onSessionsChanged = { [weak self] in
      self?.reconcileSoon()
    }

    let changes = Observations { [weak session] () -> ReadyUser in
      ReadyUser(ready: session?.status.phase == .ready, user: session?.uiMetaUser)
    }

    following = Task { [weak self] in
      for await next in changes {
        guard let self else {
          return
        }

        self.follow(next)
      }
    }
  }

  /// Stop following. The device's copy stays on disk for the next session.
  public func stop() {
    following?.cancel()
    following = nil
    writer.stop()
    session?.arrangement.detach(sync)

    for task in settingsTasks {
      task.cancel()
    }

    settingsTasks = []
    settingsBridge = nil

    if let session, session.onSessionsChanged != nil {
      session.onSessionsChanged = nil
    }
  }

  /// The app came to the front or left it: the heartbeat follows, and coming back reconciles.
  public func setForeground(_ foreground: Bool) {
    writer.setForeground(foreground)

    if foreground {
      reconcileSoon()
    }
  }

  /// Which chat of this gateway is on screen, for the `seen` heartbeat.
  public func setOpenChat(_ bot: String?) {
    writer.setOpenChat(bot)
  }

  /// The reader changed what this device is told about: the row says so now.
  public func apply(_ preferences: PushPreferences) {
    writer.apply(preferences)
    Task { await writer.refresh() }
  }

  /// `PushController.onAddressesChanged`: rewrite this gateway's row when it is among them.
  public func addressesChanged(_ gatewayIds: Set<String>) async {
    await writer.addressesChanged(gatewayIds)
  }

  /**
   Sign-out or removal: take this installation's row out of the gateway's push section now, while
   the session can still write, and wait (at most `limit`) for it to go out. A gateway that cannot
   be reached keeps the row; the relay registration it names is revoked anyway.
   */
  public func withdrawRow(within limit: Duration = .seconds(3)) async {
    stop()
    sync.setPushRow(nil, installation: writer.installation)

    guard user != nil else {
      return
    }

    let sync = self.sync
    let deadline = ContinuousClock.now + limit

    // The send is not cancellable, so it is left to finish on its own and only waited for.
    Task { await sync.flush() }

    // The app section, which holds the row: a bot change held back for a section this build
    // cannot read stays pending for good and is not what this waits for.
    while sync.state.dirtyApp, ContinuousClock.now < deadline {
      try? await Task.sleep(for: .milliseconds(20))
    }
  }

  /// Reconcile now, or once more after the one running.
  public func reconcileSoon() {
    guard user != nil else {
      return
    }

    guard reconciling == nil else {
      again = true
      return
    }

    reconciling = Task { [weak self] in
      while let self {
        self.again = false
        await self.sync.reconcile()

        guard self.again else {
          self.reconciling = nil
          return
        }
      }
    }
  }

  /// Wait for every reconcile and send this bridge started. For tests.
  public func settle() async {
    while let running = reconciling {
      await running.value
    }

    await sync.settle()
  }

  /**
   The device's settings and this gateway's app section: the settings bridge carries the account's
   fields (the default chat view, the name order, the text size, the theme) both ways, and the
   session's default chat view follows the model.
   */
  private func followSettings(_ session: GatewaySession) {
    guard let settings, settingsBridge == nil else {
      return
    }

    let bridge = UIMetaSettingsBridge(store: settings, sync: sync)
    settingsBridge = bridge

    let changes = Observations { settings.synced }
    let defaults = Observations { settings.synced.defaults }
    let names = Observations { settings.botNamePolicy }

    settingsTasks = [
      Task {
        await bridge.start()

        for await _ in changes {
          guard !Task.isCancelled else {
            return
          }

          await bridge.settingsDidChange()
        }
      },
      Task { [weak session] in
        for await options in defaults {
          guard !Task.isCancelled else {
            return
          }

          session?.setDefaultVisibility(options)
        }
      },
      Task { [weak session] in
        for await policy in names {
          guard !Task.isCancelled else {
            return
          }

          session?.setBotNamePolicy(policy)
        }
      }
    ]
  }

  private func follow(_ next: ReadyUser) {
    guard next.ready, let named = next.user, !named.isEmpty else {
      return
    }

    if user != named {
      user = named
      sync.setUser(named)
    }

    reconcileSoon()
  }

  private struct ReadyUser: Sendable, Equatable {
    var ready: Bool
    var user: String?
  }
}
