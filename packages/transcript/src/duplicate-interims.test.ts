/**
 * Mid-turn notes on screen twice: once as the row the gateway wrote, once as
 * the muted live copy that should have become that row.
 *
 * Reported from TestFlight on 2026-10-03 (native 0.2.2, iPad). A long turn with
 * interim assistant messages on: "Entry 90 staat op Betaald…" and "Ik zoek de
 * mutatie zelf op…" each showed twice, normal and then grey, and two later notes
 * showed grey and then normal again under their "Thought for 1s" row.
 *
 * The gateway's side of it, read off the fork (`agent/turn_tool_round.py`,
 * `tui_gateway/prompt_turn.py`): a tool round streams its text as
 * `message.delta`, then PERSISTS the assistant row (with its tool calls), and
 * only then emits `message.interim {text, already_streamed}` — no row id, no
 * message id, nothing but the words. The same words come back later as a
 * `session.history` row with a `row_id`, and the same frames come back through
 * `session.events.since` when a chat is opened from the cache it saved mid-turn.
 * The gateway never sends one interim text twice in a turn
 * (`_delivered_interim_texts`), which is what makes the words a safe key inside
 * one turn and a dangerous one across turns.
 *
 * Each route a note can be described twice by gets a case, and so does the
 * opposite: two messages that really are the same words must both stay.
 */
import { describe, expect, it } from 'vitest'

import { snapshotForCache, stateFromCache } from './cache'
import { reconcile, reconcileTail } from './reconcile'
import { applyEvent, applyResumeSnapshot, beginLocalTurn, confirmSubmit, type TranscriptEvent } from './reducer'
import { rowsToItems, type TranscriptRow } from './rows-to-items'
import { type AssistantItem, type ChatState, createChatState, type TranscriptItem } from './types'

const NOW = 1_790_000_000_000
const LATER = NOW + 120_000

const PROMPT = 'doe wat je moet doen'
const FIRST = 'Entry 90 staat op Betaald. Nu de € 0,01 op Nog te betalen kosten: eerst kijken hoe die erop staat.'
const SECOND = 'Ik zoek de mutatie zelf op via de API: de Mollie-uitbetaling van 16-09.'
const FINAL = 'Ik heb alles nagelopen en niets ingediend.'

const fresh = () => createChatState('boekhouder', 'stored-1', 'resolved-1')
const list = (state: ChatState) => state.order.map(id => state.items[id]!)
const assistants = (state: ChatState) => list(state).filter((item): item is AssistantItem => item.kind === 'assistant')
const shown = (state: ChatState) => assistants(state).map(item => item.text)
const tools = (state: ChatState) => list(state).filter(item => item.kind === 'tool')
const kinds = (state: ChatState) =>
  list(state).map((item: TranscriptItem) => (item.kind === 'tool' ? `tool:${item.toolId}` : `${item.kind}`))

/** Painted, submitted, and the gateway took it straight away. */
function sentTurn(text = PROMPT): ChatState {
  return confirmSubmit(beginLocalTurn(fresh(), text, undefined, NOW), { status: 'streaming' }, NOW)
}

/** One tool round as the gateway sends it: words, the persisted row's interim, the call. */
const round = (seq: number, text: string, toolId: string): TranscriptEvent[] => [
  { type: 'message.delta', seq, payload: { text } },
  { type: 'message.interim', seq: seq + 1, payload: { text, already_streamed: true } },
  { type: 'tool.start', seq: seq + 2, payload: { tool_id: toolId, name: 'terminal', context: 'curl …' } },
  { type: 'tool.complete', seq: seq + 3, payload: { tool_id: toolId, name: 'terminal', result: 'ok' } }
]

const TURN: TranscriptEvent[] = [
  { type: 'message.start', seq: 1 },
  ...round(2, FIRST, 'call_1'),
  ...round(6, SECOND, 'call_2'),
  { type: 'message.delta', seq: 10, payload: { text: FINAL } },
  {
    type: 'message.complete',
    seq: 11,
    payload: { text: FINAL, status: 'complete', usage: { input: 12, output: 34, total: 46 } }
  }
]

/** The rows `session.history` answers for that turn, in the fork's own shape. */
const ROWS: TranscriptRow[] = [
  { role: 'user', row_id: 1, text: PROMPT, timestamp: 1_790_000_000 },
  { role: 'assistant', row_id: 2, text: FIRST, timestamp: 1_790_000_001 },
  { role: 'tool', name: 'terminal', context: 'curl …', tool_call_id: 'call_1', timestamp: 1_790_000_002 },
  { role: 'assistant', row_id: 4, text: SECOND, timestamp: 1_790_000_003 },
  { role: 'tool', name: 'terminal', context: 'curl …', tool_call_id: 'call_2', timestamp: 1_790_000_004 },
  { role: 'assistant', row_id: 6, text: FINAL, timestamp: 1_790_000_005 }
]

const apply = (state: ChatState, events: readonly TranscriptEvent[], now = NOW) =>
  events.reduce((next, event) => applyEvent(next, event, now), state)

describe('a chat opened from the cache it saved mid-turn', () => {
  /**
   * The owner's route. The app went away after the first note; the cache holds
   * that note live, and a watermark of the frame it came in on. Opening the chat
   * again reads history (every row of the turn, now written) and then replays
   * every frame after the watermark — frames that describe rows already on screen.
   */
  function reopened(): ChatState {
    const away = apply(sentTurn(), TURN.slice(0, 5))
    const cached = stateFromCache(
      'boekhouder',
      { storedSessionId: 'stored-1', resolvedSessionId: 'resolved-1' },
      {
        ...snapshotForCache({ ...away, lastSeqSessionId: 'runtime-1' }, NOW)
      }
    )
    const hydrated = reconcile(cached, rowsToItems(ROWS, 'rpc'))

    return apply(hydrated, TURN.slice(5), LATER)
  }

  it('shows every note once, as its row', () => {
    const state = reopened()

    expect(shown(state)).toEqual([FIRST, SECOND, FINAL])
    expect(assistants(state).map(item => item.rowId)).toEqual([2, 4, 6])
  })

  it('draws nothing muted once the rows are in', () => {
    expect(assistants(reopened()).some(item => item.interim)).toBe(false)
  })

  it('does not stand a second card up for a call history already holds', () => {
    const state = reopened()

    expect(tools(state)).toHaveLength(2)
    expect(kinds(state)).toEqual(['user', 'assistant', 'tool:call_1', 'assistant', 'tool:call_2', 'assistant'])
  })

  it('keeps what only the stream knew on the row it settled onto', () => {
    const state = reopened()

    expect(assistants(state).at(-1)).toMatchObject({
      rowId: 6,
      text: FINAL,
      status: 'complete',
      streaming: false,
      usage: { input: 12, output: 34, total: 46 }
    })
    expect(state.turn.assistantId).toBeUndefined()
  })
})

describe('a history reload after the notes streamed live', () => {
  it('pairs every live note with its row and leaves nothing beside it', () => {
    const live = apply(sentTurn(), TURN)

    expect(assistants(live).filter(item => item.interim)).toHaveLength(2)

    const reloaded = reconcile(live, rowsToItems(ROWS, 'rpc'))

    expect(shown(reloaded)).toEqual([FIRST, SECOND, FINAL])
    expect(kinds(reloaded)).toEqual(['user', 'assistant', 'tool:call_1', 'assistant', 'tool:call_2', 'assistant'])
    // The ids the live bubbles had are the ids the rows now carry: nothing remounts.
    expect(assistants(reloaded).map(item => item.id)).toEqual(assistants(live).map(item => item.id))
    expect(assistants(reloaded).some(item => item.interim)).toBe(false)
  })

  it('does the same through a tail sweep', () => {
    const tailed = reconcileTail(apply(sentTurn(), TURN), rowsToItems(ROWS, 'rest'))

    expect(shown(tailed)).toEqual([FIRST, SECOND, FINAL])
    expect(tools(tailed)).toHaveLength(2)
  })
})

describe('a replay that lands on rows a reload already brought', () => {
  it('settles a replayed note onto its row instead of beside it', () => {
    const loaded = reconcile(sentTurn(), rowsToItems(ROWS.slice(0, 4), 'rpc'))
    const replayed = apply(loaded, [{ type: 'message.start', seq: 1 }, ...round(2, FIRST, 'call_1')])

    expect(shown(replayed)).toEqual([FIRST, SECOND])
  })

  it('settles a note that arrives with no streamed words first', () => {
    const loaded = reconcile(sentTurn(), rowsToItems(ROWS.slice(0, 2), 'rpc'))
    const replayed = apply(loaded, [
      { type: 'message.start', seq: 1 },
      { type: 'message.interim', seq: 2, payload: { text: FIRST, already_streamed: false } }
    ])

    expect(shown(replayed)).toEqual([FIRST])
  })

  it('carries the thought the replay rebuilt onto the row that had none', () => {
    const loaded = reconcile(sentTurn(), rowsToItems(ROWS.slice(0, 2), 'rpc'))
    const replayed = apply(loaded, [
      { type: 'message.start', seq: 1 },
      { type: 'reasoning.delta', seq: 2, payload: { text: 'Check the ledger first.' } },
      ...round(3, FIRST, 'call_1')
    ])

    expect(assistants(replayed)).toHaveLength(1)
    expect(assistants(replayed)[0]).toMatchObject({ rowId: 2, reasoning: 'Check the ledger first.' })
  })
})

describe('a re-hydration over notes that are already doubled', () => {
  /** What a 0.2.2 cache holds after the report: the row, and the grey copy left beside it. */
  function doubled(): ChatState {
    const live = apply(sentTurn(), TURN.slice(0, 5))
    const withRows = reconcile(live, rowsToItems(ROWS.slice(0, 4), 'rpc'))
    // The copy the old reducer left: a muted note with no row, after the rows.
    const copy: AssistantItem = {
      id: 'a:99000',
      kind: 'assistant',
      text: SECOND,
      streaming: false,
      interim: true,
      ts: 1_790_000_010,
      seq: 99_000,
      version: 0,
      origin: 'live'
    }

    return { ...withRows, items: { ...withRows.items, [copy.id]: copy }, order: [...withRows.order, copy.id] }
  }

  it('folds the grey copy into its row on a full reload', () => {
    const state = reconcile(doubled(), rowsToItems(ROWS, 'rpc'))

    expect(shown(state)).toEqual([FIRST, SECOND, FINAL])
  })

  it('folds the grey copy into its row on a tail sweep', () => {
    const state = reconcileTail(doubled(), rowsToItems(ROWS.slice(2), 'rest'))

    expect(shown(state)).toEqual([FIRST, SECOND, FINAL])
  })
})

describe('the same words said twice', () => {
  it('keeps two identical notes in one turn when both rows exist', () => {
    // A model that says "Checking." before each of two calls. The gateway sends
    // no interim for the second (it already delivered those words), so the
    // second bubble is sealed by its tool call.
    const live = apply(sentTurn('check both'), [
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'Checking.' } },
      { type: 'message.interim', seq: 3, payload: { text: 'Checking.', already_streamed: true } },
      { type: 'tool.start', seq: 4, payload: { tool_id: 'call_a', name: 'terminal' } },
      { type: 'tool.complete', seq: 5, payload: { tool_id: 'call_a', name: 'terminal' } },
      { type: 'message.delta', seq: 6, payload: { text: 'Checking.' } },
      { type: 'tool.start', seq: 7, payload: { tool_id: 'call_b', name: 'terminal' } },
      { type: 'tool.complete', seq: 8, payload: { tool_id: 'call_b', name: 'terminal' } }
    ])
    const rows: TranscriptRow[] = [
      { role: 'user', row_id: 1, text: 'check both' },
      { role: 'assistant', row_id: 2, text: 'Checking.' },
      { role: 'tool', name: 'terminal', tool_call_id: 'call_a' },
      { role: 'assistant', row_id: 4, text: 'Checking.' },
      { role: 'tool', name: 'terminal', tool_call_id: 'call_b' }
    ]

    expect(shown(live)).toEqual(['Checking.', 'Checking.'])
    expect(shown(reconcileTail(live, rowsToItems(rows, 'rest')))).toEqual(['Checking.', 'Checking.'])
    expect(shown(reconcile(live, rowsToItems(rows, 'rpc')))).toEqual(['Checking.', 'Checking.'])
  })

  it('keeps a second identical note whose row a racing tail has not reached yet', () => {
    const live = apply(sentTurn('check both'), [
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: 'Checking.' } },
      { type: 'message.interim', seq: 3, payload: { text: 'Checking.', already_streamed: true } },
      { type: 'tool.start', seq: 4, payload: { tool_id: 'call_a', name: 'terminal' } },
      { type: 'tool.complete', seq: 5, payload: { tool_id: 'call_a', name: 'terminal' } },
      { type: 'message.delta', seq: 6, payload: { text: 'Checking.' } },
      { type: 'tool.start', seq: 7, payload: { tool_id: 'call_b', name: 'terminal' } }
    ])
    // Read before the second row was written, delivered after the second seal.
    const racing = reconcileTail(
      live,
      rowsToItems(
        [
          { role: 'user', row_id: 1, text: 'check both' },
          { role: 'assistant', row_id: 2, text: 'Checking.' },
          { role: 'tool', name: 'terminal', tool_call_id: 'call_a' }
        ],
        'rest'
      )
    )

    expect(shown(racing)).toEqual(['Checking.', 'Checking.'])
  })

  it('keeps a note that repeats the words of a note from an earlier turn', () => {
    const earlier = reconcile(
      fresh(),
      rowsToItems(
        [
          { role: 'user', row_id: 1, text: 'first' },
          { role: 'assistant', row_id: 2, text: 'On it.' },
          { role: 'assistant', row_id: 3, text: 'Done.' }
        ],
        'rpc'
      )
    )
    const next = confirmSubmit(beginLocalTurn(earlier, 'second', undefined, NOW), { status: 'streaming' }, NOW)
    const live = apply(next, [
      { type: 'message.start', seq: 1 },
      { type: 'message.interim', seq: 2, payload: { text: 'On it.', already_streamed: false } }
    ])

    expect(shown(live)).toEqual(['On it.', 'Done.', 'On it.'])
    expect(
      shown(
        reconcile(
          live,
          rowsToItems(
            [
              { role: 'user', row_id: 1, text: 'first' },
              { role: 'assistant', row_id: 2, text: 'On it.' },
              { role: 'assistant', row_id: 3, text: 'Done.' },
              { role: 'user', row_id: 4, text: 'second' }
            ],
            'rpc'
          )
        )
      )
    ).toEqual(['On it.', 'Done.', 'On it.'])
  })

  it('keeps two identical replies in two turns through a reload', () => {
    const rows: TranscriptRow[] = [
      { role: 'user', row_id: 1, text: 'ping' },
      { role: 'assistant', row_id: 2, text: 'pong' },
      { role: 'user', row_id: 3, text: 'ping' },
      { role: 'assistant', row_id: 4, text: 'pong' }
    ]
    const once = reconcile(fresh(), rowsToItems(rows, 'rpc'))

    expect(shown(reconcile(once, rowsToItems(rows, 'rpc')))).toEqual(['pong', 'pong'])
    expect(shown(reconcileTail(once, rowsToItems(rows.slice(2), 'rest')))).toEqual(['pong', 'pong'])
  })
})

describe('a resume while the turn has written its notes', () => {
  /** `inflight.assistant` is every delta of the turn, notes included, run together. */
  const flattened = `${FIRST}${SECOND}Nu de verkoopkant`

  it('gives the resumed reply only the words no note above already shows', () => {
    const loaded = reconcile(sentTurn(), rowsToItems(ROWS.slice(0, 5), 'rpc'))
    const resumed = applyResumeSnapshot(
      loaded,
      {
        inflight: { user: PROMPT, assistant: flattened, streaming: true },
        running: true,
        turn_started_at: 1_790_000_000
      },
      LATER
    )

    expect(shown(resumed)).toEqual([FIRST, SECOND, 'Nu de verkoopkant'])
  })

  it('does not paste the notes into the bubble the stream is filling', () => {
    const live = apply(sentTurn(), [
      ...TURN.slice(0, 9),
      { type: 'message.delta', seq: 10, payload: { text: 'Nu de' } }
    ])
    const tailed = reconcileTail(live, rowsToItems(ROWS.slice(0, 5), 'rest'))
    const resumed = applyResumeSnapshot(
      tailed,
      {
        inflight: { user: PROMPT, assistant: flattened, streaming: true },
        running: true,
        turn_started_at: 1_790_000_000
      },
      LATER
    )

    expect(shown(resumed)).toEqual([FIRST, SECOND, 'Nu de verkoopkant'])
  })

  it('adds nothing when the notes are all the turn has said', () => {
    const loaded = reconcile(sentTurn(), rowsToItems(ROWS.slice(0, 5), 'rpc'))
    const resumed = applyResumeSnapshot(
      loaded,
      {
        inflight: { user: PROMPT, assistant: `${FIRST}\n\n${SECOND}`, streaming: false },
        running: true,
        turn_started_at: 1_790_000_000
      },
      LATER
    )

    expect(shown(resumed)).toEqual([FIRST, SECOND])
  })
})
