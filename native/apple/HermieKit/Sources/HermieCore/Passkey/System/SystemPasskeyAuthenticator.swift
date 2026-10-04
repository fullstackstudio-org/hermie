import AuthenticationServices
import Foundation

/**
 The app's passkey authenticator: the system passkey sheet (`ASAuthorizationController` with the
 platform provider, plan CP-9).

 - Registration: user verification required, attestation `none`, the name the model built
   (`<display name> — <gateway host>`, plan P3), the gateway's user handle, and the credentials the
   gateway already has for this user excluded.
 - Assertion: user verification required, and `allowedCredentials` always set from the request; an
   empty list is refused before any sheet (`noCredential`), so the sheet never lists the person's
   passkeys for every gateway.
 - One ceremony at a time across the app: a second call while one runs is `busy`.
 - `cancel()` dismisses the running sheet (`request.cancel` withdrew the request) and ends the
   ceremony as `cancelled` at once.
 - An error keeps the platform's domain and code and nothing else: no challenge, no credential id,
   no text the platform wrote.

 The controller sits behind `PasskeyAuthorizationDriver`, so the rules above are tested without the
 system. `LockGuardedPasskeyAuthenticator` wraps this one so the app lock does not re-lock under
 the sheet.
 */
@MainActor
public final class SystemPasskeyAuthenticator: PasskeyAuthenticator {
  /// The window the sheet is shown over; `nil` when the app has none in front.
  public typealias Anchor = @MainActor () -> ASPresentationAnchor?

  private struct Running {
    var token: UInt64
    var driver: any PasskeyAuthorizationDriver
    var continuation: CheckedContinuation<Result<PasskeyAuthorizationOutcome, PasskeyCeremonyError>, Never>
  }

  private let makeDriver: @MainActor () -> any PasskeyAuthorizationDriver
  private var running: Running?
  private var nextToken: UInt64 = 0

  /// The app's: a fresh `ASAuthorizationController` per ceremony, shown over `anchor()`.
  public convenience init(anchor: @escaping Anchor) {
    self.init(driver: { ControllerPasskeyDriver(anchor: anchor) })
  }

  /// Tests: a driver of their own per ceremony.
  init(driver: @escaping @MainActor () -> any PasskeyAuthorizationDriver) {
    makeDriver = driver
  }

  /// A ceremony is running.
  var isRunning: Bool {
    running != nil
  }

  // MARK: - PasskeyAuthenticator

  public func register(_ request: PasskeyRegistrationRequest) async throws(PasskeyCeremonyError) -> PasskeyRegistration {
    guard !request.rpID.isEmpty else {
      throw .unavailable(reason: "rp_not_configured")
    }

    let outcome = try await run(Self.registrationRequest(request))

    guard case .registration(let registration) = outcome else {
      throw .failed("The passkey sheet returned something else than a new passkey.")
    }

    return registration
  }

  public func assert(_ request: PasskeyAssertionRequest) async throws(PasskeyCeremonyError) -> PasskeyAssertionResponse {
    guard !request.rpID.isEmpty else {
      throw .unavailable(reason: "rp_not_configured")
    }

    // Never an unfiltered sheet (plan P3).
    guard !request.allowCredentialIDs.isEmpty else {
      throw .noCredential
    }

    let outcome = try await run(Self.assertionRequest(request))

    guard case .assertion(let response) = outcome else {
      throw .failed("The passkey sheet returned something else than a signature.")
    }

    guard request.allowCredentialIDs.contains(response.credentialID) else {
      throw .failed("The passkey sheet signed with a passkey the request did not allow.")
    }

    return response
  }

  public func cancel() async {
    guard let current = running else {
      return
    }

    running = nil
    current.driver.cancel()
    current.continuation.resume(returning: .failure(.cancelled))
  }

  // MARK: - The ceremony

  private func run(_ request: ASAuthorizationRequest) async throws(PasskeyCeremonyError) -> PasskeyAuthorizationOutcome {
    guard running == nil else {
      throw .busy
    }

    guard !Task.isCancelled else {
      throw .cancelled
    }

    nextToken += 1

    let token = nextToken
    let driver = makeDriver()
    let result = await withCheckedContinuation { continuation in
      running = Running(token: token, driver: driver, continuation: continuation)
      driver.perform(request) { [weak self] outcome in
        self?.finish(token, outcome)
      }
    }

    return try result.get()
  }

  /// The driver's answer for the ceremony `token`; a late answer for one already cancelled is dropped.
  private func finish(_ token: UInt64, _ outcome: PasskeyAuthorizationOutcome) {
    guard let current = running, current.token == token else {
      return
    }

    running = nil

    switch outcome {
    case .error(let domain, let code):
      current.continuation.resume(returning: .failure(Self.ceremonyError(domain: domain, code: code)))
    case .refused(let reason):
      current.continuation.resume(returning: .failure(.failed(reason)))
    case .registration, .assertion:
      current.continuation.resume(returning: .success(outcome))
    }
  }

  // MARK: - The requests

  /// The registration request: UV required, attestation `none`, the model's name and user handle.
  static func registrationRequest(_ request: PasskeyRegistrationRequest)
    -> ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest
  {
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: request.rpID)
    let registration = provider.createCredentialRegistrationRequest(
      challenge: Data(request.challenge),
      name: request.name,
      userID: Data(request.userHandle)
    )

    registration.displayName = request.displayName
    registration.userVerificationPreference = .required
    registration.attestationPreference = .none

    if !request.excludeCredentialIDs.isEmpty {
      registration.excludedCredentials = request.excludeCredentialIDs.map(Self.descriptor)
    }

    return registration
  }

  /// The assertion request: UV required, restricted to the request's credentials.
  static func assertionRequest(_ request: PasskeyAssertionRequest)
    -> ASAuthorizationPlatformPublicKeyCredentialAssertionRequest
  {
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: request.rpID)
    let assertion = provider.createCredentialAssertionRequest(challenge: Data(request.challenge))

    assertion.userVerificationPreference = .required
    assertion.allowedCredentials = request.allowCredentialIDs.map(Self.descriptor)

    return assertion
  }

  private static func descriptor(_ id: [UInt8]) -> ASAuthorizationPlatformPublicKeyCredentialDescriptor {
    ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: Data(id))
  }

  // MARK: - Errors

  /**
   What a platform error means for the model. Only the domain and the code are read: the text the
   platform wrote is never passed on, so nothing it might echo reaches a log or the gateway.

   | Error | Ceremony error |
   | --- | --- |
   | `ASAuthorizationError.canceled` | `cancelled`: nothing is sent, the app's sheet stays |
   | `.notInteractive` | `unavailable(not_interactive)` |
   | `.deviceNotConfiguredForPasskeyCreation` | `unavailable(device_not_configured)` |
   | `.matchedExcludedCredential` | `failed`: this provider already holds a passkey for the account |
   | `.unknown`, `.invalidResponse`, `.notHandled`, `.failed`, any other | `failed(domain code)` |

   The iOS 27 and macOS 27 SDKs have no code of their own for "no passkey on this device": the
   system's sheet for it ("You don't have a saved passkey on this device") ends as `.canceled`, the
   code of a person dismissing a sheet that offered a passkey, and nothing the app may read tells
   the two apart. So both stay `cancelled` here, and the model reads it with what this device knows
   (`PasskeyModel.holdsNoneHere`): a dismissal on a device that holds none of the request's passkeys
   is explained; one on a device that has answered with one of them stays a plain dismissal.
   */
  nonisolated static func ceremonyError(domain: String, code: Int) -> PasskeyCeremonyError {
    guard domain == ASAuthorizationError.errorDomain else {
      return .failed("The passkey sheet failed (\(domain) \(code)).")
    }

    switch ASAuthorizationError.Code(rawValue: code) {
    case .canceled?:
      return .cancelled
    case .notInteractive?:
      return .unavailable(reason: "not_interactive")
    case .deviceNotConfiguredForPasskeyCreation?:
      return .unavailable(reason: "device_not_configured")
    case .matchedExcludedCredential?:
      return .failed("A passkey for this account is already in this passkey provider (ASAuthorizationError \(code)).")
    default:
      return .failed("The passkey sheet failed (ASAuthorizationError \(code)).")
    }
  }
}
