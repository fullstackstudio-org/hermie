/**
 * Saying something out loud, in a browser.
 *
 * The Web Speech API's synthesis half, which is the one half of it that is
 * genuinely everywhere: Safari, Firefox and Chrome have all shipped
 * `speechSynthesis` for years, and it is on-device in every one of them. The
 * recognition half is not — see `speech-recognition.web.ts`, which has to hide a
 * control because of it.
 *
 * `expo-speech` has a web implementation of its own and is deliberately not used
 * here. It reaches for `window` at import time, which is fine in a browser and
 * not fine in the Jest environment the app's suites run in, and the API it wraps
 * is four lines long.
 *
 * ## Two browser bugs this works around
 *
 * - **`cancel()` does not always fire `onend`.** So the engine tracks its own
 *   utterance and refuses callbacks from anything that is not the current one;
 *   a late `onend` from a cancelled utterance would otherwise advance the
 *   reader's queue.
 * - **A queue survives a page's own idea of "stopped".** `speechSynthesis`
 *   keeps its own pending list, so every `speak` cancels first, exactly as the
 *   native seam does and for the same reason.
 */
import type { SpeechEngine, SpeechUtterance } from './platform-contracts'

export type { SpeechEngine, SpeechUtterance } from './platform-contracts'

/** The synthesis half of the Web Speech API, or nothing. */
function synthesis(): SpeechSynthesis | null {
  try {
    return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
  } catch {
    // A document with a restrictive policy can throw on the property access.
    return null
  }
}

/** The utterance this engine is currently responsible for, so late events can be ignored. */
let current: SpeechSynthesisUtterance | null = null

export const speechEngine: SpeechEngine = {
  get available(): boolean {
    return synthesis() !== null && typeof SpeechSynthesisUtterance === 'function'
  },

  speak({ language, onDone, onError, rate, text }: SpeechUtterance) {
    const engine = synthesis()

    if (!engine || !text || typeof SpeechSynthesisUtterance !== 'function') {
      onError?.()

      return
    }

    engine.cancel()
    current = null

    try {
      const utterance = new SpeechSynthesisUtterance(text)

      if (language) {
        utterance.lang = language
      }

      if (rate !== undefined) {
        utterance.rate = rate
      }

      // Identity, not a flag: `cancel()` is unreliable about `onend` across
      // browsers, so the test is "is this still the utterance we started".
      utterance.onend = () => {
        if (current === utterance) {
          current = null
          onDone?.()
        }
      }

      utterance.onerror = () => {
        if (current === utterance) {
          current = null
          onError?.()
        }
      }

      current = utterance
      engine.speak(utterance)
    } catch {
      current = null
      onError?.()
    }
  },

  stop() {
    // Drop ownership FIRST: `cancel()` may deliver an `onend` synchronously, and
    // a stop must never look like a completion to the queue above.
    current = null
    synthesis()?.cancel()
  }
}
