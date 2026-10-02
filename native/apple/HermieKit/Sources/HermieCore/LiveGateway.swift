import Foundation
import HermieGateway
import HermieStore
import Observation

/// Where the live gateway's session stands, as the chat list says it.
public enum LiveGatewayPhase: Sendable, Equatable {
  /// No gateway is configured, none is active, or the launch has not finished reading them.
  case none
  /// The session is being built and started.
  case connecting
  /// A session is running; its own `status` says whether the socket is up.
  case live
  /// Nothing to sign in with is stored for this gateway (or what is stored belongs to an origin it
  /// moved away from).
  case signedOut
  /// The session could not be built (an unreadable keychain, a malformed address).
  case failed(String)
}

/**
 The one live `GatewaySession` of the app (ADR-0024): the session of the registry's active gateway,
 built when that gateway becomes active and shut down before the next one starts.

 It writes nothing: not the gateway list, not a credential. Which gateway is active is
 `GatewayDirectory`'s value, and the credentials come from `GatewayAccounts` (through the sync
 engine), so this only reads and follows:

 - nothing is read before `AppLaunch.start()` has finished (`AppLaunch.ready`), when the engine
   knows which credentials belong to an origin their gateway moved away from;
 - a change of the active gateway's credentials (`GatewayAccounts.credentialsRevision`: a sign-in,
 a sign-out, a removal) builds its session again;
 - `GatewayAccounts.endSession` ends the session first when this device stops using a gateway's
   credentials, and forgets who the gateway said this was.

 How a session is built is the `Connector`'s: the app's (`accountsConnector`) goes through the
 accounts; a test hands in one over a scripted link. A connector that returns nil found nothing to
 sign in with, and the phase says `signedOut`.
 */
@MainActor
@Observable
public final class LiveGateway {
  public typealias Connector = @MainActor (GatewayRecord) async throws -> GatewaySession?

  /// What the live session follows: the active gateway and its credentials' revision.
  struct Target: Sendable, Equatable {
    var id: String?
    var revision: Int
  }

  public private(set) var session: GatewaySession?
  /// The gateway `session` belongs to, or the one that could not be opened.
  public private(set) var gatewayID: String?
  public private(set) var phase = LiveGatewayPhase.none

  @ObservationIgnored public let directory: GatewayDirectory
  @ObservationIgnored private let connector: Connector
  @ObservationIgnored private let ready: @MainActor () -> Bool
  @ObservationIgnored private let revision: @MainActor (String) -> Int
  @ObservationIgnored private var following: Task<Void, Never>?
  /// Transitions run one after another: the old session is shut down before the next one starts.
  @ObservationIgnored private var queue: Task<Void, Never>?
  @ObservationIgnored private var background = false
  @ObservationIgnored private var target = Target(id: nil, revision: 0)
  @ObservationIgnored private var pending: Task<Void, Never>?
  static let settleDelay: Duration = .milliseconds(200)

  /// - Parameters:
  ///   - ready: whether the gateway list and the credentials may be read yet.
  ///   - revision: the credentials' revision of a gateway; a change rebuilds its session.
  public init(
    directory: GatewayDirectory,
    connector: @escaping Connector,
    ready: @escaping @MainActor () -> Bool = { true },
    revision: @escaping @MainActor (String) -> Int = { _ in 0 }
  ) {
    self.directory = directory
    self.connector = connector
    self.ready = ready
    self.revision = revision
  }

  /// The app's live gateway: credentials through `accounts`, chats cached in the launch's database,
  /// and `accounts.endSession` set so a sign-out or a removal ends the socket first.
  public convenience init(launch: AppLaunch, accounts: GatewayAccounts) {
    self.init(
      directory: launch.gateways,
      connector: Self.accountsConnector(launch: launch, accounts: accounts),
      ready: { [weak launch] in launch?.ready ?? false },
      revision: { [weak accounts] id in accounts?.credentialsRevision[id] ?? 0 }
    )

    accounts.endSession = { [weak self] id in
      await self?.end(id)
    }
  }

  /// Follow the active gateway from now on. Idempotent; nothing is read before `ready`.
  public func start() {
    guard following == nil else {
      return
    }

    let directory = self.directory
    let ready = self.ready
    let revision = self.revision
    let changes = Observations { () -> Target in
      // Every input is read on every pass, so each one is observed whatever the others say.
      let isReady = ready()
      let loaded = directory.loaded
      let active = directory.activeId
      let current = active.map(revision) ?? 0

      guard isReady, loaded, let active else {
        return Target(id: nil, revision: 0)
      }

      return Target(id: active, revision: current)
    }

    following = Task { [weak self] in
      for await next in changes {
        guard let self else {
          return
        }

        self.settle(next)
      }
    }
  }

  /// Follow `next` once the inputs have been still for a moment: a gateway set up a moment ago
  /// becomes active and has its credentials stored in two steps, and one session is enough.
  private func settle(_ next: Target) {
    pending?.cancel()
    pending = Task { [weak self] in
      try? await Task.sleep(for: Self.settleDelay)

      guard !Task.isCancelled, let self else {
        return
      }

      await self.follow(next)
    }
  }

  /// Make `next.id` the live gateway: nothing when it already is with the same credentials,
  /// otherwise the old session is shut down first. A nil id shuts everything down.
  func follow(_ next: Target) async {
    await enqueue { live in
      guard next != live.target || live.phase == .none else {
        return
      }

      live.target = next
      await live.open(next.id)
    }
  }

  /// Follow `id` with its current revision (tests; the app follows the directory).
  public func follow(_ id: String?) async {
    await follow(Target(id: id, revision: id.map(revision) ?? 0))
  }

  /// Build the session again for the same gateway, after the keychain could not be read.
  public func reconnect() async {
    await enqueue { live in
      await live.open(live.gatewayID ?? live.directory.activeId)
    }
  }

  /// This device stops using `id`'s credentials (a sign-out, a removal): the session ends, and who
  /// the gateway said this was is forgotten. The revision bump that follows builds it again, signed
  /// out.
  public func end(_ id: String) async {
    await enqueue { live in
      guard live.gatewayID == id, let session = live.session else {
        return
      }

      live.session = nil
      live.phase = .signedOut
      await session.forgetIdentity()
      await session.shutdown()
    }
  }

  /// The app went to the background: the session writes its chats and closes its socket.
  public func enterBackground() async {
    background = true
    await session?.enterBackground()
  }

  public func enterForeground() async {
    background = false
    await session?.enterForeground()
  }

  /// Stop following and shut the session down.
  public func shutdown() async {
    following?.cancel()
    following = nil
    pending?.cancel()
    pending = nil
    await enqueue { live in
      live.target = Target(id: nil, revision: 0)
      await live.open(nil)
    }
  }

  private func enqueue(_ work: @escaping @MainActor (LiveGateway) async -> Void) async {
    let previous = queue
    let task = Task { @MainActor [weak self] in
      await previous?.value

      if let self {
        await work(self)
      }
    }

    queue = task
    await task.value
  }

  private func open(_ id: String?) async {
    if let old = session {
      session = nil
      await old.shutdown()
    }

    gatewayID = id

    guard let id else {
      phase = .none
      return
    }

    phase = .connecting

    do {
      guard let record = try await directory.store.load().gateway(id: id) else {
        phase = .none
        return
      }

      guard let session = try await connector(record) else {
        phase = .signedOut
        return
      }

      // Published before it starts, so the chat list paints the cached roster while it dials.
      self.session = session
      phase = .live
      await session.start()

      if background {
        await session.enterBackground()
      }
    } catch GatewayAccessError.signedOut {
      phase = .signedOut
    } catch {
      phase = .failed(ChatResolver.describe(error))
    }
  }
}

extension LiveGateway {
  /**
   The app's connector: the gateway's credentials through `accounts` (the engine's
   `storedCredentials(of:)`, empty while they belong to an origin the gateway left), a native
   gateway's one token coordinator from `accounts.coordinator(for:)`, and its chats cached in the
   launch's database under its id.

   Returns nil when there is nothing to sign in with, or the auth mode cannot be used outside a web
   page (`cookie`).
   */
  public static func accountsConnector(launch: AppLaunch, accounts: GatewayAccounts) -> Connector {
    { [weak launch, weak accounts] record in
      guard let launch, let accounts else {
        return nil
      }

      // The engine read the credentials for the stored auth kind; the session uses the same one.
      let access = try await accounts.access(for: record.id)

      guard access.secrets.hasCredentials else {
        return nil
      }

      let headers = access.secrets.extraHeaders
      let credentials: any CredentialProvider

      switch authMode(record.authKind) {
      case .sessionToken:
        credentials = SessionTokenCredentials(token: access.secrets.sessionToken ?? "")
      case .nativePKCE:
        credentials = NativePKCECredentials(
          baseURL: access.baseURL,
          coordinator: try accounts.coordinator(for: record.id, baseURL: access.baseURL, headers: headers),
          extraHeaders: headers,
          transport: accounts.services.transport
        )
      case .cookie, nil:
        return nil
      }

      var current = record
      current.address = access.baseURL

      return try GatewaySession(
        record: current,
        credentials: credentials,
        extraHeaders: headers.isEmpty ? nil : headers,
        database: launch.store
      )
    }
  }

  static func authMode(_ kind: GatewayAuthKind) -> GatewayAuthMode? {
    switch kind {
    case .nativePKCE: .nativePKCE
    case .sessionToken: .sessionToken
    case .cookie: .cookie
    case .other: nil
    }
  }
}
