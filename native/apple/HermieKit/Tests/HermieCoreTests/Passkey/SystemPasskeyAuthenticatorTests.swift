import AuthenticationServices
import Foundation
import Testing

@testable import HermieCore

/// A driver the test answers by hand: it records what it was asked and whether it was cancelled.
@MainActor
private final class FakeDriver: PasskeyAuthorizationDriver {
  var requests: [ASAuthorizationRequest] = []
  var cancelled = false
  private var completion: (@MainActor (PasskeyAuthorizationOutcome) -> Void)?

  var isPerforming: Bool { completion != nil }

  func perform(_ request: ASAuthorizationRequest, completion: @escaping @MainActor (PasskeyAuthorizationOutcome) -> Void) {
    requests.append(request)
    self.completion = completion
  }

  func cancel() {
    cancelled = true
  }

  /// Answer as the system would; the completion stays callable, as a late delegate call would be.
  func complete(_ outcome: PasskeyAuthorizationOutcome) {
    completion?(outcome)
  }
}

/// Hands out one fresh fake per ceremony and keeps them.
@MainActor
private final class Drivers {
  var made: [FakeDriver] = []

  var last: FakeDriver? { made.last }

  func make() -> any PasskeyAuthorizationDriver {
    let driver = FakeDriver()
    made.append(driver)
    return driver
  }
}

private let challenge = [UInt8](repeating: 0xC4, count: 32)
private let allowed: [[UInt8]] = [[1, 2, 3], [4, 5, 6]]

private func assertion(_ id: [UInt8] = [4, 5, 6]) -> PasskeyAssertionResponse {
  PasskeyAssertionResponse(
    credentialID: id, authenticatorData: [9], clientDataJSON: [8], signature: [7], userHandle: [6])
}

private let registration = PasskeyRegistration(
  credentialID: [1], clientDataJSON: [2], attestationObject: [3], transports: ["internal"])

private let assertionRequest = PasskeyAssertionRequest(
  rpID: "confirm.hermie.dev", challenge: challenge, allowCredentialIDs: allowed)

private let registrationRequest = PasskeyRegistrationRequest(
  rpID: "confirm.hermie.dev",
  challenge: challenge,
  userHandle: [UInt8](repeating: 0x55, count: 32),
  name: "Hermie — gw.example.com",
  displayName: "Hermie — gw.example.com",
  excludeCredentialIDs: [[7, 7]]
)

@MainActor
private func waitUntilPerforming(_ drivers: Drivers, count: Int = 1) async {
  while drivers.made.count < count || drivers.last?.isPerforming != true {
    await Task.yield()
  }
}

@MainActor
@Suite("System passkey authenticator")
struct SystemPasskeyAuthenticatorTests {
  // MARK: The requests

  @Test("registration: UV required, attestation none, the model's name, user handle and exclusions")
  func registrationRequestShape() {
    let request = SystemPasskeyAuthenticator.registrationRequest(registrationRequest)

    #expect(request.relyingPartyIdentifier == "confirm.hermie.dev")
    #expect(request.challenge == Data(challenge))
    #expect(request.userID == Data(repeating: 0x55, count: 32))
    #expect(request.name == "Hermie — gw.example.com")
    #expect(request.displayName == "Hermie — gw.example.com")
    #expect(request.userVerificationPreference == .required)
    #expect(request.attestationPreference == .none)
    #expect(request.excludedCredentials?.map(\.credentialID) == [Data([7, 7])])
  }

  @Test("assertion: UV required and restricted to the request's credentials")
  func assertionRequestShape() {
    let request = SystemPasskeyAuthenticator.assertionRequest(assertionRequest)

    #expect(request.relyingPartyIdentifier == "confirm.hermie.dev")
    #expect(request.challenge == Data(challenge))
    #expect(request.userVerificationPreference == .required)
    #expect(request.allowedCredentials.map(\.credentialID) == [Data([1, 2, 3]), Data([4, 5, 6])])
  }

  // MARK: Running a ceremony

  @Test("an assertion runs one sheet and returns what it signed")
  func assertionRuns() async throws {
    let drivers = Drivers()
    let authenticator = SystemPasskeyAuthenticator(driver: drivers.make)

    let running = Task { try await authenticator.assert(assertionRequest) }

    await waitUntilPerforming(drivers)
    #expect(drivers.last?.requests.first is ASAuthorizationPlatformPublicKeyCredentialAssertionRequest)
    drivers.last?.complete(.assertion(assertion()))

    #expect(try await running.value == assertion())
    #expect(!authenticator.isRunning)
  }

  @Test("a registration runs one sheet and returns the new passkey")
  func registrationRuns() async throws {
    let drivers = Drivers()
    let authenticator = SystemPasskeyAuthenticator(driver: drivers.make)

    let running = Task { try await authenticator.register(registrationRequest) }

    await waitUntilPerforming(drivers)
    #expect(drivers.last?.requests.first is ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest)
    drivers.last?.complete(.registration(registration))

    #expect(try await running.value == registration)
  }

  @Test("an empty allow list never shows a sheet")
  func emptyAllowList() async {
    let drivers = Drivers()
    let authenticator = SystemPasskeyAuthenticator(driver: drivers.make)
    let request = PasskeyAssertionRequest(rpID: "confirm.hermie.dev", challenge: challenge, allowCredentialIDs: [])

    await #expect(throws: PasskeyCeremonyError.noCredential) { try await authenticator.assert(request) }
    #expect(drivers.made.isEmpty)
  }

  @Test("a build without an RP never shows a sheet")
  func noRP() async {
    let drivers = Drivers()
    let authenticator = SystemPasskeyAuthenticator(driver: drivers.make)
    let request = PasskeyAssertionRequest(rpID: "", challenge: challenge, allowCredentialIDs: allowed)

    await #expect(throws: PasskeyCeremonyError.unavailable(reason: "rp_not_configured")) {
      try await authenticator.assert(request)
    }
    #expect(drivers.made.isEmpty)
  }

  @Test("a signature by a passkey the request did not allow is refused")
  func foreignCredential() async {
    let drivers = Drivers()
    let authenticator = SystemPasskeyAuthenticator(driver: drivers.make)

    let running = Task { try await authenticator.assert(assertionRequest) }

    await waitUntilPerforming(drivers)
    drivers.last?.complete(.assertion(assertion([9, 9, 9])))

    await #expect(throws: PasskeyCeremonyError.failed("The passkey sheet signed with a passkey the request did not allow.")) {
      try await running.value
    }
  }

  @Test("the wrong kind of answer, or none the driver could read, fails without sending")
  func wrongKind() async {
    let drivers = Drivers()
    let authenticator = SystemPasskeyAuthenticator(driver: drivers.make)

    let first = Task { try await authenticator.assert(assertionRequest) }
    await waitUntilPerforming(drivers)
    drivers.last?.complete(.registration(registration))
    let firstError = await #expect(throws: PasskeyCeremonyError.self) { try await first.value }
    #expect(firstError?.refusalReason == nil)

    let second = Task { try await authenticator.assert(assertionRequest) }
    await waitUntilPerforming(drivers, count: 2)
    drivers.last?.complete(.refused("There is no window to show the passkey sheet in."))
    await #expect(throws: PasskeyCeremonyError.failed("There is no window to show the passkey sheet in.")) {
      try await second.value
    }
  }

  // MARK: One at a time

  @Test("a second ceremony while one runs is busy, and the first is untouched")
  func busy() async throws {
    let drivers = Drivers()
    let authenticator = SystemPasskeyAuthenticator(driver: drivers.make)

    let first = Task { try await authenticator.assert(assertionRequest) }
    await waitUntilPerforming(drivers)

    await #expect(throws: PasskeyCeremonyError.busy) { try await authenticator.assert(assertionRequest) }
    await #expect(throws: PasskeyCeremonyError.busy) { try await authenticator.register(registrationRequest) }
    #expect(drivers.made.count == 1, "no second sheet")

    drivers.last?.complete(.assertion(assertion()))
    #expect(try await first.value == assertion())

    // Free again.
    let next = Task { try await authenticator.assert(assertionRequest) }
    await waitUntilPerforming(drivers, count: 2)
    drivers.last?.complete(.assertion(assertion()))
    #expect(try await next.value == assertion())
  }

  // MARK: Cancelling

  @Test("cancel dismisses the sheet and ends the ceremony as cancelled at once")
  func cancel() async throws {
    let drivers = Drivers()
    let authenticator = SystemPasskeyAuthenticator(driver: drivers.make)

    let running = Task { try await authenticator.assert(assertionRequest) }
    await waitUntilPerforming(drivers)
    let driver = try #require(drivers.last)

    await authenticator.cancel()

    #expect(driver.cancelled)
    await #expect(throws: PasskeyCeremonyError.cancelled) { try await running.value }
    #expect(!authenticator.isRunning)

    // The system's own "canceled" arriving late changes nothing, and a new ceremony runs.
    driver.complete(.error(domain: ASAuthorizationError.errorDomain, code: ASAuthorizationError.Code.canceled.rawValue))

    let next = Task { try await authenticator.assert(assertionRequest) }
    await waitUntilPerforming(drivers, count: 2)
    // A late answer of the first sheet does not land in the second ceremony.
    driver.complete(.assertion(assertion([1, 2, 3])))
    #expect(authenticator.isRunning)
    drivers.last?.complete(.assertion(assertion()))
    #expect(try await next.value == assertion())
  }

  @Test("cancel with nothing running does nothing")
  func cancelIdle() async {
    let drivers = Drivers()
    let authenticator = SystemPasskeyAuthenticator(driver: drivers.make)

    await authenticator.cancel()
    #expect(drivers.made.isEmpty)
  }

  @Test("a task cancelled before the sheet never shows it")
  func cancelledTask() async {
    let drivers = Drivers()
    let authenticator = SystemPasskeyAuthenticator(driver: drivers.make)
    let running = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await authenticator.assert(assertionRequest)
    }

    await #expect(throws: PasskeyCeremonyError.cancelled) { try await running.value }
    #expect(drivers.made.isEmpty)
  }

  // MARK: Errors

  nonisolated static let mapping: [(code: ASAuthorizationError.Code, error: PasskeyCeremonyError)] = [
    (.canceled, .cancelled),
    (.notInteractive, .unavailable(reason: "not_interactive")),
    (.deviceNotConfiguredForPasskeyCreation, .unavailable(reason: "device_not_configured")),
    (
      .matchedExcludedCredential,
      .failed("A passkey for this account is already in this passkey provider (ASAuthorizationError 1006).")
    ),
    (.unknown, .failed("The passkey sheet failed (ASAuthorizationError 1000).")),
    (.invalidResponse, .failed("The passkey sheet failed (ASAuthorizationError 1002).")),
    (.notHandled, .failed("The passkey sheet failed (ASAuthorizationError 1003).")),
    (.failed, .failed("The passkey sheet failed (ASAuthorizationError 1004).")),
  ]

  @Test("the platform's errors map by code", arguments: 0..<mapping.count)
  func errorMapping(index: Int) async {
    let (code, expected) = Self.mapping[index]
    let drivers = Drivers()
    let authenticator = SystemPasskeyAuthenticator(driver: drivers.make)

    let running = Task { try await authenticator.assert(assertionRequest) }
    await waitUntilPerforming(drivers)
    drivers.last?.complete(.error(domain: ASAuthorizationError.errorDomain, code: code.rawValue))

    await #expect(throws: expected) { try await running.value }
  }

  @Test("only a dismissal and a platform that cannot ask send nothing or a reason as the model expects")
  func refusalReasons() {
    let domain = ASAuthorizationError.errorDomain

    #expect(SystemPasskeyAuthenticator.ceremonyError(domain: domain, code: 1001).refusalReason == nil)
    #expect(SystemPasskeyAuthenticator.ceremonyError(domain: domain, code: 1004).refusalReason == nil)
    #expect(SystemPasskeyAuthenticator.ceremonyError(domain: domain, code: 1005).refusalReason == "not_interactive")
  }

  @Test("an unknown code or another domain fails with the domain and code only")
  func otherErrors() {
    #expect(
      SystemPasskeyAuthenticator.ceremonyError(domain: ASAuthorizationError.errorDomain, code: 4242)
        == .failed("The passkey sheet failed (ASAuthorizationError 4242).")
    )
    #expect(
      SystemPasskeyAuthenticator.ceremonyError(domain: "NSCocoaErrorDomain", code: 7)
        == .failed("The passkey sheet failed (NSCocoaErrorDomain 7).")
    )
  }

  // MARK: The driver's reading of a credential

  @Test("a new passkey's transports follow where it was made")
  func transports() {
    #expect(ControllerPasskeyDriver.transports(.platform) == ["internal"])
    #expect(ControllerPasskeyDriver.transports(.crossPlatform) == ["hybrid"])
  }
}
