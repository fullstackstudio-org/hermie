import Foundation
import HermieGateway
import HermieStore
import Observation

/// What is stored for one gateway, read back together: its config and its secrets.
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
 The credentials side of the configured gateways: who is signed in where, signing out, forgetting a
 removed gateway's secrets, and one `TokenCoordinator` per gateway for everything in this process that
 calls it with a bearer.

 One coordinator per gateway matters: a refresh token rotates, and two coordinators refreshing the
 same grant would spend it twice, which a provider with reuse detection answers by revoking the
 session. Anything that needs the stored tokens (the account page, sign-out, and the session) asks
 `coordinator(for:)`; a change of credentials bumps `credentialsRevision`, and drops the cached one.

 `GatewayDirectory.onRemoved` is set to `forget(_:)` by the app.
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

  /// Per gateway id. A gateway not read yet is `.unknown`.
  public private(set) var statuses: [String: Status] = [:]
  /// Per gateway id: bumped whenever its stored credentials changed (signed in, out, or removed).
  public private(set) var credentialsRevision: [String: Int] = [:]

  /// The address of every gateway seen, so a removed one can still be revoked at.
  @ObservationIgnored private var remembered: [String: String] = [:]
  @ObservationIgnored private var coordinators: [String: (baseURL: String, coordinator: TokenCoordinator)] = [:]
  @ObservationIgnored private var following = false

  public init(directory: GatewayDirectory, services: GatewayServices) {
    self.directory = directory
    self.services = services
  }

  public func status(for id: String) -> Status {
    statuses[id] ?? .unknown
  }

  /// Keep the remembered addresses and the statuses in step with the gateway list. Idempotent.
  public func follow() {
    guard !following else {
      return
    }

    following = true
    observeDirectory()
  }

  private func observeDirectory() {
    let entries = withObservationTracking {
      directory.entries
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in self?.observeDirectory() }
    }

    for entry in entries {
      remembered[entry.id] = entry.address
    }

    Task { await refresh() }
  }

  /// Read whether each configured gateway has a credential stored.
  public func refresh() async {
    for entry in directory.entries {
      remembered[entry.id] = entry.address

      let status: Status = ((try? await access(for: entry.id))?.secrets.hasCredentials ?? false) ? .signedIn : .signedOut

      if statuses[entry.id] != status {
        statuses[entry.id] = status
      }
    }
  }

  // MARK: - Reading

  public func config(for id: String) async -> StoredGatewayConfig? {
    let key = StoredGatewayConfig.key(gatewayId: id)

    return StoredGatewayConfig.decode(try? await services.store.read { try $0.kvValue(forKey: key) })
  }

  /// The config and the secrets of one gateway. The address falls back to the registry's when the
  /// config is missing, and the mode to the registry's auth kind.
  public func access(for id: String) async throws -> GatewayAccess {
    let config = await config(for: id)

    guard let baseURL = config?.baseUrl ?? directory.entry(id: id)?.address ?? remembered[id] else {
      throw GatewayAccessError.unknownGateway
    }

    let mode = config?.mode ?? .nativePKCE
    let keys = try Self.keys(id)
    let storage = services.secrets
    let secrets: StoredGatewaySecrets

    do {
      secrets = try await services.offMain {
        try GatewaySecrets.load(storage: storage, keys: keys, baseURL: baseURL, mode: mode)
      }
    } catch {
      throw GatewayAccessError.keychain
    }

    return GatewayAccess(id: id, baseURL: baseURL, mode: mode, config: config, secrets: secrets)
  }

  /// The one token coordinator for a gateway's stored tokens.
  public func coordinator(for id: String, baseURL: String, headers: [String: String]) throws -> TokenCoordinator {
    if let cached = coordinators[id], cached.baseURL == baseURL {
      return cached.coordinator
    }

    let store = SecretTokenStore(storage: services.secrets, keys: try Self.keys(id))
    let coordinator = services.tokenCoordinator(store: store, baseURL: baseURL, headers: headers)

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

  /// `/api/auth/me` on a stored gateway.
  public func identity(for id: String) async throws -> AuthIdentity {
    try await client(for: id).authMe()
  }

  // MARK: - Changing

  /**
   Sign out of one gateway: hand a native grant back when the gateway advertises `native_revoke`
   (best effort, bounded by the probe's and the revoke's timeouts), then delete the credential. The
   way in (custom headers, front door) and the address stay, so signing in again asks for nothing
   but the sign-in.
   */
  public func signOut(_ id: String) async {
    if let access = try? await access(for: id) {
      if access.mode == .nativePKCE, let coordinator = try? coordinator(for: id, baseURL: access.baseURL, headers: access.secrets.extraHeaders) {
        await revoke(baseURL: access.baseURL, headers: access.secrets.extraHeaders, coordinator: coordinator)
      }
    }

    if let keys = try? Self.keys(id) {
      let storage = services.secrets

      _ = try? await services.offMain {
        for key in [keys.accessToken, keys.refreshToken, keys.tokenMeta, keys.sessionToken] {
          try? storage.delete(key)
        }
      }
    }

    try? await GatewayRegistration.signedOut(id: id, in: services.store)

    credentialsChanged(id)
    statuses[id] = .signedOut
  }

  /**
   A gateway was removed from the list (`GatewayDirectory.onRemoved`): revoke a native grant when the
   gateway advertises it, then delete every secret stored for it. The registry and the key-value
   store were purged before this is called, so the address comes from what was remembered.
   */
  public func forget(_ id: String) async {
    if let baseURL = remembered[id], let keys = try? Self.keys(id) {
      let storage = services.secrets
      let stored = try? await services.offMain {
        try GatewaySecrets.load(storage: storage, keys: keys, baseURL: baseURL, mode: .nativePKCE)
      }

      if let stored, stored.hasCredentials, stored.canRefresh,
        let coordinator = try? coordinator(for: id, baseURL: baseURL, headers: stored.extraHeaders) {
        await revoke(baseURL: baseURL, headers: stored.extraHeaders, coordinator: coordinator)
      }
    }

    if let all = try? SecretKeys.gateway(id).all {
      let storage = services.secrets

      _ = try? await services.offMain {
        for key in all {
          try? storage.delete(key)
        }
      }
    }

    remembered[id] = nil
    statuses[id] = nil
    credentialsChanged(id)
  }

  /// The credentials of a gateway were written by someone else (onboarding, the sign-in sheet).
  public func credentialsChanged(_ id: String, signedIn: Bool? = nil) {
    coordinators[id] = nil
    credentialsRevision[id, default: 0] += 1

    if let signedIn {
      statuses[id] = signedIn ? .signedIn : .signedOut
    }
  }

  /// `NativePKCECredentials.signOut()` with the probe's verdict on `native_revoke`. Never throws: the
  /// local wipe happens either way.
  private func revoke(baseURL: String, headers: [String: String], coordinator: TokenCoordinator) async {
    let canRevoke = (try? await services.probe(baseURL, headers))?.supportsNativeRevoke ?? false
    let credentials = NativePKCECredentials(
      baseURL: baseURL,
      coordinator: coordinator,
      extraHeaders: headers,
      canRevoke: canRevoke,
      transport: services.transport
    )

    try? await credentials.signOut()
  }

  static func keys(_ id: String) throws -> GatewaySecretKeys {
    do {
      return try GatewaySecretKeys(gatewayID: id)
    } catch {
      throw GatewayAccessError.unknownGateway
    }
  }
}

extension GatewayAccounts {
  /**
   The app's accounts: the launch's store, the keychain, and a loopback listener that answers the
   browser with `pages`. Removing a gateway (`GatewayDirectory.onRemoved`) forgets its secrets.
   */
  public static func live(launch: AppLaunch, pages: LoopbackPages) -> GatewayAccounts {
    // One services value for the whole app, so every window shares the one browser sign-in gate.
    let services = GatewayServices(
      store: launch.store,
      secrets: KeychainStore(),
      makeListener: { LoopbackCallbackListener(pages: pages) }
    )
    let accounts = GatewayAccounts(directory: launch.gateways, services: services)

    launch.gateways.onRemoved = { [weak accounts] id in
      await accounts?.forget(id)
    }

    accounts.follow()
    return accounts
  }
}
