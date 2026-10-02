/**
 * The hands-free loop: listen, send, read the reply, listen again.
 *
 * A class with every side of it injected — the recognizer, the speaker, the
 * send, and the clock — because the interesting failures are all about ORDER
 * and TIMING and none of them can be produced by a person sitting in front of a
 * simulator:
 *
 *  - a reply arriving while the recognizer is still open;
 *  - a recognizer whose final result lands after the reader has already left;
 *  - the reader interrupting the speaker mid-sentence;
 *  - a cancel landing in the same tick as the confirmation timer.
 *
 * ## The four rules that make it usable rather than alarming
 *
 * 1. **It never sends an empty transcript.** A pause that produced nothing goes
 *    straight back to listening. Without this the loop sends a blank turn every
 *    time somebody clears their throat, and the bot answers it.
 * 2. **It shows what it heard before sending, by default.** `confirmMs` of the
 *    transcript on screen with a cancel under it. Voice mode SPEAKS FOR THE
 *    READER, and a recognizer that mishears should not be able to put words on
 *    a conversation with no moment to stop it. The setting can turn it off; it
 *    is on by default and that default is the point.
 * 3. **Silence ends the utterance.** The recognizer's own final result where it
 *    produces one, and `silenceMs` after the last thing heard where it does
 *    not — some recognizers in continuous mode never volunteer a final at all.
 *    The timer is armed only after something HAS been heard, so a reader who
 *    takes three seconds to start talking is not cut off before they begin.
 * 4. **Leaving stops everything, in one call, from any phase.** A microphone
 *    still open or a speaker still talking after the overlay has gone is the
 *    worst thing this feature can do.
 */
import type { RecognitionEngine, RecognitionFailure } from '../../platform/platform-contracts'

export type VoicePhase =
  | 'idle'
  /** Microphone open, nothing heard yet or still hearing. */
  | 'listening'
  /** Heard something; showing it before it goes. */
  | 'confirming'
  /** Handed to the chat; waiting for the turn to be accepted. */
  | 'sending'
  /** The turn is running. Nothing is listening and nothing is speaking. */
  | 'waiting'
  /** Reading the reply. A tap interrupts. */
  | 'speaking'
  /** Something went wrong and the loop has stopped. */
  | 'error'

export interface VoiceLoopState {
  phase: VoicePhase
  /** What has been heard, or what is about to be sent. */
  transcript: string
  /** Input level, 0…1, while listening. */
  level: number
  failure: RecognitionFailure | null
}

export const VOICE_IDLE: VoiceLoopState = { phase: 'idle', transcript: '', level: 0, failure: null }

/** How long after the last thing heard the loop stops listening by itself. */
export const SILENCE_MS = 1500

/** How long the transcript is shown before it is sent, when confirming. */
export const CONFIRM_MS = 1000

export interface VoiceLoopOptions {
  engine: RecognitionEngine
  /** Say this, and call back when it has finished or been cut. */
  speak: (text: string, done: () => void) => void
  /** Silence the speaker now. */
  stopSpeaking: () => void
  /** Put this on the conversation. Resolving means "accepted", not "answered". */
  send: (text: string) => Promise<void>
  /** BCP-47, or nothing for the device's own. */
  language?: string
  /** Show the transcript before sending. On by default; see rule 2. */
  confirm?: boolean
  onChange?: (state: VoiceLoopState) => void
  /** Listening began or ended: where the haptics hang. */
  onListeningChange?: (listening: boolean) => void
  silenceMs?: number
  confirmMs?: number
}

export class VoiceLoop {
  private readonly options: VoiceLoopOptions

  private state: VoiceLoopState = VOICE_IDLE

  private silence: ReturnType<typeof setTimeout> | null = null

  private confirmTimer: ReturnType<typeof setTimeout> | null = null

  /** Every start bumps it; anything from an older generation is dropped. */
  private generation = 0

  constructor(options: VoiceLoopOptions) {
    this.options = options
  }

  get snapshot(): VoiceLoopState {
    return this.state
  }

  /** Open the microphone and begin. Safe to call on a loop already running. */
  start(): void {
    if (this.state.phase !== 'idle' && this.state.phase !== 'error') {
      return
    }

    this.listen()
  }

  /**
   * The reply for the turn this loop sent.
   *
   * Called by the host when a turn COMPLETES — never while it streams, for the
   * same reason the automatic read does not: a reply being written is a reply
   * whose text will be different in 200ms.
   */
  replied(markdown: string): void {
    if (this.state.phase !== 'waiting') {
      return
    }

    const generation = this.generation

    if (!markdown.trim()) {
      // A turn that produced no words — a tool-only turn, a refusal the
      // transcript carried as a notice. Nothing to read; listen again.
      this.listen()

      return
    }

    this.set({ ...this.state, phase: 'speaking', level: 0 })
    this.options.speak(markdown, () => {
      if (generation === this.generation && this.state.phase === 'speaking') {
        this.listen()
      }
    })
  }

  /**
   * A tap on the overlay.
   *
   * Only meaningful while speaking, where it cuts the reply and listens again —
   * which is the whole of "let me say something". While listening it does
   * nothing on purpose: a tap that stopped the microphone would make the
   * indicator a button whose meaning changes under the reader's finger.
   */
  interrupt(): void {
    if (this.state.phase !== 'speaking') {
      return
    }

    this.options.stopSpeaking()
    this.listen()
  }

  /** The cancel under the transcript: do not send that. */
  cancel(): void {
    if (this.state.phase !== 'confirming') {
      return
    }

    this.clearTimers()
    this.listen()
  }

  /** Swipe down, Escape, or the screen going away. Stops everything. */
  leave(): void {
    this.generation += 1
    this.clearTimers()
    this.options.engine.abort()
    this.options.stopSpeaking()

    if (this.state.phase === 'listening') {
      this.options.onListeningChange?.(false)
    }

    this.set(VOICE_IDLE)
  }

  private listen(): void {
    this.clearTimers()
    this.generation += 1

    const generation = this.generation

    this.set({ phase: 'listening', transcript: '', level: 0, failure: null })
    this.options.onListeningChange?.(true)

    this.options.engine.start({
      ...(this.options.language ? { language: this.options.language } : {}),
      // Continuous, because the loop wants ONE utterance ended by silence
      // rather than a session that closes on the first pause and restarts.
      continuous: true,
      onPartial: text => this.heard(generation, text),
      onFinal: text => {
        if (generation !== this.generation) {
          return
        }

        this.clearTimers()
        this.commit(generation, text)
      },
      onVolume: level => {
        if (generation === this.generation && this.state.phase === 'listening') {
          this.set({ ...this.state, level })
        }
      },
      onError: failure => {
        if (generation !== this.generation) {
          return
        }

        this.clearTimers()

        /*
          A silence with nothing in it is not an error here.

          `no-speech` in a loop means the reader has not said anything yet, and
          stopping the whole of voice mode over it would make the feature
          unusable for anybody who pauses to think. Everything else stops,
          because a loop that silently retried a broken recognizer would spin.
        */
        if (failure === 'no-speech') {
          this.listen()

          return
        }

        this.options.onListeningChange?.(false)
        this.set({ ...this.state, phase: 'error', failure, level: 0 })
      },
      onEnd: () => {
        if (generation !== this.generation || this.state.phase !== 'listening') {
          return
        }

        /*
          The session closed without a final result.

          Some recognizers do this after a long silence. What was heard so far
          is the utterance — sending it is what the reader expects, and an empty
          one goes round again, which `commit` already decides.
        */
        this.clearTimers()
        this.commit(generation, this.state.transcript)
      }
    })
  }

  private heard(generation: number, text: string): void {
    if (generation !== this.generation || this.state.phase !== 'listening') {
      return
    }

    this.set({ ...this.state, transcript: text })

    // Armed only once something has been heard: a reader who takes three
    // seconds to begin must not be cut off before they start.
    if (!text.trim()) {
      return
    }

    if (this.silence) {
      clearTimeout(this.silence)
    }

    this.silence = setTimeout(() => {
      this.silence = null

      if (generation !== this.generation) {
        return
      }

      // Ask for a final; if none comes, `onEnd` commits what is here.
      this.options.engine.stop()
    }, this.options.silenceMs ?? SILENCE_MS)
  }

  private commit(generation: number, text: string): void {
    const transcript = text.trim()

    this.options.onListeningChange?.(false)

    // Rule 1. Nothing heard is not a message.
    if (!transcript) {
      this.listen()

      return
    }

    if (this.options.confirm === false) {
      this.dispatch(generation, transcript)

      return
    }

    this.set({ ...this.state, phase: 'confirming', transcript, level: 0 })
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null

      if (generation === this.generation && this.state.phase === 'confirming') {
        this.dispatch(generation, transcript)
      }
    }, this.options.confirmMs ?? CONFIRM_MS)
  }

  private dispatch(generation: number, transcript: string): void {
    this.set({ ...this.state, phase: 'sending', transcript, level: 0 })

    this.options
      .send(transcript)
      .then(() => {
        if (generation === this.generation && this.state.phase === 'sending') {
          this.set({ ...this.state, phase: 'waiting' })
        }
      })
      .catch(() => {
        if (generation === this.generation) {
          // A send that could not be made is the end of the loop rather than a
          // retry: the reader can see the overlay and decide.
          this.set({ ...this.state, phase: 'error', failure: 'failed' })
        }
      })
  }

  private clearTimers(): void {
    if (this.silence) {
      clearTimeout(this.silence)
      this.silence = null
    }

    if (this.confirmTimer) {
      clearTimeout(this.confirmTimer)
      this.confirmTimer = null
    }
  }

  private set(state: VoiceLoopState): void {
    this.state = state
    this.options.onChange?.(state)
  }
}
