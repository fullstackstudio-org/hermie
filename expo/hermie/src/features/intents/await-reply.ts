/**
 * Waiting for the reply a Shortcut asked for.
 *
 * `ChatController.send` returns once the gateway has ACCEPTED the prompt, which
 * is a different moment from the bot having answered — and the answer is the
 * whole point of "Ask <bot>", because it is what flows into the next action of
 * a Shortcut. So this is the one place in the app that watches a turn to its
 * end and takes the text out.
 *
 * ## It watches the store rather than the socket
 *
 * A reply arrives as a stream of deltas into the chat store, which is already
 * the app's one model of a turn: `turn.active` goes true when a prompt is
 * submitted and false when the turn ends, however it ends — completed,
 * interrupted, or failed. Watching the store rather than the gateway means a
 * reply that came in over a reconnect, or one the reducer reconstructed from a
 * REST tail, is the same reply.
 *
 * ## A marker on its own is not enough, and the difference is the whole file
 *
 * The first version of this took the id of the last thing the bot had said and
 * waited for a DIFFERENT one. On a warm app that is right; on the launch a
 * Shortcut actually produces it answered instantly with the PREVIOUS reply.
 *
 * A Shortcut cold-starts the app. Nothing is in the chat store yet, so the
 * marker was read off an EMPTY transcript — and then opening the chat hydrates
 * it: the cache paints the thread, the resume binds it, the history read fills
 * it in. Every one of those is a store write, none of them is a reply to
 * anything, and the newest of them is the answer to the question that was asked
 * last time. The watch saw a last-message id that differed from "nothing", no
 * running turn, and settled — before the prompt had been sent at all.
 *
 * So two things changed, and both are load bearing:
 *
 *  - **the baseline is taken after the chat is open.** The runner opens the
 *    chat, and only then starts the watch, so hydration is finished and the
 *    marker is the reply that was genuinely there. The watch is still started
 *    BEFORE the send, because a fast gateway can finish the whole turn before
 *    `send` returns and a watch that only reacted to later changes would sit
 *    through the entire budget for a reply that had already landed;
 *  - **nothing settles until the prompt has been accepted, and then only for a
 *    reply that stands AFTER it.** `prompted` is the seam. A store that changes
 *    before it — a late resume, a reconnect that re-lays the tail, a teammate's
 *    turn — cannot produce an answer, because there is no question yet. After
 *    it, `answersPrompt` asks where the reply sits relative to our own words
 *    rather than merely whether its id has changed, which is what a re-emitted
 *    transcript breaks.
 *
 * ## Three ways out, and all three answer
 *
 * A new reply: its text. The budget runs out: `null`, which the runner turns
 * into "still working, open Hermie to read it". A turn that ends with nothing
 * new in it — an interruption, a tool-only turn, an error — also `null`, for
 * the same reason: a Shortcut that returns an empty string looks like it
 * worked.
 *
 * Nothing here is cancelled from outside. The subscription and the timer are
 * torn down by whichever fires first, so a caller that walks away leaks
 * neither.
 */
import type { ChatState } from '@hermie/transcript'

import { INTENT_BUDGET_MS } from './queue'

/**
 * What identifies the prompt this watch is waiting on the other side of.
 *
 * `itemId` is the transcript item the send painted, which is the exact answer
 * to "is this reply newer than my question" — `text` is what stands in when
 * there is no such item, which happens for a prompt the controller parked
 * behind a turn that was already running.
 */
export interface PromptMark {
  /** The item `ChatController.send` painted, when it painted one. */
  itemId?: string
  /** The prompt as submitted, which is what its bubble says. */
  text: string
}

export interface ReplyWatch {
  /**
   * The gateway has the prompt. Nothing can be an answer before this is called.
   *
   * Safe to call after the reply has already arrived: the check runs again
   * immediately, which is the fast-gateway case.
   */
  prompted: (mark: PromptMark) => void
  /** The reply, or `null`. Never rejects. */
  reply: Promise<string | null>
}

export interface StartReplyWatchOptions {
  chats: {
    getState: () => { chats: Record<string, ChatState> }
    subscribe: (listener: () => void) => () => void
  }
  botName: string
  /** Defaults to the queue's own budget, which is what the intent polls for. */
  timeoutMs?: number
  /** Injected in tests. */
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

/**
 * The last thing the bot actually SAID in this chat, as an id and its text.
 *
 * Deliberately the last `assistant` item and not the last item: a turn
 * routinely ends with a tool call, a notice or an injected row, and none of
 * those is an answer. `interim` bubbles — mid-turn commentary the gateway seals
 * before the real reply — are skipped for the same reason.
 *
 * Exported because it is the part worth testing on its own: a scan over a
 * transcript, with no store, no clock and no gateway in it.
 */
export function lastReplyOf(chat: ChatState | undefined): { id: string; text: string } | null {
  if (!chat) {
    return null
  }

  // `items` is an id-keyed map and `order` is the sequence; walking `order`
  // backwards is the only way to ask "the last thing said" — a map has no last.
  for (let index = chat.order.length - 1; index >= 0; index -= 1) {
    const id = chat.order[index]
    const item = id === undefined ? undefined : chat.items[id]

    if (item?.kind !== 'assistant' || item.interim) {
      continue
    }

    return { id: item.id, text: item.text.trim() }
  }

  return null
}

/**
 * Whether this reply is an answer to the prompt that was just sent.
 *
 * Position in the transcript, not identity: "a different id from before" is
 * true of every reply a re-hydration re-lays, and that is precisely what made
 * the previous answer look like a new one. A reply that stands AFTER our own
 * words is an answer to them; one that stands before them is history.
 *
 * Two ways to place it, in order of exactness:
 *
 *  1. the item the send painted. `beginLocalTurn` mints it and the reconcile
 *     keeps its id when the gateway echoes the turn back, so it is still there
 *     by the time the reply arrives;
 *  2. its TEXT, for a prompt the controller parked behind a running turn. No
 *     item exists for a parked prompt — it lives in the queue strip until the
 *     turn ahead of it ends — so the bubble to measure against is the one that
 *     appears when it is finally sent, and what makes it ours is what it says.
 *     This is the same pairing the reconciler uses for an unacknowledged turn.
 *
 * Neither available means the answer is "not yet". That is the safe direction:
 * the budget runs out and the person is told the bot is still working, which is
 * a sentence they can act on — where a reply that turns out to be the previous
 * one is a Shortcut that quietly returns the wrong thing.
 *
 * Exported for the same reason `lastReplyOf` is: it is a scan over a transcript
 * with no clock and no store in it.
 */
export function answersPrompt(
  chat: ChatState,
  replyId: string,
  prompt: PromptMark,
  baselineId: string | null
): boolean {
  if (replyId === baselineId) {
    return false
  }

  const replyAt = chat.order.indexOf(replyId)

  if (replyAt < 0) {
    return false
  }

  if (prompt.itemId !== undefined) {
    const promptAt = chat.order.indexOf(prompt.itemId)

    if (promptAt >= 0) {
      return replyAt > promptAt
    }
  }

  const wanted = prompt.text.trim()

  for (let index = replyAt - 1; index >= 0; index -= 1) {
    const id = chat.order[index]
    const item = id === undefined ? undefined : chat.items[id]

    if (item?.kind === 'user' && item.text.trim() === wanted) {
      return true
    }
  }

  return false
}

/**
 * Start watching now; answer with the reply to the prompt that is about to go.
 *
 * Call this once the chat is OPEN and before sending — the note above has why
 * both halves of that matter. It never rejects, so a caller whose send failed
 * can simply abandon the watch; it carries its own timeout and settles to
 * `null` on its own.
 */
export function startReplyWatch(options: StartReplyWatchOptions): ReplyWatch {
  const { botName, chats } = options
  const timeoutMs = options.timeoutMs ?? INTENT_BUDGET_MS
  const schedule = options.setTimeoutImpl ?? setTimeout
  const cancel = options.clearTimeoutImpl ?? clearTimeout

  const baseline = lastReplyOf(chats.getState().chats[botName])?.id ?? null

  let prompt: PromptMark | null = null
  let settled = false
  let unsubscribe = (): void => undefined
  let announce: (value: string | null) => void = () => undefined

  const reply = new Promise<string | null>(resolve => {
    announce = resolve
  })

  const finish = (value: string | null): void => {
    if (settled) {
      return
    }

    settled = true
    cancel(timer)
    unsubscribe()
    announce(value)
  }

  const timer = schedule(() => finish(null), timeoutMs)

  const check = (): void => {
    // No question yet, so nothing in the transcript can be its answer. This is
    // the guard the cold-start bug got past: hydration writes the whole of the
    // previous conversation into the store before the prompt has gone.
    if (!prompt) {
      return
    }

    const chat = chats.getState().chats[botName]

    // Still running is the ordinary case and the only reason to keep waiting.
    if (!chat || chat.turn.active) {
      return
    }

    const latest = lastReplyOf(chat)

    if (!latest || !answersPrompt(chat, latest.id, prompt, baseline)) {
      return
    }

    finish(latest.text || null)
  }

  unsubscribe = chats.subscribe(check)

  return {
    prompted: mark => {
      prompt = mark
      // Once immediately: a gateway fast enough to finish the turn before `send`
      // returned has already written the reply, and a watch that only reacted to
      // CHANGES from here would wait out the whole budget for it.
      check()
    },
    reply
  }
}
