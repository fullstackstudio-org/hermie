import Foundation
import HermieProtocol

extension ComposerModel {
  /**
   Put what voice mode heard on the conversation without touching the field: a draft the reader was
   typing stays theirs. Sent with `surface: "voice-call"` on every prompt of a call (the gateway then
   knows the reply will be heard, and asks for short spoken sentences; a submit without it is back to
   the plain window) and the call's recent exchange as `voice_context`. A gateway that does not know
   the fields ignores them.

   True when the gateway took it, or it was parked behind a running turn to go when that ends.
   */
  public func sendSpoken(_ submission: VoiceSubmission) async -> Bool {
    guard canSend else {
      notice = .notSent(ChatRuntimeError.notAttached(bot).message)
      return false
    }

    onSubmit?()

    do {
      let painted = try await chat.store.send(bot, text: submission.text, extra: Self.voiceFields(submission))
      announce(painted == nil ? .queued : .sent)
      return true
    } catch let error as ChatRuntimeError where error.isNotAttached {
      notice = .notSent(error.message)
      return false
    } catch {
      notice = .failed(ChatResolver.describe(error))
      return false
    }
  }

  /// The fields a call's prompt carries beside its words.
  nonisolated static func voiceFields(_ submission: VoiceSubmission) -> JSONObject {
    var fields: JSONObject = ["surface": .string(VoiceSubmission.surface)]

    if let context = submission.context, !context.isEmpty {
      fields["voice_context"] = .string(context)
    }

    return fields
  }
}
