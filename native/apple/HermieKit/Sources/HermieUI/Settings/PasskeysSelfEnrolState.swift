import Foundation
import HermieCore
import HermieGateway
import HermieProtocol

/**
 Where "Add a passkey" stands on the Passkeys page (plan `confirm-passkey.md`, "Flows — Native app"):
 one case, chosen from what the model holds and the time, so the page says exactly one thing and a
 test can pin each. The words are `PasskeysText`'s; the grant and its use secret are not here.

 The two steps are "Sign in again" and "Create the passkey". The countdown is the grant's
 `expires_at`: a grant that ran out is `expired` whatever phase the model still holds, since only
 the clock tells the page before the next call does.
 */
enum PasskeysSelfEnrolState: Equatable {
  /// Nothing to show: the gateway or this session cannot do it (the code path is all there is).
  case hidden
  /// The gateway said why it is not available to this person: `disabled` or `providerNoReauth`.
  case unavailable(PasskeyReauthReason)
  /// Offered, nothing started.
  case available
  /// Step 1: the sign-in sheet is up.
  case signingIn(secondsLeft: Int)
  /// Step 1 ended before the sign-in came back; the grant is open, so signing in again reuses it.
  case signInEnded(SignInProblem, secondsLeft: Int)
  /// The sign-in counted: step 2 may run, and run again after a dismissed passkey sheet.
  case ready(secondsLeft: Int)
  /// Step 2: the system's passkey sheet is up.
  case enrolling(secondsLeft: Int)
  /// The grant ran out before the passkey was made.
  case expired
  /// The grant cannot be used any more, for this reason (always one that says to start again).
  case failed(PasskeyReauthReason)
  /// The passkey was added.
  case done

  /// How far one of the two steps has come.
  enum Step: Equatable {
    /// Not yet its turn.
    case upcoming
    /// Its turn, and the person can press its button.
    case current
    /// Running now.
    case working
    /// Finished.
    case done
  }

  var step1: Step {
    switch self {
    case .hidden, .unavailable: .upcoming
    case .available, .signInEnded, .expired, .failed: .current
    case .signingIn: .working
    case .ready, .enrolling, .done: .done
    }
  }

  var step2: Step {
    switch self {
    case .hidden, .unavailable, .available, .signingIn, .signInEnded, .expired, .failed: .upcoming
    case .ready: .current
    case .enrolling: .working
    case .done: .done
    }
  }

  /// Whether the two steps are shown at all.
  var showsSteps: Bool {
    switch self {
    case .hidden, .unavailable: false
    default: true
    }
  }

  /// The "Sign in again" button may be pressed: nothing runs and the sign-in has not counted.
  var canSignIn: Bool {
    step1 == .current
  }

  /// The "Create the passkey" button may be pressed.
  var canCreate: Bool {
    step2 == .current
  }

  /// The grant's time left, while there is a grant that can still be used.
  var secondsLeft: Int? {
    switch self {
    case .signingIn(let seconds), .signInEnded(_, let seconds), .ready(let seconds), .enrolling(let seconds): seconds
    default: nil
    }
  }

  /// The sentence that says why there is nothing to do, or what went wrong with the last try.
  @MainActor
  func sentence(host: String = "") -> String? {
    switch self {
    case .unavailable(let reason), .failed(let reason): PasskeysText.reauthSentence(reason, host: host)
    case .signInEnded(let problem, _): PasskeysText.reauthSentence(.signIn(problem), host: host)
    case .expired: PasskeysText.reauthSentence(.expired)
    case .hidden, .available, .signingIn, .ready, .enrolling, .done: nil
    }
  }

  /// The state from what the model holds (`PasskeyModel.canSelfEnrol`, the status's `self_enrol` and the
  /// self-enrolment) at `now`.
  static func from(
    canSelfEnrol: Bool,
    selfEnrol: PasskeySelfEnrolStatus?,
    enrolment: PasskeySelfEnrolment?,
    now: Date
  ) -> PasskeysSelfEnrolState {
    if let enrolment {
      let left = enrolment.secondsLeft(at: now)

      switch enrolment.phase {
      // The sheet may be up as the clock runs out: the sign-in that comes back sets a new deadline.
      case .signingIn: return .signingIn(secondsLeft: left)
      case .signInEnded(let problem):
        return enrolment.isExpired(at: now) ? .expired : .signInEnded(problem, secondsLeft: left)
      case .ready: return enrolment.isExpired(at: now) ? .expired : .ready(secondsLeft: left)
      case .enrolling: return .enrolling(secondsLeft: left)
      case .failed(let reason): return .failed(reason)
      case .done: return .done
      }
    }

    if canSelfEnrol {
      return .available
    }

    switch selfEnrol?.reason {
    case "disabled"?: return .unavailable(.disabled)
    case "provider_no_reauth"?: return .unavailable(.providerNoReauth)
    default: return .hidden
    }
  }

  @MainActor
  static func of(_ model: PasskeyModel, now: Date) -> PasskeysSelfEnrolState {
    from(
      canSelfEnrol: model.canSelfEnrol,
      selfEnrol: model.status?.selfEnrol,
      enrolment: model.selfEnrolment,
      now: now
    )
  }

  /// What the failure line says after an action threw `error`, or `nil` when the state already says
  /// it (a phase that ended in a reason shows its own sentence) or there is nothing to say (the
  /// person closed a sheet).
  @MainActor
  static func failureLine(
    for error: PasskeyActionError,
    state: PasskeysSelfEnrolState,
    host: String
  ) -> String? {
    if case .reauth = error {
      switch state {
      case .failed, .signInEnded, .expired: return nil
      default: break
      }
    }

    return PasskeysText.failure(error, host: host)
  }
}
