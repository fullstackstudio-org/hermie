import Foundation
import HermieGateway
import HermieProtocol
import HermieShared
import HermieStore
import Observation

/// What is stored for one gateway, read back together: its config and the credentials a connection
/// may use (`GatewaySyncEngine.storedCredentials`).
public struct GatewayAccess: Sendable {
  public var id: String
  public var baseURL: String
  public var mode: GatewayAuthMode
  public var config: StoredGatewayConfig?
  public var secrets: StoredGatewaySecrets
}

/// Why a stored gateway could not be used.
public enum GatewayAccessError: Error, Sendable, Equatable, CustomStringConvertible {
  /// No gateway with that id, or nothing stored for it.
  case unknownGateway
  /// The keychain refused to read or write.
  case keychain
  /// Nothing to sign in with: the gateway is signed out.
  case signedOut

  public var description: String {
    switch self {
    case .unknownGateway: "That gateway is not configured on this device."
    case .keychain: "The keychain could not be read or written."
    case .signedOut: "You are signed out of this gateway."
    }
  }
}

/**
 The credentials side of the configured gateways: who is signed in where, signing out, removing a
 gateway (its grant revoked first), and one `TokenCoordinator` per gateway for everything in this
 process that calls it with a bearer.

 Every write goes through the sync engine (`launch.sync`), the only writer of the gateway list and
 of every credential: it binds credentials to the origin they were entered for and records what the
 person did for the other devices. Credentials are read only through `storedCredentials(of:)` and
 `tokenStore(of:)`, which give nothing for a gateway whose credentials still belong to an origin it
 moved away from.

 One coordinator per gateway matters: a refresh token rotates, and two coordinators refreshing the
 same grant would spend it twice, which a provider with reuse detection answers by revoking the
 session. Anything that needs the stored tokens (the account page, sign-out, a sign-in again, and
 the session) asks `coordinator(for:)`; a change of credentials bumps `credentialsRevision` and drops
 the cached one.
 */
@MainActor
@Observable
public final class GatewayAccounts {
  public enum Status: Sendable, Equatable {
    case unknown
    case signedIn
    case signedOut
  }

  public let services: GatewayServices
  public let directory: GatewayDirectory
  public let sync: GatewaySyncEngine
  @ObservationIgnored public let store: SQLiteStore
  @ObservationIgnored public let push: PushController?
  @ObservationIgnored let share: ShareDeliveryPublisher?
  /// Told when a sign-in finishes here, so a gateway taken from iCloud stops saying "Sign in needed".
  @ObservationIgnored let iCloudSync: ICloudSyncModel

  /**
   Called when this device stops using a gateway's credentials (a sign-out, a removal), so the live
   session to it ends. The session wiring sets it; nothing else may keep a socket signed in with
   credentials that are gone.
   */
  @ObservationIgnored public var endSession: (@MainActor (String) async -> Void)?

  /**
   Called with a gateway's key once this device stopped using it: after a sign-out, and after a
   removal that went through (never before one that can still be refused). The system surfaces
   purge what they hold for it. The session wiring sets it.
   */
  @ObservationIgnored public var purgeSurfaces: (@MainActor (String) -> Void)?

  /// Per gateway id. A gateway not read yet is `.unknown`.
  public private(set) var statuses: [String: Status] = [:]
  /// Per gateway id: bumped whenever its stored credentials changed (signed in, out, or removed).
  public private(set) var credentialsRevision: [String: Int] = [:]
  /// Gateways signed out of whose push registration could not be retired, kept so a
  /// screen can say so; the next sign-out or removal asks the relay again.
  public private(set) var pushStillRegistered: Set<String> = []

  @ObservationIgnored private var coordinators: [String: (baseURL: String, coordinator: TokenCoordinator)] = [:]
  @ObservationIgnored private var following = false

  public init(launch: AppLaunch, services: GatewayServices, share: ShareDeliveryPublisher? = nil) {
    self.directory = launch.gateways
    self.sync = launch.sync
    self.store = launch.store
    self.push = launch.push
    self.iCloudSync = launch.iCloudSync
    self.services = services
    self.share = share
  }

  public func status(for id: String) -> Status {
    statuses[id] ?? .unknown
  }

  /// Keep the statuses in step with the gateway list. Idempotent.
  public func follow() {
    guard !following else {
      return
    }

    following = true
    observeDirectory()
  }

  private func observeDirectory() {
    _ = withObservationTracking {
      directory.entries
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in self?.observeDirectory() }
    }

    Task { await refresh() }
  }

  /// Read whether each configured gateway has a credential stored.
  public func refresh() async {
    for entry in directory.entries {
      let status: Status = ((try? await access(for: entry.id))?.secrets.hasCredentials ?? false) ? .signedIn : .signedOut

      if statuses[entry.id] != status {
        statuses[entry.id] = status
      }
    }
  }

  // MARK: - Reading

  public func config(for id: String) async -> StoredGatewayConfig? {
    let key = StoredGatewayConfig.key(gatewayId: id)

    return StoredGatewayConfig.decode(try? await store.read { try $0.kvValue(forKey: key) })
  }

  /// The config and the credentials of one gateway, through the engine.
  public func access(for id: String) async throws -> GatewayAccess {
    let config = await config(for: id)

    guard let baseURL = directory.entry(id: id)?.address ?? config?.baseUrl else {
      throw GatewayAccessError.unknownGateway
    }

    let secrets: StoredGatewaySecrets

    do {
      secrets = try await sync.storedCredentials(of: id)
    } catch SyncEngineError.unknownGateway {
      throw GatewayAccessError.unknownGateway
    } catch {
      throw GatewayAccessError.keychain
    }

    return GatewayAccess(id: id, baseURL: baseURL, mode: config?.mode ?? .nativePKCE, config: config, secrets: secrets)
  }

  /// The one token coordinator for a gateway, over the engine's token store for it.
  public func coordinator(for id: String, baseURL: String, headers: [String: String]) throws -> TokenCoordinator {
    if let cached = coordinators[id], cached.baseURL == baseURL {
      return cached.coordinator
    }

    let coordinator = services.tokenCoordinator(store: try sync.tokenStore(of: id), baseURL: baseURL, headers: headers)

    coordinators[id] = (baseURL, coordinator)
    return coordinator
  }

  /// A REST client for a stored gateway, with its stored credential.
  public func client(for id: String) async throws -> HTTPClient {
    let access = try await access(for: id)

    guard access.secrets.hasCredentials else {
      throw GatewayAccessError.signedOut
    }

    let credentials: any CredentialProvider =
      switch access.mode {
      case .sessionToken:
        SessionTokenCredentials(token: access.secrets.sessionToken ?? "")
      case .nativePKCE:
        NativePKCECredentials(
          baseURL: access.baseURL,
          coordinator: try coordinator(for: id, baseURL: access.baseURL, headers: access.secrets.extraHeaders),
          extraHeaders: access.secrets.extraHeaders,
          transport: services.transport
        )
      case .cookie:
        SignInRequiredCredentials(storedMode: .cookie)
      }

    return try HTTPClient(
      baseURL: access.baseURL,
      credentials: credentials,
      extraHeaders: access.secrets.extraHeaders,
      transport: services.transport
    )
  }

  /// `/api/auth/me` on a stored gateway, as the gateway answers it (the account
  /// details a settings page shows). Who this client IS on that gateway is
  /// `probeIdentity(for:)`, the same read the live session makes.
  public func identity(for id: String) async throws -> AuthIdentity {
    try await client(for: id).authMe()
  }

  /// Who a stored gateway says this client is, by the session's rule
  /// (`IdentityProbe.read`): a session token is anonymous without asking. Feed it
  /// to `GatewayIdentityState.after(_:)`.
  public func probeIdentity(for id: String) async -> IdentityProbe {
    do {
      return await IdentityProbe.read(try await client(for: id))
    } catch {
      return .failed(ChatResolver.describe(error))
    }
  }

  // MARK: - Changing

  /**
   Sign out of one gateway on this device: the live session ends, a native grant is handed back
   when the gateway advertises `native_revoke` (best effort, bounded by the probe's and the revoke's
   timeouts), then the engine deletes the six sign-in items (the way in, custom headers and front
   door, with them, as the Expo build does). The address stays. Push stops for it; the share sheet
   stops sending to it.
   */
  public func signOut(_ id: String) async {
    await endSession?(id)

    if let key = directory.entry(id: id)?.key {
      purgeSurfaces?(key)
    }

    await revokeIfAdvertised(id)
    try? await sync.signOut(id: id, scope: .thisDevice)
    do {
      try await push?.retire(gatewayId: id)
      pushStillRegistered.remove(id)
    } catch {
      // The retire stores its mark first and changes nothing when it cannot: the
      // sign-out stands, but this gateway can still send notifications here.
      pushStillRegistered.insert(id)
    }
    _ = share?.drop(gatewayId: id)
    credentialsChanged(id, signedIn: false)
  }

  /**
   Remove a gateway: the engine is asked first whether it takes the removal in this scope (a
   refused one, such as "Remove from All Devices" for a gateway that is no longer synced, throws
   here with the session and the grant untouched). Then the live session ends, its grant is handed
   back (the credentials are still there to do it with), and the directory removes it through the
   engine, which purges what this device kept for it. `onRemoved` finishes the rest
   (`forgotten(_:)`).
   */
  public func remove(_ id: String, scope: RemovalScope = .thisDevice) async throws {
    try await sync.checkRemoval(id: id, scope: scope)

    // Read now: once the directory has removed it, its key is gone with it.
    let key = directory.entry(id: id)?.key

    await endSession?(id)
    await revokeIfAdvertised(id)
    try await directory.remove(id: id, scope: scope)

    // Only once the removal went through: a refused one leaves the gateway, and what is queued for it.
    if let key {
      purgeSurfaces?(key)
    }
  }

  /// A gateway left the list (`GatewayDirectory.onRemoved`, whoever removed it): forget what this
  /// process holds for it, and stop the share sheet sending to it. The engine removed the secrets.
  public func forgotten(_ id: String) async {
    _ = share?.drop(gatewayId: id)
    statuses[id] = nil
    credentialsChanged(id)
  }

  /// The credentials of a gateway changed (onboarding, the sign-in sheet, a sign-out).
  public func credentialsChanged(_ id: String, signedIn: Bool? = nil) {
    coordinators[id] = nil
    credentialsRevision[id, default: 0] += 1

    if let signedIn {
      statuses[id] = signedIn ? .signedIn : .signedOut
    }
  }

  /// A finished sign-in (every one lands here, from setup and from the sign-in sheet): iCloud Sync
  /// stops asking for it, push resumes for the gateway, and when it is the live one the share sheet
  /// gets what it sends with.
  func signedIn(_ id: String) async {
    iCloudSync.signedIn(id)
    await push?.resume(gatewayId: id)

    guard directory.activeId == id, let share, let access = try? await access(for: id) else {
      return
    }

    let tokens = access.mode == .nativePKCE
      ? try? await coordinator(for: id, baseURL: access.baseURL, headers: access.secrets.extraHeaders).current()
      : nil
    let record = ShareDeliveryRecord.build(
      gatewayId: id,
      gatewayKey: GatewayKey.of(access.baseURL),
      baseUrl: access.baseURL,
      authMode: access.mode.rawValue,
      headers: access.secrets.extraHeaders,
      sessionToken: access.secrets.sessionToken,
      accessToken: tokens?.accessToken,
      expiresAt: tokens?.expiresAt ?? 0
    )

    if let record {
      _ = share.publish(record)
    }
  }

  /// Hand a native grant back, when the gateway takes it (`native_revoke`). Never throws, and
  /// changes nothing stored: the engine deletes the credentials afterwards.
  private func revokeIfAdvertised(_ id: String) async {
    guard let access = try? await access(for: id), access.mode == .nativePKCE,
      let coordinator = try? coordinator(for: id, baseURL: access.baseURL, headers: access.secrets.extraHeaders),
      let held = try? await coordinator.current(), !held.refreshToken.isEmpty
    else {
      return
    }

    let headers = access.secrets.extraHeaders

    guard (try? await services.probe(access.baseURL, headers))?.supportsNativeRevoke == true,
      let url = try? GatewayAddress.apiURL(access.baseURL, path: NativePKCECredentials.revokePath)
    else {
      return
    }

    let body = JSONValue.object(["refresh_token": .string(held.refreshToken), "provider": .string(held.provider)])

    _ = try? await services.transport.requestText(
      url,
      JSONRequest(
        method: "POST",
        headers: (try? GatewayAddress.normalizeHeaders(headers)) ?? [:],
        body: body,
        timeoutMs: NativePKCECredentials.revokeTimeoutMs
      )
    )
  }
}

extension GatewayAccounts {
  /**
   The app's accounts over its launch, with a loopback listener that answers the browser with
   `pages`. A gateway that leaves the list (`GatewayDirectory.onRemoved`) is forgotten here too.
   */
  public static func live(launch: AppLaunch, pages: LoopbackPages) -> GatewayAccounts {
    // One services value for the whole app, so every window shares the one browser sign-in gate.
    let services = GatewayServices(makeListener: { LoopbackCallbackListener(pages: pages) })
    let accounts = GatewayAccounts(launch: launch, services: services, share: ShareDeliveryPublisher.live())

    launch.gateways.onRemoved = { [weak accounts] id in
      await accounts?.forgotten(id)
    }

    accounts.follow()
    return accounts
  }
}
