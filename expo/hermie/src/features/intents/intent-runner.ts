/**
 * Running what a Shortcut asked for, and writing the answer back.
 *
 * The other end of `queue.ts`. A Swift App Intent has written a request into
 * the shared container and is sitting in a poll loop with a stopwatch; this
 * opens the chat, sends the prompt, waits for the reply where one was asked
 * for, and writes the result the intent is waiting to read.
 *
 * ## Every request is answered, including the ones that fail
 *
 * This is the rule the whole class is arranged around, and it is the opposite
 * of the share outbox's. A share that cannot be delivered is KEPT, because
 * nobody is waiting and tomorrow will do. A Shortcut is somebody holding a
 * phone: an unanswered request is a spinner that ends in the system's own
 * unhelpful timeout, so a refusal written immediately is worth more than a
 * retry that might work. Nothing here is ever left pending.
 *
 * ## "Ask" waits for the turn; "Send to" does not
 *
 * The difference is the whole reason there are two intents. `ask` returns the
 * reply text so it can flow into the next action of a Shortcut, which means it
 * has to wait for a turn to finish inside a budget it did not choose. `send` is
 * fire-and-forget and is the honest answer for anything that takes real work:
 * it returns the moment the gateway has the prompt.
 *
 * ## Open, then watch, then send
 *
 * Three steps in one order, and the order is a bug fix rather than a style. A
 * Shortcut used to answer with the reply to the question asked BEFORE it,
 * because the watch was started first and opening the chat then hydrated the
 * transcript underneath it — a store full of the last conversation, with the
 * previous answer newest. `runOne` and `await-reply.ts` carry the detail.
 */
import type { ReplyWatch } from './await-reply'
import {
  intentFailure,
  intentReply,
  isExpired,
  parsePendingIntent,
  sortIntents,
  INTENT_BUDGET_MS,
  type PendingIntent
} from './queue'
import type { IntentQueue } from '../../platform/intent-queue'

export interface IntentRunnerPorts {
  queue: IntentQueue
  /** Whether the gateway socket is usable. Nothing is attempted while it is not. */
  ready: () => boolean
  /**
   * Resume this bot's chat and bring it on screen.
   *
   * On screen as well as resumed, deliberately: a Shortcut that opened the app
   * has already taken over the person's phone, and landing them on whatever was
   * last visible while a message is sent somewhere else is disorienting. It
   * rejects for a bot the roster does not have, which is what turns a renamed
   * profile into a sentence rather than a silence.
   */
  open: (bot: string) => Promise<void>
  /**
   * Submit the prompt, and say which transcript item it was painted as.
   *
   * The id is what the watch measures a reply against, and it is `undefined`
   * for the one case that has no item yet: a prompt the controller parked
   * behind a turn that was already running. `await-reply.ts` has what stands in
   * for it then.
   */
  send: (bot: string, text: string) => Promise<string | undefined>
  /**
   * Begin watching for the reply to the prompt that is about to be sent.
   *
   * Started between `open` and `send`, and neither side of that is arbitrary.
   * After `open`, because opening a chat HYDRATES it — cache, resume, history —
   * and a baseline taken before that is a baseline taken on an empty
   * transcript, which is how a Shortcut came to answer with the previous reply.
   * Before `send`, because a fast gateway can finish the whole turn before
   * `send` returns.
   *
   * `budgetMs` is what is left of the request's own budget rather than the
   * budget itself: the poll on the Swift side started when the request was
   * written, so a watch that ran the full budget from here would answer a file
   * nobody is reading any more.
   */
  startReplyWatch: (bot: string, budgetMs: number) => ReplyWatch
  now: () => number
}

export class IntentRunner {
  private readonly ports: IntentRunnerPorts

  private running = false
  /** A run asked for while one was in flight. Runs once, not once per request. */
  private again = false

  constructor(ports: IntentRunnerPorts) {
    this.ports = ports
  }

  /**
   * Drain the queue.
   *
   * Called on the `hermie://intent/<id>` link the intent opened, and again
   * whenever the gateway becomes ready — the second is what covers a cold
   * launch, where the link arrives before there is any socket to send on.
   *
   * It never rejects. A request that could not be run has been answered with a
   * reason, which is the only thing anybody downstream can use.
   */
  async run(): Promise<void> {
    if (this.running) {
      this.again = true

      return
    }

    this.running = true

    try {
      do {
        this.again = false
        await this.runOnce()
      } while (this.again)
    } finally {
      this.running = false
    }
  }

  private async runOnce(): Promise<void> {
    if (!this.ports.queue.available) {
      return
    }

    const entries = await this.ports.queue.list()
    const pending: PendingIntent[] = []

    for (const entry of entries) {
      const intent = parsePendingIntent(entry.payload)

      if (!intent || intent.id !== entry.id) {
        // A request from a build this one does not understand. Answered rather
        // than dropped, because the Shortcut on the other side is still waiting
        // and "this version of Hermie cannot run that" is a fact it can show.
        await this.ports.queue.complete(
          entry.id,
          intentFailure(entry.id, 'Hermie could not read that request. It may have been made by a newer version.')
        )

        continue
      }

      pending.push(intent)
    }

    for (const intent of sortIntents(pending)) {
      await this.runOne(intent)
    }
  }

  private async runOne(intent: PendingIntent): Promise<void> {
    if (isExpired(intent, this.ports.now())) {
      // Nobody is listening any more. The prompt is deliberately NOT sent: a
      // message arriving in a chat ten minutes after somebody gave up asking
      // for it is worse than no message.
      await this.ports.queue.complete(
        intent.id,
        intentFailure(intent.id, 'Hermie took too long to open, so nothing was sent.')
      )

      return
    }

    if (!this.ports.ready()) {
      // Not yet. This is the one case that is left pending on purpose — the
      // request is still inside its budget, the socket is dialling, and the
      // `ready` edge runs this again in a moment. The Swift side is still
      // polling, so the wait costs nothing that was not already being spent.
      return
    }

    /**
     * Open, then watch, then send — and abandon the watch if the send fails.
     *
     * The order is the fix for a Shortcut that answered with the PREVIOUS reply:
     * opening a chat paints the whole of the last conversation into the store,
     * so a watch started before it took its baseline on an empty transcript and
     * read the hydration as an answer. The port's own comment and
     * `await-reply.ts` have the rest of it.
     *
     * A watch nobody waits on costs one timer and settles itself, so there is no
     * cancel handle here — a cancellable watch would be a second thing to get
     * wrong for a case whose whole cost is that timer.
     */
    let watch: ReplyWatch | null = null

    try {
      await this.ports.open(intent.bot)

      if (intent.kind === 'ask') {
        watch = this.ports.startReplyWatch(intent.bot, this.budgetLeft(intent))
      }

      const promptId = await this.ports.send(intent.bot, intent.text)

      watch?.prompted({ itemId: promptId, text: intent.text })
    } catch (error) {
      await this.ports.queue.complete(intent.id, intentFailure(intent.id, messageOf(error)))

      return
    }

    if (!watch) {
      // Fire and forget: the gateway has the prompt, which is the whole of what
      // "Send to" promised.
      await this.ports.queue.complete(intent.id, intentReply(intent.id, ''))

      return
    }

    const reply = await watch.reply.catch(() => null)

    await this.ports.queue.complete(
      intent.id,
      reply === null
        ? intentFailure(
            intent.id,
            `${intent.bot} is still working. The message was sent — open Hermie to read the reply, or use “Send to” for prompts that take a while.`
          )
        : intentReply(intent.id, reply)
    )
  }

  /**
   * What is left of this request's budget, in milliseconds.
   *
   * ONE number lives in `queue.ts` and both sides spend it, but they do not
   * start spending it at the same moment: the Swift side starts polling when it
   * writes the request, and this side only reaches the send after a launch, a
   * dial and a hydration. Handing the watch the remainder keeps the two ends in
   * step — the app gives up a moment before the Shortcut does, so the answer it
   * writes is one somebody still reads.
   */
  private budgetLeft(intent: PendingIntent): number {
    return Math.max(0, INTENT_BUDGET_MS - (this.ports.now() - intent.createdAt))
  }
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)

  return text || 'Hermie could not send that message.'
}
