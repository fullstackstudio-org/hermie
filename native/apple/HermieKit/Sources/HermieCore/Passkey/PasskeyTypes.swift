import Foundation
import HermieGateway
import HermieProtocol

/// What this build can do with passkeys. The RP is a build setting (the native apps' associated
/// domain); a build without one never advertises the level and refuses every passkey frame.
public struct PasskeyConfiguration: Sendable {
  /// The RP the build's ceremonies run under (`confirm.hermie.dev` for the official build).
  public var rpID: String?
  public var kind: PasskeyRPKind
  /// The app shows a `plain` confirmation too, so `plain` is advertised beside `passkey`. Off until
  /// the app has a sheet for it (CP-10); until then the model declines every `plain` request
  /// `-32601` whatever this says, so none waits out the gateway's deadline.
  public var plain: Bool
  /// The first half of the credential name the app gives a new passkey: the system sheet shows
  /// `<displayName> — <gateway host>` (plan P3).
  public var displayName: String

  public init(rpID: String?, kind: PasskeyRPKind = .native, plain: Bool = false, displayName: String = "Hermie") {
    self.rpID = rpID
    self.kind = kind
    self.plain = plain
    self.displayName = displayName
  }

  /// The name of a new passkey for the gateway at `host`, built by the app, never by the gateway.
  public func credentialName(host: String) -> String {
    "\(displayName) — \(host)"
  }
}

/// Everything a session needs to run the passkey model (`GatewaySession.Options.passkey`).
public struct PasskeySetup: Sendable {
  public var configuration: PasskeyConfiguration
  public var authenticator: any PasskeyAuthenticator
  /// `nil`: the launch's key-value store, else memory.
  public var pins: (any PasskeyPinStore)?
  /// What adding a passkey by signing in again runs on. `nil`: no self-enrolment from this app.
  public var reauth: PasskeyReauthSetup?

  public init(
    configuration: PasskeyConfiguration,
    authenticator: any PasskeyAuthenticator,
    pins: (any PasskeyPinStore)? = nil,
    reauth: PasskeyReauthSetup? = nil
  ) {
    self.configuration = configuration
    self.authenticator = authenticator
    self.pins = pins
    self.reauth = reauth
  }
}

/// The app's sign-in machinery, for self-enrolment's sign-in again: one services value per launch
/// (one browser gate, one callback port) and the app lock, which reads the sheet as a system prompt.
public struct PasskeyReauthSetup: Sendable {
  public var services: GatewayServices
  public var lock: AppLock?

  public init(services: GatewayServices, lock: AppLock?) {
    self.services = services
    self.lock = lock
  }

  /// The re-authentication of a session over `credentials`; `nil` for credentials that cannot sign
  /// in through the browser (a session token has no person behind it).
  @MainActor
  func reauthenticator(for credentials: any CredentialProvider) -> (any PasskeyReauthenticating)? {
    guard let native = credentials as? NativePKCECredentials else {
      return nil
    }

    return BrowserReauthenticator(services: services, credentials: native, lock: lock)
  }
}

/// A self-enrolment in progress (plan "Flows — Native app"): step 1 signs in again for a
/// fresh-authentication grant, step 2 creates the passkey with it. Its description shows neither the
/// grant nor its use secret.
public struct PasskeySelfEnrolment: Sendable, Equatable {
  public enum Phase: Sendable, Equatable {
    /// Step 1: the sign-in sheet is up.
    case signingIn
    /// Step 1 ended before the sign-in came back (the sheet was closed, the app could not listen,
    /// the attempt was replaced). The grant is still open: signing in again reuses it until it
    /// expires.
    case signInEnded(SignInProblem)
    /// The sign-in counted: step 2 may run, and run again after a cancelled passkey sheet, until
    /// the grant expires.
    case ready
    /// Step 2: the passkey is being created.
    case enrolling
    /// The grant cannot be used any more; start again (`reason`).
    case failed(PasskeyReauthReason)
    /// The passkey was added.
    case done
  }

  /// When the grant runs out, for the countdown: the gateway's `expires_at`.
  public internal(set) var expiresAt: Date
  public internal(set) var phase: Phase
  /// The grant, for `PasskeyModel.enrol(grantID:)`. Useless without its binding, which never leaves
  /// the model; never shown or logged.
  public let grantID: String
  let provider: String?
  /// The grant's one-time binding, once the sign-in counted.
  var useSecret: String?

  init(grantID: String, provider: String?, expiresAt: Date, phase: Phase) {
    self.grantID = grantID
    self.provider = provider
    self.expiresAt = expiresAt
    self.phase = phase
  }

  /// Past `expires_at`: the gateway has forgotten the grant.
  public func isExpired(at now: Date) -> Bool {
    expiresAt <= now
  }

  /// Whole seconds left at `now`, never below 0.
  public func secondsLeft(at now: Date) -> Int {
    max(0, Int(expiresAt.timeIntervalSince(now).rounded(.up)))
  }

  /// "Create the passkey" may be pressed at `now`.
  public func canEnrol(at now: Date) -> Bool {
    phase == .ready && !isExpired(at: now)
  }
}

extension PasskeySelfEnrolment: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "PasskeySelfEnrolment(phase: \(phase), expiresAt: \(expiresAt))" }
  public var debugDescription: String { description }
  public var customMirror: Mirror {
    Mirror(self, children: ["phase": phase, "expiresAt": expiresAt], displayStyle: .struct)
  }
}

/// Why adding a passkey by signing in again did not go ahead (`PasskeyActionError.reauth`).
public enum PasskeyReauthReason: Sendable, Equatable {
  /// The gateway does not offer it: an older gateway (no `self_enrol` in the status, no route), or a
  /// session that cannot sign in through the browser. Codes still work.
  case notOffered
  /// 403 `self_enrol_disabled`, or the status says `disabled`: the operator switched it off.
  case disabled
  /// 403 `provider_no_reauth`: the sign-in provider cannot ask the person to authenticate again.
  case providerNoReauth
  /// 429 `rate_limited`; `retryAfter` is the answer's `Retry-After` in seconds, when it gave one.
  case rateLimited(retryAfter: Int?)
  /// The sign-in sheet ended before the sign-in came back.
  case signIn(SignInProblem)
  /// The grant ran out (here or at the gateway: `reauth_invalid` `unknown`, or the token answer's
  /// `unknown`, `not_open`, `client_mismatch`).
  case expired
  /// `reauth_invalid` `not_fresh`: the sign-in did not come back to the gateway.
  case notFresh
  /// `reauth_invalid` `spent`: the grant was used for a passkey already.
  case spent
  /// The sign-in came back and did not count: `user_mismatch`, `provider_mismatch`,
  /// `auth_time_missing`, `auth_not_fresh` (contract §7.2), or the grant could not be completed
  /// (`not_open`, `client_mismatch`), as the gateway said it, or `""`.
  case failed(failure: String)
}

/// One `confirm` at level `passkey`, as the sheet shows it.
public struct PasskeyConfirmation: Sendable, Equatable, Identifiable {
  /// The server request's id.
  public let id: String
  /// The runtime session the request belongs to: which chat shows it.
  public let sessionID: String
  /// The sheet's text and the base URL it names: the only input of the sheet, and the value the
  /// challenge is computed from.
  public let display: ConfirmDisplay
  /// The bound user's name, as the gateway gave it.
  public let userName: String
  /// When this device gives up on it, for the countdown: the frame's `passkey.expires_at`, and never
  /// more than `PasskeyModel.maxConfirmSeconds` after `receivedAt`, so a clock that is far off cannot
  /// keep a request open (or make it last for days).
  public let expiresAt: Date
  /// When this device read the frame: the order the sheets come up in.
  public let receivedAt: Date
  public internal(set) var phase: PasskeyConfirmPhase
  /// An assertion was sent and its delivery is not known (the call failed without a reply): the
  /// gateway may have taken it. From then on no state of this confirmation says "nothing was
  /// confirmed" (`PasskeyModel.setPhase` turns those endings into `.outcomeUnknown`).
  public internal(set) var answerMayHaveArrived = false

  /// Still waiting for this device to answer (or answering).
  public var isOpen: Bool { phase.isOpen }

  /// Past `expires_at`: the gateway has given up on it.
  public func isExpired(at now: Date) -> Bool {
    expiresAt <= now
  }

  /// Confirm and Decline may be pressed at `now`: the phase allows it and it has not expired. The
  /// model ends an expired one as timed out when either is pressed.
  public func isActionable(at now: Date) -> Bool {
    phase.isActionable && !isExpired(at: now)
  }
}

/// Where one confirmation stands.
public enum PasskeyConfirmPhase: Sendable, Equatable {
  /// On screen; Confirm and Decline are offered.
  case waiting
  /// The system passkey sheet is up.
  case signing
  /// The answer is on its way (`request.answer`).
  case sending
  /// The gateway refused the assertion (4034, `reason` as it gave it). The request stays open: the
  /// person may try again.
  case refused(reason: String)
  /// The answer did not reach the gateway (no socket, a timeout); try again.
  case notSent(String)
  /// `request.answer` said `ok`: the assertion was received and is valid. NOT "confirmed": the
  /// gateway commits it next, and says `request.cancel verification_failed` if that fails.
  case received
  /// The decline went through.
  case declined
  /// It is over without this device's answer counting.
  case ended(PasskeyConfirmEnd)

  public var isOpen: Bool {
    switch self {
    case .waiting, .signing, .sending, .refused, .notSent: true
    case .received, .declined, .ended: false
    }
  }

  /// Confirm (and Decline) may be pressed.
  public var isActionable: Bool {
    switch self {
    case .waiting, .refused, .notSent: true
    default: false
    }
  }
}

/// How a confirmation ended other than by this device's answer.
public enum PasskeyConfirmEnd: Sendable, Equatable {
  /// `request.cancel timeout`.
  case timedOut
  /// `request.cancel resolved` before this device answered: another client did.
  case answeredElsewhere
  /// The fifth refused answer settled it (`too_many_attempts`).
  case tooManyAttempts
  /// The answer was received but the gateway could not commit it (`verification_failed`): NOT confirmed.
  case verificationFailed
  /// `request.answer` said 4033: this connection may not answer it.
  case notAllowed
  /// This device cannot run the ceremony; the 4040 `reason` it sent.
  case unavailable(reason: String)
  /// Withdrawn for another reason (`request.cancel`'s, as it came).
  case withdrawn(reason: String)
  /// It ended after an assertion that may have reached the gateway (`answerMayHaveArrived`): whether
  /// the action ran is not known here, and the sheet says so instead of "nothing was confirmed".
  case outcomeUnknown
}

/// Something the person should see that is not one confirmation: never a silent failure.
public struct PasskeyNotice: Sendable, Equatable, Identifiable {
  public enum Kind: Sendable, Equatable {
    /// The gateway presents another `gateway_id` than the one pinned on enrolment.
    case gatewayIDMismatch
    /// The gateway presents a `gateway_id` pinned for no gateway in the list (a pin that outlived
    /// its gateway): refused.
    case gatewayIDConflict
    /// The gateway presents the `gateway_id` pinned for another STORED gateway: most likely one
    /// gateway stored twice (a LAN address and a public one). A question, not a finding: the action
    /// "same gateway as `name`" is `PasskeyModel.linkPins(with: storedGatewayID)`. Until the person
    /// confirms, the gateway's passkey frames are refused.
    case sameGatewayAs(storedGatewayID: String, name: String)
    /// What this device pinned for the stored gateway `storedGatewayID` cannot be read. It is kept
    /// as it is, never reset, and passkeys stay off for that gateway until it is removed.
    case pinUnreadable(storedGatewayID: String)
    /// A passkey frame in a contract version this build does not speak.
    case unsupportedVersion
    /// A passkey frame listing no credential for this build's RP.
    case noCredentialForApp
    /// A passkey frame this build could not read (a field missing or malformed).
    case malformedRequest
    /// A confirmation arrived already past its `expires_at`: most likely this device's clock is
    /// wrong. It was ended without a sheet.
    case expiredOnArrival
    /// A credential was added to this account without this device (`passkey.changed`, or the list grew).
    case credentialAdded(name: String)
    /// A credential was revoked without this device.
    case credentialRevoked(name: String)
  }

  public let id: UInt64
  public let kind: Kind
  /// Unix seconds.
  public let at: Double
}

/// Why an enrolment, an invite or a revoke did not happen.
public enum PasskeyActionError: Error, Sendable, Equatable {
  /// This build has no RP, or the gateway's address cannot be a base URL.
  case notConfigured
  /// The enrolment code is not 20 symbols of the contract's alphabet.
  case invalidCode
  /// The gateway does not offer the level, or says why not (`reason` as it came).
  case unavailable(reason: String)
  /// The gateway does not accept this build's RP.
  case rpNotAccepted
  /// No passkey of this account for this build's RP on the gateway.
  case notEnrolled
  /// The gateway presents another `gateway_id` than the one pinned (a notice is up too).
  case gatewayIDMismatch
  /// The gateway presents a `gateway_id` pinned for another stored gateway (a notice is up too).
  case gatewayIDConflict
  /// This device's pins for the gateway cannot be read (a notice is up too).
  case pinUnreadable
  /// The ceremony produced nothing.
  case ceremony(PasskeyCeremonyError)
  /// The route refused.
  case refused(PasskeyRouteError)
  /// The answer was not what the route promises.
  case badAnswer
  /// The call did not get through; the text is for the developer detail.
  case transport(String)
  /// Adding a passkey by signing in again did not go ahead (contract §7.2, §8).
  case reauth(PasskeyReauthReason)
}

/// A fresh enrolment code minted with a passkey, for another device or a browser. Its description
/// shows none of it.
public struct PasskeyInvite: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public let code: String
  public let expiresAt: Date?

  public var description: String { "PasskeyInvite(<redacted>)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .struct) }
}
