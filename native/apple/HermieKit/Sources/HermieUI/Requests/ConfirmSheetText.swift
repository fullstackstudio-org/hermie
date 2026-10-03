import HermieCore

/**
 What the confirm sheet says for each state of one confirmation, as values a test can read. Every
 sentence here is the app's own and fixed: nothing the agent or the gateway wrote reaches a button,
 a heading or a status line (the gateway's `reason` words pick a sentence, they are never shown).
 */
enum ConfirmSheetText {
  /// How a status line is drawn.
  enum Tone: Equatable {
    case progress
    case good
    case problem
    case neutral
  }

  struct Status: Equatable {
    var text: String
    var symbol: String
    var tone: Tone
    /// Shown with a spinner instead of a symbol.
    var busy = false
  }

  /// The line under the text, or `nil` while there is nothing to say (waiting for the person).
  static func status(for phase: PasskeyConfirmPhase) -> Status? {
    switch phase {
    case .waiting:
      nil
    case .signing:
      Status(text: NativeStrings.Confirm.signing, symbol: "key.fill", tone: .progress, busy: true)
    case .sending:
      Status(text: NativeStrings.Requests.sending, symbol: "paperplane", tone: .progress, busy: true)
    case .refused(let reason):
      Status(text: refusal(reason), symbol: "exclamationmark.triangle", tone: .problem)
    case .notSent:
      Status(text: NativeStrings.Confirm.notSent, symbol: "exclamationmark.triangle", tone: .problem)
    case .received:
      Status(text: NativeStrings.Confirm.received, symbol: "checkmark.circle.fill", tone: .good)
    case .declined:
      Status(text: NativeStrings.Confirm.declined, symbol: "hand.raised", tone: .neutral)
    case .ended(let end):
      Status(text: ending(end), symbol: "xmark.circle", tone: .problem)
    }
  }

  /// A refused answer in plain words, from the gateway's reason (contract §9).
  static func refusal(_ reason: String) -> String {
    switch reason {
    case "unknown_credential", "counter_regression", "backup_state_mismatch":
      NativeStrings.Confirm.refusedUnknownCredential
    case "uv_required":
      NativeStrings.Confirm.refusedUserVerification
    default:
      NativeStrings.Confirm.refusedOther
    }
  }

  /// How a confirmation that ended without this device's answer counting ended.
  static func ending(_ end: PasskeyConfirmEnd) -> String {
    switch end {
    case .timedOut: NativeStrings.Confirm.timedOut
    case .answeredElsewhere: NativeStrings.Confirm.answeredElsewhere
    case .tooManyAttempts: NativeStrings.Confirm.tooManyAttempts
    case .verificationFailed: NativeStrings.Confirm.verificationFailed
    case .notAllowed: NativeStrings.Confirm.notAllowed
    case .unavailable(let reason):
      reason == "no_credential" ? NativeStrings.Confirm.noCredential : NativeStrings.Confirm.cannotConfirm
    case .withdrawn: NativeStrings.Confirm.withdrawn
    }
  }

  /// The sheet closes by itself a moment after these: the answer is in, or the person said no.
  static func closesByItself(_ phase: PasskeyConfirmPhase) -> Bool {
    phase == .received || phase == .declined
  }

  /// Seconds the closing states stay up, so the outcome can be read (and heard).
  static let lingerSeconds = 2.5
}
