/**
 * Saying something out loud, in a browser (`speech.web.ts` in the Expo app).
 *
 * The synthesis half of the Web Speech API, which is the half that is genuinely everywhere: Safari, Firefox and
 * Chrome have all shipped `speechSynthesis` for years, with the browser's or the system's own voices on this
 * device. Nothing is sent anywhere.
 *
 * ## Two browser bugs this works around
 *
 * - **`cancel()` does not always fire `onend`.** So the engine tracks its own utterance and refuses callbacks from
 *   anything that is not the current one: a late `onend` from a cancelled utterance would otherwise advance the
 *   reader's queue.
 * - **The browser keeps a pending list of its own.** Every `speak` cancels first, so what was said before is cut
 *   rather than queued behind: the queue that knows about messages is the reader's (`reader.ts`).
 */
import type { SpeechEngine, SpeechUtterance } from './speech-engines'

interface SynthesisWindow {
  speechSynthesis?: SpeechSynthesis
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance
}

const pageWindow = (): SynthesisWindow | null => {
  try {
    return typeof window === 'undefined' ? null : (window as unknown as SynthesisWindow)
  } catch {
    // A document with a restrictive policy can throw on the property access.
    return null
  }
}

export function createWebSynthesis(win: SynthesisWindow | null = pageWindow()): SpeechEngine {
  /** The utterance this engine is currently responsible for, so late events can be ignored. */
  let current: SpeechSynthesisUtterance | null = null

  const synthesis = (): SpeechSynthesis | null => {
    try {
      return win?.speechSynthesis ?? null
    } catch {
      return null
    }
  }

  const utteranceConstructor = (): typeof SpeechSynthesisUtterance | null => {
    try {
      return typeof win?.SpeechSynthesisUtterance === 'function' ? win.SpeechSynthesisUtterance : null
    } catch {
      return null
    }
  }

  return {
    get available(): boolean {
      return synthesis() !== null && utteranceConstructor() !== null
    },

    speak({ language, onDone, onError, rate, text }: SpeechUtterance): void {
      const engine = synthesis()
      const Utterance = utteranceConstructor()

      if (!engine || !Utterance || !text) {
        onError?.()

        return
      }

      engine.cancel()
      current = null

      try {
        const utterance = new Utterance(text)

        if (language) {
          utterance.lang = language
        }

        if (rate !== undefined) {
          utterance.rate = rate
        }

        // Identity, not a flag: `cancel()` is unreliable about `onend` across browsers, so the test is "is this still
        // the utterance we started".
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

    stop(): void {
      // Ownership goes first: `cancel()` may deliver an `onend` synchronously, and a stop must never look like a
      // completion to the queue above.
      current = null
      synthesis()?.cancel()
    }
  }
}

/** The page's synthesiser. */
export const webSynthesis: SpeechEngine = createWebSynthesis()
