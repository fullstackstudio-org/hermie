/**
 * Listening, in a browser — where it mostly is not possible.
 *
 * `SpeechRecognition` is the half of the Web Speech API that never became a
 * standard everybody shipped. Chrome has it under `webkitSpeechRecognition` and
 * **sends the audio to Google's servers to be transcribed**; Safari has it and
 * does the same with Apple's; Firefox does not have it at all.
 *
 * That leaves this seam in a different position from every other one in this
 * folder, and it is worth stating rather than hiding behind a feature test:
 *
 *  - **`available` is honest about presence, not about privacy.** Where the API
 *    exists the button is drawn, because a browser that has already asked the
 *    visitor for the microphone is a browser where the visitor has made that
 *    choice at the platform's own prompt.
 *  - **The on-device rule cannot be enforced here.** The native seam refuses a
 *    device with no offline model precisely so the claim stays true; the web
 *    has no equivalent switch, so the claim is narrower on the web and the
 *    README and the ADR both say which platforms it holds for.
 *
 * Firefox, and any browser without the API, gets **no mic button at all** rather
 * than one that explains itself — there is nothing a visitor could do about it,
 * and a permanently disabled control is a worse answer than a composer that
 * simply does not offer the feature.
 */
import type {
  RecognitionEngine,
  RecognitionFailure,
  RecognitionPermission,
  RecognitionRequest
} from './platform-contracts'

export type {
  RecognitionEngine,
  RecognitionFailure,
  RecognitionPermission,
  RecognitionRequest
} from './platform-contracts'

/** The minimum of the API this uses; the DOM lib does not declare it. */
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

function constructorFor(): RecognitionConstructor | null {
  try {
    const scope = window as unknown as {
      SpeechRecognition?: RecognitionConstructor
      webkitSpeechRecognition?: RecognitionConstructor
    }

    return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
  } catch {
    return null
  }
}

function failureFor(code: string): RecognitionFailure {
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

/** The session this seam owns, so a late event from an older one is ignored. */
let current: WebRecognition | null = null

export const speechRecognition: RecognitionEngine = {
  get available(): boolean {
    return typeof window !== 'undefined' && constructorFor() !== null
  },

  async requestPermission(): Promise<RecognitionPermission> {
    /*
      There is nothing to ask.

      The browser prompts for the microphone when `start()` is called, and its
      answer arrives as a `not-allowed` error rather than as a return value. So
      this reports "granted" — meaning "go ahead and try" — and the refusal path
      is the error, which is the same one-line explanation the phones show.
      Asking `navigator.permissions.query({name: 'microphone'})` instead was
      rejected: Firefox does not implement that descriptor, Safari answers
      `prompt` for a site that has already been granted, and a wrong answer here
      would hide a button that works.
    */
    return constructorFor() ? 'granted' : 'unavailable'
  },

  async supportedLanguages(): Promise<string[]> {
    /*
      The API has no way to enumerate them.

      `SpeechRecognition.lang` takes a tag and either works or reports
      `language-not-supported` when the session starts, which is too late to
      build a picker from. So the picker offers the document's language alone,
      and the footer says why.
    */
    return []
  },

  start({ continuous = false, language, onEnd, onError, onFinal, onPartial }: RecognitionRequest) {
    const Recognition = constructorFor()

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
        // The API delivers a growing list of results; the last one is what the
        // caller wants, and `isFinal` on it is what says whether it will change.
        const last = event.results[event.results.length - 1]
        const transcript = last?.[0]?.transcript ?? ''

        if (last?.isFinal) {
          onFinal?.(transcript)
        } else {
          onPartial?.(transcript)
        }
      }

      recognition.onerror = event => {
        if (event.error !== 'aborted') {
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

  stop() {
    current?.stop()
  },

  abort() {
    const recognition = current

    // Ownership goes first, so the `end` this provokes is ignored rather than
    // reported as a session that finished on its own.
    current = null
    recognition?.abort()
  }
}

/**
 * Whether the platform can send the reader to a settings screen.
 *
 * False in a browser: microphone permission lives in the site information
 * popover, which no page can open. The copy that would say "Open Settings"
 * therefore says nothing, rather than naming a button that is not there.
 */
export const CAN_OPEN_SETTINGS = false
