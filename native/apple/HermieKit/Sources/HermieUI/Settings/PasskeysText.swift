import Foundation
import HermieCore
import HermieGateway

/// The words of the Passkeys page and of the model's notices: every state, every refusal and every
/// notice in plain language. Nothing the gateway wrote is shown except a passkey's own name.
enum PasskeysText {
  /// One sentence for where the gateway's passkeys stand, and a symbol for it.
  static func state(_ state: PasskeysPageState) -> (text: String, symbol: String) {
    switch state {
    case .loading: (NativeStrings.Passkeys.loading, "hourglass")
    case .notConfigured: (NativeStrings.Passkeys.notConfigured, "nosign")
    case .notOffered: (NativeStrings.Passkeys.notOffered, "nosign")
    case .originNotListed: (NativeStrings.Passkeys.originNotListed, "exclamationmark.triangle")
    case .rateLimited(let seconds): (rateLimited(seconds), "clock.badge.exclamationmark")
    case .unreadable: (NativeStrings.Passkeys.unreadable, "wifi.exclamationmark")
    case .unavailable(let reason): (unavailable(reason), "nosign")
    case .rpNotAccepted: (NativeStrings.Passkeys.rpNotAccepted, "exclamationmark.triangle")
    case .notEnrolled: (NativeStrings.Passkeys.notEnrolled, "key")
    case .enrolled: (NativeStrings.Passkeys.enrolled, "checkmark.shield")
    }
  }

  /// Why the gateway has the level off for this account, from its `reason`.
  static func unavailable(_ reason: String) -> String {
    switch reason {
    case "no_base_url": NativeStrings.Passkeys.noBaseURL
    case "private_origin": NativeStrings.Passkeys.privateOrigin
    case "no_identity": NativeStrings.Passkeys.noIdentity
    default: NativeStrings.Passkeys.disabled
    }
  }

  static func rateLimited(_ seconds: Int?) -> String {
    guard let seconds, seconds > 0 else {
      return NativeStrings.Passkeys.rateLimitedSoon
    }

    return NativeStrings.Passkeys.rateLimited(seconds: seconds)
  }

  /// What went wrong with an enrolment, a code or a removal, or `nil` when there is nothing to say
  /// (the person dismissed the system's passkey sheet).
  static func failure(_ error: PasskeyActionError) -> String? {
    switch error {
    case .invalidCode: NativeStrings.Passkeys.invalidCode
    case .notConfigured: NativeStrings.Passkeys.notConfigured
    case .unavailable(let reason): unavailable(reason)
    case .rpNotAccepted: NativeStrings.Passkeys.rpNotAccepted
    case .notEnrolled: NativeStrings.Passkeys.noPasskeyHere
    case .gatewayIDMismatch, .gatewayIDConflict, .pinUnreadable: NativeStrings.Passkeys.seeNotice
    case .ceremony(let ceremony): ceremonyFailure(ceremony)
    case .refused(let route): refusal(route)
    case .badAnswer: NativeStrings.Passkeys.badAnswer
    case .transport: NativeStrings.Passkeys.unreadable
    case .reauth(let reason): reauthFailure(reason)
    }
  }

  /// Self-enrolment's failures, in the words the page already has; the page's own sentences for
  /// each come with the page (SE-7b).
  private static func reauthFailure(_ reason: PasskeyReauthReason) -> String? {
    switch reason {
    case .signIn(.cancelled), .busy: nil
    case .rateLimited(let seconds): rateLimited(seconds)
    case .notOffered: NativeStrings.Passkeys.notOffered
    case .disabled: NativeStrings.Passkeys.disabled
    case .expired, .notFresh, .spent: NativeStrings.Passkeys.tooSlow
    case .providerNoReauth, .signIn, .failed: NativeStrings.Passkeys.refused
    }
  }

  private static func ceremonyFailure(_ error: PasskeyCeremonyError) -> String? {
    switch error {
    case .cancelled: nil
    case .busy: NativeStrings.Passkeys.promptBusy
    case .noCredential: NativeStrings.Passkeys.noPasskeyHere
    case .unavailable: NativeStrings.Passkeys.cannotUsePasskeys
    case .failed: NativeStrings.Passkeys.promptFailed
    }
  }

  private static func refusal(_ error: PasskeyRouteError) -> String {
    switch error.kind {
    case .notOffered: NativeStrings.Passkeys.notOffered
    case .originNotListed: NativeStrings.Passkeys.originNotListed
    case .rateLimited: rateLimited(error.retryAfter)
    case .unexpectedAnswer: NativeStrings.Passkeys.badAnswer
    case .refused:
      switch error.error {
      case "code_invalid": NativeStrings.Passkeys.codeNotValid
      case "invites_disabled": NativeStrings.Passkeys.invitesOff
      case "credential_exists": NativeStrings.Passkeys.alreadyEnrolled
      case "expired", "stepup_invalid": NativeStrings.Passkeys.tooSlow
      default: NativeStrings.Passkeys.refused
      }
    }
  }

  // MARK: - Notices

  /// One notice the passkey model raised, in plain words.
  static func notice(_ kind: PasskeyNotice.Kind) -> String {
    switch kind {
    case .gatewayIDMismatch: NativeStrings.Passkeys.Notice.gatewayIDMismatch
    case .gatewayIDConflict: NativeStrings.Passkeys.Notice.gatewayIDConflict
    case .sameGatewayAs(_, let name): NativeStrings.Passkeys.Notice.sameGateway(name)
    case .pinUnreadable: NativeStrings.Passkeys.Notice.pinUnreadable
    case .unsupportedVersion: NativeStrings.Passkeys.Notice.unsupportedVersion
    case .noCredentialForApp: NativeStrings.Passkeys.Notice.noCredentialForApp
    case .malformedRequest: NativeStrings.Passkeys.Notice.malformedRequest
    case .expiredOnArrival: NativeStrings.Passkeys.Notice.expiredOnArrival
    case .credentialAdded(let name): NativeStrings.Passkeys.Notice.added(name)
    case .credentialRevoked(let name): NativeStrings.Passkeys.Notice.revoked(name)
    }
  }

  /// The one action a notice offers, when it has one: link two stored gateways that are one.
  static func noticeAction(_ kind: PasskeyNotice.Kind) -> String? {
    if case .sameGatewayAs(_, let name) = kind {
      return NativeStrings.Passkeys.Notice.sameGatewayAction(name)
    }

    return nil
  }

  static func noticeSymbol(_ kind: PasskeyNotice.Kind) -> String {
    switch kind {
    case .gatewayIDMismatch, .gatewayIDConflict, .pinUnreadable: "exclamationmark.triangle"
    case .sameGatewayAs: "questionmark.circle"
    case .unsupportedVersion, .noCredentialForApp, .malformedRequest, .expiredOnArrival: "exclamationmark.circle"
    case .credentialAdded, .credentialRevoked: "key"
    }
  }
}
