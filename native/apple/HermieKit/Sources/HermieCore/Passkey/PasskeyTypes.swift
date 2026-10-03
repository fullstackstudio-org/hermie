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
  /// the app has a sheet for it.
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

  public init(
    configuration: PasskeyConfiguration,
    authenticator: any PasskeyAuthenticator,
    pins: (any PasskeyPinStore)? = nil
  ) {
    self.configuration = configuration
    self.authenticator = authenticator
    self.pins = pins
  }
}

/// One `confirm` at level `passkey`, as the sheet shows it.
public struct PasskeyConfirmation: Sendable, Equatable, Identifiable {
  /// The server request's id.
  public let id: String
  /// The sheet's text and the base URL it names: the only input of the sheet, and the value the
  /// challenge is computed from.
  public let display: ConfirmDisplay
  /// The bound user's name, as the gateway gave it.
  public let userName: String
  /// When the gateway gives up on it (`passkey.expires_at`), for the countdown.
  public let expiresAt: Date?
  public internal(set) var phase: PasskeyConfirmPhase

  /// Still waiting for this device to answer (or answering).
  public var isOpen: Bool { phase.isOpen }
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
