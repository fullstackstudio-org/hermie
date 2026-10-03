/**
 * Frames and rows paired by the identity the gateway sends, never by words.
 *
 * Reported from TestFlight on 2026-10-03 (native 0.2.2, iPad): a long turn with
 * interim assistant messages on, the chat reopened from the cache it saved
 * mid-turn, and every note on screen twice — normal, then a grey copy — and
 * every tool card twice. Reopening reads history first and then replays the
 * turn's frames after the cached watermark, so every frame describes a row that
 * history has just brought, and nothing in the frame said which.
 *
 * A gateway that knows now says (`identity.ts`): a note's `message.interim` and
 * the turn's `message.complete` name the row they were persisted as, a tool
 * frame names its call (`call_row_id` + `call_index`) and its result row, and
 * every frame of a turn carries the turn's id on its envelope, which the
 * prompt's row carries too. Each case here drives one route a row can be
 * described twice by, with that identity on the wire. The same inputs without
 * it are what every other suite in this package pins, unchanged.
 */
import { describe, expect, it } from 'vitest'

import { snapshotForCache, stateFromCache } from './cache'
import * as unrecorded from './index'
import { prependHistory, reconcile, reconcileTail } from './reconcile'
import { applyEvent, applyResumeSnapshot, beginLocalTurn, confirmSubmit, type TranscriptEvent } from './reducer'
import { rowsToItems, type TranscriptRow } from './rows-to-items'
import {
  type AssistantItem,
  type ChatState,
  createChatState,
  type ToolItem,
  type TranscriptItem,
  type UserItem
} from './types'

const NOW = 1_790_000_000_000
/** When the chat is opened again. */
const LATER = NOW + 120_000

const EARLIER_PROMPT = 'kijk even naar de grootboekrekeningen'
const EARLIER_REPLY = 'Alles staat goed.'
const PROMPT = 'doe wat je moet doen'
const THOUGHT = 'Check the ledger first.'
const FIRST = 'Entry 90 staat op Betaald. Nu de € 0,01 op Nog te betalen kosten: eerst kijken hoe die erop staat.'
const SECOND = 'Ik zoek de mutatie zelf op via de API: de Mollie-uitbetaling van 16-09.'
const FINAL = 'Ik heb alles nagelopen en niets ingediend.'
const USAGE = { input: 12, output: 34, total: 46 }

const TURN = 'turn-t'

const fresh = () => createChatState('boekhouder', 'stored-1', 'resolved-1')
const list = (state: ChatState) => state.order.map(id => state.items[id]!)
const assistants = (state: ChatState) => list(state).filter((item): item is AssistantItem => item.kind === 'assistant')
const users = (state: ChatState) => list(state).filter((item): item is UserItem => item.kind === 'user')
const cards = (state: ChatState) => list(state).filter((item): item is ToolItem => item.kind === 'tool')
const shape = (state: ChatState) =>
  list(state).map((item: TranscriptItem) =>
    item.kind === 'tool' ? `tool:${item.callKey ?? item.toolId}@${item.rowId}` : `${item.kind}@${item.rowId}`
  )

const apply = (state: ChatState, events: readonly TranscriptEvent[], now = NOW) =>
  events.reduce((next, event) => applyEvent(next, event, now), state)

/** Every frame of the turn carries its id on the envelope, as the gateway stamps it. */
const framesOf = (turnId: string, events: readonly TranscriptEvent[]): TranscriptEvent[] =>
  events.map(event => ({ ...event, turn_id: turnId }))

/** The earlier exchange already on screen, as history brought it. */
const EARLIER_ROWS: TranscriptRow[] = [
  { role: 'user', row_id: 1, text: EARLIER_PROMPT, display_metadata: { turn_id: 'turn-e' }, timestamp: 1_789_999_000 },
  { role: 'assistant', row_id: 2, text: EARLIER_REPLY, timestamp: 1_789_999_001 }
]

/** The new turn's rows, in the fork's RPC shape: tool rows name their call and their own row. */
const TURN_ROWS: TranscriptRow[] = [
  { role: 'user', row_id: 11, text: PROMPT, display_metadata: { turn_id: TURN }, timestamp: 1_790_000_000 },
  { role: 'assistant', row_id: 12, text: FIRST, reasoning: THOUGHT, timestamp: 1_790_000_001 },
  {
    role: 'tool',
    row_id: 13,
    name: 'terminal',
    context: 'curl …',
    tool_call_id: 'call_a',
    call_row_id: 12,
    call_index: 0,
    timestamp: 1_790_000_002
  },
  { role: 'assistant', row_id: 14, text: SECOND, timestamp: 1_790_000_003 },
  {
    role: 'tool',
    row_id: 15,
    name: 'terminal',
    context: 'curl …',
    tool_call_id: 'call_b',
    call_row_id: 14,
    call_index: 0,
    timestamp: 1_790_000_004
  },
  { role: 'assistant', row_id: 16, text: FINAL, timestamp: 1_790_000_005 }
]

const toolFrames = (seq: number, toolId: string, callRowId: number, callIndex: number, rowId: number) => [
  {
    type: 'tool.start',
    seq,
    payload: { tool_id: toolId, name: 'terminal', context: 'curl …', call_row_id: callRowId, call_index: callIndex }
  },
  {
    type: 'tool.complete',
    seq: seq + 1,
    payload: {
      tool_id: toolId,
      name: 'terminal',
      result: 'ok',
      call_row_id: callRowId,
      call_index: callIndex,
      row_id: rowId
    }
  }
]

/** The turn as the gateway sends it, interim notes on. */
const FRAMES: TranscriptEvent[] = framesOf(TURN, [
  { type: 'message.start', seq: 1 },
  { type: 'reasoning.delta', seq: 2, payload: { text: THOUGHT } },
  { type: 'message.delta', seq: 3, payload: { text: FIRST } },
  { type: 'message.interim', seq: 4, payload: { text: FIRST, already_streamed: true, row_id: 12 } },
  ...toolFrames(5, 'call_a', 12, 0, 13),
  { type: 'message.delta', seq: 7, payload: { text: SECOND } },
  { type: 'message.interim', seq: 8, payload: { text: SECOND, already_streamed: true, row_id: 14 } },
  ...toolFrames(9, 'call_b', 14, 0, 15),
  { type: 'message.delta', seq: 11, payload: { text: FINAL } },
  { type: 'message.complete', seq: 12, payload: { text: FINAL, status: 'complete', usage: USAGE, row_id: 16 } }
])

/** The same turn from a gateway with interim notes off: nothing seals a note but its tool call. */
const FRAMES_NO_INTERIMS = FRAMES.filter(event => event.type !== 'message.interim')

/** The earlier exchange on screen, then the owner's prompt painted and taken straight away. */
function sentTurn(): ChatState {
  const hydrated = reconcile(fresh(), rowsToItems(EARLIER_ROWS, 'rpc'))

  return confirmSubmit(beginLocalTurn(hydrated, PROMPT, undefined, NOW), { status: 'streaming' }, NOW)
}

/** What a chat opened again paints first: the transcript it cached, with its watermark. */
const fromCache = (state: ChatState) =>
  stateFromCache(
    'boekhouder',
    { storedSessionId: 'stored-1', resolvedSessionId: 'resolved-1' },
    snapshotForCache({ ...state, lastSeqSessionId: 'runtime-1' }, NOW)
  )

/**
 * The owner's route: away after `cut` frames, back when the turn has finished.
 * History (every row, the earlier exchange and the whole turn) is read first,
 * then every frame after the cached watermark is replayed.
 */
function reopened(frames: readonly TranscriptEvent[], cut: number): ChatState {
  const away = apply(sentTurn(), frames.slice(0, cut))
  const hydrated = reconcile(fromCache(away), rowsToItems([...EARLIER_ROWS, ...TURN_ROWS], 'rpc'))

  return apply(hydrated, frames.slice(cut), LATER)
}

/** One item per row, one card per call, nothing left standing for a row it is not. */
function expectSettled(state: ChatState): void {
  const rowIds = list(state).map(item => item.rowId)

  expect(rowIds.every(rowId => rowId !== undefined)).toBe(true)
  expect(new Set(rowIds).size).toBe(rowIds.length)
  expect(shape(state)).toEqual([
    'user@1',
    'assistant@2',
    'user@11',
    'assistant@12',
    'tool:12/0@13',
    'assistant@14',
    'tool:14/0@15',
    'assistant@16'
  ])
  expect(assistants(state).map(item => item.text)).toEqual([EARLIER_REPLY, FIRST, SECOND, FINAL])
  expect(assistants(state).some(item => item.interim || item.streaming)).toBe(false)
  expect(cards(state).map(card => [card.status, card.resultKnown])).toEqual([
    ['complete', true],
    ['complete', true]
  ])
  expect(users(state).some(item => item.unknownAuthor)).toBe(false)
  expect(state.turn.active).toBe(false)
}

describe('a chat reopened from the cache it saved mid-turn', () => {
  const CUTS: [string, number][] = [
    ['the first delta', 3],
    ['the first interim', 4],
    ['the first tool.start', 5],
    ['the first tool.complete', 6]
  ]

  it.each(CUTS)('shows every row once when the cache was cut after %s', (_label, cut) => {
    expectSettled(reopened(FRAMES, cut))
  })

  it.each([
    ['the first delta', 3],
    ['the first tool.start', 4],
    ['the first tool.complete', 5]
  ] as [string, number][])('does the same with interim notes off, cut after %s', (_label, cut) => {
    expectSettled(reopened(FRAMES_NO_INTERIMS, cut))
  })

  it('keeps what only the stream knew, and never a replayed duration', () => {
    const state = reopened(FRAMES, 4)
    const final = assistants(state).at(-1)

    expect(final).toMatchObject({ rowId: 16, text: FINAL, status: 'complete', usage: USAGE })
    expect(final?.durationS).toBeUndefined()
    expect(assistants(state).find(item => item.rowId === 12)?.reasoning).toBe(THOUGHT)
    expect(state.turn.assistantId).toBeUndefined()
  })

  it('carries the thought a replay rebuilt onto the row that had none', () => {
    const rows = TURN_ROWS.map(row => (row.row_id === 12 ? { ...row, reasoning: undefined } : row))
    const away = apply(sentTurn(), FRAMES.slice(0, 1))
    const hydrated = reconcile(fromCache(away), rowsToItems([...EARLIER_ROWS, ...rows], 'rpc'))
    const state = apply(hydrated, FRAMES.slice(1), LATER)

    expect(assistants(state).find(item => item.rowId === 12)).toMatchObject({ text: FIRST, reasoning: THOUGHT })
    expect(assistants(state)).toHaveLength(4)
  })

  it('stands no placeholder up for a message.start replayed over the prompt it started', () => {
    const away = apply(sentTurn(), [])
    const hydrated = reconcile(fromCache(away), rowsToItems([...EARLIER_ROWS, TURN_ROWS[0]!], 'rpc'))
    const started = applyEvent(hydrated, FRAMES[0]!, LATER)

    expect(users(started).map(item => [item.text, item.turnId, item.unknownAuthor])).toEqual([
      [EARLIER_PROMPT, 'turn-e', undefined],
      [PROMPT, TURN, undefined]
    ])
    expect(started.turn.foreignReconcilePending).toBeUndefined()
    expect(started.turn.local).toBe(false)
    expect(started.turn.id).toBe(TURN)
    expect(started.turn.active).toBe(true)
  })

  it('settles the whole turn replayed from its first frame over the history that holds it', () => {
    expectSettled(reopened(FRAMES, 0))
  })
})

describe('a turn streamed live with identity', () => {
  it('stamps every note and card with the row it became', () => {
    const state = apply(sentTurn(), FRAMES)

    expect(shape(state)).toEqual([
      'user@1',
      'assistant@2',
      'user@undefined',
      'assistant@12',
      'tool:12/0@13',
      'assistant@14',
      'tool:14/0@15',
      'assistant@16'
    ])
    expect(state.byRowId['12']).toBe(assistants(state)[1]!.id)
    expect(state.byCallKey['14/0']).toBe(cards(state)[1]!.id)
    expect(state.turn.id).toBeUndefined()
  })

  it('stamps the note a tool call seals when no interim names it', () => {
    const state = apply(sentTurn(), FRAMES_NO_INTERIMS)

    expect(assistants(state).map(item => [item.rowId, item.interim])).toEqual([
      [2, false],
      [12, true],
      [14, true],
      [16, false]
    ])
  })

  it('holds the turn id while the turn runs', () => {
    expect(apply(sentTurn(), FRAMES.slice(0, 3)).turn.id).toBe(TURN)
  })
})

describe('call identity', () => {
  /** Two turns from a provider that numbers every turn's calls from `call_0`. */
  const firstTurn = framesOf('turn-1', [
    { type: 'message.start', seq: 1 },
    { type: 'message.delta', seq: 2, payload: { text: 'Looking.' } },
    {
      type: 'tool.start',
      seq: 3,
      payload: { tool_id: 'call_0', name: 'terminal', context: 'ls', call_row_id: 2, call_index: 0 }
    },
    {
      type: 'tool.complete',
      seq: 4,
      payload: { tool_id: 'call_0', name: 'terminal', result: 'one', call_row_id: 2, call_index: 0, row_id: 3 }
    },
    { type: 'message.complete', seq: 5, payload: { text: 'Done once.', status: 'complete', row_id: 4 } }
  ])
  const secondTurn = framesOf('turn-2', [
    { type: 'message.start', seq: 6 },
    { type: 'message.delta', seq: 7, payload: { text: 'Again.' } },
    {
      type: 'tool.start',
      seq: 8,
      payload: { tool_id: 'call_0', name: 'terminal', context: 'pwd', call_row_id: 6, call_index: 0 }
    },
    {
      type: 'tool.output_risk',
      seq: 9,
      payload: { tool_id: 'call_0', risk: 'high', findings: ['token'], call_row_id: 6, call_index: 0 }
    },
    {
      type: 'tool.complete',
      seq: 10,
      payload: { tool_id: 'call_0', name: 'terminal', result: 'two', call_row_id: 6, call_index: 0, row_id: 7 }
    },
    { type: 'message.complete', seq: 11, payload: { text: 'Done twice.', status: 'complete', row_id: 8 } }
  ])
  const callRows: TranscriptRow[] = [
    { role: 'user', row_id: 1, text: 'once', display_metadata: { turn_id: 'turn-1' } },
    { role: 'assistant', row_id: 2, text: 'Looking.' },
    { role: 'tool', row_id: 3, name: 'terminal', context: 'ls', tool_call_id: 'call_0', call_row_id: 2, call_index: 0 },
    { role: 'assistant', row_id: 4, text: 'Done once.' },
    { role: 'user', row_id: 5, text: 'twice', display_metadata: { turn_id: 'turn-2' } },
    { role: 'assistant', row_id: 6, text: 'Again.' },
    {
      role: 'tool',
      row_id: 7,
      name: 'terminal',
      context: 'pwd',
      tool_call_id: 'call_0',
      call_row_id: 6,
      call_index: 0
    },
    { role: 'assistant', row_id: 8, text: 'Done twice.' }
  ]

  it('keeps two turns that reuse call_0 on their own cards', () => {
    const state = apply(fresh(), [...firstTurn, ...secondTurn])

    expect(cards(state).map(card => [card.callKey, card.result, card.rowId, card.outputRisk?.risk])).toEqual([
      ['2/0', 'one', 3, undefined],
      ['6/0', 'two', 7, 'high']
    ])
  })

  it('reuses the card history holds when the second turn is replayed over it', () => {
    const hydrated = reconcile(fresh(), rowsToItems(callRows, 'rpc'))
    const state = apply(hydrated, secondTurn, LATER)

    expect(cards(state).map(card => [card.callKey, card.result, card.rowId, card.outputRisk?.risk])).toEqual([
      ['2/0', undefined, 3, undefined],
      ['6/0', 'two', 7, 'high']
    ])
    expect(assistants(state).map(item => item.rowId)).toEqual([2, 4, 6, 8])
  })

  it('never hands a result to an earlier turn whose card shares the tool id', () => {
    // The second turn's tool.start was missed (a replay gap): its result must
    // not land on the first turn's `call_0`.
    const state = apply(fresh(), [...firstTurn, ...secondTurn.filter(event => event.type !== 'tool.start')])

    expect(cards(state).map(card => [card.callKey, card.result])).toEqual([
      ['2/0', 'one'],
      ['6/0', 'two']
    ])
  })

  it('keeps two calls sharing one tool id in one message apart', () => {
    const frames = framesOf('turn-x', [
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'Both at once.' } },
      { type: 'tool.start', seq: 3, payload: { tool_id: 'call', name: 'read', call_row_id: 2, call_index: 0 } },
      { type: 'tool.start', seq: 4, payload: { tool_id: 'call', name: 'read', call_row_id: 2, call_index: 1 } },
      {
        type: 'tool.complete',
        seq: 5,
        payload: { tool_id: 'call', name: 'read', result: 'b', call_row_id: 2, call_index: 1, row_id: 4 }
      },
      {
        type: 'tool.complete',
        seq: 6,
        payload: { tool_id: 'call', name: 'read', result: 'a', call_row_id: 2, call_index: 0, row_id: 3 }
      }
    ])
    const live = apply(fresh(), frames)

    expect(cards(live).map(card => [card.callKey, card.result, card.rowId])).toEqual([
      ['2/0', 'a', 3],
      ['2/1', 'b', 4]
    ])

    const history = reconcile(
      fresh(),
      rowsToItems(
        [
          { role: 'assistant', row_id: 2, text: 'Both at once.' },
          { role: 'tool', row_id: 3, name: 'read', tool_call_id: 'call', call_row_id: 2, call_index: 0 },
          { role: 'tool', row_id: 4, name: 'read', tool_call_id: 'call', call_row_id: 2, call_index: 1 }
        ],
        'rpc'
      )
    )
    const replayed = apply(history, frames, LATER)

    expect(cards(replayed).map(card => [card.callKey, card.result, card.rowId])).toEqual([
      ['2/0', 'a', 3],
      ['2/1', 'b', 4]
    ])
    expect(assistants(replayed).map(item => item.rowId)).toEqual([2])
  })

  it('materialises a card again when its call key points at nothing', () => {
    const live = apply(fresh(), firstTurn.slice(0, 3))
    const drifted = { ...live, byCallKey: { '2/0': 't:gone' }, byToolId: {} }
    const state = applyEvent(drifted, firstTurn[3]!, NOW)

    expect(cards(state).map(card => [card.callKey, card.result])).toEqual([
      ['2/0', undefined],
      ['2/0', 'one']
    ])
    expect(state.byCallKey['2/0']).toBe(cards(state)[1]!.id)
  })
})

describe('a reasoning-only round between two notes', () => {
  const frames = framesOf(TURN, [
    { type: 'message.start', seq: 1 },
    { type: 'message.delta', seq: 2, payload: { text: FIRST } },
    { type: 'message.interim', seq: 3, payload: { text: FIRST, already_streamed: true, row_id: 12 } },
    ...toolFrames(4, 'call_a', 12, 0, 13),
    // The model thinks, says nothing, and calls again.
    { type: 'reasoning.delta', seq: 6, payload: { text: 'One more lookup.' } },
    { type: 'message.interim', seq: 7, payload: { text: '', already_streamed: true, row_id: 14 } },
    ...toolFrames(8, 'call_b', 14, 0, 15),
    { type: 'message.delta', seq: 10, payload: { text: SECOND } },
    { type: 'message.interim', seq: 11, payload: { text: SECOND, already_streamed: true, row_id: 16 } },
    ...toolFrames(12, 'call_c', 16, 0, 17),
    { type: 'message.delta', seq: 14, payload: { text: FINAL } },
    { type: 'message.complete', seq: 15, payload: { text: FINAL, status: 'complete', row_id: 18 } }
  ])
  const rows: TranscriptRow[] = [
    { role: 'user', row_id: 11, text: PROMPT, display_metadata: { turn_id: TURN } },
    { role: 'assistant', row_id: 12, text: FIRST },
    { role: 'tool', row_id: 13, name: 'terminal', tool_call_id: 'call_a', call_row_id: 12, call_index: 0 },
    { role: 'assistant', row_id: 14, text: '', reasoning: 'One more lookup.' },
    { role: 'tool', row_id: 15, name: 'terminal', tool_call_id: 'call_b', call_row_id: 14, call_index: 0 },
    { role: 'assistant', row_id: 16, text: SECOND },
    { role: 'tool', row_id: 17, name: 'terminal', tool_call_id: 'call_c', call_row_id: 16, call_index: 0 },
    { role: 'assistant', row_id: 18, text: FINAL }
  ]
  const expected = [
    'user@11',
    'assistant@12',
    'tool:12/0@13',
    'assistant@14',
    'tool:14/0@15',
    'assistant@16',
    'tool:16/0@17',
    'assistant@18'
  ]

  it('gives the thought its own row live, and every later note its own', () => {
    const live = apply(fresh(), frames)

    // Nobody local sent it, so the prompt is a placeholder until the tail names it.
    expect(shape(live)).toEqual(['user@undefined', ...expected.slice(1)])
    expect(users(live)[0]).toMatchObject({ unknownAuthor: true, turnId: TURN })
    expect(assistants(live).map(item => item.text)).toEqual([FIRST, '', SECOND, FINAL])
  })

  it.each([0, 3, 5, 6, 7, 10])('settles every note after it on a replay cut after frame %i', cut => {
    const away = apply(fresh(), frames.slice(0, cut))
    const hydrated = reconcile(fromCache(away), rowsToItems(rows, 'rpc'))
    const state = apply(hydrated, frames.slice(cut), LATER)

    expect(shape(state)).toEqual(expected)
    expect(assistants(state).map(item => item.text)).toEqual([FIRST, '', SECOND, FINAL])
  })
})

describe('turn identity on message.start', () => {
  it('stands the placeholder for a foreign turn up with that turn id', () => {
    const hydrated = reconcile(fresh(), rowsToItems(EARLIER_ROWS, 'rpc'))
    const started = applyEvent(hydrated, { type: 'message.start', seq: 1, turn_id: 'turn-f' }, NOW)
    const placeholder = users(started).at(-1)

    expect(placeholder).toMatchObject({ unknownAuthor: true, text: '', turnId: 'turn-f', origin: 'foreign' })
    expect(started.turn.foreignReconcilePending).toBe(true)
    expect(started.turn.id).toBe('turn-f')
  })

  it('gives a parked prompt the turn id of the turn it starts', () => {
    const parked = confirmSubmit(beginLocalTurn(fresh(), 'later please', undefined, NOW), { status: 'queued' }, NOW)
    const idle = { ...parked, turn: { ...parked.turn, local: false, active: false } }
    const started = applyEvent(idle, { type: 'message.start', seq: 1, turn_id: 'turn-q' }, NOW)

    expect(users(started)).toHaveLength(1)
    expect(users(started)[0]).toMatchObject({ text: 'later please', pending: false, turnId: 'turn-q' })
    expect(started.turn.local).toBe(true)
  })

  it('forgets the turn id when the turn ends', () => {
    const state = apply(fresh(), [
      { type: 'message.start', seq: 1, turn_id: 'turn-f' },
      { type: 'message.complete', seq: 2, turn_id: 'turn-f', payload: { text: 'hi', status: 'complete' } }
    ])

    expect(state.turn.id).toBeUndefined()
  })
})

describe('message.complete naming its row', () => {
  it('reads the receipt when the frame carries no row_id of its own', () => {
    const state = apply(fresh(), [
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'hello' } },
      {
        type: 'message.complete',
        seq: 3,
        payload: { text: 'hello', status: 'complete', persisted_turn: { final_assistant_row_id: 9 } }
      }
    ])

    expect(assistants(state).map(item => [item.text, item.rowId])).toEqual([['hello', 9]])
    expect(state.byRowId['9']).toBe(assistants(state)[0]!.id)
  })

  it('does not land the reply on a note that stands for another row', () => {
    // The final continues the last note's words, which used to be enough to
    // land it there. The note is row 12; the reply is row 16.
    const state = apply(fresh(), [
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'Checking.' } },
      { type: 'message.interim', seq: 3, payload: { text: 'Checking.', row_id: 12 } },
      { type: 'message.complete', seq: 4, payload: { text: 'Checking. Done.', status: 'complete', row_id: 16 } }
    ])

    expect(assistants(state).map(item => [item.text, item.rowId, item.interim])).toEqual([
      ['Checking.', 12, true],
      ['Checking. Done.', 16, false]
    ])
  })
})

describe('a turn the cache cut mid-stream', () => {
  const half = framesOf('turn-h', [
    { type: 'message.start', seq: 1 },
    { type: 'message.delta', seq: 2, payload: { text: 'Hello ' } },
    { type: 'message.delta', seq: 3, payload: { text: 'world.' } },
    { type: 'message.interim', seq: 4, payload: { text: 'Hello world.', already_streamed: true, row_id: 2 } },
    { type: 'message.complete', seq: 5, payload: { text: 'Bye.', status: 'complete', row_id: 3 } }
  ])
  const halfRows: TranscriptRow[] = [
    { role: 'user', row_id: 1, text: 'hi', display_metadata: { turn_id: 'turn-h' } },
    { role: 'assistant', row_id: 2, text: 'Hello world.' },
    { role: 'assistant', row_id: 3, text: 'Bye.' }
  ]
  const snapshotOf = (state: ChatState) => snapshotForCache({ ...state, lastSeqSessionId: 'runtime-1' }, NOW)
  const ids = { storedSessionId: 'stored-1', resolvedSessionId: 'resolved-1' }

  it('carries on the bubble it was filling, and settles it onto its row', () => {
    const away = apply(fresh(), half.slice(0, 2))
    const snapshot = snapshotOf(away)

    expect(snapshot.turn).toEqual({ id: 'turn-h', assistantId: away.turn.assistantId })

    const hydrated = reconcile(stateFromCache('boekhouder', ids, snapshot), rowsToItems(halfRows, 'rpc'))
    const state = apply(hydrated, half.slice(2), LATER)

    expect(list(state).map(item => `${item.kind}@${item.rowId}`)).toEqual(['user@1', 'assistant@2', 'assistant@3'])
    expect(assistants(state).map(item => item.text)).toEqual(['Hello world.', 'Bye.'])
  })

  it('carries on a bubble that held only a thought when it was cut', () => {
    const thinking = framesOf('turn-h', [
      half[0]!,
      { type: 'reasoning.delta', seq: 2, payload: { text: 'Greet first.' } },
      ...half.slice(1).map(event => ({ ...event, seq: (event.seq ?? 0) + 1 }))
    ])
    const away = apply(fresh(), thinking.slice(0, 2))
    const hydrated = reconcile(fromCache(away), rowsToItems(halfRows, 'rpc'))
    const state = apply(hydrated, thinking.slice(2), LATER)

    expect(list(state).map(item => `${item.kind}@${item.rowId}`)).toEqual(['user@1', 'assistant@2', 'assistant@3'])
    expect(assistants(state)[0]).toMatchObject({ text: 'Hello world.', reasoning: 'Greet first.' })
  })

  it('reads a cache from before the turn was kept exactly as it always read', () => {
    const away = apply(fresh(), half.slice(0, 2))
    const { turn: _turn, ...old } = snapshotOf(away)
    const state = stateFromCache('boekhouder', ids, old)

    expect(state.turn).toEqual({ active: false, local: false, nextSeq: state.turn.nextSeq })
  })

  it('drops a restored pointer whose bubble is gone or already sealed', () => {
    const away = apply(fresh(), half.slice(0, 4))
    const sealedId = assistants(away)[0]!.id
    const gone = stateFromCache('boekhouder', ids, {
      ...snapshotOf(away),
      turn: { id: 'turn-h', assistantId: 'a:missing', reasoningId: 'a:missing' }
    })
    const sealed = stateFromCache('boekhouder', ids, {
      ...snapshotOf(away),
      turn: { id: 'turn-h', assistantId: sealedId }
    })

    expect([gone.turn.id, gone.turn.assistantId, gone.turn.reasoningId]).toEqual(['turn-h', undefined, undefined])
    expect([sealed.turn.id, sealed.turn.assistantId]).toEqual(['turn-h', undefined])
  })

  it('restores nothing from a snapshot read as cold, which replays nothing', () => {
    const away = apply(fresh(), half.slice(0, 2))
    const { lastSeqSessionId: _session, ...cold } = snapshotOf(away)

    expect(stateFromCache('boekhouder', ids, cold).turn.assistantId).toBeUndefined()
    expect(stateFromCache('boekhouder', ids, cold).turn.id).toBeUndefined()
  })

  it('lets the restored turn go when a different turn starts', () => {
    const thinking = apply(fresh(), [
      half[0]!,
      { type: 'reasoning.delta', seq: 2, turn_id: 'turn-h', payload: { text: 'x' } }
    ])
    const restored = stateFromCache('boekhouder', ids, snapshotOf(thinking))
    const next = applyEvent(restored, { type: 'message.start', seq: 3, turn_id: 'turn-n' }, LATER)

    expect(restored.turn).toMatchObject({ id: 'turn-h', reasoningId: restored.turn.assistantId })
    expect([next.turn.id, next.turn.assistantId, next.turn.reasoningId]).toEqual(['turn-n', undefined, undefined])
  })

  it('writes no turn for a gateway that names none', () => {
    const away = apply(
      fresh(),
      half.slice(0, 2).map(({ turn_id: _turnId, ...event }) => event)
    )

    expect(snapshotOf(away).turn).toBeUndefined()
  })
})

describe('our own prompt at message.start', () => {
  it('takes the turn id when it is the one optimistic prompt standing', () => {
    const state = applyEvent(sentTurn(), FRAMES[0]!, NOW)

    expect(users(state).at(-1)).toMatchObject({ text: PROMPT, origin: 'optimistic', turnId: TURN })
  })

  it('stays unstamped when two prompts could be it', () => {
    const two = beginLocalTurn(sentTurn(), 'and this', undefined, NOW)
    const state = applyEvent(two, FRAMES[0]!, NOW)

    expect(users(state).filter(item => item.turnId === TURN)).toHaveLength(0)
  })
})

// ── part 2: reconcile, tail and resume ───────────────────────────────────────

/** The turn's rows as a later projection words them: the same rows, different punctuation. */
const REWORDED_ROWS: TranscriptRow[] = TURN_ROWS.map(row =>
  row.role === 'assistant' && typeof row.text === 'string' ? { ...row, text: `${row.text.replace(/\.$/u, '')} …` } : row
)

/** The same rows as the REST route returns them: `id`, the stored tool id, no `row_id`. */
const restRowsOf = (rows: readonly TranscriptRow[]): TranscriptRow[] =>
  rows.map(({ row_id, tool_call_id, text, ...row }) => ({
    ...row,
    id: row_id,
    content: text,
    ...(tool_call_id ? { tool_id: tool_call_id } : {})
  }))

describe('a re-hydration after the turn streamed live', () => {
  it('pairs every note and card by its id, though no text key would match', () => {
    const live = apply(sentTurn(), FRAMES)
    const reloaded = reconcile(live, rowsToItems([...EARLIER_ROWS, ...REWORDED_ROWS], 'rpc'))

    expect(shape(reloaded)).toEqual([
      'user@1',
      'assistant@2',
      'user@11',
      'assistant@12',
      'tool:12/0@13',
      'assistant@14',
      'tool:14/0@15',
      'assistant@16'
    ])
    // The ids the live items had are the ids the rows carry now: nothing remounts.
    expect(assistants(reloaded).map(item => item.id)).toEqual(assistants(live).map(item => item.id))
    expect(cards(reloaded).map(card => card.id)).toEqual(cards(live).map(card => card.id))
    expect(assistants(reloaded).map(item => item.text)).toEqual([
      EARLIER_REPLY,
      ...REWORDED_ROWS.filter(row => row.role === 'assistant').map(row => row.text)
    ])
    expect(cards(reloaded).every(card => card.resultKnown && card.result === 'ok')).toBe(true)
  })

  it('does the same through a tail sweep', () => {
    const live = apply(sentTurn(), FRAMES)
    const tailed = reconcileTail(live, rowsToItems(restRowsOf(REWORDED_ROWS), 'rest'))

    expect(shape(tailed)).toEqual(shape(reconcile(live, rowsToItems([...EARLIER_ROWS, ...REWORDED_ROWS], 'rpc'))))
    expect(assistants(tailed).map(item => item.id)).toEqual(assistants(live).map(item => item.id))
    expect(new Set(list(tailed).map(item => item.rowId)).size).toBe(list(tailed).length)
  })

  it('pairs the card a cache kept with its row when two turns reused call_0', () => {
    const turnOne = framesOf('turn-1', [
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'Looking.' } },
      { type: 'tool.start', seq: 3, payload: { tool_id: 'call_0', name: 'ls', call_row_id: 2, call_index: 0 } },
      {
        type: 'tool.complete',
        seq: 4,
        payload: { tool_id: 'call_0', name: 'ls', result: 'one', call_row_id: 2, call_index: 0, row_id: 3 }
      },
      { type: 'message.complete', seq: 5, payload: { text: 'Once.', status: 'complete', row_id: 4 } }
    ])
    const turnTwo = framesOf('turn-2', [
      { type: 'message.start', seq: 6 },
      { type: 'message.delta', seq: 7, payload: { text: 'Again.' } },
      { type: 'tool.start', seq: 8, payload: { tool_id: 'call_0', name: 'ls', call_row_id: 6, call_index: 0 } },
      {
        type: 'tool.complete',
        seq: 9,
        payload: { tool_id: 'call_0', name: 'ls', result: 'two', call_row_id: 6, call_index: 0, row_id: 7 }
      },
      { type: 'message.complete', seq: 10, payload: { text: 'Twice.', status: 'complete', row_id: 8 } }
    ])
    const rows: TranscriptRow[] = [
      { role: 'user', row_id: 1, text: 'once', display_metadata: { turn_id: 'turn-1' } },
      { role: 'assistant', row_id: 2, text: 'Looking.' },
      { role: 'tool', row_id: 3, name: 'ls', tool_call_id: 'call_0', call_row_id: 2, call_index: 0 },
      { role: 'assistant', row_id: 4, text: 'Once.' },
      { role: 'user', row_id: 5, text: 'twice', display_metadata: { turn_id: 'turn-2' } },
      { role: 'assistant', row_id: 6, text: 'Again.' },
      { role: 'tool', row_id: 7, name: 'ls', tool_call_id: 'call_0', call_row_id: 6, call_index: 0 },
      { role: 'assistant', row_id: 8, text: 'Twice.' }
    ]
    // Away right after the second turn's tool.start: its card is cached with no row yet.
    const away = apply(fresh(), [...turnOne, ...turnTwo.slice(0, 3)])
    const hydrated = reconcile(fromCache(away), rowsToItems(rows, 'rpc'))
    const state = apply(hydrated, turnTwo.slice(3), LATER)

    expect(cards(state).map(card => [card.callKey, card.rowId, card.result])).toEqual([
      ['2/0', 3, 'one'],
      ['6/0', 7, 'two']
    ])
    expect(cards(state).map(card => card.id)).toEqual(cards(away).map(card => card.id))
    expect(assistants(state).map(item => item.rowId)).toEqual([2, 4, 6, 8])
  })
})

describe('two identical prompts from two authors (HERM-83, by id)', () => {
  /** The reader's "ok", parked and then claimed by its own turn; no author on the bubble. */
  function readerTurn(): ChatState {
    const parked = confirmSubmit(beginLocalTurn(fresh(), 'ok', undefined, NOW), { status: 'queued' }, NOW)
    const idle = { ...parked, turn: { ...parked.turn, local: false, active: false } }

    return applyEvent(idle, { type: 'message.start', seq: 1, turn_id: 'turn-reader' }, NOW)
  }

  const rows: TranscriptRow[] = [
    {
      role: 'user',
      row_id: 5,
      text: 'ok',
      display_metadata: { turn_id: 'turn-colleague', author: { id: 'telegram:2', name: 'Sam' } }
    },
    {
      role: 'user',
      row_id: 6,
      text: 'ok',
      display_metadata: { turn_id: 'turn-reader', author: { id: 'telegram:1', name: 'Sebas' } }
    }
  ]

  it('pairs each with its own row on a re-hydration', () => {
    const live = readerTurn()
    const bubble = users(live)[0]!
    const state = reconcile(live, rowsToItems(rows, 'rpc'))

    expect(users(state).map(item => [item.rowId, item.turnId])).toEqual([
      [5, 'turn-colleague'],
      [6, 'turn-reader']
    ])
    expect(state.byRowId['6']).toBe(bubble.id)
  })

  it('pairs each with its own row on a tail sweep', () => {
    const live = readerTurn()
    const bubble = users(live)[0]!
    const state = reconcileTail(live, rowsToItems(restRowsOf(rows), 'rest'))

    expect(users(state).map(item => [item.rowId, item.turnId])).toEqual([
      [5, 'turn-colleague'],
      [6, 'turn-reader']
    ])
    expect(state.byRowId['6']).toBe(bubble.id)
  })
})

describe('a tail sweep filling placeholders', () => {
  it('fills the placeholder its turn stood up, and only that one', () => {
    const live = apply(fresh(), [
      { type: 'message.start', seq: 1, turn_id: 'turn-f1' },
      { type: 'message.complete', seq: 2, turn_id: 'turn-f1', payload: { status: 'complete' } },
      { type: 'message.start', seq: 3, turn_id: 'turn-f2' }
    ])
    const [first, second] = users(live)

    expect([first?.turnId, second?.turnId]).toEqual(['turn-f1', 'turn-f2'])

    const state = reconcileTail(
      live,
      rowsToItems(
        [{ role: 'user', id: 9, content: 'from the second', display_metadata: { turn_id: 'turn-f2' } }],
        'rest'
      )
    )

    // Only the turn that named it fills the second; the first's turn is over and
    // the tail paired nothing for it, so it is settled rather than left to wait.
    expect(state.items[first!.id]).toBeUndefined()
    expect(state.items[second!.id]).toMatchObject({ text: 'from the second', rowId: 9, turnId: 'turn-f2' })
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })

  it('does not hand a turn’s row to the placeholder of another turn that is still waiting', () => {
    const live = apply(fresh(), [
      { type: 'message.start', seq: 1, turn_id: 'turn-f1' },
      { type: 'message.start', seq: 3, turn_id: 'turn-f2' }
    ])
    const [first, second] = users(live)
    const state = reconcileTail(
      live,
      rowsToItems(
        [{ role: 'user', id: 9, content: 'from the first', display_metadata: { turn_id: 'turn-f1' } }],
        'rest'
      )
    )

    expect(state.items[first!.id]).toMatchObject({ text: 'from the first', rowId: 9, turnId: 'turn-f1' })
    // The running turn's own row has not come yet.
    expect(state.items[second!.id]).toMatchObject({ unknownAuthor: true, text: '', turnId: 'turn-f2' })
    expect(state.turn.foreignReconcilePending).toBe(true)
  })
})

describe('an older page re-sending a call', () => {
  it('is not added twice when the card on screen has no row yet', () => {
    const live = apply(sentTurn(), FRAMES.slice(0, 5))
    const page = rowsToItems([TURN_ROWS[2]!], 'rpc')
    const state = prependHistory(live, page)

    expect(cards(state)).toHaveLength(1)
    expect(state).toBe(live)
  })
})

describe('a resume naming its turn', () => {
  /** Away after the second card finished; back while the turn still runs. */
  function resumedMidTurn(inflight: Record<string, unknown>): ChatState {
    const away = apply(sentTurn(), FRAMES.slice(0, 10))
    const hydrated = reconcile(fromCache(away), rowsToItems([...EARLIER_ROWS, ...TURN_ROWS.slice(0, 5)], 'rpc'))

    return applyResumeSnapshot(
      hydrated,
      {
        running: true,
        inflight: { user: PROMPT, display_metadata: { turn_id: TURN }, ...inflight }
      },
      LATER
    )
  }

  it('paints only what no sealed note above already shows', () => {
    const state = resumedMidTurn({
      assistant: `${FIRST}${SECOND}Ik heb alles`,
      assistant_unsealed: 'Ik heb alles',
      streaming: true
    })

    expect(assistants(state).map(item => item.text)).toEqual([EARLIER_REPLY, FIRST, SECOND, 'Ik heb alles'])
    expect(assistants(state).at(-1)).toMatchObject({ streaming: true, origin: 'inflight' })
    expect(state.turn.assistantId).toBe(assistants(state).at(-1)!.id)
    expect(users(state)).toHaveLength(2)
    expect(state.turn.id).toBe(TURN)
  })

  it('paints no bubble for an empty rest between two segments', () => {
    const state = resumedMidTurn({ assistant: `${FIRST}${SECOND}`, assistant_unsealed: '', streaming: false })

    expect(assistants(state).map(item => item.text)).toEqual([EARLIER_REPLY, FIRST, SECOND])
  })

  it('opens an empty bubble for an empty rest the stream is about to fill', () => {
    const state = resumedMidTurn({ assistant: `${FIRST}${SECOND}`, assistant_unsealed: '', streaming: true })

    expect(assistants(state).map(item => [item.text, item.streaming])).toEqual([
      [EARLIER_REPLY, false],
      [FIRST, false],
      [SECOND, false],
      ['', true]
    ])
  })

  it('knows the prompt by its turn id, however its words normalise', () => {
    const away = apply(sentTurn(), FRAMES.slice(0, 1))
    const rows = [{ ...TURN_ROWS[0]!, text: `${PROMPT}!` }]
    const hydrated = reconcile(fromCache(away), rowsToItems([...EARLIER_ROWS, ...rows], 'rpc'))
    const state = applyResumeSnapshot(
      hydrated,
      { running: true, inflight: { user: PROMPT, display_metadata: { turn_id: TURN }, assistant: '' } },
      LATER
    )

    expect(users(state).map(item => [item.text, item.rowId])).toEqual([
      [EARLIER_PROMPT, 1],
      [`${PROMPT}!`, 11]
    ])
    expect(state.turn.id).toBe(TURN)
  })

  it('fills the placeholder its turn stood up, with the turn id on it', () => {
    const hydrated = reconcile(fresh(), rowsToItems(EARLIER_ROWS, 'rpc'))
    const started = applyEvent(hydrated, { type: 'message.start', seq: 1, turn_id: 'turn-f' }, NOW)
    const placeholder = users(started).at(-1)!
    const state = applyResumeSnapshot(
      started,
      { running: true, inflight: { user: 'from elsewhere', display_metadata: { turn_id: 'turn-f' } } },
      LATER
    )

    expect(state.items[placeholder.id]).toMatchObject({ kind: 'user', text: 'from elsewhere', turnId: 'turn-f' })
    expect(users(state)).toHaveLength(2)
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })
})

// ── part 3: a cache saved after every frame ──────────────────────────────────
//
// The owner's case in full. A chat with three earlier turns of history (one
// whose tool call is `call_0`, as the new turn's will be; one whose note says
// exactly what a note of the new turn says), then one new turn, cached after
// every single one of its frames. Each cut is reopened two ways: the turn
// finished while the app was away (history holds every row, the rest of the
// frames replay), and the turn is still running (history holds the rows the
// gateway had written by then, a resume describes the rest as the gateway
// would, then the frames replay).

const EVERY_TURN = 'turn-every'
const NOTE_A = 'Ik kijk eerst naar de boekingen van september.'
const NOTE_ECHO = 'Dat klopt met het bankafschrift.'
const NOTE_FINAL = 'Alles is nagelopen; er hoeft niets te gebeuren.'

const EVERY_EARLIER: TranscriptRow[] = [
  { role: 'user', row_id: 1, text: 'eerste vraag', display_metadata: { turn_id: 'turn-1' } },
  { role: 'assistant', row_id: 2, text: 'Kijken.' },
  { role: 'tool', row_id: 3, name: 'terminal', tool_call_id: 'call_0', call_row_id: 2, call_index: 0 },
  { role: 'assistant', row_id: 4, text: 'Klaar.' },
  { role: 'user', row_id: 5, text: 'tweede vraag', display_metadata: { turn_id: 'turn-2' } },
  { role: 'assistant', row_id: 6, text: NOTE_ECHO },
  { role: 'user', row_id: 7, text: 'derde vraag', display_metadata: { turn_id: 'turn-3' } },
  { role: 'assistant', row_id: 8, text: 'Prima.' }
]

/** The new turn's rows, each with the index of the frame that persisted it. */
const EVERY_ROWS: [TranscriptRow, number][] = [
  [{ role: 'user', row_id: 11, text: 'loop alles na', display_metadata: { turn_id: EVERY_TURN } }, -1],
  [{ role: 'assistant', row_id: 12, text: NOTE_A }, 4],
  [{ role: 'tool', row_id: 13, name: 'terminal', tool_call_id: 'call_0', call_row_id: 12, call_index: 0 }, 6],
  [{ role: 'assistant', row_id: 14, text: NOTE_ECHO }, 8],
  [{ role: 'tool', row_id: 15, name: 'terminal', tool_call_id: 'call_1', call_row_id: 14, call_index: 0 }, 10],
  [{ role: 'assistant', row_id: 16, text: NOTE_FINAL }, 12]
]

const EVERY_FRAMES: TranscriptEvent[] = framesOf(EVERY_TURN, [
  { type: 'message.start', seq: 21 },
  { type: 'reasoning.delta', seq: 22, payload: { text: 'September first.' } },
  // One note in two deltas, so a cache can be cut in the middle of it.
  { type: 'message.delta', seq: 23, payload: { text: 'Ik kijk eerst naar ' } },
  { type: 'message.delta', seq: 24, payload: { text: 'de boekingen van september.' } },
  { type: 'message.interim', seq: 25, payload: { text: NOTE_A, already_streamed: true, row_id: 12 } },
  ...toolFrames(26, 'call_0', 12, 0, 13),
  { type: 'message.delta', seq: 28, payload: { text: NOTE_ECHO } },
  { type: 'message.interim', seq: 29, payload: { text: NOTE_ECHO, already_streamed: true, row_id: 14 } },
  ...toolFrames(30, 'call_1', 14, 0, 15),
  { type: 'message.delta', seq: 32, payload: { text: NOTE_FINAL } },
  { type: 'message.complete', seq: 33, payload: { text: NOTE_FINAL, status: 'complete', usage: USAGE, row_id: 16 } }
])

/** The resume the gateway would answer with `cut` frames of the turn behind it. */
function inflightAt(frames: readonly TranscriptEvent[], cut: number, withIdentity: boolean): Record<string, unknown> {
  let assistant = ''
  let sealedLength = 0

  for (const event of frames.slice(0, cut)) {
    const payload = (event.payload ?? {}) as { text?: string; already_streamed?: boolean }

    if (event.type === 'message.delta') {
      assistant += payload.text ?? ''
    } else if (event.type === 'message.interim' && payload.already_streamed) {
      sealedLength = assistant.length
    }
  }

  const unsealed = assistant.slice(sealedLength).replace(/^\s+/u, '')

  return {
    user: 'loop alles na',
    assistant,
    streaming: unsealed !== '',
    ...(withIdentity ? { display_metadata: { turn_id: EVERY_TURN }, assistant_unsealed: unsealed } : {})
  }
}

/** Frames and rows as a gateway without any of the identity would send them. */
const stripFrame = ({ turn_id: _turnId, ...event }: TranscriptEvent): TranscriptEvent => {
  const {
    row_id: _row,
    call_row_id: _call,
    call_index: _index,
    ...payload
  } = (event.payload ?? {}) as Record<string, unknown>

  return event.payload === undefined ? event : { ...event, payload }
}
const stripRow = (row: TranscriptRow): TranscriptRow => {
  const { call_row_id: _call, call_index: _index, display_metadata: _metadata, ...rest } = row

  // A tool row's own `row_id` is part of the identity too; the other rows always had theirs.
  return row.role === 'tool' ? { ...rest, row_id: undefined } : rest
}

/**
 * The engine calls part 3 makes, in two copies. The golden corpus records every
 * engine call a test makes, and fourteen cuts reopened two ways, with and
 * without identity, would put several megabytes of near-identical states into
 * it on every regeneration. So the loop below runs every cut here, and only the
 * cuts named below go through the recorded copy for the port to replay.
 *
 * The unrecorded copy is the engine itself, reached through `./index`: the
 * recorder wraps a test's imports of the engine's public modules, never the
 * modules those import in turn (`golden/plugin.ts`).
 */
const recordedEngine = {
  applyEvent,
  applyResumeSnapshot,
  beginLocalTurn,
  confirmSubmit,
  reconcile,
  rowsToItems,
  snapshotForCache,
  stateFromCache
}
type Engine = typeof recordedEngine
const quietEngine: Engine = {
  applyEvent: unrecorded.applyEvent,
  applyResumeSnapshot: unrecorded.applyResumeSnapshot,
  beginLocalTurn: unrecorded.beginLocalTurn,
  confirmSubmit: unrecorded.confirmSubmit,
  reconcile: unrecorded.reconcile,
  rowsToItems: unrecorded.rowsToItems,
  snapshotForCache: unrecorded.snapshotForCache,
  stateFromCache: unrecorded.stateFromCache
}

/**
 * The cuts the corpus records with identity: after the turn's start, after a
 * thought with no words, between the two deltas of one note, after a tool's
 * result, and inside the second note — the cuts each pairing rule is needed at.
 * Before the turn and after its last frame are part 1's cases already.
 */
const GOLDEN_CUTS: ReadonlySet<number> = new Set([1, 2, 3, 6, 9])

/** The cuts the corpus records without identity: inside each of the two notes. */
const GOLDEN_LEGACY_CUTS: ReadonlySet<number> = new Set([3, 9])

/**
 * Every reopen of the turn, after each cut: [cut, finished-while-away, still-running].
 * `recordRunning` says whether the still-running reopen of a recorded cut is
 * recorded too, or only the finished one.
 */
function everyReopen(
  withIdentity: boolean,
  recordedCuts: ReadonlySet<number>,
  recordRunning: boolean
): [number, ChatState, ChatState][] {
  const earlier = withIdentity ? EVERY_EARLIER : EVERY_EARLIER.map(stripRow)
  const turnRows = EVERY_ROWS.map(([row, at]): [TranscriptRow, number] => [withIdentity ? row : stripRow(row), at])
  const frames = withIdentity ? EVERY_FRAMES : EVERY_FRAMES.map(stripFrame)
  const runs: [number, ChatState, ChatState][] = []
  const quiet = quietEngine
  // The earlier history on screen and the owner's prompt sent, as the device held it.
  let live = quiet.confirmSubmit(
    quiet.beginLocalTurn(quiet.reconcile(fresh(), quiet.rowsToItems(earlier, 'rpc')), 'loop alles na', undefined, NOW),
    { status: 'streaming' },
    NOW
  )

  for (let cut = 0; cut <= frames.length; cut += 1) {
    if (cut > 0) {
      live = quiet.applyEvent(live, frames[cut - 1]!, NOW)
    }

    const engine = recordedCuts.has(cut) ? recordedEngine : quietEngine
    const runningEngine = recordRunning ? engine : quietEngine
    const rest = frames.slice(cut)
    const replay = (by: Engine, state: ChatState) =>
      rest.reduce((next, event) => by.applyEvent(next, event, LATER), state)
    const cachedBy = (by: Engine) =>
      by.stateFromCache(
        'boekhouder',
        { storedSessionId: 'stored-1', resolvedSessionId: 'resolved-1' },
        by.snapshotForCache({ ...live, lastSeqSessionId: 'runtime-1' }, NOW)
      )
    const finished = replay(
      engine,
      engine.reconcile(cachedBy(engine), engine.rowsToItems([...earlier, ...turnRows.map(([row]) => row)], 'rpc'))
    )
    const written = turnRows.filter(([, at]) => at < cut).map(([row]) => row)
    const hydrated = runningEngine.reconcile(
      cachedBy(runningEngine),
      runningEngine.rowsToItems([...earlier, ...written], 'rpc')
    )
    const running = cut < frames.length
    const resumed = runningEngine.applyResumeSnapshot(
      hydrated,
      running ? { running: true, inflight: inflightAt(frames, cut, withIdentity) } : { running: false },
      LATER
    )

    runs.push([cut, finished, replay(runningEngine, resumed)])
  }

  return runs
}

/** The invariants of a settled reopen, as one comparable value. */
function settledShape(state: ChatState) {
  const rowIds = list(state).map(item => item.rowId)

  return {
    everyItemHasARow: rowIds.every(rowId => rowId !== undefined),
    rowIdsUnique: new Set(rowIds).size === rowIds.length,
    notes: assistants(state).map(item => item.text),
    cards: cards(state).map(card => `${card.callKey}:${card.status}`),
    prompts: users(state).map(item => item.text),
    placeholders: users(state).filter(item => item.unknownAuthor).length,
    active: state.turn.active
  }
}

describe('a cache saved after every frame of a turn', () => {
  const expected = {
    everyItemHasARow: true,
    rowIdsUnique: true,
    notes: ['Kijken.', 'Klaar.', NOTE_ECHO, 'Prima.', NOTE_A, NOTE_ECHO, NOTE_FINAL],
    cards: ['2/0:complete', '12/0:complete', '14/0:complete'],
    prompts: ['eerste vraag', 'tweede vraag', 'derde vraag', 'loop alles na'],
    placeholders: 0,
    active: false
  }

  it('reopens after every frame with every row once, whether the turn finished or still runs', () => {
    for (const [cut, finished, running] of everyReopen(true, GOLDEN_CUTS, true)) {
      expect(settledShape(finished), `finished, cut after ${cut} frames`).toEqual(expected)
      expect(settledShape(running), `running, cut after ${cut} frames`).toEqual(expected)
      expect(
        cards(finished)
          .slice(1)
          .every(card => card.resultKnown),
        `finished results, cut ${cut}`
      ).toBe(true)
      expect(
        cards(running)
          .slice(1)
          .every(card => card.resultKnown),
        `running results, cut ${cut}`
      ).toBe(true)
    }
  })

  it('reopens without identity as the engine always did', () => {
    // Recorded (the finished reopens at the corpus cuts) so the port replays the
    // old path too.
    const counts = everyReopen(false, GOLDEN_LEGACY_CUTS, false).map(([, finished, running]) => [
      finished.order.length,
      running.order.length
    ])

    // Measured against main before any identity existed (d8584f3b), by running this
    // very scenario through that tree's engine: the same counts, duplicates and
    // all — a settled reopen holds 14 items. A tool row without a call identity
    // is named by its place in the history, as there, not by its provider's
    // `call_0`, which every turn reuses.
    expect(counts).toEqual([
      [20, 15],
      [19, 14],
      [20, 15],
      [20, 14],
      [19, 14],
      [18, 14],
      [18, 14],
      [18, 15],
      [17, 16],
      [16, 16],
      [16, 16],
      [16, 17],
      [15, 16],
      [14, 14]
    ])
  })
})

// ── a gateway that does not send the identity, and reuses its call ids ───────

describe('a tool row without a call identity', () => {
  const history: TranscriptRow[] = [
    { role: 'user', text: 'first', row_id: 1 },
    { role: 'assistant', text: 'checking', row_id: 2 },
    // The provider's own id, named `call_0` again in every later turn.
    { role: 'tool', name: 'terminal', tool_call_id: 'call_0', context: 'ls old', timestamp: 1 },
    { role: 'assistant', text: 'done', row_id: 4 }
  ]

  it('keeps the history card of an earlier turn when a later turn reuses its call id', () => {
    const opened = reconcile(fresh(), rowsToItems(history, 'rpc'))
    // A new turn whose `tool.start` was missed, so only its `tool.complete` arrives.
    const state = apply(
      opened,
      [
        { type: 'message.start', seq: 10 },
        {
          type: 'tool.complete',
          seq: 11,
          payload: { tool_id: 'call_0', name: 'terminal', result: 'NEW RESULT', summary: 'ls new' }
        }
      ],
      LATER
    )

    const [old, added] = cards(state)

    expect(cards(state)).toHaveLength(2)
    // The earlier turn's card is the one history named, untouched.
    expect(old).toMatchObject({ id: 't:row-2', context: 'ls old', resultKnown: false })
    expect(added).toMatchObject({ id: 't:call_0', result: 'NEW RESULT' })
  })

  it('is named by its place in the history, as before the gateway sent identity', () => {
    const [card] = cards(reconcile(fresh(), rowsToItems(history, 'rpc')))

    expect(card).toMatchObject({ id: 't:row-2', toolId: 'row-2' })
    expect(card?.callKey).toBeUndefined()
  })

  it('is named by the provider id once the row says which call it was', () => {
    const rows = history.map(row => (row.role === 'tool' ? { ...row, call_row_id: 2, call_index: 0 } : row))
    const [card] = cards(reconcile(fresh(), rowsToItems(rows, 'rpc')))

    expect(card).toMatchObject({ id: 't:call_0', toolId: 'call_0', callKey: '2/0' })
  })
})

// ── a turn the gateway started itself ────────────────────────────────────────
//
// An auto-continue or a notification starts a turn nobody typed. Its `message.start`
// stands up a placeholder for the speaker, and the `role:user` row it persists
// names the turn — but projects to a notice, not to a bubble of the owner's.

describe('a placeholder for a turn the gateway started itself', () => {
  const OWN = [
    { role: 'user', row_id: 1, text: 'hi' },
    { role: 'assistant', row_id: 2, text: 'hello' }
  ] satisfies TranscriptRow[]
  const continued = (turnId: string): TranscriptRow => ({
    role: 'user',
    row_id: 3,
    text: 'continue',
    display_kind: 'auto_continue',
    display_metadata: { turn_id: turnId }
  })
  const turnOf = (turnId: string, from: number): TranscriptEvent[] => [
    { type: 'message.start', seq: from, turn_id: turnId },
    { type: 'message.delta', seq: from + 1, turn_id: turnId, payload: { text: 'resumed work' } },
    {
      type: 'message.complete',
      seq: from + 2,
      turn_id: turnId,
      payload: { text: 'resumed work', status: 'complete' }
    }
  ]
  const kinds = (state: ChatState) => list(state).map(item => item.kind)
  const awayFrom = () => apply(reconcile(fresh(), rowsToItems(OWN, 'rpc')), turnOf('T1', 10))

  it('is settled by the notice its turn row became, in its place', () => {
    const away = awayFrom()

    expect(users(away).filter(item => item.unknownAuthor)).toHaveLength(1)
    expect(away.turn.foreignReconcilePending).toBe(true)

    const state = reconcileTail(
      away,
      rowsToItems([continued('T1'), { role: 'assistant', row_id: 4, text: 'resumed work' }], 'rpc')
    )

    expect(kinds(state)).toEqual(['user', 'assistant', 'notice', 'assistant'])
    expect(users(state).filter(item => item.unknownAuthor)).toHaveLength(0)
    expect(list(state)[2]).toMatchObject({ kind: 'notice', noticeKind: 'auto_continue', rowId: 3, turnId: 'T1' })
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })

  it('leaves the next sweep nothing to wait for, so the owner’s next prompt pairs plainly', () => {
    const settled = reconcileTail(
      awayFrom(),
      rowsToItems([continued('T1'), { role: 'assistant', row_id: 4, text: 'resumed work' }], 'rpc')
    )
    const sent = confirmSubmit(beginLocalTurn(settled, 'next question', undefined, NOW), { status: 'streaming' }, NOW)
    const answered = apply(sent, turnOf('T2', 20).slice(0, 1))
    const state = reconcileTail(
      apply(answered, [
        { type: 'message.delta', seq: 21, turn_id: 'T2', payload: { text: 'answer' } },
        { type: 'message.complete', seq: 22, turn_id: 'T2', payload: { text: 'answer', status: 'complete' } }
      ]),
      rowsToItems(
        [
          { role: 'user', row_id: 5, text: 'next question', display_metadata: { turn_id: 'T2' } },
          { role: 'assistant', row_id: 6, text: 'answer' }
        ],
        'rpc'
      )
    )

    expect(users(state).map(item => [item.text, item.rowId, item.unknownAuthor])).toEqual([
      ['hi', 1, undefined],
      ['next question', 5, undefined]
    ])
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })

  it('waits on while the turn still runs and the tail only brings rows of another turn', () => {
    const state = reconcileTail(
      apply(reconcile(fresh(), rowsToItems(OWN, 'rpc')), turnOf('T1', 10).slice(0, 2)),
      rowsToItems(
        [
          { ...continued('T0'), row_id: 3 },
          { role: 'assistant', row_id: 4, text: 'older' }
        ],
        'rpc'
      )
    )

    expect(users(state).filter(item => item.unknownAuthor)).toHaveLength(1)
    expect(state.turn.foreignReconcilePending).toBe(true)
  })

  it('goes when the turn row only joins a dispatch and leaves nothing of its own to show', () => {
    const dispatched = apply(reconcile(fresh(), rowsToItems(OWN, 'rpc')), [
      { type: 'tool.start', seq: 5, payload: { tool_id: 'dm-1', name: 'message_agent', args: { target: 'sam' } } },
      {
        type: 'tool.complete',
        seq: 6,
        payload: {
          tool_id: 'dm-1',
          name: 'message_agent',
          result: JSON.stringify({ status: 'queued', process_id: 'proc-1', to: 'sam' })
        }
      }
    ])
    const away = apply(dispatched, turnOf('T1', 10))
    const report = [
      '[IMPORTANT: Background process proc-1 completed with exit code 0.',
      'Command: python bot_mode_dm.py --run-delivery d1',
      'Output:',
      'Sam says hi]'
    ].join('\n')
    const rows: TranscriptRow[] = [
      {
        role: 'user',
        row_id: 6,
        text: report,
        display_kind: 'process_complete',
        display_metadata: { turn_id: 'T1' }
      }
    ]

    expect(users(away).filter(item => item.unknownAuthor)).toHaveLength(1)

    const state = reconcileTail(away, rowsToItems(rows, 'rpc'))

    expect(users(state).filter(item => item.unknownAuthor)).toHaveLength(0)
    expect(list(state).find(item => item.kind === 'bot_dm_out')).toMatchObject({ reply: { text: 'Sam says hi' } })
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })
})

// ── a resume that names another turn than the cached one ─────────────────────

describe('the turn pointers a cache restored, met by a resume', () => {
  const midTurn = () =>
    apply(reconcile(fresh(), rowsToItems([{ role: 'user', row_id: 1, text: 'hi' }], 'rpc')), [
      { type: 'message.start', seq: 1, turn_id: 'T1' },
      { type: 'message.delta', seq: 2, turn_id: 'T1', payload: { text: 'Hal' } }
    ])
  // Between two segments of the turn the gateway says it is not streaming, so
  // nothing here re-points the turn at a bubble: what is left is what was restored.
  const resumeOf = (turnId: string) =>
    applyResumeSnapshot(
      midTurn(),
      {
        running: true,
        inflight: { user: 'hi', display_metadata: { turn_id: turnId }, assistant: 'Hal', streaming: false }
      },
      LATER
    )

  it('keeps them when the resume names the same turn', () => {
    const state = resumeOf('T1')

    expect(state.turn).toMatchObject({ id: 'T1', active: true })
    expect(state.turn.assistantId).toBeDefined()
    expect(state.turn.reasoningId).toBeUndefined()
  })

  it('drops them when the resume names another turn, which the cached one is over for', () => {
    const before = midTurn()

    expect(before.turn).toMatchObject({ id: 'T1' })
    expect(before.turn.assistantId).toBeDefined()

    const state = resumeOf('T2')

    expect(state.turn).toMatchObject({ id: 'T2', active: true })
    // The old turn's bubble is not where the next delta of the new turn goes.
    expect(state.turn.assistantId).toBeUndefined()
    expect(state.turn.reasoningId).toBeUndefined()
  })
})

// ── the same placeholder, on the paths the notice does not reach ─────────────
//
// A turn the gateway starts itself leaves a `turnId` placeholder that only its
// own row may fill, and that row reaches the engine in more than one shape: as a
// notice (above), joined into a dispatch card of the same page (no item of its
// own), already in history when the turn's `message.start` is replayed, in a
// full reconcile before the tail, and in a resume that names the turn.

describe('a turn the gateway started itself, on every path its row can take', () => {
  const unknown = (state: ChatState) => users(state).filter(item => item.unknownAuthor)
  const kinds = (state: ChatState) => list(state).map(item => item.kind)
  const START = { type: 'message.start', seq: 20, turn_id: 'T1' } satisfies TranscriptEvent
  const DELTA = {
    type: 'message.delta',
    seq: 21,
    turn_id: 'T1',
    payload: { text: 'on it' }
  } satisfies TranscriptEvent
  const COMPLETE = {
    type: 'message.complete',
    seq: 22,
    turn_id: 'T1',
    payload: { text: 'on it', status: 'complete' }
  } satisfies TranscriptEvent
  const continued: TranscriptRow = {
    role: 'user',
    row_id: 3,
    text: 'continue',
    display_kind: 'auto_continue',
    display_metadata: { turn_id: 'T1' }
  }
  const OWN = [
    { role: 'user', row_id: 1, text: 'hi' },
    { role: 'assistant', row_id: 2, text: 'hello' }
  ] satisfies TranscriptRow[]

  describe('a delivery that finds its dispatch inside the same page', () => {
    const DISPATCHED: TranscriptRow[] = [
      { role: 'user', row_id: 1, text: 'tell sam' },
      {
        role: 'tool',
        row_id: 2,
        name: 'message_agent',
        tool_call_id: 'dm-1',
        args: { target: 'sam', message: 'ping' }
      },
      { role: 'assistant', row_id: 3, text: 'sent' }
    ]
    const REPORT = [
      '[IMPORTANT: Background process proc-1 completed with exit code 0.',
      'Command: python bot_mode_dm.py --run-delivery d1',
      'Output:',
      'Sam says hi]'
    ].join('\n')
    const tail: TranscriptRow[] = [
      ...DISPATCHED,
      {
        role: 'user',
        row_id: 4,
        text: REPORT,
        display_kind: 'process_complete',
        display_metadata: { turn_id: 'T1' }
      },
      { role: 'assistant', row_id: 5, text: 'Sam answered.' }
    ]

    it('lays the turn id on the reply it joined, since no item of the row’s own is left', () => {
      const [dispatch] = rowsToItems(tail, 'rpc').filter(item => item.kind === 'bot_dm_out')

      expect(dispatch).toMatchObject({ reply: { text: 'Sam says hi', rowId: 4, turnId: 'T1' } })
    })

    it('settles the placeholder, and the next sweep has nothing to wait for', () => {
      const opened = reconcile(fresh(), rowsToItems(DISPATCHED, 'rpc'))
      const away = apply(opened, [START])

      expect(unknown(away)).toHaveLength(1)
      expect(away.turn.foreignReconcilePending).toBe(true)

      const state = reconcileTail(away, rowsToItems(tail, 'rpc'))

      expect(unknown(state)).toHaveLength(0)
      expect(state.turn.foreignReconcilePending).toBeUndefined()
      expect(list(state).find(item => item.kind === 'bot_dm_out')).toMatchObject({ reply: { text: 'Sam says hi' } })
    })
  })

  describe('a turn whose row history already holds when its message.start is replayed', () => {
    it('stands no placeholder up, and waits for no tail', () => {
      const history = reconcile(fresh(), rowsToItems([...OWN, continued], 'rpc'))
      const state = apply(history, [START])

      expect(kinds(state)).toEqual(['user', 'assistant', 'notice'])
      expect(unknown(state)).toHaveLength(0)
      expect(state.turn.foreignReconcilePending).toBeUndefined()
      expect(state.turn).toMatchObject({ id: 'T1', active: true })
    })

    it('still stands one up for a notice that is not yet a row', () => {
      const state = apply(reconcile(fresh(), rowsToItems(OWN, 'rpc')), [START])

      expect(unknown(state)).toHaveLength(1)
    })
  })

  describe('a full reconcile before the tail', () => {
    it('settles the placeholder with the notice history brings for its turn', () => {
      const away = apply(reconcile(fresh(), rowsToItems(OWN, 'rpc')), [START, DELTA])

      expect(unknown(away)).toHaveLength(1)

      const state = reconcile(
        away,
        rowsToItems([...OWN, continued, { role: 'assistant', row_id: 4, text: 'on it' }], 'rpc')
      )

      expect(unknown(state)).toHaveLength(0)
      expect(state.turn.foreignReconcilePending).toBeUndefined()
      expect(list(state).filter(item => item.kind === 'notice')).toHaveLength(1)
      expect(list(state).filter(item => item.kind === 'assistant' && item.text === 'on it')).toHaveLength(1)
    })

    it('keeps a placeholder whose turn history has not reached', () => {
      const away = apply(reconcile(fresh(), rowsToItems(OWN, 'rpc')), [START, DELTA])
      const state = reconcile(away, rowsToItems(OWN, 'rpc'))

      expect(unknown(state)).toHaveLength(1)
      expect(state.turn.foreignReconcilePending).toBe(true)
    })
  })

  describe('a resume that names the turn after the tail settled its placeholder', () => {
    it('adds no prompt of the owner’s below the reply it started', () => {
      const away = apply(reconcile(fresh(), rowsToItems(OWN, 'rpc')), [START, DELTA])
      const settled = reconcileTail(
        away,
        rowsToItems([continued, { role: 'assistant', row_id: 4, text: 'on it' }], 'rpc')
      )
      const state = applyResumeSnapshot(
        settled,
        {
          running: true,
          inflight: {
            user: 'continue',
            display_metadata: { turn_id: 'T1' },
            assistant: 'on it',
            streaming: true
          }
        },
        LATER
      )

      expect(users(state).map(item => item.text)).toEqual(['hi'])
      expect(kinds(state)).toEqual(['user', 'assistant', 'notice', 'assistant'])
    })
  })

  describe('a turn that is over', () => {
    const rows = [{ role: 'assistant', row_id: 9, text: 'unrelated' }] satisfies TranscriptRow[]

    it('waits on while the turn still runs and the tail brings nothing of it', () => {
      const away = apply(reconcile(fresh(), rowsToItems(OWN, 'rpc')), [START, DELTA])
      const state = reconcileTail(away, rowsToItems(rows, 'rpc'))

      expect(unknown(state)).toHaveLength(1)
      expect(state.turn.foreignReconcilePending).toBe(true)
    })

    it('settles the placeholder once message.complete has come and the tail paired nothing for it', () => {
      const away = apply(reconcile(fresh(), rowsToItems(OWN, 'rpc')), [START, DELTA, COMPLETE])

      expect(unknown(away)).toHaveLength(1)

      const state = reconcileTail(away, rowsToItems(rows, 'rpc'))

      expect(unknown(state)).toHaveLength(0)
      expect(state.turn.foreignReconcilePending).toBeUndefined()
    })

    it('settles the placeholder of an earlier turn once another turn runs', () => {
      const away = apply(reconcile(fresh(), rowsToItems(OWN, 'rpc')), [START, DELTA])
      const later = apply(away, [{ type: 'message.start', seq: 30, turn_id: 'T2' }])

      expect(unknown(later).map(item => item.turnId)).toEqual(['T1', 'T2'])

      const state = reconcileTail(later, rowsToItems(rows, 'rpc'))

      expect(unknown(state).map(item => item.turnId)).toEqual(['T2'])
      expect(state.turn.foreignReconcilePending).toBe(true)
    })
  })
})

// ── a delivery that joined a card is a row on screen, and a stale tail heals ──

describe('a delivery row held only as the reply of a dispatch card', () => {
  const unknown = (state: ChatState) => users(state).filter(item => item.unknownAuthor)
  const DISPATCH: TranscriptRow = {
    role: 'tool',
    row_id: 2,
    name: 'message_agent',
    tool_call_id: 'dm-1',
    args: { target: 'sam', message: 'ping' }
  }
  const REPORT = [
    '[IMPORTANT: Background process proc-1 completed with exit code 0.',
    'Command: python bot_mode_dm.py --run-delivery d1',
    'Output:',
    'Sam says hi]'
  ].join('\n')
  const delivery: TranscriptRow = {
    role: 'user',
    row_id: 4,
    text: REPORT,
    display_kind: 'process_complete',
    display_metadata: { turn_id: 'T1' }
  }
  const PAGE: TranscriptRow[] = [
    { role: 'user', row_id: 1, text: 'tell sam' },
    DISPATCH,
    { role: 'assistant', row_id: 3, text: 'sent' },
    delivery,
    { role: 'assistant', row_id: 5, text: 'Sam answered.' }
  ]
  const START = { type: 'message.start', seq: 20, turn_id: 'T1' } satisfies TranscriptEvent
  const replies = (state: ChatState) =>
    list(state).filter(item => item.kind === 'bot_dm_out' && item.reply?.text === 'Sam says hi')
  const notices = (state: ChatState) => list(state).filter(item => item.kind === 'notice')

  it('counts as the turn’s prompt on screen: a replayed message.start stands no placeholder up', () => {
    const history = reconcile(fresh(), rowsToItems(PAGE, 'rpc'))
    const state = apply(history, [START])

    expect(unknown(state)).toHaveLength(0)
    expect(state.turn.foreignReconcilePending).toBeUndefined()
    expect(replies(state)).toHaveLength(1)
    expect(notices(state)).toHaveLength(0)
  })

  it('counts as the prompt a resume finds shown, so it adds no bubble of the owner’s', () => {
    const history = reconcile(fresh(), rowsToItems(PAGE, 'rpc'))
    const state = applyResumeSnapshot(
      history,
      {
        running: true,
        inflight: {
          user: 'Sam says hi',
          display_metadata: { turn_id: 'T1' },
          assistant: 'Sam answered.',
          streaming: false
        }
      },
      LATER
    )

    expect(users(state).map(item => item.text)).toEqual(['tell sam'])
    expect(replies(state)).toHaveLength(1)
  })

  it('is held by a tail page without the dispatch, which adds no second copy as a notice', () => {
    const history = reconcile(fresh(), rowsToItems(PAGE, 'rpc'))
    const state = reconcileTail(
      apply(history, [START]),
      // The dispatch is further back than this page reaches.
      rowsToItems([delivery, { role: 'assistant', row_id: 5, text: 'Sam answered.' }], 'rpc')
    )

    expect(replies(state)).toHaveLength(1)
    expect(notices(state)).toHaveLength(0)
    expect(unknown(state)).toHaveLength(0)
  })

  it('settles the placeholder a known delivery row names, when it stood up before the join', () => {
    const standing = apply(reconcile(fresh(), rowsToItems(PAGE.slice(0, 3), 'rpc')), [START])
    const card = list(standing).find(item => item.kind === 'bot_dm_out')!

    expect(unknown(standing)).toHaveLength(1)

    // The join is on screen already (an earlier sweep brought it), the placeholder still stands.
    const held: ChatState = {
      ...standing,
      items: {
        ...standing.items,
        [card.id]: { ...card, reply: { text: 'Sam says hi', rowId: 4, turnId: 'T1' } } as TranscriptItem
      }
    }
    const state = reconcileTail(held, rowsToItems([delivery], 'rpc'))

    expect(unknown(state)).toHaveLength(0)
    expect(replies(state)).toHaveLength(1)
    expect(notices(state)).toHaveLength(0)
    expect(state.turn.foreignReconcilePending).toBeUndefined()
  })
})

describe('a stale tail that closes a placeholder', () => {
  const OWN = [
    { role: 'user', row_id: 1, text: 'hi' },
    { role: 'assistant', row_id: 2, text: 'hello' }
  ] satisfies TranscriptRow[]
  const continued: TranscriptRow = {
    role: 'user',
    row_id: 3,
    text: 'continue',
    display_kind: 'auto_continue',
    display_metadata: { turn_id: 'T1' }
  }
  const turn = [
    { type: 'message.start', seq: 20, turn_id: 'T1' },
    { type: 'message.delta', seq: 21, turn_id: 'T1', payload: { text: 'on it' } },
    { type: 'message.complete', seq: 22, turn_id: 'T1', payload: { text: 'on it', status: 'complete' } }
  ] satisfies TranscriptEvent[]
  const unknown = (state: ChatState) => users(state).filter(item => item.unknownAuthor)

  it('is healed by the next tail, which puts the notice above the reply by its row id', () => {
    const away = apply(reconcile(fresh(), rowsToItems(OWN, 'rpc')), turn)

    expect(unknown(away)).toHaveLength(1)

    // Sent mid-turn, landing after `message.complete`: the reply's row is in it,
    // the turn's own row is not.
    const stale = reconcileTail(away, rowsToItems([{ role: 'assistant', row_id: 4, text: 'on it' }], 'rpc'))

    expect(unknown(stale)).toHaveLength(0)
    expect(stale.turn.foreignReconcilePending).toBeUndefined()
    expect(list(stale).map(item => item.kind)).toEqual(['user', 'assistant', 'assistant'])

    const healed = reconcileTail(
      stale,
      rowsToItems([continued, { role: 'assistant', row_id: 4, text: 'on it' }], 'rpc')
    )

    expect(list(healed).map(item => [item.kind, item.rowId])).toEqual([
      ['user', 1],
      ['assistant', 2],
      ['notice', 3],
      ['assistant', 4]
    ])
    expect(unknown(healed)).toHaveLength(0)
    expect(healed.turn.foreignReconcilePending).toBeUndefined()
  })
})
