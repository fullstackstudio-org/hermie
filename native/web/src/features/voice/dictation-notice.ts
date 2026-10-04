/**
 * The one line a failed dictation gets, or nothing at all.
 *
 * Only where there is something to say. A refused microphone is the one with a way out, and it is the browser's
 * to give (the site information beside the address): no page can open it, so there is no "Open Settings" here.
 * `no-speech` says so and leaves the draft untouched, because a press that heard nothing is not an error and a
 * composer that silently did nothing would read as a broken button.
 */
import { strings } from '../../generated/strings'
import type { RecognitionFailure } from '../../platform/speech-engines'

export function noticeFor(failure: RecognitionFailure | null): string | null {
  switch (failure) {
    case 'permission':
      return strings.chat.voice.permissionDenied
    case 'no-speech':
      return strings.chat.voice.noSpeech
    case 'unavailable':
      return strings.chat.voice.unavailable
    case 'failed':
      return strings.chat.voice.failed
    default:
      return null
  }
}
