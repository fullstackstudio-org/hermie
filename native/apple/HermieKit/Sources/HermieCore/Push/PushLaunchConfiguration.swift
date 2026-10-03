import Foundation

/**
 What a launch needs to know to register for push: the relay origin, the APNs topic and the APNs
 environment. `live(bundle:)` is the app's; `disabled` is the default for tests and previews, which
 never reach a relay.

 There is no user-facing setting for the relay: the origin is the default constant in the app, and
 only a test injects another (a loopback fake).
 */
public struct PushLaunchConfiguration: Sendable {
  /// nil disables relay calls altogether (every call fails with `invalidOrigin`).
  public var relayOrigin: String?
  /// The bundle id: the relay's `topic`, checked against its allow-list.
  public var topic: String
  public var environment: APNsEnvironment
  public var environmentSource: APNsEnvironmentDetection.Source

  public init(
    relayOrigin: String?,
    topic: String,
    environment: APNsEnvironment,
    environmentSource: APNsEnvironmentDetection.Source
  ) {
    self.relayOrigin = relayOrigin
    self.topic = topic
    self.environment = environment
    self.environmentSource = environmentSource
  }

  /// The Info.plist key a build turns the relay off with (`HERMIE_PUSH` in Config/Shared.xcconfig).
  public static let infoKey = "HermiePush"

  /// The app bundle's topic and environment, and the default relay. A Debug build
  /// (`dev.hermie.app.dev`, `HermiePush` = `NO`) gets no relay: the relay does not serve its topic,
  /// and a row naming it in the person's push section would be one no notifier can deliver to.
  public static func live(bundle: Bundle = .main) -> PushLaunchConfiguration {
    let detected = APNsEnvironmentDetection.current(bundle: bundle)
    let off = (bundle.object(forInfoDictionaryKey: infoKey) as? String)?.uppercased() == "NO"

    return PushLaunchConfiguration(
      relayOrigin: off ? nil : PushRelay.defaultOrigin,
      topic: bundle.bundleIdentifier ?? "dev.hermie.app",
      environment: detected.environment,
      environmentSource: detected.source
    )
  }

  /// No relay. Tests and previews.
  public static let disabled = PushLaunchConfiguration(
    relayOrigin: nil,
    topic: "dev.hermie.app",
    environment: .sandbox,
    environmentSource: .fallback
  )

  /// The client for `relayOrigin`, or one that refuses every call.
  public func client() -> any PushRelayClient {
    relayOrigin.flatMap { HTTPPushRelayClient(origin: $0) } ?? DisabledPushRelayClient()
  }
}

/// A relay client that sends nothing: every call fails with `invalidOrigin`.
public struct DisabledPushRelayClient: PushRelayClient {
  public init() {}

  public var origin: String { "" }

  public func register(token: APNsDeviceToken, environment: APNsEnvironment, topic: String)
    async throws(PushRelayError) -> PushCapability
  {
    throw .invalidOrigin
  }

  public func update(handle: String, manageSecret: String, token: APNsDeviceToken, environment: APNsEnvironment)
    async throws(PushRelayError)
  {
    throw .invalidOrigin
  }

  public func delete(handle: String, manageSecret: String) async throws(PushRelayError) {
    throw .invalidOrigin
  }
}
