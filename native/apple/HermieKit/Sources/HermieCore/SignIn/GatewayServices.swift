import Foundation
import HermieGateway

/// What a probe of a typed address found, and where (`ResolvedAddress`, which has no public init).
public struct OnboardingProbe: Sendable, Equatable {
  public var result: ProbeResult
  /// The address that answered, scheme included.
  public var baseURL: String
  /// No scheme was typed, https did not answer at all, and http did.
  public var foundOverHTTP: Bool

  public init(result: ProbeResult, baseURL: String, foundOverHTTP: Bool) {
    self.result = result
    self.baseURL = baseURL
    self.foundOverHTTP = foundOverHTTP
  }
}

/**
 What onboarding, sign-in and sign-out reach outside themselves for, besides the launch (its store,
 its sync engine, which is the only writer of the gateway list and of every credential, and its
 push): the network, the loopback listener and the clock. Tests replace any of it.
 */
public struct GatewayServices: Sendable {
  public var transport: HTTPTransport
  /// `Probe.resolveGatewayAddress` (ADR-0014): https first, http only when no scheme was typed.
  public var resolve: @Sendable (_ raw: String, _ customHeaders: [String: String], _ frontDoor: FrontDoor) async throws
    -> OnboardingProbe
  /// `Probe.probeGateway` of a known address, with its wire headers.
  public var probe: @Sendable (_ baseURL: String, _ headers: [String: String]) async throws -> ProbeResult
  /// A fresh listener per browser sign-in attempt.
  public var makeListener: @Sendable () -> any LoopbackCallbackListening
  public var nowMilliseconds: @Sendable () -> Double
  public var nowSeconds: @Sendable () -> Double
  public var sleep: @Sendable (Duration) async throws -> Void
  /// How long typing settles before the address is probed.
  public var probeDebounce: Duration
  /// How long a browser sign-in may stay open (`SIGN_IN_TIMEOUT_MS`).
  public var signInTimeout: Duration
  /// Where the one browser sign-in at a time is kept (`BrowserSignInGate.process` in the app).
  public var browserGate: BrowserSignInGate

  public init(
    transport: HTTPTransport = HTTPTransport(),
    resolve: (@Sendable (String, [String: String], FrontDoor) async throws -> OnboardingProbe)? = nil,
    probe: (@Sendable (String, [String: String]) async throws -> ProbeResult)? = nil,
    makeListener: @escaping @Sendable () -> any LoopbackCallbackListening = { LoopbackCallbackListener() },
    nowMilliseconds: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 },
    nowSeconds: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    probeDebounce: Duration = .milliseconds(500),
    signInTimeout: Duration = .seconds(600),
    browserGate: BrowserSignInGate? = nil
  ) {
    self.transport = transport
    self.resolve =
      resolve ?? { raw, custom, frontDoor in
        let found = try await Probe.resolveGatewayAddress(
          raw,
          customHeaders: custom,
          frontDoor: frontDoor,
          transport: transport
        )

        return OnboardingProbe(result: found.probe, baseURL: found.baseURL, foundOverHTTP: found.foundOverHTTP)
      }
    self.probe = probe ?? { baseURL, headers in try await Probe.probeGateway(baseURL, extraHeaders: headers, transport: transport) }
    self.makeListener = makeListener
    self.nowMilliseconds = nowMilliseconds
    self.nowSeconds = nowSeconds
    self.sleep = sleep
    self.probeDebounce = probeDebounce
    self.signInTimeout = signInTimeout
    self.browserGate = browserGate ?? BrowserSignInGate()
  }

  /// A coordinator over one gateway's stored tokens, refreshing through `NativeAuth`.
  func tokenCoordinator(store: any TokenStore, baseURL: String, headers: [String: String]) -> TokenCoordinator {
    let transport = transport

    return TokenCoordinator(
      store: store,
      refresh: { held in
        try await NativeAuth.refreshTokens(
          baseURL: baseURL,
          refreshToken: held.refreshToken,
          provider: held.provider,
          options: NativeAuth.Options(transport: transport, extraHeaders: headers)
        )
      },
      nowSeconds: nowSeconds
    )
  }
}

/**
 The browser sign-in in progress, so there is one at a time: the callback port is one per device. A
 new attempt, from any window, cancels the one before and waits until it has let go of the port.
 */
@MainActor
public final class BrowserSignInGate: Sendable {
  public nonisolated init() {}

  /// The attempt in progress, if any.
  public var current: Task<Void, Never>?
}
