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
import { reconcile } from './reconcile'
import { applyEvent, beginLocalTurn, confirmSubmit, type TranscriptEvent } from './reducer'
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

  it.each([0, 3, 5, 7, 10])('settles every note after it on a replay cut after frame %i', cut => {
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
