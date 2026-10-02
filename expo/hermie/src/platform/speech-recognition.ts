/**
 * Listening, on the phones and in the Mac's iPad build.
 *
 * `expo-speech-recognition` is `SFSpeechRecognizer` on Apple platforms and
 * `android.speech.SpeechRecognizer` on Android, and it is asked for the
 * **on-device** recognizer: `requiresOnDeviceRecognition` is `true`, which on
 * iOS is `SFSpeechRecognizer.supportsOnDeviceRecognition` and on Android routes
 * to the offline service. What the reader dictates is a message they are about
 * to send to their own gateway, and a client that quietly posted it to Apple's
 * or Google's servers first would be making a decision about somebody else's
 * words — see `docs/adr/0021-voice-on-device-first.md`.
 *
 * **Where the device has no offline model, this refuses rather than falling back
 * to the network.** That is the one genuinely costly consequence of the rule and
 * it is deliberate: a silent fallback would make the privacy claim above false
 * on exactly the devices the reader could not check.
 *
 * ## One session at a time
 *
 * There is one microphone, so there is one session. `start` tears down whatever
 * was running first, and every listener this module adds is removed when the
 * session ends — a listener that outlived its session would deliver the next
 * utterance's partials to the previous caller's composer.
 *
 * ## The gateway is deliberately not involved
 *
 * `voice.record` exists and it is not a transcription service for this app: it
 * records on the GATEWAY HOST's microphone and answers `{status: "recording"}`,
 * with the text arriving later as a `voice.transcript` event. There is no RPC
 * anywhere in the contract that takes audio from a client and gives back text —
 * `wake.feed` takes client PCM but only feeds a wake-word detector and answers
 * `{fed}`. See the platform notes for the reading of `methods_voice.py`.
 */
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition'

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

/** Every listener belonging to the session that is running, so it can be torn down. */
let subscriptions: { remove: () => void }[] = []

function release(): void {
  for (const subscription of subscriptions) {
    try {
      subscription.remove()
    } catch {
      // A module that has already gone. Nothing left to remove.
    }
  }

  subscriptions = []
}

/**
 * The recognizer's error codes, reduced to the four a caller acts on.
 *
 * `aborted` is deliberately absent from the mapping and answered as `failed`
 * only if it ever reaches here: `abort()` is this app asking, and an error card
 * about something the reader just did is noise. The caller drops it — see
 * `dictation.ts`.
 */
function failureFor(code: string): RecognitionFailure {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return 'permission'
  }

  if (code === 'no-speech') {
    return 'no-speech'
  }

  if (code === 'language-not-supported' || code === 'audio-capture') {
    return 'unavailable'
  }

  return 'failed'
}

export const speechRecognition: RecognitionEngine = {
  get available(): boolean {
    try {
      // Both halves: a recognizer at all, AND an on-device one. See the header
      // — a device with only the network recognizer is a device this refuses.
      return (
        ExpoSpeechRecognitionModule.isRecognitionAvailable() &&
        ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()
      )
    } catch {
      return false
    }
  },

  async requestPermission(): Promise<RecognitionPermission> {
    try {
      const response = await ExpoSpeechRecognitionModule.requestPermissionsAsync()

      return response.granted ? 'granted' : 'denied'
    } catch {
      // No native side at all: not a refusal, and the copy differs.
      return 'unavailable'
    }
  },

  async supportedLanguages(): Promise<string[]> {
    try {
      const { installedLocales } = await ExpoSpeechRecognitionModule.getSupportedLocales({})

      /*
        The INSTALLED list, not the supported one.

        `locales` is everything the recognizer knows about and `installedLocales`
        is what is on the device — and since this seam asks for on-device
        recognition (see the header), the second is the only one that is true.
        Offering a language whose model is not downloaded would produce a picker
        entry that fails the moment it is used.
      */
      return installedLocales
    } catch {
      // Android below API 31 throws rather than answering. Not an error: the
      // caller offers the device's own language and says nothing more.
      return []
    }
  },

  start({ continuous = false, language, onEnd, onError, onFinal, onPartial, onVolume }: RecognitionRequest) {
    release()

    try {
      ExpoSpeechRecognitionModule.abort()
    } catch {
      // Nothing was running. The point of the call is that this is cheap.
    }

    /*
      One `end` and no more, whatever order the platform reports things in.

      Android delivers `error` then `end`; iOS can deliver `end` alone when a
      session is cut. The caller's state machine takes `onEnd` as the last word,
      so delivering it twice would restart a loop that had already moved on.
    */
    let ended = false
    const finish = (): void => {
      if (ended) {
        return
      }

      ended = true
      release()
      onEnd?.()
    }

    try {
      subscriptions.push(
        ExpoSpeechRecognitionModule.addListener('result', event => {
          const transcript = event.results?.[0]?.transcript ?? ''

          if (event.isFinal) {
            onFinal?.(transcript)
          } else {
            onPartial?.(transcript)
          }
        }),
        ExpoSpeechRecognitionModule.addListener('error', event => {
          if (event.error !== 'aborted') {
            onError?.(failureFor(event.error))
          }

          finish()
        }),
        ExpoSpeechRecognitionModule.addListener('end', finish)
      )

      if (onVolume) {
        subscriptions.push(
          ExpoSpeechRecognitionModule.addListener('volumechange', event => {
            /*
              The module reports roughly −2…10 in decibel-ish units. The overlay
              wants 0…1, and the arithmetic lives here because it is a fact
              about THIS recognizer: a second engine reporting a different range
              would convert its own, and the indicator above would not change.
            */
            onVolume(Math.max(0, Math.min(1, (event.value + 2) / 12)))
          })
        )
      }

      ExpoSpeechRecognitionModule.start({
        ...(language ? { lang: language } : {}),
        interimResults: true,
        continuous,
        requiresOnDeviceRecognition: true,
        // Punctuation from the recognizer rather than from a reader typing it:
        // the text goes into a composer and is sent as a message, not as a
        // search query.
        addsPunctuation: true
      })
    } catch {
      onError?.('unavailable')
      finish()
    }
  },

  stop() {
    try {
      ExpoSpeechRecognitionModule.stop()
    } catch {
      release()
    }
  },

  abort() {
    try {
      ExpoSpeechRecognitionModule.abort()
    } catch {
      // Nothing running. `release` happens on the `end` that follows, or here.
    }

    release()
  }
}

/**
 * Whether the platform can send the reader to a settings screen.
 *
 * True on the phones and in the Mac window: `Linking.openSettings()` opens this
 * app's own page, which is the only place a refused microphone can be undone.
 * The web half answers false — see `speech-recognition.web.ts`.
 */
export const CAN_OPEN_SETTINGS = true
