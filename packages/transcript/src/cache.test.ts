import { describe, expect, it } from 'vitest'

import { CACHE_ITEM_LIMIT, snapshotForCache, stateFromCache } from './cache'
import { reconcile } from './reconcile'
import { applyEvent, applyServerRequest, beginLocalTurn } from './reducer'
import { rowsToItems } from './rows-to-items'
import { visibleItems } from './selectors'
import { approvalRequest, delegationEvents, dmDispatchTurn } from './__fixtures__/events'
import { authoredRow, rpcHistoryRows } from './__fixtures__/rows'
import { type BotDmOutItem, type ChatState, createChatState, type TranscriptItem, type UserItem } from './types'

const NOW = 1_700_000_000_000
const IDS = { storedSessionId: 'stored-1', resolvedSessionId: 'resolved-1' }

const fresh = () => createChatState('researcher', IDS.storedSessionId, IDS.resolvedSessionId)
const hydrated = () => reconcile(fresh(), rowsToItems(rpcHistoryRows, 'rpc'))
const roundTrip = (state: ChatState) => stateFromCache('researcher', IDS, snapshotForCache(state, NOW))

describe('cache round trip', () => {
  it('restores the same items in the same order with the same ids', () => {
    const before = hydrated()
    const after = roundTrip(before)

    expect(after.order).toEqual(before.order)
    expect(after.botName).toBe('researcher')
    expect(after.storedSessionId).toBe('stored-1')
  })

  it('restores every index the reducer needs to keep working', () => {
    const before = reconcile(
      { ...applyEvent(fresh(), { type: 'message.start', seq: 1 }, NOW), turn: { ...fresh().turn } },
      rowsToItems(rpcHistoryRows, 'rpc')
    )
    const after = roundTrip(before)

    expect(after.byRowId).toEqual(before.byRowId)
    expect(after.byToolId).toEqual(before.byToolId)
  })

  it('rebuilds the call index from the items, never from stored indices', () => {
    const before = reconcile(
      fresh(),
      rowsToItems(
        [
          { role: 'user', text: 'go', row_id: 1, display_metadata: { turn_id: 'turn-1' } },
          { role: 'assistant', text: 'on it', row_id: 2 },
          { role: 'tool', name: 'read_file', tool_id: 'call_0', row_id: 3, call_row_id: 2, call_index: 0 }
        ],
        'rpc'
      )
    )
    const snapshot = snapshotForCache(before, NOW)
    const after = stateFromCache('researcher', IDS, snapshot)

    expect(before.byCallKey).toEqual({ '2/0': 't:call_0' })
    expect(after.byCallKey).toEqual(before.byCallKey)
    expect(JSON.stringify(snapshot)).not.toContain('byCallKey')
    expect((after.items['r:1'] as UserItem).turnId).toBe('turn-1')
  })

  it('restores the delivery process index so a late reply still lands', () => {
    const live = dmDispatchTurn.reduce((state, event) => applyEvent(state, event, NOW), fresh())
    const after = roundTrip(live)
    const dispatch = after.order.map(id => after.items[id]).find(item => item?.kind === 'bot_dm_out') as BotDmOutItem

    expect(after.byProcessId['proc-2f9c']).toBe(dispatch.id)
  })

  it('restores subagents and the delegation index', () => {
    const live = delegationEvents.reduce((state, event) => applyEvent(state, event, NOW), fresh())
    const after = roundTrip(live)

    expect(Object.keys(after.subagents)).toEqual(['child-0', 'child-1', 'child-2'])
    expect(after.byDelegationId['del-9']).toBeDefined()
  })

  it('paints identically from cache and from the live state', () => {
    const before = hydrated()
    const view = (state: ChatState) =>
      visibleItems(state, { level: 'normal', showBotToBot: true, showThinking: true }).map(entry => entry.item.id)

    expect(view(roundTrip(before))).toEqual(view(before))
  })

  it('reports itself as cached, not live', () => {
    expect(roundTrip(hydrated()).hydration).toBe('cached')
  })

  it('remembers how far the transcript was read', () => {
    const snapshot = snapshotForCache(hydrated(), NOW)

    expect(snapshot.lastRowId).toBe(16)
    expect(stateFromCache('researcher', IDS, snapshot).lastSeenRowId).toBe(16)
  })

  it('carries the event watermark together with the session it was counted under', () => {
    const before = { ...hydrated(), lastSeq: 42, lastSeqSessionId: 'runtime-1', epoch: 'e1' }
    const snapshot = snapshotForCache(before, NOW)

    expect(snapshot).toMatchObject({ lastSeq: 42, lastSeqSessionId: 'runtime-1', epoch: 'e1' })

    const after = stateFromCache('researcher', IDS, snapshot)

    expect(after).toMatchObject({ lastSeq: 42, lastSeqSessionId: 'runtime-1', epoch: 'e1' })
  })

  it('reads a watermark with no session id as cold rather than trusting it', () => {
    // The gateway restarts event numbering at 1 for every runtime session it
    // builds. A bare number from an unknown session would make the reducer
    // discard the whole of the next one as replay.
    const snapshot = { ...snapshotForCache(hydrated(), NOW), lastSeq: 42, epoch: 'e1' }
    const after = stateFromCache('researcher', IDS, snapshot)

    expect(after.lastSeq).toBe(0)
    expect(after.lastSeqSessionId).toBeUndefined()
    expect(after.epoch).toBeUndefined()
    // Everything else still paints; only the watermark is refused.
    expect(after.order).toHaveLength(snapshot.items.length)
  })
})

describe('author survives the cache (HERM-83)', () => {
  it('round-trips an author through actual JSON, not just object identity', () => {
    const withAuthor = reconcile(fresh(), rowsToItems([authoredRow], 'rpc'))
    const snapshot = snapshotForCache(withAuthor, NOW)
    // `snapshotForCache` is what actually gets written to disk, so prove the
    // round trip through the wire format it will really take, not the object
    // this process happens to still be holding a reference to.
    const throughJson = JSON.parse(JSON.stringify(snapshot))
    const after = stateFromCache('researcher', IDS, throughJson)
    const user = after.order.map(id => after.items[id]).find((item): item is UserItem => item?.kind === 'user')

    expect(user?.author).toEqual({ id: 'oidc:user-a', name: 'Robin' })
  })

  it('loads a cached item from an older build with no author as unattributed', () => {
    // An older build's cache never wrote `author` at all — not `author:
    // undefined`, the key is simply absent, the way a build before this field
    // existed would have written it. Rehydrating that item must not invent one.
    const withAuthor = reconcile(fresh(), rowsToItems([authoredRow], 'rpc'))
    const snapshot = snapshotForCache(withAuthor, NOW)
    const legacyItem = snapshot.items[0] as UserItem & Record<string, unknown>

    expect(legacyItem.author).toBeDefined()

    const { author: _author, ...withoutAuthor } = legacyItem
    const legacySnapshot = { ...snapshot, items: [withoutAuthor as TranscriptItem] }

    const after = stateFromCache('researcher', IDS, legacySnapshot)
    const user = after.order.map(id => after.items[id]).find((item): item is UserItem => item?.kind === 'user')

    expect(user).toBeDefined()
    expect(user?.author).toBeUndefined()
  })
})

describe('what the cache refuses to keep', () => {
  it('drops an optimistic message the gateway never acknowledged', () => {
    const state = beginLocalTurn(hydrated(), 'never sent', undefined, NOW)

    expect(snapshotForCache(state, NOW).items.some(item => item.origin === 'optimistic')).toBe(false)
  })

  it('drops a foreign placeholder', () => {
    const state = applyEvent(hydrated(), { type: 'message.start', seq: 1 }, NOW)

    expect(snapshotForCache(state, NOW).items.some(item => item.origin === 'foreign')).toBe(false)
  })

  it('drops an unanswered request, which only the gateway may re-open', () => {
    const state = applyServerRequest(hydrated(), approvalRequest, NOW)

    expect(snapshotForCache(state, NOW).items.some(item => item.kind === 'approval')).toBe(false)
  })

  it('seals a bubble that was mid-stream when the app went away', () => {
    const state = applyEvent(
      applyEvent(hydrated(), { type: 'message.start', seq: 1 }, NOW),
      { type: 'message.delta', seq: 2, payload: { text: 'half' } },
      NOW
    )
    const assistant = snapshotForCache(state, NOW)
      .items.filter(item => item.kind === 'assistant')
      .at(-1)

    expect(assistant).toMatchObject({ streaming: false })
  })

  it('keeps only the last window of items', () => {
    const many: TranscriptItem[] = Array.from({ length: CACHE_ITEM_LIMIT + 20 }, (_value, index) => ({
      id: `r:${index}`,
      kind: 'user',
      seq: index * 1000,
      version: 0,
      origin: 'history',
      rowId: index,
      text: `message ${index}`
    }))
    const snapshot = snapshotForCache(reconcile(fresh(), many), NOW)

    expect(snapshot.items).toHaveLength(CACHE_ITEM_LIMIT)
    expect(snapshot.items[0]?.id).toBe('r:20')
  })

  it('returns an empty chat for a snapshot written by another format', () => {
    const snapshot = { ...snapshotForCache(hydrated(), NOW), format: 99 }

    expect(stateFromCache('researcher', IDS, snapshot).order).toEqual([])
  })
})
