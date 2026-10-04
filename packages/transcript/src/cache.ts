/**
 * Offline cache shape.
 *
 * Only settled transcript goes in: an optimistic submit, a foreign placeholder
 * and an unanswered request all describe a moment, not the chat, and restoring
 * them from disk would resurrect a question the gateway already forgot.
 */
import {
  type ChatState,
  createChatState,
  isRequestLikeItem,
  SEQ_STEP,
  type Subagent,
  type TranscriptItem
} from './types'

export const CACHE_ITEM_LIMIT = 200
export const CACHE_FORMAT = 1

export interface CachedTranscript {
  format: number
  items: TranscriptItem[]
  subagents: Subagent[]
  lastRowId?: number
  lastSeq: number
  /**
   * The runtime session id `lastSeq` was counted under.
   *
   * Without it a cached watermark is a number with no frame of reference: the
   * gateway restarts event numbering at 1 for every runtime session it builds,
   * so replaying "everything after 41" against a session that has only reached
   * 12 silently drops the entire chat.
   */
  lastSeqSessionId?: string
  epoch?: string
  /**
   * The turn that was streaming when the snapshot was taken, written only for a
   * turn the gateway named (`turn.id`). See `CachedTurn`.
   */
  turn?: CachedTurn
  updatedAt: number
}

/**
 * Where a turn cut off by the snapshot was writing.
 *
 * A chat saved mid-stream holds a half-written bubble, and the frames that
 * finish it are replayed when the chat opens again. Without these pointers the
 * replay could not know that bubble was the one it was filling: it started a
 * second one, and the half-written first stayed on screen beside the row the
 * turn became (the owner's reopen, cut between two deltas, or right after a
 * thought with no words yet). With them the replay carries on where the stream
 * stopped, and the frame naming the row settles that bubble onto it.
 *
 * Only the pointers the reducer appends through. Nothing that would make a
 * reopened chat claim a turn is running (`active`), or time one (`startedAt`).
 */
export interface CachedTurn {
  /** The gateway's id for the turn. */
  id: string
  /** The bubble receiving deltas. */
  assistantId?: string
  /** The item holding the turn's thought. */
  reasoningId?: string
}

export interface SessionIds {
  storedSessionId: string
  resolvedSessionId: string
}

const isCacheable = (item: TranscriptItem): boolean => {
  if (item.origin === 'optimistic' || item.origin === 'foreign') {
    return false
  }

  return !(isRequestLikeItem(item) && item.state === 'open')
}

export function snapshotForCache(state: ChatState, now: number = Date.now()): CachedTranscript {
  const items = state.order
    .map(id => state.items[id])
    .filter((item): item is TranscriptItem => Boolean(item) && isCacheable(item!))
    .slice(-CACHE_ITEM_LIMIT)
    // A bubble that was mid-stream when the app went away is finished as far as
    // the cache is concerned; nothing will ever append to it again.
    .map(item => (item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item))

  const lastRowId = items.reduce<number | undefined>(
    (last, item) => (item.rowId !== undefined ? item.rowId : last),
    undefined
  )

  const turn = cachedTurnOf(state, items)

  return {
    format: CACHE_FORMAT,
    items,
    subagents: Object.values(state.subagents),
    ...(lastRowId !== undefined ? { lastRowId } : {}),
    lastSeq: state.lastSeq,
    ...(state.lastSeqSessionId ? { lastSeqSessionId: state.lastSeqSessionId } : {}),
    ...(state.epoch ? { epoch: state.epoch } : {}),
    ...(turn ? { turn } : {}),
    updatedAt: now
  }
}

/** The running turn's pointers, when the gateway named the turn and they point into what is cached. */
function cachedTurnOf(state: ChatState, items: readonly TranscriptItem[]): CachedTurn | undefined {
  const id = state.turn.id

  if (!id) {
    return undefined
  }

  const cached = new Set(items.map(item => item.id))
  const assistantId = state.turn.assistantId && cached.has(state.turn.assistantId) ? state.turn.assistantId : undefined
  const reasoningId = state.turn.reasoningId && cached.has(state.turn.reasoningId) ? state.turn.reasoningId : undefined

  return { id, ...(assistantId ? { assistantId } : {}), ...(reasoningId ? { reasoningId } : {}) }
}

/**
 * Put a cached turn's pointers back, each only while it still names what it
 * named: a bubble that is there, an assistant one, and still open — a pointer
 * at anything else would send the next delta somewhere it does not belong.
 */
function restoreTurn(state: ChatState, turn: CachedTurn | undefined): void {
  if (!turn || typeof turn.id !== 'string' || !turn.id) {
    return
  }

  state.turn.id = turn.id

  const live = turn.assistantId ? state.items[turn.assistantId] : undefined

  if (live?.kind === 'assistant' && !live.interim && live.rowId === undefined) {
    state.turn.assistantId = live.id
  }

  const held = turn.reasoningId ? state.items[turn.reasoningId] : undefined

  if (held?.kind === 'assistant') {
    state.turn.reasoningId = held.id
  }
}

/** Rebuild a paintable state from disk. Indices are derived, never stored. */
export function stateFromCache(botName: string, ids: SessionIds, snapshot: CachedTranscript): ChatState {
  const state = createChatState(botName, ids.storedSessionId, ids.resolvedSessionId)

  if (snapshot.format !== CACHE_FORMAT) {
    return state
  }

  snapshot.items.forEach((item, index) => {
    const placed = { ...item, seq: index * SEQ_STEP }

    state.items[placed.id] = placed
    state.order.push(placed.id)

    if (placed.rowId !== undefined) {
      state.byRowId[String(placed.rowId)] = placed.id
    }

    if (placed.kind === 'tool' || placed.kind === 'bot_dm_out') {
      state.byToolId[placed.toolId] = placed.id
    }

    if (
      (placed.kind === 'tool' || placed.kind === 'bot_dm_out' || placed.kind === 'subagent_group') &&
      placed.callKey
    ) {
      state.byCallKey[placed.callKey] = placed.id
    }

    if (placed.kind === 'bot_dm_out' && placed.dispatch.processId) {
      state.byProcessId[placed.dispatch.processId] = placed.id
    }

    if (placed.kind === 'subagent_group') {
      if (placed.toolId) {
        state.byToolId[placed.toolId] = placed.id
      }

      if (placed.delegationId) {
        state.byDelegationId[placed.delegationId] = placed.id
      }
    }

    if (isRequestLikeItem(placed)) {
      state.byRequestId[placed.requestId] = placed.id
    }
  })

  for (const child of snapshot.subagents) {
    state.subagents[child.id] = child
  }

  state.turn.nextSeq = snapshot.items.length * SEQ_STEP
  state.hydration = 'cached'

  if (snapshot.lastSeqSessionId) {
    state.lastSeq = snapshot.lastSeq
    state.lastSeqSessionId = snapshot.lastSeqSessionId

    if (snapshot.epoch) {
      state.epoch = snapshot.epoch
    }

    // Only beside a watermark: the turn is continued by the frames replayed
    // after it, and a snapshot read as cold replays nothing.
    restoreTurn(state, snapshot.turn)
  }
  // A snapshot from before the watermark carried its session id cannot say which
  // session it counted, so it is read as cold: one extra replay-free hydration
  // beats a silently truncated chat.

  if (snapshot.lastRowId !== undefined) {
    state.lastSeenRowId = snapshot.lastRowId
  }

  return state
}
