/**
 * The two seams the voice code stands on, as types: what listens and what speaks. Nothing above them touches
 * a microphone or a speaker, which is what lets the state machines run in a test with a fake of each.
 */

/**
 * Why a recogniser said no, as a closed set: each has a different answer for the reader. A session this client
 * cancels itself is not among them: an explanation for something the reader just did is noise.
 */
export type RecognitionFailure = 'permission' | 'no-speech' | 'unavailable' | 'failed'

export interface RecognitionRequest {
  /** BCP-47, or nothing for the browser's own. */
  language?: string
  /** Keep listening through pauses. Dictation into the composer does not. */
  continuous?: boolean
  /** The WHOLE transcript of the session so far, still open to revision. */
  onPartial?: (text: string) => void
  /** The transcript as the recogniser will have it. */
  onFinal?: (text: string) => void
  onError?: (failure: RecognitionFailure) => void
  /** The session is over, however it ended. Always the last call. */
  onEnd?: () => void
}

export interface RecognitionEngine {
  /** Whether this browser has a recogniser at all. */
  readonly available: boolean
  /** Start listening. The browser asks for the microphone itself, and a refusal arrives as `onError('permission')`. */
  start: (request: RecognitionRequest) => void
  /** Stop listening and take the final result. */
  stop: () => void
  /** Stop and throw away what was heard: nothing is called after it. */
  abort: () => void
}

export interface SpeechUtterance {
  text: string
  /** BCP-47, or nothing for the browser's own voice. */
  language?: string
  /** 1 is the engine's own normal. */
  rate?: number
  /** Said to the end. NOT called for an utterance `stop()` cut. */
  onDone?: () => void
  /** A failure is a completion as far as a queue is concerned. */
  onError?: () => void
}

export interface SpeechEngine {
  /** Whether this browser can speak at all. */
  readonly available: boolean
  speak: (utterance: SpeechUtterance) => void
  stop: () => void
}
