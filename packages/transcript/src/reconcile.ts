/**
 * Reconciliation: fold a freshly hydrated transcript into the live state
 * without losing the tail and without renaming items.
 *
 * Stable ids are the point. A UI keyed on `item.id` must not remount every row
 * when a re-hydration lands, so a fresh item adopts the id of the current item
 * it matches: durable `rowId` first, then `tool_id`, then what the item says and
 * carries (`itemMatchKey`).
 *
 * Ported from `apps/desktop/src/lib/chat-messages/reconciliation.ts`.
 */
import { isInjectedNotice } from './injected'
import { isMatchable, itemMatchKey } from './rows-to-items'
import {
  type AssistantItem,
  type BotDmOutItem,
  type ChatState,
  freeItemId,
  type NoticeItem,
  SEQ_STEP,
  type SubagentGroupItem,
  type ToolItem,
  type TranscriptItem,
  type UserItem
} from './types'
import { replyFromDeliveryOutput } from './bot-dm'

const toolKeyOf = (item: TranscriptItem): string | undefined =>
  item.kind === 'tool' || item.kind === 'bot_dm_out'
    ? item.toolId
    : item.kind === 'subagent_group'
      ? item.toolId
      : undefined

/** The gateway's call identity on an item kind that can carry one (`identity.ts`). */
const callKeyOfItem = (item: TranscriptItem): string | undefined =>
  item.kind === 'tool' || item.kind === 'bot_dm_out' || item.kind === 'subagent_group' ? item.callKey : undefined

/** The gateway's turn identity on a prompt. */
const turnIdOfItem = (item: TranscriptItem): string | undefined => (item.kind === 'user' ? item.turnId : undefined)

/**
 * Whether `current`, found by a call key or a turn id, may be `fresh`.
 *
 * The id says they are the same call or turn; a row id that says otherwise
 * wins, because two persisted rows are two rows whatever else they share.
 */
const rowsAgree = (current: TranscriptItem, fresh: TranscriptItem): boolean =>
  current.rowId === undefined || fresh.rowId === undefined || current.rowId === fresh.rowId

/**
 * Whether two items the old keys paired may really be one, as far as the
 * gateway's identities go: two different calls, or two different turns, are
 * never one item, however alike their tool ids or words. An item without the
 * identity says nothing either way, which is every item from before it existed.
 */
function identitiesAgree(a: TranscriptItem | undefined, b: TranscriptItem): boolean {
  if (!a) {
    return true
  }

  const callA = callKeyOfItem(a)
  const callB = callKeyOfItem(b)
  const turnA = turnIdOfItem(a)
  const turnB = turnIdOfItem(b)

  return (!callA || !callB || callA === callB) && (!turnA || !turnB || turnA === turnB)
}

/**
 * The last-resort pairing key: the kind, the text, and the attachments.
 *
 * The attachments are in it because a send can have no text to pair on at all —
 * a turn whose whole body was a `@file:` reference projects to the empty string,
 * and the file is then the only thing identifying it.
 */
const matchKeyOf = (item: TranscriptItem): string => `${item.kind}\n${itemMatchKey(item)}`

/**
 * Whether two items that say the same thing may be the same turn, as far as
 * WHO said it goes (HERM-83).
 *
 * In a group chat two people can both say "ok", and a key made of the words
 * alone paired the reader's optimistic "ok" with a colleague's persisted one —
 * handing the reader's bubble the colleague's row and author, and losing the
 * reader's own turn. So two items that each name an author pair only when it
 * is the same author.
 *
 * One side without an author still pairs. That is a gateway that stamps nobody
 * answering a reader whose identity is known — the bubble carries an author,
 * its row does not — and they are one turn; refusing them would draw every
 * message that reader sends twice. It is also every row from before the stamp
 * existed, which is how pairing always worked.
 */
function authorsAgree(a: TranscriptItem | undefined, b: TranscriptItem): boolean {
  const left = a?.kind === 'user' ? a.author?.id : undefined
  const right = b.kind === 'user' ? b.author?.id : undefined

  return !left || !right || left === right
}

/**
 * Notice kinds this client mints itself and the gateway never writes as a row —
 * see the `'command'` case of `NoticeKind` in `types.ts` and `session.reclaimed`
 * (`reducer.ts`), which is a broadcast, not a persisted turn. A re-hydration has
 * nothing to match either against, ever, no matter how long the client waits.
 */
const EPHEMERAL_NOTICE_KINDS: ReadonlySet<NoticeItem['noticeKind']> = new Set(['command', 'reclaimed'])

const isEphemeralNotice = (item: TranscriptItem): boolean =>
  item.kind === 'notice' && EPHEMERAL_NOTICE_KINDS.has(item.noticeKind)

/** Items the backend never persists, so a re-hydration can never re-supply them. */
const isEphemeral = (item: TranscriptItem): boolean =>
  item.kind === 'approval' || item.kind === 'clarify' || isEphemeralNotice(item)

/**
 * Something the reader has already settled, as opposed to a question still
 * open or a card still waiting on an answer.
 *
 * It is the difference between a question and a record of one, and the two
 * belong in different places. An OPEN request is being asked NOW: it stands at
 * the tail whatever timestamp it carries, because that is where the reader is
 * looking and where the turn is waiting. An ANSWERED or CANCELLED one is a line
 * in the transcript like any other, and its place is the moment it happened.
 *
 * Which is the whole of the owner's report. A card answered yesterday is cached
 * (`cache.ts` keeps everything but an open request), painted on a cold open, and
 * then survives the history re-hydration as an item history can never re-supply
 * — and was appended BEHIND every row that hydration brought back, including
 * this morning's. `layoutRows` stamps a date wherever the day changes between
 * neighbours, so the reader got `TODAY`, yesterday's card, and `TODAY` again.
 *
 * A `command` or `reclaimed` notice is the same shape of problem with no "open"
 * state to protect: a slash command's answer and a reclaimed-session notice are
 * always a record of something that already happened, so they always belong
 * here rather than in the plain `kept` bucket `placeByTimestamp` never sorts.
 */
const isSettledRequest = (item: TranscriptItem): boolean =>
  ((item.kind === 'approval' || item.kind === 'clarify') && item.state !== 'open') || isEphemeralNotice(item)

/**
 * Put items that carry their own moment back into it, rather than at the end.
 *
 * Only for the handful of items a re-hydration keeps without being able to place
 * them: they have no row id, so `inRowOrder` has nothing to sort them by, and
 * the timestamp they were created with is the only thing that says where they
 * belong. Each one goes in front of the first item that is strictly NEWER than
 * it; an item carrying no timestamp of its own is passed over, because its
 * position is the one its neighbours gave it. Nothing newer than the whole list
 * moves at all, which is the ordinary live case — a card answered a moment ago
 * still lands at the tail, exactly as it did before.
 *
 * Deliberately not a sort of the transcript. A streaming bubble, an interim note
 * and an optimistic submit each have ordering rules of their own that a
 * timestamp does not know about, and re-sorting the whole list by `ts` would
 * overrule every one of them.
 */
function placeByTimestamp(list: readonly TranscriptItem[], floating: readonly TranscriptItem[]): TranscriptItem[] {
  const placed = [...list]

  for (const item of floating) {
    const ts = item.ts

    if (ts === undefined) {
      placed.push(item)

      continue
    }

    const newer = placed.findIndex(other => other.ts !== undefined && other.ts > ts)

    placed.splice(newer < 0 ? placed.length : newer, 0, item)
  }

  return placed
}

/**
 * A row that opens a turn, and therefore names the author a foreign
 * `message.start` placeholder is standing in for.
 *
 * A cron delivery counts: the scheduler's report runs on the `user` role and
 * starts a turn nobody local submitted, so it is exactly what such a placeholder
 * is waiting for. `mergeWithLive` needs no cron case of its own — the stream
 * learns nothing about a delivery that the persisted row does not also carry, so
 * the default "fresh wins, id is kept" merge is already correct.
 *
 * A gateway-injected notice counts for the same reason: a fan-out's report or a
 * background process's completion is written on the `user` role and the gateway
 * runs a turn on it. Without this the placeholder had nothing to become and
 * stayed on screen as an empty bubble beside the card.
 *
 * A STEER does not count, although it is a `user` row. It is handed to the turn
 * already running and starts none of its own, so letting it fill a placeholder
 * would draw a mid-turn correction as the prompt of somebody else's turn.
 */
const isAuthoredRow = (item: TranscriptItem): boolean =>
  (item.kind === 'user' && item.displayKind !== 'steer') ||
  item.kind === 'bot_dm_in' ||
  item.kind === 'cron_delivery' ||
  isInjectedNotice(item)

/** Merge live knowledge onto a hydrated row: history is thinner than the stream. */
function mergeWithLive(fresh: TranscriptItem, current: TranscriptItem): TranscriptItem {
  const merged = { ...fresh, id: current.id, version: current.version + 1 } as TranscriptItem

  if (fresh.kind !== current.kind) {
    return merged
  }

  // An identity either side learned is kept: a row from a history projection
  // that predates it, merged onto a card the stream named, still names its call.
  const callKey = callKeyOfItem(current)

  if (callKey && !callKeyOfItem(merged)) {
    ;(merged as ToolItem | BotDmOutItem | SubagentGroupItem).callKey = callKey
  }

  const turnId = turnIdOfItem(current)

  if (turnId && merged.kind === 'user' && !merged.turnId) {
    merged.turnId = turnId
  }

  if (merged.kind === 'tool' && current.kind === 'tool') {
    // A history tool row has a name and a preview but never a result.
    if (!merged.resultKnown && current.resultKnown) {
      const carried = merged as ToolItem

      carried.resultKnown = true
      carried.result = current.result
      carried.status = current.status
      carried.isError = current.isError
      carried.resultText = current.resultText ?? carried.resultText
      carried.summary = carried.summary ?? current.summary
      carried.inlineDiff = current.inlineDiff ?? carried.inlineDiff
      carried.durationS = current.durationS ?? carried.durationS
      carried.argsText = current.argsText ?? carried.argsText
      carried.outputRisk = current.outputRisk ?? carried.outputRisk
    }

    return merged
  }

  if (merged.kind === 'bot_dm_out' && current.kind === 'bot_dm_out') {
    const carried = merged as BotDmOutItem

    if (carried.dispatch.status === 'unknown') {
      carried.dispatch = current.dispatch
    }

    carried.reply = carried.reply ?? current.reply
    // A tool row carries no timestamp, so the moment the dispatch went out is
    // known only to the stream that watched it leave. Losing it on the merge
    // would take the row's date stamp with it.
    carried.ts = carried.ts ?? current.ts

    return merged
  }

  if (merged.kind === 'subagent_group' && current.kind === 'subagent_group') {
    const carried = merged as SubagentGroupItem

    carried.rootIds = current.rootIds.length ? current.rootIds : carried.rootIds
    carried.delegationId = carried.delegationId ?? current.delegationId
    carried.completion = carried.completion ?? current.completion

    if (carried.status === 'dispatched' && current.status !== 'dispatched') {
      carried.status = current.status
    }

    return merged
  }

  if (merged.kind === 'assistant' && current.kind === 'assistant') {
    const carried = merged as AssistantItem

    carried.reasoning = carried.reasoning ?? current.reasoning
    carried.reasoningVerbose = carried.reasoningVerbose ?? current.reasoningVerbose
    carried.durationS = carried.durationS ?? current.durationS
    carried.usage = carried.usage ?? current.usage
    // A failed turn is not persisted as a failure; keep the local verdict.
    carried.error = carried.error ?? current.error
    carried.status = current.error ? (current.status ?? carried.status) : carried.status

    return merged
  }

  if (merged.kind === 'user' && current.kind === 'user') {
    const carried = merged as UserItem

    carried.attachments = carried.attachments ?? current.attachments
    carried.pending = false

    return merged
  }

  return merged
}

/**
 * Put a merged list back into the gateway's own row order.
 *
 * `reconcileTail` splices rows it has never seen in front of the live tail,
 * which is right whenever they were written after everything on screen — and
 * wrong the moment they were not. A teammate's delivery or a cron turn written
 * while the user was still typing carries a LOWER row id than the message they
 * then sent, so arrival order shows the two the wrong way round, and the ids
 * that say so only arrive with the tail.
 *
 * Row ids are the order the gateway holds, so a persisted item sorts by its own.
 * An item with no row id yet sorts with the newest row above it, which keeps a
 * streaming bubble under the prompt it answers and keeps a row genuinely newer
 * than the whole live tail behind that tail, exactly as the splice intended.
 */
function inRowOrder(list: readonly TranscriptItem[]): TranscriptItem[] {
  let newestAbove = -1
  const keyed = list.map((item, index) => {
    const key = item.rowId ?? newestAbove

    newestAbove = Math.max(newestAbove, item.rowId ?? -1)

    return { item, key, index }
  })

  return keyed.sort((a, b) => a.key - b.key || a.index - b.index).map(entry => entry.item)
}

function rebuild(state: ChatState, list: readonly TranscriptItem[]): ChatState {
  const next: ChatState = {
    ...state,
    items: {},
    order: [],
    byToolId: {},
    byCallKey: {},
    byRowId: {},
    byRequestId: {},
    byApprovalId: {},
    byProcessId: {},
    byDelegationId: {},
    turn: { ...state.turn }
  }

  list.forEach((item, index) => {
    /*
      The id is re-checked here rather than assumed.

      A persisted item's id is its gateway ROW NUMBER, and a gateway that
      restarts under a live session numbers the rebuilt one from 1 again. So a
      freshly projected `r:4` and a live `r:4` kept from the tail are two
      different rows wearing one id, and this loop is the single funnel both
      reconcilers push `order` through. The earlier of the two keeps the id a
      list is keyed on; only the later is renamed.
    */
    const placed = { ...item, id: freeItemId(next.items, item.id), seq: index * SEQ_STEP }

    next.items[placed.id] = placed
    next.order.push(placed.id)

    if (placed.rowId !== undefined) {
      next.byRowId[String(placed.rowId)] = placed.id
    }

    const toolKey = toolKeyOf(placed)

    if (toolKey) {
      next.byToolId[toolKey] = placed.id
    }

    if (
      (placed.kind === 'tool' || placed.kind === 'bot_dm_out' || placed.kind === 'subagent_group') &&
      placed.callKey
    ) {
      next.byCallKey[placed.callKey] = placed.id
    }

    if (placed.kind === 'bot_dm_out' && placed.dispatch.processId) {
      next.byProcessId[placed.dispatch.processId] = placed.id
    }

    if (placed.kind === 'subagent_group' && placed.delegationId) {
      next.byDelegationId[placed.delegationId] = placed.id
    }

    if (placed.kind === 'approval' || placed.kind === 'clarify') {
      next.byRequestId[placed.requestId] = placed.id
    }

    if (placed.kind === 'approval' && placed.approvalId) {
      next.byApprovalId[placed.approvalId] = placed.id
    }
  })

  /*
    `nextSeq` is a HIGH-WATER MARK, not a position.

    It was `list.length * SEQ_STEP`, which reads the counter off the transcript's
    current length — and a re-hydration is free to make the transcript SHORTER.
    Pull the gateway out from under a live session and the rebuilt one comes back
    with fewer rows than the client holds, so this line moved the counter
    BACKWARDS, onto seq values already spent on ids that are still in the list.
    The next send then minted an id the transcript already had: `order` is a
    list, so it grew a second entry pointing at the same item, which is React's
    "two children with the same key" and, on screen, the same user bubble twice.

    Seven seeded rows, a transcript that loses one on the rebuild, and sends the
    dead gateway never persisted is the arrangement that was reported, and it
    lands on `o:9000` exactly.

    The only thing the counter owes the order is to sit ABOVE every seq in the
    list, and `list.length * SEQ_STEP` still does that — so taking the larger of
    the two costs nothing and takes the collision away.
  */
  next.turn.nextSeq = Math.max(state.turn.nextSeq, list.length * SEQ_STEP)
  next.turn.assistantId = next.turn.assistantId && next.items[next.turn.assistantId] ? next.turn.assistantId : undefined

  return next
}

/**
 * Replace the transcript with `freshItems` (a full re-hydration), keeping ids
 * stable, keeping live knowledge history does not carry, and keeping the
 * not-yet-persisted tail plus any open request.
 */
export function reconcile(state: ChatState, freshItems: readonly TranscriptItem[]): ChatState {
  const byRowId = new Map<number, string>()
  const byTurnId = new Map<string, string>()
  const byCallKey = new Map<string, string>()
  const byToolKey = new Map<string, string>()
  const byMatchKey = new Map<string, string[]>()

  for (const id of state.order) {
    const item = state.items[id]

    if (!item) {
      continue
    }

    if (item.rowId !== undefined && !byRowId.has(item.rowId)) {
      byRowId.set(item.rowId, id)
    }

    const turnId = turnIdOfItem(item)

    if (turnId && !byTurnId.has(turnId)) {
      byTurnId.set(turnId, id)
    }

    const callKey = callKeyOfItem(item)

    if (callKey && !byCallKey.has(callKey)) {
      byCallKey.set(callKey, id)
    }

    const toolKey = toolKeyOf(item)

    if (toolKey && !byToolKey.has(toolKey)) {
      byToolKey.set(toolKey, id)
    }

    if (isMatchable(item)) {
      const key = matchKeyOf(item)

      byMatchKey.set(key, [...(byMatchKey.get(key) ?? []), id])
    }
  }

  const used = new Set<string>()
  const merged: TranscriptItem[] = []

  /** A candidate found by an identity, when nothing has claimed it and no row id contradicts it. */
  const byIdentity = (id: string | undefined, fresh: TranscriptItem): string | undefined => {
    const current = id && !used.has(id) ? state.items[id] : undefined

    return current && rowsAgree(current, fresh) ? current.id : undefined
  }

  for (const fresh of freshItems) {
    let matchId = fresh.rowId !== undefined ? byRowId.get(fresh.rowId) : undefined

    // The gateway's own identities next: the turn a prompt opened, the call a
    // card is. Each is unique where the words and the provider's tool ids are
    // not, so a pair made here needs nothing the reader can see to agree.
    if (!matchId || used.has(matchId)) {
      const turnId = turnIdOfItem(fresh)

      matchId = turnId ? byIdentity(byTurnId.get(turnId), fresh) : undefined
    }

    if (!matchId || used.has(matchId)) {
      const callKey = callKeyOfItem(fresh)

      matchId = callKey ? byIdentity(byCallKey.get(callKey), fresh) : undefined
    }

    if (!matchId || used.has(matchId)) {
      const toolKey = toolKeyOf(fresh)

      matchId = toolKey ? byToolKey.get(toolKey) : undefined

      if (matchId && !identitiesAgree(state.items[matchId], fresh)) {
        matchId = undefined
      }
    }

    if (!matchId || used.has(matchId)) {
      matchId = isMatchable(fresh)
        ? byMatchKey
            .get(matchKeyOf(fresh))
            ?.find(
              id => !used.has(id) && authorsAgree(state.items[id], fresh) && identitiesAgree(state.items[id], fresh)
            )
        : undefined
    }

    const current = matchId && !used.has(matchId) ? state.items[matchId] : undefined

    if (current) {
      used.add(current.id)
      merged.push(mergeWithLive(fresh, current))

      continue
    }

    merged.push(fresh)
  }

  const lastUsedIndex = state.order.reduce((last, id, index) => (used.has(id) ? index : last), -1)
  const kept: TranscriptItem[] = []
  /** Kept, but with a moment of their own to be put back into — see `placeByTimestamp`. */
  const settled: TranscriptItem[] = []

  state.order.forEach((id, index) => {
    const item = state.items[id]

    if (!item || used.has(id)) {
      return
    }

    if (!isEphemeral(item) && !(item.origin !== 'history' && index > lastUsedIndex)) {
      return
    }

    if (isSettledRequest(item) && item.ts !== undefined) {
      settled.push(item)

      return
    }

    kept.push(item)
  })

  const next = rebuild(state, placeByTimestamp([...merged, ...kept], settled))

  next.hydration = 'live'

  return next
}

/**
 * Put a page of OLDER rows in front of the transcript.
 *
 * This is the other direction from `reconcile`, and it is a different operation
 * rather than the same one with a longer list. `reconcile` is a re-hydration: it
 * is handed what the server says the transcript IS, matches it against what is
 * on screen and keeps the live tail. Handing it a page that only covers rows
 * 400–600 would be telling it the conversation is those rows, and everything
 * newer that is not "live" would be dropped on the floor.
 *
 * So a page arrives as what it is: rows strictly older than everything held,
 * placed at the front, with nothing in the existing list touched. The only
 * merging it does is a refusal — a row whose `rowId` is already in the list is
 * dropped rather than added twice, which is what makes a page that overlaps the
 * one before it harmless. Overlap is not hypothetical: the offset a page is
 * fetched at counts rows, and a turn that lands between two pages shifts every
 * older row by one.
 *
 * Ordering is the server's. The route answers oldest-first whichever end it
 * counted from — measured against a real gateway, 2026-09-21 — so the page is
 * already in the order it belongs in.
 *
 * Nothing about hydration changes. A transcript that was `live` is still live
 * with more of itself loaded, and one that was `stale` did not become fresh
 * because its far end grew.
 */
export function prependHistory(state: ChatState, olderItems: readonly TranscriptItem[]): ChatState {
  const known = new Set<number>()
  const knownCalls = new Set<string>()

  for (const id of state.order) {
    const item = state.items[id]
    const rowId = item?.rowId
    const callKey = item ? callKeyOfItem(item) : undefined

    if (rowId !== undefined) {
      known.add(rowId)
    }

    if (callKey) {
      knownCalls.add(callKey)
    }
  }

  // The call key is the belt to the row id's braces: a call is one card, so an
  // older page re-sending it is a page that overlaps, whatever its row says.
  const older = olderItems.filter(item => {
    const callKey = callKeyOfItem(item)

    return (item.rowId === undefined || !known.has(item.rowId)) && (!callKey || !knownCalls.has(callKey))
  })

  if (!older.length) {
    return state
  }

  const current = state.order.map(id => state.items[id]).filter((item): item is TranscriptItem => Boolean(item))

  /*
    `rebuild` frees a colliding id rather than letting `order` hold it twice, and
    that guard is load-bearing here rather than theoretical. A REST row with no
    `id` falls back to a POSITIONAL item id (`user:0`), and position is per page,
    so two pages can both produce `user:0`. Every row this route returns has an
    id in practice; the fallback is what happens when one does not.
  */
  return rebuild(state, [...older, ...current])
}

/**
 * Fold a short tail fetch into the existing transcript: fill the placeholder a
 * foreign `message.start` left behind, join DM replies onto their dispatch, and
 * append rows we had not seen. Nothing live is ever dropped — a tail fetch that
 * races the turn it is describing must not delete the bubble being streamed.
 */
export function reconcileTail(state: ChatState, tailItems: readonly TranscriptItem[]): ChatState {
  const list = state.order.map(id => state.items[id]).filter((item): item is TranscriptItem => Boolean(item))
  const placeholders = list.filter(item => item.kind === 'user' && item.unknownAuthor).map(item => item.id)
  const knownRowIds = new Set(list.map(item => item.rowId).filter((rowId): rowId is number => rowId !== undefined))
  const byId = new Map(list.map(item => [item.id, item]))
  const appended: TranscriptItem[] = []
  let placeholderCursor = 0

  /**
   * The live tail, indexed by what each item says and carries.
   *
   * A turn we sent ourselves exists twice for a moment: as the optimistic
   * bubble and the streamed reply the reducer built (no `rowId`, because
   * nothing persisted them yet), and as the rows the gateway wrote. There is no
   * id in common — `prompt.submit` does not answer with one — so this key is the
   * only thing that can pair them, exactly as `reconcile` already does for a
   * full re-hydration. Without it the next `sessions.changed` sweep appends the
   * persisted copies and every sent message shows up twice.
   *
   * Indexing on TEXT alone was that bug's second half: a send carrying only a
   * file has no text, so the bubble was never a candidate and the row landed
   * beside it.
   */
  const liveByMatchKey = new Map<string, string[]>()

  for (const item of list) {
    if (item.rowId !== undefined || !isMatchable(item)) {
      continue
    }

    const key = matchKeyOf(item)

    liveByMatchKey.set(key, [...(liveByMatchKey.get(key) ?? []), item.id])
  }

  /**
   * The live prompts that know which turn they opened: a parked prompt the
   * turn's `message.start` claimed, and a foreign placeholder standing in for a
   * turn's author. A row naming that turn is theirs and nobody else's.
   */
  const liveByTurnId = new Map<string, string>()

  for (const item of list) {
    const turnId = turnIdOfItem(item)

    if (turnId && item.rowId === undefined && !liveByTurnId.has(turnId)) {
      liveByTurnId.set(turnId, item.id)
    }
  }

  const pairedLive = new Set<string>()
  /** Placeholders already given their row, by turn id or by position. */
  const filled = new Set<string>()
  /**
   * The tail carried an authored row that belonged to a bubble already on
   * screen — our own optimistic submit coming back persisted. It is the only
   * evidence that says a placeholder standing beside it was never anybody
   * else's turn, as opposed to a turn whose row the tail has not reached yet.
   */
  let pairedAuthoredRow = false

  for (const fresh of tailItems) {
    if (fresh.rowId !== undefined && knownRowIds.has(fresh.rowId)) {
      const existingId = state.byRowId[String(fresh.rowId)]
      const current = existingId ? byId.get(existingId) : undefined

      if (current) {
        byId.set(current.id, mergeWithLive(fresh, current))
      }

      continue
    }

    // A prompt that names its turn goes to the live item standing for that
    // turn: the claimed prompt, or the placeholder that turn put up — that one,
    // never the next placeholder along.
    const turnId = turnIdOfItem(fresh)
    const turnMatchId = turnId ? liveByTurnId.get(turnId) : undefined
    const turnMatch = turnMatchId && !pairedLive.has(turnMatchId) ? byId.get(turnMatchId) : undefined

    if (turnMatch && (!(turnMatch.kind === 'user' && turnMatch.unknownAuthor) || isAuthoredRow(fresh))) {
      pairedLive.add(turnMatch.id)

      if (turnMatch.kind === 'user' && turnMatch.unknownAuthor) {
        filled.add(turnMatch.id)
        byId.set(turnMatch.id, { ...fresh, id: turnMatch.id, version: turnMatch.version + 1 })
      } else {
        byId.set(turnMatch.id, mergeWithLive(fresh, turnMatch))
        pairedAuthoredRow = true
      }

      continue
    }

    // A turn the gateway started itself (an auto-continue, a notification) has a
    // `role:user` row that is no bubble of the owner's: it projects to a notice,
    // a report or a bot message, and still names its turn. That row is what the
    // turn's placeholder was standing in for, so it takes the placeholder's place
    // — or, when it only joins a dispatch and leaves nothing to show, the
    // placeholder goes. Either way the turn's row has arrived and nothing is
    // left pending for it.
    const noticeTurnMatchId = fresh.kind !== 'user' && fresh.turnId ? liveByTurnId.get(fresh.turnId) : undefined
    const noticeTurnMatch =
      noticeTurnMatchId && !pairedLive.has(noticeTurnMatchId) ? byId.get(noticeTurnMatchId) : undefined

    if (noticeTurnMatch?.kind === 'user' && noticeTurnMatch.unknownAuthor) {
      pairedLive.add(noticeTurnMatch.id)
      filled.add(noticeTurnMatch.id)

      const standing =
        fresh.kind === 'notice' && fresh.noticeKind === 'process_complete' && fresh.completions?.length
          ? joinDeliveries(state, byId, fresh)
          : fresh

      if (standing) {
        byId.set(noticeTurnMatch.id, { ...standing, id: noticeTurnMatch.id, version: noticeTurnMatch.version + 1 })
      } else {
        byId.delete(noticeTurnMatch.id)
      }

      continue
    }

    // A call is one card: its key first, then the provider's tool id — and not
    // a tool id whose card names another call.
    const callKey = callKeyOfItem(fresh)
    const callMatchId = callKey ? state.byCallKey[callKey] : undefined
    const callMatch = callMatchId ? byId.get(callMatchId) : undefined

    if (callMatch && callKeyOfItem(callMatch) === callKey && rowsAgree(callMatch, fresh)) {
      byId.set(callMatch.id, mergeWithLive(fresh, callMatch))

      continue
    }

    const toolKey = toolKeyOf(fresh)
    const toolMatchId = toolKey ? state.byToolId[toolKey] : undefined
    const toolMatch = toolMatchId ? byId.get(toolMatchId) : undefined

    if (toolMatch && identitiesAgree(toolMatch, fresh)) {
      byId.set(toolMatch.id, mergeWithLive(fresh, toolMatch))

      continue
    }

    const liveId = isMatchable(fresh)
      ? liveByMatchKey
          .get(matchKeyOf(fresh))
          ?.find(id => !pairedLive.has(id) && authorsAgree(byId.get(id), fresh) && identitiesAgree(byId.get(id), fresh))
      : undefined
    const liveMatch = liveId ? byId.get(liveId) : undefined

    if (liveMatch) {
      pairedLive.add(liveMatch.id)
      byId.set(liveMatch.id, mergeWithLive(fresh, liveMatch))

      if (isAuthoredRow(fresh)) {
        pairedAuthoredRow = true
      }

      continue
    }

    if (fresh.kind === 'notice' && fresh.noticeKind === 'process_complete' && fresh.completions?.length) {
      const leftover = joinDeliveries(state, byId, fresh)

      if (!leftover) {
        continue
      }

      appended.push(leftover)

      continue
    }

    // By position, for a row that names no turn: the next placeholder nobody has
    // filled. A row that names its turn and found no item for it is simply new.
    while (placeholderCursor < placeholders.length && filled.has(placeholders[placeholderCursor] ?? '')) {
      placeholderCursor += 1
    }

    if (!turnId && isAuthoredRow(fresh) && placeholderCursor < placeholders.length) {
      const placeholderId = placeholders[placeholderCursor]

      placeholderCursor += 1

      if (placeholderId && byId.has(placeholderId)) {
        filled.add(placeholderId)
        byId.set(placeholderId, { ...fresh, id: placeholderId, version: (byId.get(placeholderId)?.version ?? 0) + 1 })

        continue
      }
    }

    appended.push(fresh)
  }

  // Splice new rows in front of the live tail (the bubbles of a turn that is
  // still running) instead of behind it.
  const ordered = state.order.map(id => byId.get(id)).filter((item): item is TranscriptItem => Boolean(item))
  let insertAt = ordered.length

  while (insertAt > 0) {
    const candidate = ordered[insertAt - 1]

    if (!candidate || candidate.origin === 'history' || candidate.rowId !== undefined) {
      break
    }

    insertAt -= 1
  }

  let merged = [...ordered.slice(0, insertAt), ...appended, ...ordered.slice(insertAt)]
  let stillPending = placeholders.some(id => !filled.has(id))

  if (pairedAuthoredRow && filled.size === 0) {
    // The tail described this turn without needing a placeholder, which means
    // the turn was ours all along: the row paired with the optimistic bubble
    // above. An empty placeholder nobody will ever fill is an empty bubble the
    // reader has to explain to themselves, so it goes. A tail that simply has
    // not reached the foreign row yet pairs nothing and leaves it standing —
    // and so does a placeholder that names its turn, which only that turn's
    // row may fill.
    const stale = new Set(
      placeholders.filter(id => {
        const item = byId.get(id)

        return item?.kind === 'user' && item.unknownAuthor && !item.text.trim() && !item.turnId
      })
    )

    if (stale.size) {
      merged = merged.filter(item => !stale.has(item.id))
      stillPending = stillPending && stale.size < placeholders.length
    }
  }

  const next = rebuild(state, inRowOrder(merged))

  next.turn = { ...next.turn, foreignReconcilePending: stillPending ? true : undefined }

  return next
}

/** Attach every delivery block on a notice to the dispatch that spawned it. */
function joinDeliveries(
  state: ChatState,
  byId: Map<string, TranscriptItem>,
  notice: NoticeItem
): NoticeItem | undefined {
  const leftovers = (notice.completions ?? []).filter(block => {
    const dispatchId = state.byProcessId[block.sid]
    const dispatch = dispatchId ? byId.get(dispatchId) : undefined

    if (dispatch?.kind !== 'bot_dm_out') {
      return true
    }

    const outcome = replyFromDeliveryOutput(block.output)

    byId.set(dispatch.id, {
      ...dispatch,
      version: dispatch.version + 1,
      reply: {
        text: outcome.text ?? '',
        ...(notice.ts !== undefined ? { ts: notice.ts } : {}),
        ...(notice.rowId !== undefined ? { rowId: notice.rowId } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {})
      },
      dispatch: outcome.error ? { ...dispatch.dispatch, status: 'failed', error: outcome.error } : dispatch.dispatch
    })

    return false
  })

  if (!leftovers.length) {
    return undefined
  }

  return { ...notice, completions: leftovers }
}
