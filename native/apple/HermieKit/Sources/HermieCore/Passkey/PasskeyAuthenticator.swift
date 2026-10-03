import Foundation

/**
 The seam a passkey ceremony runs through.

 The app's implementation drives the system passkey sheet (`AuthenticationServices`, platform
 provider, user verification required, attestation `none`); tests use `SoftPasskeyAuthenticator`.
 The model computes every challenge itself (`PasskeyChallenge`) and hands over the 32 bytes, as the
 WebAuthn API takes them: an authenticator never sees the text it commits to, and never chooses
 what it signs.

 Rules every implementation keeps:

 - one ceremony at a time; a second call while one runs fails with `busy`;
 - an assertion is always restricted to `allowCredentialIDs`, which is never empty;
 - the person dismissing the system sheet is `cancelled`, which sends nothing to the gateway;
 - `cancel()` ends a running ceremony (the gateway withdrew the request) as `cancelled`;
 - nothing it receives or returns is logged.
 */
public protocol PasskeyAuthenticator: Sendable {
  /// Create a credential for `request.rpID` (a registration ceremony).
  func register(_ request: PasskeyRegistrationRequest) async throws(PasskeyCeremonyError) -> PasskeyRegistration

  /// Sign `request.challenge` with one of `request.allowCredentialIDs` (an assertion ceremony).
  func assert(_ request: PasskeyAssertionRequest) async throws(PasskeyCeremonyError) -> PasskeyAssertionResponse

  /// End the running ceremony, if any.
  func cancel() async
}

/// What a registration ceremony is asked to create.
public struct PasskeyRegistrationRequest: Sendable, Hashable {
  public var rpID: String
  public var challenge: [UInt8]
  /// The gateway's user handle for the signed-in user (`user.handle`, 32 bytes).
  public var userHandle: [UInt8]
  /// The credential's name, built by the app (`<display name> — <gateway host>`), which the system
  /// sheet shows (plan P3).
  public var name: String
  public var displayName: String
  /// Credentials the user already has for this RP on this gateway: the platform refuses to make
  /// another one in the same provider.
  public var excludeCredentialIDs: [[UInt8]]

  public init(
    rpID: String,
    challenge: [UInt8],
    userHandle: [UInt8],
    name: String,
    displayName: String,
    excludeCredentialIDs: [[UInt8]] = []
  ) {
    self.rpID = rpID
    self.challenge = challenge
    self.userHandle = userHandle
    self.name = name
    self.displayName = displayName
    self.excludeCredentialIDs = excludeCredentialIDs
  }
}

/// What a registration ceremony returned, raw.
public struct PasskeyRegistration: Sendable, Hashable {
  public var credentialID: [UInt8]
  public var clientDataJSON: [UInt8]
  public var attestationObject: [UInt8]
  public var transports: [String]

  public init(credentialID: [UInt8], clientDataJSON: [UInt8], attestationObject: [UInt8], transports: [String]) {
    self.credentialID = credentialID
    self.clientDataJSON = clientDataJSON
    self.attestationObject = attestationObject
    self.transports = transports
  }
}

/// What an assertion ceremony is asked to sign.
public struct PasskeyAssertionRequest: Sendable, Hashable {
  public var rpID: String
  public var challenge: [UInt8]
  /// Never empty: an unfiltered sheet would list the person's passkeys for every gateway (plan P3).
  public var allowCredentialIDs: [[UInt8]]

  public init(rpID: String, challenge: [UInt8], allowCredentialIDs: [[UInt8]]) {
    self.rpID = rpID
    self.challenge = challenge
    self.allowCredentialIDs = allowCredentialIDs
  }
}

/// What an assertion ceremony returned, raw.
public struct PasskeyAssertionResponse: Sendable, Hashable {
  public var credentialID: [UInt8]
  public var authenticatorData: [UInt8]
  public var clientDataJSON: [UInt8]
  /// ASN.1 DER ECDSA.
  public var signature: [UInt8]
  public var userHandle: [UInt8]?

  public init(
    credentialID: [UInt8],
    authenticatorData: [UInt8],
    clientDataJSON: [UInt8],
    signature: [UInt8],
    userHandle: [UInt8]?
  ) {
    self.credentialID = credentialID
    self.authenticatorData = authenticatorData
    self.clientDataJSON = clientDataJSON
    self.signature = signature
    self.userHandle = userHandle
  }
}

/// Why a ceremony produced nothing.
public enum PasskeyCeremonyError: Error, Sendable, Equatable {
  /// The person dismissed the system sheet, or `cancel()` ended it. Nothing is sent: the app's own
  /// sheet stays open.
  case cancelled
  /// Another ceremony is running.
  case busy
  /// None of the allowed credentials is on this device or in its passkey providers.
  case noCredential
  /// The ceremony cannot run here: no RP configured, the associated domain is missing, no passcode,
  /// no passkey provider. `reason` is the 4040 reason sent to the gateway.
  case unavailable(reason: String)
  /// Anything else the platform reported; the text is for the developer detail.
  case failed(String)

  /// The `data.reason` of the 4040 answer for an error that ends this client's part, or `nil` for
  /// one that sends nothing (`cancelled`, `busy`, `failed`: the person may try again).
  public var refusalReason: String? {
    switch self {
    case .noCredential: "no_credential"
    case .unavailable(let reason): reason
    case .cancelled, .busy, .failed: nil
    }
  }
}
