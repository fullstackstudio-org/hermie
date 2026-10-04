/**
 * Listening, in a browser, where it mostly is not possible (`speech-recognition.web.ts` in the Expo app).
 *
 * `SpeechRecognition` is the half of the Web Speech API that never became a standard everybody shipped. Chrome has
 * it as `webkitSpeechRecognition` and **sends the audio to Google's servers to be transcribed**; Safari has it and
 * does the same with Apple's; Firefox does not have it at all. That puts this seam in a different position from
 * every other, and it is worth saying rather than hiding behind a feature test:
 *
 *  - **`available` is honest about presence, not about privacy.** Where the API exists the button is drawn,
 *    because a browser that asks the visitor for the microphone has asked them at the platform's own prompt, and
 *    the page says in Settings, Voice who does the transcribing.
 *  - **The on-device rule cannot be enforced here.** The Apple apps refuse a language with no model on the device
 *    (ADR-0022), and the browser has no switch for that: the claim is narrower on the web, and the README and
 *    `docs/web.md` name the platforms it holds for.
 *
 * A browser without the API gets no microphone at all, not one that explains itself.
 *
 * One session at a time, and a session that is replaced does not report: a late `end` from the old one must not be
 * taken for the new one's.
 */
import type { RecognitionEngine, RecognitionFailure, RecognitionRequest } from './speech-engines'

/** The part of the API this uses; the DOM lib does not declare it. */
interface WebRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult:
    | ((event: {
        resultIndex: number
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
      }) => void)
    | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}

type RecognitionConstructor = new () => WebRecognition

interface RecognitionWindow {
  SpeechRecognition?: unknown
  webkitSpeechRecognition?: unknown
}

const pageWindow = (): RecognitionWindow | null => {
  try {
    return typeof window === 'undefined' ? null : (window as unknown as RecognitionWindow)
  } catch {
    return null
  }
}

function constructorFor(win: RecognitionWindow | null): RecognitionConstructor | null {
  try {
    const found = win?.SpeechRecognition ?? win?.webkitSpeechRecognition

    return typeof found === 'function' ? (found as RecognitionConstructor) : null
  } catch {
    return null
  }
}

/** The recogniser's error codes, reduced to the four a caller acts on. */
export function failureFor(code: string): RecognitionFailure {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return 'permission'
  }

  if (code === 'no-speech') {
    return 'no-speech'
  }

  if (code === 'audio-capture' || code === 'language-not-supported') {
    return 'unavailable'
  }

  return 'failed'
}

export function createWebRecognition(win: RecognitionWindow | null = pageWindow()): RecognitionEngine {
  /** The session this engine owns, so a late event from an older one is ignored. */
  let current: WebRecognition | null = null

  return {
    get available(): boolean {
      return constructorFor(win) !== null
    },

    start({ continuous = false, language, onEnd, onError, onFinal, onPartial }: RecognitionRequest): void {
      const Recognition = constructorFor(win)

      if (!Recognition) {
        onError?.('unavailable')
        onEnd?.()

        return
      }

      current?.abort()

      try {
        const recognition = new Recognition()

        if (language) {
          recognition.lang = language
        }

        recognition.continuous = continuous
        recognition.interimResults = true

        let ended = false
        const finish = (): void => {
          if (ended || current !== recognition) {
            return
          }

          ended = true
          current = null
          onEnd?.()
        }

        recognition.onresult = event => {
          if (current !== recognition) {
            return
          }

          // The API delivers a growing list of results. For a session that is not continuous the list is one
          // utterance revised as it goes; the whole of what has been heard is every entry's best guess in order.
          let transcript = ''
          let final = true

          for (let index = 0; index < event.results.length; index += 1) {
            const result = event.results[index]

            transcript += result?.[0]?.transcript ?? ''
            final = final && Boolean(result?.isFinal)
          }

          if (final) {
            onFinal?.(transcript)
          } else {
            onPartial?.(transcript)
          }
        }

        recognition.onerror = event => {
          // `aborted` is this client asking, and an explanation for something the reader just did is noise.
          if (current === recognition && event.error !== 'aborted') {
            onError?.(failureFor(event.error))
          }

          finish()
        }

        recognition.onend = finish
        current = recognition
        recognition.start()
      } catch {
        current = null
        onError?.('failed')
        onEnd?.()
      }
    },

    stop(): void {
      current?.stop()
    },

    abort(): void {
      const recognition = current

      // Ownership goes first, so the `end` this provokes is ignored rather than reported as a session that finished.
      current = null
      recognition?.abort()
    }
  }
}

/** The page's recogniser. */
export const webRecognition: RecognitionEngine = createWebRecognition()
