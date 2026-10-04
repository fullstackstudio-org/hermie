/**
 * Dictation, as a state machine and two pure functions (`features/voice/dictation.ts` in the Expo app,
 * `DictationModel` in the native apps).
 *
 * Nothing here knows about React, a text field or a microphone. That is what makes the two things most likely to be
 * wrong testable: **where the words go**, and **what happens when the recogniser says no**.
 *
 * ## Where the words go
 *
 * A partial result is not an append. The recogniser revises what it thinks it heard ("recognise" becomes
 * "recognise the" becomes "recognise their"), so a field that appended every event would collect every revision. It
 * is also not a replace of the WHOLE field: the reader may have typed half a sentence before pressing the mic, and
 * may have put the caret in the middle of it.
 *
 * So a session takes an ANCHOR when it starts, the draft as it stood and the selection it stood with, and every
 * result, partial or final, is computed from that anchor and not from the previous result. A selected range is
 * replaced, as typing would. Recomputing rather than patching means a dropped event cannot desynchronise the field,
 * and the final result is nothing special: it is the last partial that happens to be true.
 *
 * ## What happens when the recogniser says no
 *
 * Four failures and four different answers, which is why `RecognitionFailure` is a closed set. `permission` is the
 * only one the reader can act on. `no-speech` is not really a failure (the reader pressed and said nothing), so it
 * says so and leaves the draft exactly as it was. `unavailable` means this browser cannot do it. `failed` is
 * everything else, said plainly rather than with a code. An abort is not among them: that is this client
 * cancelling, and an explanation for something the reader just did is noise.
 *
 * Dictation only ever writes the field. It never sends: what was heard is the reader's to read, change and send.
 */
import type { RecognitionEngine, RecognitionFailure } from '../../platform/speech-engines'

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
 * Spacing is arithmetic rather than a guess: a space is added before the transcript when the character in front of
 * it is not already white space, and after it when the character behind it is neither white space nor punctuation
 * that would look wrong with a gap in front of it. Dictating into the middle of `I said  and left` should not make
 * `I saidhello and left`.
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

export type DictationPhase = 'idle' | 'listening' | 'error'

export interface DictationSnapshot {
  phase: DictationPhase
  /** What has been heard so far. Empty until the first result. */
  partial: string
  /** Set only in the `error` phase. */
  failure: RecognitionFailure | null
}

export const DICTATION_IDLE: DictationSnapshot = { phase: 'idle', partial: '', failure: null }

export interface DictationOptions {
  onChange?: (snapshot: DictationSnapshot) => void
  /**
   * Every result, partial and final, with the caller deciding where it goes. `final` is passed through rather than
   * being the only call, because a caller that acted only on the final one would leave the field empty for the whole
   * time the reader was speaking, which is what makes dictation feel like it is working.
   */
  onTranscript?: (text: string, final: boolean) => void
}

export class DictationMachine {
  private readonly engine: RecognitionEngine

  private readonly options: DictationOptions

  private snapshot: DictationSnapshot = DICTATION_IDLE

  private heard = false

  /**
   * Bumped by every start and every cancel. A recogniser can deliver a result, or an `end`, for a session that has
   * already been replaced, and acting on one would put the previous utterance's words into the field the reader is
   * dictating into now.
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
   * Start listening. The browser asks for the microphone itself, so there is no permission step to wait for: a
   * refusal arrives as the `permission` failure, the same one-line explanation the phones give.
   */
  start(options: { language?: string } = {}): void {
    if (!this.engine.available) {
      this.set({ ...DICTATION_IDLE, phase: 'error', failure: 'unavailable' })

      return
    }

    if (this.snapshot.phase === 'listening') {
      return
    }

    this.generation += 1
    this.heard = false

    const generation = this.generation

    this.set({ ...DICTATION_IDLE, phase: 'listening' })

    this.engine.start({
      ...(options.language ? { language: options.language } : {}),
      onPartial: text => this.result(generation, text, false),
      onFinal: text => this.result(generation, text, true),
      onError: failure => {
        if (generation === this.generation) {
          this.set({ ...this.snapshot, phase: 'error', failure })
        }
      },
      onEnd: () => {
        if (generation !== this.generation) {
          return
        }

        // A session that was stopped, or ran out, having heard nothing says so, in a line: a press that silently did
        // nothing would read as a broken button. The draft is untouched either way. An error already reported stays.
        if (this.snapshot.phase === 'listening') {
          this.set(this.heard ? DICTATION_IDLE : { ...DICTATION_IDLE, phase: 'error', failure: 'no-speech' })
        }
      }
    })
  }

  /** Stop listening and take the final result: what a second press does. */
  stop(): void {
    if (this.snapshot.phase === 'listening') {
      this.engine.stop()
    }
  }

  /** Stop and throw away what was not delivered yet. Leaving the screen, the tab going away, a field changed by hand. */
  cancel(): void {
    if (this.snapshot.phase !== 'listening') {
      return
    }

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
    if (generation !== this.generation || this.snapshot.phase !== 'listening') {
      return
    }

    if (text.trim()) {
      this.heard = true
    }

    this.set({ ...this.snapshot, partial: text })
    this.options.onTranscript?.(text, final)
  }

  private set(snapshot: DictationSnapshot): void {
    this.snapshot = snapshot
    this.options.onChange?.(snapshot)
  }
}
