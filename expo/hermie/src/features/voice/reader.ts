/**
 * Which reply is being read, which ones are waiting, and what stops.
 *
 * The platform seam speaks ONE thing and knows nothing about messages (see
 * `platform/speech.ts` for why the platform's own queue is the wrong one). This
 * is the queue that knows about messages, and it is a plain class with an
 * injected engine so the whole state machine is testable without a speaker.
 *
 * ## Why there is a queue at all
 *
 * "Read replies aloud automatically" arms a read on every completed turn, and a
 * bot can finish a second turn while the first is still being spoken — a
 * delegation coming back, a cron delivery landing, or simply a fast model. The
 * three things that could happen are: talk over it, drop it, or queue it. The
 * first is unusable and the second silently loses a reply the reader asked to
 * hear, so it queues.
 *
 * ## Identity, and what it buys
 *
 * Everything here is keyed by the message id, which is what lets the menu ask
 * "is THIS row being read" and offer `Stop reading` on it and `Read aloud`
 * everywhere else. It is also what makes `enqueue` idempotent: an auto-read
 * effect that re-runs — which it does on every version bump of a streamed
 * reply — must not put the same reply in the queue twice.
 *
 * ## The one rule that is not obvious
 *
 * **A stop is not a completion.** `stop()` clears the queue and silences the
 * engine, and the engine's `onDone` for the utterance it just cut must not
 * advance anything. That is what `generation` is for: every start captures the
 * generation it belongs to, and a callback from an older one is dropped. A
 * boolean "stopping" flag would not do, because the two events can arrive in
 * either order on the web.
 */
import type { SpeechEngine } from '../../platform/platform-contracts'

export interface ReadRequest {
  /** The transcript item this text came from. Unique within one chat. */
  id: string
  /** Already flattened for speech — see `speech-text.ts`. */
  text: string
  /** BCP-47, or nothing for the device's own language. */
  language?: string
}

export interface ReaderState {
  /** The id being spoken right now, or `null`. */
  speakingId: string | null
  /** The ids waiting, in the order they will be read. */
  queuedIds: string[]
}

export const IDLE: ReaderState = { speakingId: null, queuedIds: [] }

export interface ReaderOptions {
  /** Read fresh on every utterance, so a rate changed mid-read applies to the next one. */
  rate?: () => number | undefined
  onChange?: (state: ReaderState) => void
}

export class SpeechReader {
  private readonly engine: SpeechEngine

  private readonly options: ReaderOptions

  private queue: ReadRequest[] = []

  private speaking: ReadRequest | null = null

  /**
   * Bumped by every stop and every start.
   *
   * See the header: it is how a callback for an utterance that has been cut is
   * told apart from a callback for the one that is actually current.
   */
  private generation = 0

  constructor(engine: SpeechEngine, options: ReaderOptions = {}) {
    this.engine = engine
    this.options = options
  }

  get state(): ReaderState {
    return { speakingId: this.speaking?.id ?? null, queuedIds: this.queue.map(request => request.id) }
  }

  /** Being spoken now, or waiting to be. The menu draws `Stop reading` for both. */
  has(id: string): boolean {
    return this.speaking?.id === id || this.queue.some(request => request.id === id)
  }

  /**
   * Put a reply in line, and start it if nothing is being read.
   *
   * Silently does nothing for an empty text, for an id already in flight, and on
   * a platform with no engine — the three cases where the honest answer is "no
   * change" rather than an error. A caller that needs to know whether speaking is
   * possible at all asks `engine.available`, which is what hides the menu line.
   */
  enqueue(request: ReadRequest): void {
    if (!this.engine.available || !request.text.trim() || this.has(request.id)) {
      return
    }

    this.queue.push(request)

    if (!this.speaking) {
      this.advance()
    } else {
      this.emit()
    }
  }

  /**
   * `Read aloud` and `Stop reading` as one gesture.
   *
   * The menu offers two lines rather than one toggle, and both land here: a row
   * that is already in flight is taken back out, anything else is queued. Taking
   * out the row being SPOKEN stops everything, because there is one speaker and
   * a reader who says "stop reading this" is not asking for the next one to
   * start immediately.
   */
  toggle(request: ReadRequest): void {
    if (this.speaking?.id === request.id) {
      this.stop()

      return
    }

    if (this.queue.some(queued => queued.id === request.id)) {
      this.queue = this.queue.filter(queued => queued.id !== request.id)
      this.emit()

      return
    }

    this.enqueue(request)
  }

  /** Silence, and forget everything waiting. */
  stop(): void {
    this.generation += 1
    this.queue = []
    this.speaking = null
    this.engine.stop()
    this.emit()
  }

  private advance(): void {
    const next = this.queue.shift()

    if (!next) {
      this.speaking = null
      this.emit()

      return
    }

    this.generation += 1

    const generation = this.generation
    const rate = this.options.rate?.()

    this.speaking = next
    this.emit()

    this.engine.speak({
      text: next.text,
      ...(next.language ? { language: next.language } : {}),
      ...(rate === undefined ? {} : { rate }),
      onDone: () => this.finished(generation),
      // A failure is a completion as far as the queue is concerned: the reply
      // could not be read, and stalling on it would take the rest of the queue
      // down with it. The reader hears the next one rather than silence.
      onError: () => this.finished(generation)
    })
  }

  private finished(generation: number): void {
    // From an utterance this reader no longer owns — see the header.
    if (generation !== this.generation) {
      return
    }

    this.speaking = null
    this.advance()
  }

  private emit(): void {
    this.options.onChange?.(this.state)
  }
}
