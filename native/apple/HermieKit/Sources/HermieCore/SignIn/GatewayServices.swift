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
 The browser half of a passkey self-enrolment (plan `confirm-passkey.md`, "Flows — Native app" step
 2): a sign-in through the system browser that completes a fresh-authentication grant instead of
 signing in. `PasskeyModel.beginSelfEnrolment` calls it; tests replace it.
 */
@MainActor
public protocol PasskeyReauthenticating: AnyObject {
  /// Sign in again for `grantID` through `presenter`. The token set is not touched.
  func reauthenticate(grantID: String, provider: String?, presenter: any BrowserSessionPresenting) async
    -> Result<ReauthCompletion, SignInProblem>
  /// The app is in front again: listen again for the attempt in progress, if any (iOS may have
  /// reclaimed a suspended app's socket while the person was in another app).
  func appBecameActive() async
  /// End the attempt in progress, if any: its sheet closes, its listener stops, and it answers
  /// `cancelled`. Another attempt in the browser gate (a sign-in) is left alone.
  func cancel() async
}

/**
 The app's re-authentication for one gateway: the sign-in's own machinery, reused. The same one
 browser attempt at a time (`GatewayServices.browserGate`: it ends a sign-in in progress, and a
 sign-in started meanwhile ends it), the same listener, timeout and sheet as `BrowserSignIn.run`,
 and the app lock reads the sheet as it reads the system passkey sheet (`AppLock.ceremonyBegan`):
 the resign the sheet causes does not lock the app under it, while a real departure still counts.
 */
@MainActor
public final class BrowserReauthenticator: PasskeyReauthenticating {
  private let services: GatewayServices
  private let credentials: NativePKCECredentials
  private let lock: AppLock?
  private var activeListener: (any LoopbackCallbackListening)?
  private var activeTask: Task<Void, Never>?
  private var attempts = 0

  public init(services: GatewayServices, credentials: NativePKCECredentials, lock: AppLock?) {
    self.services = services
    self.credentials = credentials
    self.lock = lock
  }

  public func reauthenticate(grantID: String, provider: String?, presenter: any BrowserSessionPresenting) async
    -> Result<ReauthCompletion, SignInProblem>
  {
    let gate = services.browserGate
    let previous = gate.current
    let listener = services.makeListener()
    let services = services
    let credentials = credentials
    let lock = lock
    let outcome = ReauthOutcome()

    previous?.cancel()
    attempts += 1

    let attempt = attempts
    let task = Task { @MainActor in
      await previous?.value

      guard !Task.isCancelled else {
        outcome.value = .failure(.cancelled)
        return
      }

      lock?.ceremonyBegan()
      outcome.value = await BrowserSignIn.reauthenticate(
        credentials: credentials,
        grantID: grantID,
        provider: provider,
        listener: listener,
        presenter: presenter,
        timeout: services.signInTimeout,
        sleep: services.sleep
      )
      lock?.ceremonyEnded()
    }

    gate.current = task
    activeListener = listener
    activeTask = task

    await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }

    if attempt == attempts {
      activeListener = nil
      activeTask = nil
    }

    return outcome.value ?? .failure(.cancelled)
  }

  public func appBecameActive() async {
    await activeListener?.resume()
  }

  public func cancel() async {
    guard let task = activeTask else {
      return
    }

    // The attempt's own task: the sheet closes and the listener stops as for any cancellation, and
    // the lock's guard, taken inside it, is given back there. Waits until it has.
    task.cancel()
    await task.value
  }
}

/// Where the attempt's task leaves its result.
@MainActor
private final class ReauthOutcome {
  var value: Result<ReauthCompletion, SignInProblem>?
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
