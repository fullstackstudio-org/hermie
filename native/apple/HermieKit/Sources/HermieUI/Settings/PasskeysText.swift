import Foundation
import HermieCore
import HermieGateway
import HermieProtocol

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
  @MainActor
  static func failure(_ error: PasskeyActionError, host: String = "") -> String? {
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
    case .reauth(let reason): reauthFailure(reason, host: host)
    }
  }

  /// What adding a passkey by signing in again says when it throws: the person closing the sign-in
  /// sheet, or a press while a step runs already, says nothing (the page shows where it stands); every
  /// other reason has its sentence.
  @MainActor
  private static func reauthFailure(_ reason: PasskeyReauthReason, host: String) -> String? {
    switch reason {
    case .signIn(.cancelled), .busy: return nil
    default: break
    }

    return reauthSentence(reason, host: host)
  }

  /// One sentence for why adding a passkey by signing in again did not go ahead, in words that say
  /// what to do next. Nothing the gateway or the identity provider wrote is shown: its `failure`
  /// only picks one of these.
  @MainActor
  static func reauthSentence(_ reason: PasskeyReauthReason, host: String = "") -> String {
    switch reason {
    case .notOffered: NativeStrings.Passkeys.SelfEnrol.notOffered
    case .busy: NativeStrings.Passkeys.SelfEnrol.busy
    case .disabled: NativeStrings.Passkeys.SelfEnrol.disabled
    case .providerNoReauth: NativeStrings.Passkeys.SelfEnrol.noReauth
    case .rateLimited(let seconds): rateLimited(seconds)
    case .signIn(.cancelled): NativeStrings.Passkeys.SelfEnrol.signInClosed
    case .signIn(let problem): OnboardingMessages.signInProblem(problem, host: host, sessionToken: false)
    case .expired: NativeStrings.Passkeys.SelfEnrol.expired
    case .notFresh: NativeStrings.Passkeys.SelfEnrol.notFresh
    case .spent: NativeStrings.Passkeys.SelfEnrol.spent
    case .failed(let failure):
      switch failure {
      case "auth_not_fresh": NativeStrings.Passkeys.SelfEnrol.authNotFresh
      case "auth_time_missing": NativeStrings.Passkeys.SelfEnrol.authTimeMissing
      case "user_mismatch": NativeStrings.Passkeys.SelfEnrol.userMismatch
      case "provider_mismatch": NativeStrings.Passkeys.SelfEnrol.providerMismatch
      default: NativeStrings.Passkeys.SelfEnrol.failed
      }
    }
  }

  // MARK: - Adding a passkey by signing in again

  /// The countdown, as minutes and seconds: "Time left: 9:41".
  static func timeLeft(seconds: Int) -> String {
    NativeStrings.Passkeys.SelfEnrol.timeLeft(clock(seconds: seconds))
  }

  /// Minutes and seconds, "9:41".
  static func clock(seconds: Int) -> String {
    Duration.seconds(max(0, seconds)).formatted(.time(pattern: .minuteSecond))
  }

  /// What VoiceOver says for the countdown: whole minutes, so that it does not speak every second.
  static func timeLeftSpoken(seconds: Int) -> String {
    guard seconds >= 60 else {
      return NativeStrings.Passkeys.SelfEnrol.lessThanMinute
    }

    return Duration.seconds(seconds / 60 * 60).formatted(.units(allowed: [.minutes], width: .wide))
  }

  /// "Step 1 of 2: Sign in again", for VoiceOver.
  static func stepLabel(_ number: Int, title: String) -> String {
    NativeStrings.Passkeys.SelfEnrol.stepLabel(number, title)
  }

  /// The operator's waiting period as a duration the person can read ("24 hours"); `nil` when there is none.
  static func coolingOffNotice(seconds: Double?) -> String? {
    guard let seconds, seconds >= 1 else {
      return nil
    }

    let span = Duration.seconds(Int(seconds)).formatted(
      .units(allowed: [.days, .hours, .minutes, .seconds], width: .wide, maximumUnitCount: 2))

    return NativeStrings.Passkeys.SelfEnrol.coolingOffNotice(span)
  }

  /// On a passkey that is listed but cannot answer a confirmation yet: from when it can; `nil` when it can now.
  static func coolingOff(_ credential: PasskeyCredentialInfo, now: Date) -> String? {
    guard let from = credential.usableFrom, Date(timeIntervalSince1970: from) > now else {
      return nil
    }

    return NativeStrings.Passkeys.SelfEnrol.credentialCoolingOff(
      Date(timeIntervalSince1970: from).formatted(date: .abbreviated, time: .shortened))
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
