/**
 * Turns, and the second description of a message inside one.
 *
 * A message the bot writes in the middle of a turn reaches a client more than
 * once. The gateway streams it (`message.delta`), PERSISTS it as an assistant
 * row, and only then announces it as `message.interim {text, already_streamed}`
 * (`agent/turn_tool_round.py`: "emit interim commentary after the DB append").
 * Neither frame carries a row id or a message id. Later the same words come back
 * as a `session.history` row with a `row_id`, and — when a chat is opened from a
 * cache saved mid-turn — the frames come back too, through `session.events.since`,
 * on top of rows that already describe them.
 *
 * With no id in common, the words are the key, and the words are only a safe key
 * inside one turn: the gateway never delivers the same interim text twice in a
 * turn (`_delivered_interim_texts`, reset per user turn), while two turns are free
 * to say "On it." each. So everything here is scoped to the turn an item belongs
 * to, and nothing pairs across a prompt.
 */
import { isInjectedNotice } from './injected'
import { isMatchable, normalizeMatchText } from './rows-to-items'
import type { AssistantItem, TranscriptItem } from './types'

/**
 * An item that opens a turn: the prompt it answers.
 *
 * A cron delivery counts: the scheduler's report runs on the `user` role and
 * starts a turn nobody local submitted. A gateway-injected notice counts for the
 * same reason — the gateway runs a turn on it.
 *
 * A STEER does not count, although it is a `user` row. It is handed to the turn
 * already running and starts none of its own, which is also why the gateway's
 * interim de-duplication carries on across it.
 */
export const opensTurn = (item: TranscriptItem): boolean =>
  (item.kind === 'user' && item.displayKind !== 'steer') ||
  item.kind === 'bot_dm_in' ||
  item.kind === 'cron_delivery' ||
  isInjectedNotice(item)

/** Whether two texts are the same words, as the gateway's own de-duplication compares them. */
export function sameWords(a: string, b: string): boolean {
  const left = normalizeMatchText(a)

  return left !== '' && left === normalizeMatchText(b)
}

/**
 * Whether a persisted item came from a projection that had no live item for it.
 *
 * `reconcile` and `reconcileTail` keep the LIVE item's id when they pair it with
 * its row, so a persisted item whose id is still the projection's own `r:<row>`
 * was never anybody's live bubble. That is the one row a stray live copy may be
 * folded into: a row that already took over a live bubble was that bubble's
 * row, and a second live item with the same words beside it is a second message
 * (one whose row has not arrived yet), not a copy.
 */
export const fromHistoryOnly = (item: TranscriptItem): boolean =>
  item.rowId !== undefined && item.id === `r:${item.rowId}`

/** Tool-like items: the calls a turn's notes stand between. */
const isCall = (item: TranscriptItem): boolean =>
  item.kind === 'tool' || item.kind === 'bot_dm_out' || item.kind === 'subagent_group'

/** Whether an item is settled transcript rather than something a stream is still building. */
const isSettled = (item: TranscriptItem): boolean => item.rowId !== undefined || item.origin === 'history'

/**
 * A live assistant item that may be a second description of a row: written by
 * the stream, never paired with a row, and finished.
 *
 * The bubble the stream is still filling is never one — its words are not final,
 * and pairing on a prefix is exactly how two different messages get merged.
 */
export const isLiveCopyCandidate = (item: TranscriptItem, activeId: string | undefined): item is AssistantItem =>
  item.kind === 'assistant' &&
  item.rowId === undefined &&
  item.origin !== 'history' &&
  !item.streaming &&
  !item.error &&
  item.id !== activeId &&
  isMatchable(item)

/**
 * Fold live copies into the rows they describe, one turn at a time.
 *
 * The rows a re-hydration brings are matched by row id first, so a live item a
 * replay stood up NEXT to a row that was already on screen is never matched by
 * anything and survives beside it — the muted copy under the real note. This is
 * the pass that pairs those: same turn, same words, one copy per row, in order.
 *
 * Conservative on purpose, because the same words can be two messages:
 *
 * - Only a row that came from history alone can take a copy (`fromHistoryOnly`).
 *   A row that already absorbed a live bubble has its live description.
 * - A sealed note (`interim`) pairs with any such row of its turn: the gateway
 *   never sends one interim text twice in a turn.
 * - A finished reply pairs only with the turn's LAST settled assistant row, and
 *   only when no settled call follows that row: that is where a turn's reply is,
 *   and a note with the same words sits before a call.
 */
export function foldLiveCopies(list: readonly TranscriptItem[], activeId: string | undefined): TranscriptItem[] {
  const dropped = new Set<number>()
  const replaced = new Map<number, AssistantItem>()

  const foldTurn = (from: number, to: number) => {
    const rows: number[] = []

    for (let index = from; index < to; index += 1) {
      const item = list[index]

      if (item?.kind === 'assistant' && fromHistoryOnly(item)) {
        rows.push(index)
      }
    }

    if (!rows.length) {
      return
    }

    // The turn's reply: its last settled assistant row, unless a settled call
    // comes after it.
    let reply: number | undefined

    for (let index = to - 1; index >= from; index -= 1) {
      const item = list[index]

      if (!item || (isCall(item) && isSettled(item))) {
        break
      }

      if (item.kind === 'assistant' && isSettled(item)) {
        reply = fromHistoryOnly(item) ? index : undefined
        break
      }
    }

    const taken = new Set<number>()
    const wordsAt = (index: number) => (list[index] as AssistantItem).text

    for (let index = from; index < to; index += 1) {
      const item = list[index]

      if (!item || !isLiveCopyCandidate(item, activeId)) {
        continue
      }

      const row = item.interim
        ? rows.find(candidate => !taken.has(candidate) && sameWords(wordsAt(candidate), item.text))
        : reply !== undefined && !taken.has(reply) && sameWords(wordsAt(reply), item.text)
          ? reply
          : undefined

      if (row === undefined) {
        continue
      }

      taken.add(row)
      dropped.add(index)
      replaced.set(row, carryLiveKnowledge(list[row] as AssistantItem, item))
    }
  }

  let start = 0

  list.forEach((item, index) => {
    if (opensTurn(item)) {
      foldTurn(start, index)
      start = index + 1
    }
  })
  foldTurn(start, list.length)

  return list.flatMap((item, index) => (dropped.has(index) ? [] : [replaced.get(index) ?? item]))
}

/**
 * The row, with whatever only the live copy knew: history carries no duration,
 * no usage, and on older gateways no reasoning.
 */
export function carryLiveKnowledge(row: AssistantItem, live: AssistantItem): AssistantItem {
  const reasoning = row.reasoning ?? live.reasoning
  const reasoningVerbose = row.reasoningVerbose ?? live.reasoningVerbose
  const durationS = row.durationS ?? live.durationS
  const usage = row.usage ?? live.usage

  return {
    ...row,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(reasoningVerbose !== undefined ? { reasoningVerbose } : {}),
    ...(durationS !== undefined ? { durationS } : {}),
    ...(usage !== undefined ? { usage } : {}),
    version: row.version + 1
  }
}

/**
 * What of a resume's flattened reply the transcript does not already show.
 *
 * `inflight.assistant` is every `message.delta` of the running turn run together
 * (`_append_inflight_delta`), so once a tool round has sealed a note, the note's
 * words are at the head of it. `earlier` is the turn's assistant items above the
 * bubble being resumed, in order. Each one whose words open what is left is cut
 * off; one that does not (a note that was never streamed, such as Codex
 * commentary) is passed over. Nothing in the middle is ever removed.
 *
 * `undefined` when nothing was cut, so a caller can keep its old behaviour to
 * the letter.
 */
export function unshownTail(flat: string, earlier: readonly AssistantItem[]): string | undefined {
  let rest = flat
  let cut = false

  for (const item of earlier) {
    const words = item.text.trim()
    const head = rest.trimStart()

    if (words && head.startsWith(words)) {
      rest = head.slice(words.length)
      cut = true
    }
  }

  return cut ? rest.trimStart() : undefined
}
