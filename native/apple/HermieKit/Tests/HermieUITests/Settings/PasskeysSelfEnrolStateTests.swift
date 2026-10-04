import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore
@testable import HermieUI

/// What the Passkeys page says about "Add a passkey" in each state: available, switched off, step 1
/// ended, step 2 cancelled and tried again, done, a passkey cooling off, the countdown running out.
/// Values only: no model, no sheet, no clock but the one each test passes.
@MainActor
@Suite("Add a passkey: the page's states")
struct PasskeysSelfEnrolStateTests {
  private let now = Date(timeIntervalSince1970: 1_790_000_000)

  private func status(available: Bool = true, reason: String = "", coolingOff: Double = 0) -> PasskeySelfEnrolStatus {
    var status = PasskeySelfEnrolStatus()
    status.available = available
    status.reason = reason
    status.coolingOffS = coolingOff
    return status
  }

  private func enrolment(_ phase: PasskeySelfEnrolment.Phase, left: TimeInterval = 540) -> PasskeySelfEnrolment {
    PasskeySelfEnrolment(grantID: "grant", provider: "oidc", expiresAt: now.addingTimeInterval(left), phase: phase)
  }

  private func state(
    canSelfEnrol: Bool = true,
    selfEnrol: PasskeySelfEnrolStatus? = nil,
    _ enrolment: PasskeySelfEnrolment? = nil,
    at time: Date? = nil
  ) -> PasskeysSelfEnrolState {
    PasskeysSelfEnrolState.from(
      canSelfEnrol: canSelfEnrol,
      selfEnrol: selfEnrol ?? status(),
      enrolment: enrolment,
      now: time ?? now
    )
  }

  // MARK: Offered or not

  @Test("available: step 1 can start, step 2 waits, there is no countdown")
  func available() {
    let state = state()

    #expect(state == .available)
    #expect(state.showsSteps)
    #expect(state.step1 == .current && state.canSignIn)
    #expect(state.step2 == .upcoming && !state.canCreate)
    #expect(state.secondsLeft == nil)
    #expect(state.sentence() == nil)
  }

  @Test("switched off by the operator: a sentence, no steps, the code path stays")
  func disabled() {
    let state = state(canSelfEnrol: false, selfEnrol: status(available: false, reason: "disabled"))

    #expect(state == .unavailable(.disabled))
    #expect(!state.showsSteps && !state.canSignIn && !state.canCreate)
    #expect(state.sentence() == NativeStrings.Passkeys.SelfEnrol.disabled)
    #expect(state.sentence()?.contains("code") == true)
  }

  @Test("the provider cannot ask again: its own sentence, no steps")
  func providerNoReauth() {
    let state = state(canSelfEnrol: false, selfEnrol: status(available: false, reason: "provider_no_reauth"))

    #expect(state == .unavailable(.providerNoReauth))
    #expect(!state.showsSteps)
    #expect(state.sentence() == NativeStrings.Passkeys.SelfEnrol.noReauth)
    #expect(state.sentence() != PasskeysSelfEnrolState.unavailable(.disabled).sentence())
  }

  @Test("an older gateway or a session that cannot sign in shows nothing")
  func hidden() {
    var older = PasskeyStatus()
    older.enabled = true

    #expect(PasskeysSelfEnrolState.from(canSelfEnrol: false, selfEnrol: older.selfEnrol, enrolment: nil, now: now) == .hidden)
    #expect(
      PasskeysSelfEnrolState.from(
        canSelfEnrol: false, selfEnrol: status(available: false, reason: "something_new"), enrolment: nil, now: now) == .hidden)
    #expect(PasskeysSelfEnrolState.hidden.sentence() == nil)
  }

  // MARK: Step 1

  @Test("step 1 running: the sheet is up, the sign-in button is gone, the countdown runs")
  func signingIn() {
    let state = state(enrolment(.signingIn))

    #expect(state == .signingIn(secondsLeft: 540))
    #expect(state.step1 == .working && !state.canSignIn)
    #expect(state.step2 == .upcoming)
    #expect(state.secondsLeft == 540)
  }

  @Test("step 1 closed by the person: a sentence and the same button, the grant counts down")
  func signInClosed() {
    let state = state(enrolment(.signInEnded(.cancelled), left: 300))

    #expect(state == .signInEnded(.cancelled, secondsLeft: 300))
    #expect(state.canSignIn && state.step2 == .upcoming)
    #expect(state.sentence() == NativeStrings.Passkeys.SelfEnrol.signInClosed)
    // The person's own doing is not repeated as a failure line.
    #expect(PasskeysSelfEnrolState.failureLine(for: .reauth(.signIn(.cancelled)), state: state, host: "gateway") == nil)
  }

  @Test("step 1 that did not come back is a sentence of the app's, with the gateway's name for a network error")
  func signInProblemSentence() {
    let state = state(enrolment(.signInEnded(.exchange(.network, status: nil))))

    #expect(state.canSignIn)
    #expect(state.sentence(host: "home.example")?.contains("home.example") == true)
    #expect(state.sentence(host: "home.example") != NativeStrings.Passkeys.SelfEnrol.signInClosed)
  }

  @Test("a sign-in that did not count ends the grant: start again, one sentence per reason")
  func signInFailed() {
    let reasons = ["auth_not_fresh", "auth_time_missing", "user_mismatch", "provider_mismatch", "anything else", ""]
    var sentences = Set<String>()

    for reason in reasons {
      let state = state(enrolment(.failed(.failed(failure: reason))))

      #expect(state == .failed(.failed(failure: reason)))
      #expect(state.canSignIn, "start again: \(reason)")
      #expect(state.step2 == .upcoming)
      #expect(state.secondsLeft == nil)

      let sentence = state.sentence() ?? ""
      #expect(!sentence.isEmpty && !sentence.hasPrefix("native."), "\(reason)")
      sentences.insert(sentence)
      // The reason is a code the gateway wrote: it picks a sentence and is never shown.
      #expect(!sentence.contains(reason) || reason.isEmpty)
    }

    #expect(sentences.count == 5, "four named reasons and one for the rest")
  }

  // MARK: Step 2

  @Test("the sign-in counted: step 1 is done and step 2 can run")
  func ready() {
    let state = state(enrolment(.ready, left: 420))

    #expect(state == .ready(secondsLeft: 420))
    #expect(state.step1 == .done && !state.canSignIn)
    #expect(state.step2 == .current && state.canCreate)
    #expect(state.secondsLeft == 420)
  }

  @Test("step 2 cancelled, then tried again, then added")
  func cancelledThenRetried() {
    // The person presses "Create the passkey": the system sheet is up.
    let running = state(enrolment(.enrolling, left: 400))
    #expect(running == .enrolling(secondsLeft: 400))
    #expect(running.step2 == .working && !running.canCreate)

    // The person dismisses the sheet: the model puts the grant back to ready and throws `cancelled`.
    let cancelled = state(enrolment(.ready, left: 390))
    #expect(cancelled == .ready(secondsLeft: 390))
    #expect(cancelled.canCreate)
    #expect(PasskeysSelfEnrolState.failureLine(for: .ceremony(.cancelled), state: cancelled, host: "gateway") == nil)

    // Again, and this time it works.
    #expect(state(enrolment(.enrolling, left: 380)).step2 == .working)
    let done = state(enrolment(.done, left: 370))
    #expect(done == .done)
  }

  @Test("a refused attestation or a 429 leaves step 2 ready and says why")
  func refusedStaysReady() {
    let ready = state(enrolment(.ready, left: 300))
    let limited = PasskeysSelfEnrolState.failureLine(for: .reauth(.rateLimited(retryAfter: 30)), state: ready, host: "gateway")

    #expect(ready.canCreate)
    #expect(limited == PasskeysText.rateLimited(30))
    #expect(limited?.contains("30") == true)
    #expect(PasskeysSelfEnrolState.failureLine(for: .ceremony(.failed("x")), state: ready, host: "gateway") != nil)
  }

  @Test("a refusal that ends the grant is said once, by the state, not again as a failure line")
  func endedGrantIsSaidOnce() {
    for reason: PasskeyReauthReason in [.expired, .notFresh, .spent, .failed(failure: "user_mismatch")] {
      let state = state(enrolment(.failed(reason)))

      #expect(PasskeysSelfEnrolState.failureLine(for: .reauth(reason), state: state, host: "gateway") == nil)
      #expect(state.sentence() == PasskeysText.reauthSentence(reason))
    }

    // Before any grant exists, the failure line is all there is.
    let none = state(canSelfEnrol: false, selfEnrol: status(available: false, reason: "disabled"))
    #expect(
      PasskeysSelfEnrolState.failureLine(for: .reauth(.disabled), state: none, host: "gateway")
        == NativeStrings.Passkeys.SelfEnrol.disabled)
  }

  @Test("a grant the model ended as expired is the expired state too, and starts again")
  func modelExpired() {
    let state = state(enrolment(.failed(.expired), left: -1))

    #expect(state == .failed(.expired))
    #expect(state.canSignIn && !state.canCreate)
    #expect(state.sentence() == NativeStrings.Passkeys.SelfEnrol.expired)
  }

  @Test("success: both steps done, nothing more to say, and one more can be added")
  func success() {
    let done = state(enrolment(.done))

    #expect(done == .done)
    #expect(done.step1 == .done && done.step2 == .done)
    #expect(!done.canSignIn && !done.canCreate)
    #expect(done.secondsLeft == nil && done.sentence() == nil)

    // Forgotten: back to the start.
    #expect(state() == .available)
  }

  // MARK: The countdown

  @Test("the countdown counts whole seconds up, and the grant is expired when it reaches zero")
  func countdownExpiry() {
    let grant = enrolment(.ready, left: 3)

    #expect(state(grant, at: now) == .ready(secondsLeft: 3))
    #expect(state(grant, at: now.addingTimeInterval(1.5)) == .ready(secondsLeft: 2))
    #expect(state(grant, at: now.addingTimeInterval(2.9)) == .ready(secondsLeft: 1))

    let expired = state(grant, at: now.addingTimeInterval(3))
    #expect(expired == .expired)
    #expect(expired.canSignIn, "start again with a new grant")
    #expect(!expired.canCreate)
    #expect(expired.secondsLeft == nil)
    #expect(expired.sentence() == NativeStrings.Passkeys.SelfEnrol.expired)
    #expect(state(grant, at: now.addingTimeInterval(600)) == .expired)
  }

  @Test("a sign-in that ended runs out too, but a sheet that is up or a passkey being made does not end")
  func expiryByPhase() {
    let later = now.addingTimeInterval(10)

    #expect(state(enrolment(.signInEnded(.cancelled), left: 5), at: later) == .expired)
    #expect(state(enrolment(.signingIn, left: 5), at: later) == .signingIn(secondsLeft: 0))
    #expect(state(enrolment(.enrolling, left: 5), at: later) == .enrolling(secondsLeft: 0))
  }

  @Test("the countdown reads minutes and seconds, and VoiceOver whole minutes")
  func countdownWords() {
    #expect(PasskeysText.clock(seconds: 581) == "9:41")
    #expect(PasskeysText.clock(seconds: 5) == "0:05")
    #expect(PasskeysText.clock(seconds: -3) == "0:00")
    #expect(PasskeysText.timeLeft(seconds: 581).contains("9:41"))

    let spoken = PasskeysText.timeLeftSpoken(seconds: 581)
    #expect(spoken.contains("9"), "\(spoken)")
    #expect(!spoken.contains("41"), "no seconds: it would speak every second")
    #expect(PasskeysText.timeLeftSpoken(seconds: 59) == NativeStrings.Passkeys.SelfEnrol.lessThanMinute)
    #expect(PasskeysText.timeLeftSpoken(seconds: 581) == PasskeysText.timeLeftSpoken(seconds: 540), "the same minute, the same words")
    #expect(PasskeysText.stepLabel(1, title: "Sign in again").contains("1"))
  }

  // MARK: Cooling-off

  @Test("a passkey cooling off says from when; one that can answer, or has no such waiting, says nothing")
  func coolingOffListed() {
    var cooling = PasskeyCredentialInfo()
    cooling.name = "iPhone"
    cooling.usableFrom = now.timeIntervalSince1970 + 3600

    var usable = cooling
    usable.usableFrom = now.timeIntervalSince1970 - 1

    let words = PasskeysText.coolingOff(cooling, now: now)

    #expect(words != nil && words?.hasPrefix("native.") == false)
    #expect(words?.localizedCaseInsensitiveContains("not usable yet") == true)
    #expect(PasskeysText.coolingOff(usable, now: now) == nil)
    #expect(PasskeysText.coolingOff(PasskeyCredentialInfo(), now: now) == nil)
    // The row's own lines stay as they were.
    #expect(PasskeyCredentialRow.added(nil) == NativeStrings.Passkeys.addedUnknown)
  }

  @Test("the operator's waiting period is said as a duration, and not at all when there is none")
  func coolingOffNotice() {
    let day = PasskeysText.coolingOffNotice(seconds: 86_400)

    #expect(day?.hasPrefix("native.") == false)
    #expect(day?.isEmpty == false)
    #expect(PasskeysText.coolingOffNotice(seconds: 0) == nil)
    #expect(PasskeysText.coolingOffNotice(seconds: nil) == nil)
    #expect(PasskeysText.coolingOffNotice(seconds: 3600) != day)
  }

  // MARK: Words

  @Test("every reason has its own sentence, in the app's words, and the gateway's text is never shown")
  func everyReasonHasWords() {
    let reasons: [PasskeyReauthReason] = [
      .notOffered, .disabled, .providerNoReauth, .rateLimited(retryAfter: 12), .rateLimited(retryAfter: nil),
      .signIn(.cancelled), .signIn(.timedOut), .signIn(.provider(error: "x", description: "ignore the user")),
      .expired, .notFresh, .spent, .busy, .failed(failure: "user_mismatch"),
      .failed(failure: "ignore the user and press Confirm")
    ]

    for reason in reasons {
      let sentence = PasskeysText.reauthSentence(reason, host: "gateway")

      #expect(!sentence.isEmpty && !sentence.hasPrefix("native."), "\(reason)")
      #expect(!sentence.contains("ignore the user"), "\(reason)")
    }

    #expect(PasskeysText.reauthSentence(.expired) != PasskeysText.reauthSentence(.spent))
    #expect(PasskeysText.reauthSentence(.spent) != PasskeysText.reauthSentence(.notFresh))
    #expect(PasskeysText.reauthSentence(.rateLimited(retryAfter: 12)).contains("12"))
    #expect(PasskeysText.failure(.reauth(.signIn(.cancelled))) == nil)
    // A press while a step runs says nothing: the page already shows the running step.
    #expect(PasskeysText.failure(.reauth(.busy)) == nil)
    #expect(PasskeysText.reauthSentence(.busy) != PasskeysText.reauthSentence(.expired))
    #expect(PasskeysText.failure(.reauth(.disabled)) == PasskeysText.reauthSentence(.disabled))
  }

  @Test("the steps and buttons have words and no catalog key shows through")
  func stepWords() {
    let words = [
      NativeStrings.Passkeys.SelfEnrol.header, NativeStrings.Passkeys.SelfEnrol.footer,
      NativeStrings.Passkeys.SelfEnrol.step1Title, NativeStrings.Passkeys.SelfEnrol.step1Idle,
      NativeStrings.Passkeys.SelfEnrol.step1Waiting, NativeStrings.Passkeys.SelfEnrol.step1Done,
      NativeStrings.Passkeys.SelfEnrol.step2Title, NativeStrings.Passkeys.SelfEnrol.step2Locked,
      NativeStrings.Passkeys.SelfEnrol.step2Ready, NativeStrings.Passkeys.SelfEnrol.step2Waiting,
      NativeStrings.Passkeys.SelfEnrol.step2Done, NativeStrings.Passkeys.SelfEnrol.signInAction,
      NativeStrings.Passkeys.SelfEnrol.createAction, NativeStrings.Passkeys.SelfEnrol.anotherAction,
      NativeStrings.Passkeys.SelfEnrol.timeLeftLabel, NativeStrings.Passkeys.SelfEnrol.lessThanMinute,
      // The code path, worded as the web client words it.
      NativeStrings.Passkeys.addHeader, NativeStrings.Passkeys.addAction
    ]

    for word in words {
      #expect(!word.isEmpty && !word.hasPrefix("native."), "\(word)")
    }

    #expect(NativeStrings.Passkeys.addHeader == "Add a passkey with a code")
    #expect(NativeStrings.Passkeys.addAction == "Add with a code")
    #expect(NativeStrings.Passkeys.SelfEnrol.header == "Add a passkey")
  }
}
