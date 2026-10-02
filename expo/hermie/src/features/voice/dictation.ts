/**
 * Dictation, as a state machine and two pure functions.
 *
 * Nothing here knows about React, a text field or a microphone. That is what
 * makes the two things most likely to be wrong testable: **where the words go**,
 * and **what happens when the recognizer says no**.
 *
 * ## Where the words go
 *
 * A partial result is not an append. The recognizer revises what it thinks it
 * heard — "recognise" becomes "recognise the" becomes "recognise their" — so a
 * field that appended every event would accumulate every revision. It is also
 * not a replace of the WHOLE field: the reader may have typed half a sentence
 * before tapping the mic, and may have put the caret in the middle of it.
 *
 * So dictation takes an ANCHOR at the moment it starts — the draft as it stood
 * and the selection it stood with — and every result, partial or final, is
 * computed from that anchor rather than from the previous result. A selected
 * range is replaced, which is what typing would do. Recomputing rather than
 * patching means a dropped event cannot desynchronise the field, and it makes
 * the final result nothing special: it is the last partial that happens to be
 * true.
 *
 * ## What happens when the recognizer says no
 *
 * Four failures and four different answers, which is the whole reason
 * `RecognitionFailure` is a closed set rather than an `Error`:
 *
 *  - `permission` is the only one the reader can act on, and it is the only one
 *    that offers Settings.
 *  - `no-speech` is not really a failure — the reader tapped and said nothing —
 *    so it reports a state and leaves the draft exactly as it was.
 *  - `unavailable` means this device cannot do it at all.
 *  - `failed` is everything else, said plainly rather than with a code.
 *
 * An `abort` is not among them, deliberately: that is this app cancelling, and
 * an explanation for something the reader just did is noise.
 */
import type { RecognitionEngine, RecognitionFailure } from '../../platform/platform-contracts'

/** Where dictation started: the draft, and the selection it began with. */
export interface DictationAnchor {
  base: string
  start: number
  end: number
}

/** A field position, clamped into the draft it belongs to. */
export function anchorAt(value: string, selection: { start: number; end: number }): DictationAnchor {
  const start = Math.max(0, Math.min(selection.start, value.length))
  const end = Math.max(start, Math.min(selection.end, value.length))

  return { base: value, start, end }
}

/**
 * The draft with this transcript at the caret, and where the caret lands.
 *
 * Spacing is arithmetic rather than a guess: a space is added before the
 * transcript when the character in front of it is not already whitespace, and
 * after it when the character behind it is neither whitespace nor punctuation
 * that would look wrong with a gap in front of it. Dictating into the middle of
 * `I said  and left` should not produce `I saidhello and left`.
 */
export function withTranscript(anchor: DictationAnchor, transcript: string): { value: string; caret: number } {
  const text = transcript.trim()
  const before = anchor.base.slice(0, anchor.start)
  const after = anchor.base.slice(anchor.end)

  if (!text) {
    // Nothing heard yet: the draft is the draft, and the caret has not moved.
    return { value: anchor.base, caret: anchor.start }
  }

  const lead = before && !/\s$/u.test(before) ? ' ' : ''
  const trail = after && !/^[\s.,;:!?)\]}]/u.test(after) ? ' ' : ''
  const inserted = `${lead}${text}${trail}`

  return { value: `${before}${inserted}${after}`, caret: anchor.start + inserted.length - trail.length }
}

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'error'

export interface DictationSnapshot {
  phase: DictationPhase
  /** What has been heard so far. Empty until the first result. */
  partial: string
  /** Set only in the `error` phase. */
  failure: RecognitionFailure | null
  /** Input level, 0…1, where the recognizer reports one. 0 otherwise. */
  level: number
}

export const DICTATION_IDLE: DictationSnapshot = { phase: 'idle', partial: '', failure: null, level: 0 }

export interface DictationOptions {
  onChange?: (snapshot: DictationSnapshot) => void
  /**
   * Every result, partial and final, with the caller deciding where it goes.
   *
   * `final` is passed through rather than being the only call, because a caller
   * that only acted on the final one would leave the field empty for the whole
   * time the reader was speaking — which is the thing that makes dictation feel
   * like it is working.
   */
  onTranscript?: (text: string, final: boolean) => void
  /** Fired once a session has ended, however it ended. */
  onEnd?: (snapshot: DictationSnapshot) => void
}

export interface StartOptions {
  /** BCP-47, or nothing for the device's own. */
  language?: string
  /** Keep listening through pauses. Voice mode does; push-to-talk does not. */
  continuous?: boolean
}

export class DictationMachine {
  private readonly engine: RecognitionEngine

  private readonly options: DictationOptions

  private snapshot: DictationSnapshot = DICTATION_IDLE

  /**
   * Bumped by every start and every cancel.
   *
   * The same guard the speech reader uses, for the same reason: a recognizer
   * can deliver a result or an `end` for a session that has already been
   * replaced, and acting on one would put the previous utterance's words into
   * the field the reader is now dictating into.
   */
  private generation = 0

  constructor(engine: RecognitionEngine, options: DictationOptions = {}) {
    this.engine = engine
    this.options = options
  }

  get state(): DictationSnapshot {
    return this.snapshot
  }

  get available(): boolean {
    return this.engine.available
  }

  /**
   * Ask for the microphone and start listening.
   *
   * Asynchronous because the permission dialog is, and it is awaited rather than
   * fired and forgotten: starting a recognizer while the system prompt is up
   * produces a session that ends the moment the dialog appears, which on iOS
   * reads as a mic button that flashes and does nothing.
   */
  async start(options: StartOptions = {}): Promise<void> {
    if (!this.engine.available) {
      this.set({ ...DICTATION_IDLE, phase: 'error', failure: 'unavailable' })

      return
    }

    if (this.snapshot.phase === 'listening' || this.snapshot.phase === 'starting') {
      return
    }

    this.generation += 1

    const generation = this.generation

    this.set({ ...DICTATION_IDLE, phase: 'starting' })

    const permission = await this.engine.requestPermission()

    // The reader let go, or changed their mind, while the dialog was up.
    if (generation !== this.generation) {
      return
    }

    if (permission !== 'granted') {
      this.set({
        ...DICTATION_IDLE,
        phase: 'error',
        failure: permission === 'denied' ? 'permission' : 'unavailable'
      })
      this.options.onEnd?.(this.snapshot)

      return
    }

    this.set({ ...DICTATION_IDLE, phase: 'listening' })

    this.engine.start({
      ...(options.language ? { language: options.language } : {}),
      ...(options.continuous ? { continuous: true } : {}),
      onPartial: text => this.result(generation, text, false),
      onFinal: text => this.result(generation, text, true),
      onVolume: level => {
        if (generation === this.generation && this.snapshot.phase === 'listening') {
          this.set({ ...this.snapshot, level })
        }
      },
      onError: failure => {
        if (generation !== this.generation) {
          return
        }

        this.set({ ...this.snapshot, phase: 'error', failure, level: 0 })
      },
      onEnd: () => {
        if (generation !== this.generation) {
          return
        }

        // An `end` with no error is a session that finished: back to idle,
        // keeping an error phase if one was already reported.
        if (this.snapshot.phase !== 'error') {
          this.set({ ...this.snapshot, phase: 'idle', level: 0 })
        }

        this.options.onEnd?.(this.snapshot)
      }
    })
  }

  /** Stop listening and take the final result. What a released finger does. */
  stop(): void {
    if (this.snapshot.phase === 'starting') {
      // The permission dialog is still up: there is no session to ask for a
      // final result, so this is a cancel in everything but name.
      this.cancel()

      return
    }

    if (this.snapshot.phase === 'listening') {
      this.engine.stop()
    }
  }

  /** Stop and throw away what was heard. Leaving the screen, or an Escape. */
  cancel(): void {
    this.generation += 1
    this.engine.abort()
    this.set(DICTATION_IDLE)
  }

  /** Put the error away, so the explanation does not outlive its usefulness. */
  clearError(): void {
    if (this.snapshot.phase === 'error') {
      this.set(DICTATION_IDLE)
    }
  }

  private result(generation: number, text: string, final: boolean): void {
    if (generation !== this.generation) {
      return
    }

    this.set({ ...this.snapshot, partial: text })
    this.options.onTranscript?.(text, final)
  }

  private set(snapshot: DictationSnapshot): void {
    this.snapshot = snapshot
    this.options.onChange?.(snapshot)
  }
}
