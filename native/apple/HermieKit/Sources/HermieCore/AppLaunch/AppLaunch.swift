import Foundation
import HermieStore
import Observation

/// Something about this launch the person should be told once.
public enum LaunchNotice: Sendable, Hashable, Identifiable {
  /// The database was corrupt and has been recreated; what could be read was kept.
  case recovered
  /// The lock setting could not be restored (or read) and may need switching back on.
  case lockSettingNotRestored
  /// The database could not be opened; this launch runs on memory and keeps nothing.
  case runningInMemory

  public var id: Self { self }
}

/**
 Where a launch keeps its files and who it asks to unlock. `live()` is the app's; tests build one.
 */
public struct LaunchEnvironment: Sendable {
  /// The directory `hermie.sqlite` and the lock mirror live in. nil runs on memory (tests, previews).
  public var dataDirectory: URL?
  /// The App Group container, which the database must never be inside.
  public var appGroupContainer: URL?
  public var authenticator: any DeviceAuthenticator
  public var clock: @Sendable () -> Double
  /// Where secrets live: the keychain in the app, memory in tests. The device-only set: credentials,
  /// push secrets, the sync print key.
  public var secrets: any SyncDeviceSecretStore
  /// The synced set in iCloud Keychain; only the sync engine reads it.
  public var synced: any SyncedItemStore
  /// Push: the relay, the topic and the APNs environment.
  public var push: PushLaunchConfiguration
  #if DEBUG
    /// Debug builds only: state written before anything reads it, and switches for the UI tests.
    public var testHooks: LaunchTestHooks?
  #endif

  public init(
    dataDirectory: URL?,
    appGroupContainer: URL? = nil,
    authenticator: any DeviceAuthenticator,
    clock: @escaping @Sendable () -> Double = AppLock.monotonicMilliseconds,
    secrets: any SyncDeviceSecretStore,
    synced: any SyncedItemStore,
    push: PushLaunchConfiguration = .disabled
  ) {
    self.dataDirectory = dataDirectory
    self.appGroupContainer = appGroupContainer
    self.authenticator = authenticator
    self.clock = clock
    self.secrets = secrets
    self.synced = synced
    self.push = push
  }

  /// For tests, previews and the UI tests: both keychain sets in memory. The keychain stores are
  /// required parameters everywhere else, so no production caller keeps a secret in memory by
  /// leaving one out.
  public static func inMemory(
    dataDirectory: URL?,
    appGroupContainer: URL? = nil,
    authenticator: any DeviceAuthenticator,
    clock: @escaping @Sendable () -> Double = AppLock.monotonicMilliseconds,
    push: PushLaunchConfiguration = .disabled
  ) -> LaunchEnvironment {
    LaunchEnvironment(
      dataDirectory: dataDirectory,
      appGroupContainer: appGroupContainer,
      authenticator: authenticator,
      clock: clock,
      secrets: InMemorySecretStore(),
      synced: InMemorySyncedItemStore(),
      push: push
    )
  }

  /**
   The app's own environment: Application Support (in a folder named after the bundle on the Mac,
   where an unsandboxed build would otherwise share the user's top-level folder), the App Group
   container, the system authenticator and the keychain (device-only and synced). The UI tests'
   environment keeps its keychain in memory. A debug build reads the UI tests' launch arguments
   here and nowhere else (`LaunchTestHooks`).
   */
  public static func live(bundle: Bundle = .main, arguments: [String] = ProcessInfo.processInfo.arguments)
    -> LaunchEnvironment
  {
    #if DEBUG
      if let hooks = LaunchTestHooks(arguments: arguments) {
        var environment = LaunchEnvironment.inMemory(
          dataDirectory: hooks.dataDirectory,
          appGroupContainer: nil,
          authenticator: hooks.authenticator
        )

        environment.testHooks = hooks

        return environment
      }
    #endif

    return LaunchEnvironment(
      dataDirectory: defaultDataDirectory(bundle: bundle),
      appGroupContainer: AppGroupContainer.system()?.url,
      authenticator: SystemAuthenticator(),
      secrets: KeychainStore(),
      synced: ICloudKeychainStore(),
      push: .live(bundle: bundle)
    )
  }

  static func defaultDataDirectory(bundle: Bundle) -> URL? {
    guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      return nil
    }

    #if os(macOS)
      return support.appendingPathComponent(bundle.bundleIdentifier ?? "dev.hermie.app", isDirectory: true)
    #else
      return support
    #endif
  }
}

/**
 The launch: the local store opened (or recovered) before the first frame, the lock decided from
 what that found, and the gateway list read.

 `init` runs `StoreLaunch.run` synchronously, so the app shell constructs this in its `App` init and
 the first frame already knows whether the launch had to start locked. Anything asynchronous (the
 lock preference, the registry) is read by `start()`, and the lock gate draws nothing until the
 preference is known.

 When the database cannot be opened, or `run` refuses the location, the app runs on an in-memory
 store for this launch and says so (`LaunchNotice.runningInMemory`).
 */
@MainActor
@Observable
public final class AppLaunch {
  public let environment: LaunchEnvironment
  public let store: SQLiteStore
  public let keyValues: KeyValueStore
  /// What opening the store found; nil when the launch could not even try.
  public let report: StoreLaunch.Report?
  public let lock: AppLock
  public let gateways: GatewayDirectory
  /// The one bridge to iCloud Keychain, and the only path that adds, moves or removes a gateway.
  public let sync: GatewaySyncEngine
  /// Push notifications: the switch, the permission and the relay registrations.
  public let push: PushController
  /// Told once each, in this order, until dismissed.
  public private(set) var notices: [LaunchNotice]
  /// `start()` has finished: the gateway list is read and the sync engine knows which credentials
  /// belong to an origin their gateway left. Nothing may load a credential before (`LiveGateway`
  /// waits for it).
  public private(set) var ready = false

  private var started = false

  /// - Parameter pushSystem: the platform's notification machinery (the app shell passes the real
  ///   one from HermieUI); nil is a system with no notifications.
  public init(environment: LaunchEnvironment, pushSystem: (any PushSystem)? = nil) {
    self.environment = environment

    let authenticator = environment.authenticator
    let canAuthenticate: @Sendable () -> Bool = { authenticator.canAuthenticate() }

    var report: StoreLaunch.Report?
    var store: SQLiteStore

    do {
      let result: StoreLaunch.Result

      if let directory = environment.dataDirectory {
        result = try StoreLaunch.run(
          applicationSupport: directory,
          appGroupContainer: environment.appGroupContainer,
          deviceCanAuthenticate: canAuthenticate
        )
      } else {
        result = try StoreLaunch.run(database: .inMemory, lockMirror: nil, deviceCanAuthenticate: canAuthenticate)
      }

      store = result.store
      report = result.report
    } catch {
      // Only a location inside the App Group lands here. Run on memory, locked like any other
      // launch that could not read its lock setting. An in-memory database that cannot open
      // leaves nothing to run on at all.
      store = try! SQLiteStore(.inMemory)
      report = nil
    }

    let unknownLock = report?.requiresLockThisLaunch ?? canAuthenticate()

    self.store = store
    self.report = report
    self.keyValues = KeyValueStore(store: store)
    self.lock = AppLock(
      settings: KeyValueStore(store: store),
      authenticator: authenticator,
      forcedLock: unknownLock,
      clock: environment.clock
    )
    let sync = GatewaySyncEngine(database: store, secrets: environment.secrets, synced: environment.synced)
    self.sync = sync
    self.gateways = GatewayDirectory(
      store: GatewayRegistryStore(store: store), changes: KeyValueStore(store: store), remover: sync)
    self.push = PushController(
      system: pushSystem ?? InertPushSystem(),
      registrar: PushRegistrar(
        client: environment.push.client(),
        store: PushRegistrationStore(keyValues: KeyValueStore(store: store), secrets: environment.secrets)
      ),
      settings: KeyValueStore(store: store),
      topic: environment.push.topic,
      environment: environment.push.environment,
      environmentSource: environment.push.environmentSource
    )

    var notices: [LaunchNotice] = []

    if report?.recovered == true {
      notices.append(.recovered)
    }

    if report?.lockSettingNotRestored ?? true {
      notices.append(.lockSettingNotRestored)
    }

    if report == nil || report?.openFailure != nil {
      notices.append(.runningInMemory)
    }

    self.notices = notices
  }

  /// Read the lock preference, then the gateways. Idempotent; the first window calls it.
  public func start() async {
    guard !started else {
      return
    }

    started = true

    #if DEBUG
      if let hooks = environment.testHooks {
        await hooks.seed(keyValues)
      }
    #endif

    await lock.hydrate()

    if lock.settingNeedsAttention, !notices.contains(.lockSettingNotRestored) {
      notices.append(.lockSettingNotRestored)
    }

    await gateways.load()

    // I11: sync at launch, once the gateway list is known (never on one that is unreadable or from
    // a newer build). Which gateways' credentials are bound to an origin they left is read first,
    // before anything can load a credential. With sync off or undisclosed, the reconcile only
    // cleans up locally.
    if gateways.pushGateways != nil {
      await sync.prepare()
      await sync.trigger(.launch)
    }

    ready = true
  }

  /// A scene became active (I11: at most once per 30 seconds, the engine throttles).
  public func becameActive() async {
    guard started, gateways.pushGateways != nil else {
      return
    }

    await sync.trigger(.foreground)
  }

  public func dismiss(_ notice: LaunchNotice) {
    notices.removeAll { $0 == notice }
  }
}
