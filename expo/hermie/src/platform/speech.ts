/**
 * Saying something out loud, on the phones and in the Mac's iPad build.
 *
 * `expo-speech` is `AVSpeechSynthesizer` on Apple platforms and `TextToSpeech`
 * on Android: **on-device, no network, no account, no key**. That is the whole
 * reason it is the default rather than a fallback — see
 * `docs/adr/0021-voice-on-device-first.md`. A reply read aloud is the reply
 * itself, so sending it somewhere to be synthesised would send the conversation
 * to a third party that the reader never chose and this app never mentions.
 *
 * ## The audio session, and what this file can and cannot decide
 *
 * `useApplicationAudioSession: false` is the one lever JS has here, and it is
 * the right way round: it tells the platform to give the synthesiser its **own**
 * session, which is what makes iOS duck other audio while the reply is read,
 * yield to a phone call or Siri, and resume afterwards — none of which this app
 * could arrange for itself without owning an `AVAudioSession`, which would mean
 * a dependency (`expo-audio`) whose only job would be to configure a category.
 *
 * What that leaves undecided is the **silent switch**, and this file cannot
 * settle it: the category the platform picks for that session is the platform's
 * choice, not a parameter. `docs/platform-notes.md` records it as one of the
 * things a device check has to answer, because a simulator has no such switch.
 *
 * ## One utterance at a time, deliberately
 *
 * `Speech.speak` APPENDS to the platform's own queue when something is already
 * being spoken. That queue is the wrong one to use: it holds text rather than
 * identity, so nothing could answer "which reply is being read" or "take the
 * third one back out". So every `speak` here stops first, and the queue that
 * matters lives in `features/voice/reader.ts` where the ids are.
 */
import * as Speech from 'expo-speech'

import type { SpeechEngine, SpeechUtterance } from './platform-contracts'

export type { SpeechEngine, SpeechUtterance } from './platform-contracts'

export const speechEngine: SpeechEngine = {
  available: true,

  speak({ language, onDone, onError, rate, text }: SpeechUtterance) {
    if (!text) {
      return
    }

    /*
      Stop before starting. See the note above: the platform queue is append-only
      and anonymous, and two `speak` calls without this would read both replies
      one after the other with no way to cancel just the second.
    */
    void Speech.stop().catch(() => undefined)

    try {
      Speech.speak(text, {
        ...(language ? { language } : {}),
        ...(rate === undefined ? {} : { rate }),
        // The system's own session: ducking, interruption and resumption are
        // then the platform's business rather than this app's. See above.
        useApplicationAudioSession: false,
        onDone: () => onDone?.(),
        onError: () => onError?.(),
        /*
          A stop is NOT a completion, and the difference is load bearing.

          `onStopped` fires when `Speech.stop()` cuts an utterance — including
          the stop two lines above, which happens whenever the reader starts a
          second reply while the first is being read. Routing it to `onDone`
          would advance the reader's queue on the very call that was replacing
          its head, and the queue would eat an item per tap.
        */
        onStopped: () => undefined
      })
    } catch {
      // A module present without its native side throws synchronously, and a
      // reply that cannot be spoken is not a reason for a screen to fall over.
      onError?.()
    }
  },

  stop() {
    void Speech.stop().catch(() => undefined)
  }
}
