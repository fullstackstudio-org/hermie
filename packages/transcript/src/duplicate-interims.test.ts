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
import { type AssistantItem, type ChatState, createChatState, type ToolItem, type TranscriptItem } from './types'

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

/** What a chat opened again paints first: the transcript it cached, with the watermark it was taken at. */
const fromCache = (state: ChatState) =>
  stateFromCache(
    'boekhouder',
    { storedSessionId: 'stored-1', resolvedSessionId: 'resolved-1' },
    snapshotForCache({ ...state, lastSeqSessionId: 'runtime-1' }, NOW)
  )

/** Opened again from what `away` cached: history first, then every frame after the cached watermark. */
const reopen = (away: ChatState, rows: TranscriptRow[], replay: readonly TranscriptEvent[]) =>
  apply(reconcile(fromCache(away), rowsToItems(rows, 'rpc')), replay, LATER)

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
  /** Away right after the turn started: nothing of it is cached but the watermark. */
  const started = () => apply(sentTurn(), [{ type: 'message.start', seq: 1 }])

  it('settles a replayed note onto its row instead of beside it', () => {
    const replayed = reopen(started(), ROWS.slice(0, 4), round(2, FIRST, 'call_1'))

    expect(shown(replayed)).toEqual([FIRST, SECOND])
  })

  it('settles a note that arrives with no streamed words first', () => {
    const replayed = reopen(started(), ROWS.slice(0, 2), [
      { type: 'message.interim', seq: 2, payload: { text: FIRST, already_streamed: false } }
    ])

    expect(shown(replayed)).toEqual([FIRST])
  })

  it('carries the thought the replay rebuilt onto the row that had none', () => {
    const replayed = reopen(started(), ROWS.slice(0, 2), [
      { type: 'reasoning.delta', seq: 2, payload: { text: 'Check the ledger first.' } },
      ...round(3, FIRST, 'call_1')
    ])

    expect(assistants(replayed)).toHaveLength(1)
    expect(assistants(replayed)[0]).toMatchObject({ rowId: 2, reasoning: 'Check the ledger first.', seenLive: true })
  })

  it('leaves the row its own duration rather than one timed off the replay', () => {
    const replayed = reopen(apply(sentTurn(), []), ROWS, TURN)

    expect(assistants(replayed).at(-1)).toMatchObject({ rowId: 6, status: 'complete' })
    expect(assistants(replayed).at(-1)?.durationS).toBeUndefined()
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

/**
 * A tool call id is not unique in a transcript. The fork says so itself
 * (`conversation_compression_reply_anchor.py`): llama.cpp emits one constant id,
 * other providers reuse `call_0` every turn, and `deterministic_call_id` repeats
 * whenever the same call does. A card for one call must never stand in for
 * another call that happens to carry its id.
 */
describe('a tool call id used again', () => {
  const call = (seq: number, toolId: string, result: string): TranscriptEvent[] => [
    { type: 'tool.start', seq, payload: { tool_id: toolId, name: 'terminal', context: result } },
    { type: 'tool.complete', seq: seq + 1, payload: { tool_id: toolId, name: 'terminal', result } }
  ]
  const cards = (state: ChatState) =>
    list(state)
      .filter((item): item is ToolItem => item.kind === 'tool')
      .map(item => `${item.toolId}=${String(item.result)}`)

  /** Turn one calls `call_0`, and so does turn two. */
  function twoTurns(start: ChatState = fresh()): ChatState {
    const first = apply(confirmSubmit(beginLocalTurn(start, 'one', undefined, NOW), { status: 'streaming' }, NOW), [
      { type: 'message.start', seq: 1 },
      ...call(2, 'call_0', 'first'),
      { type: 'message.complete', seq: 4, payload: { text: 'One done.' } }
    ])

    return apply(confirmSubmit(beginLocalTurn(first, 'two', undefined, NOW), { status: 'streaming' }, NOW), [
      { type: 'message.start', seq: 5 },
      ...call(6, 'call_0', 'second'),
      { type: 'message.complete', seq: 8, payload: { text: 'Two done.' } }
    ])
  }

  it('gives a later turn its own card, and its result lands on that card', () => {
    expect(cards(twoTurns())).toEqual(['call_0=first', 'call_0=second'])
    expect(kinds(twoTurns())).toEqual(['user', 'tool:call_0', 'assistant', 'user', 'tool:call_0', 'assistant'])
  })

  it('does the same in a chat opened from its cache', () => {
    const reopened = reconcile(
      fromCache(fresh()),
      rowsToItems(
        [
          { role: 'user', row_id: 1, text: 'zero' },
          { role: 'assistant', row_id: 2, text: 'Zero.' }
        ],
        'rpc'
      )
    )

    expect(cards(twoTurns(reopened))).toEqual(['call_0=first', 'call_0=second'])
  })

  it('gives a second call with the same id in one turn a card of its own', () => {
    const state = apply(sentTurn('twice'), [
      { type: 'message.start', seq: 1 },
      ...call(2, 'call_0', 'first'),
      ...call(4, 'call_0', 'second')
    ])

    expect(cards(state)).toEqual(['call_0=first', 'call_0=second'])
  })

  it('pairs each card with its own row on a reload, turn by turn', () => {
    const live = twoTurns()
    const rows: TranscriptRow[] = [
      { role: 'user', row_id: 1, text: 'one' },
      { role: 'tool', name: 'terminal', tool_call_id: 'call_0' },
      { role: 'assistant', row_id: 3, text: 'One done.' },
      { role: 'user', row_id: 4, text: 'two' },
      { role: 'tool', name: 'terminal', tool_call_id: 'call_0' },
      { role: 'assistant', row_id: 6, text: 'Two done.' }
    ]
    const reloaded = reconcile(live, rowsToItems(rows, 'rpc'))

    expect(cards(reloaded)).toEqual(['call_0=first', 'call_0=second'])
    expect(list(reloaded).map(item => item.id)).toEqual(list(live).map(item => item.id))
  })

  it('pairs a tail row with the card of its own turn', () => {
    const live = twoTurns()
    const tailed = reconcileTail(
      live,
      rowsToItems(
        [
          { role: 'user', id: 4, content: 'two' },
          { role: 'tool', id: 5, name: 'terminal', tool_call_id: 'call_0' },
          { role: 'assistant', id: 6, content: 'Two done.' }
        ],
        'rest'
      )
    )

    expect(cards(tailed)).toEqual(['call_0=first', 'call_0=second'])
    expect(list(tailed).filter(item => item.kind === 'tool')).toHaveLength(2)
    expect(list(tailed).find(item => item.kind === 'tool' && item.rowId === 5)?.id).toBe(list(live)[4]?.id)
  })

  it('replays reused ids onto the cards history holds, one each, in order', () => {
    const rows: TranscriptRow[] = [
      { role: 'user', row_id: 1, text: PROMPT },
      { role: 'assistant', row_id: 2, text: FIRST },
      { role: 'tool', name: 'terminal', context: 'first', tool_call_id: 'call_0' },
      { role: 'tool', name: 'terminal', context: 'second', tool_call_id: 'call_0' },
      { role: 'assistant', row_id: 5, text: FINAL }
    ]
    const replayed = reopen(apply(sentTurn(), [{ type: 'message.start', seq: 1 }]), rows, [
      { type: 'message.delta', seq: 2, payload: { text: FIRST } },
      { type: 'message.interim', seq: 3, payload: { text: FIRST, already_streamed: true } },
      ...call(4, 'call_0', 'first'),
      ...call(6, 'call_0', 'second'),
      { type: 'message.complete', seq: 8, payload: { text: FINAL } }
    ])

    expect(cards(replayed)).toEqual(['call_0=first', 'call_0=second'])
    expect(shown(replayed)).toEqual([FIRST, FINAL])
  })
})

describe('a reply that says what the last note said', () => {
  const SAME = 'Ik controleer het nog één keer.'

  it('keeps its own bubble live, after a tail made the note a row', () => {
    const noted = apply(sentTurn(), [
      { type: 'message.start', seq: 1 },
      { type: 'message.delta', seq: 2, payload: { text: SAME } },
      { type: 'message.interim', seq: 3, payload: { text: SAME, already_streamed: true } }
    ])
    const tailed = reconcileTail(
      noted,
      rowsToItems(
        [
          { role: 'user', id: 1, content: PROMPT },
          { role: 'assistant', id: 2, content: SAME }
        ],
        'rest'
      )
    )
    const done = apply(tailed, [
      { type: 'message.delta', seq: 4, payload: { text: SAME } },
      { type: 'message.complete', seq: 5, payload: { text: SAME } }
    ])

    expect(shown(done)).toEqual([SAME, SAME])
  })

  it('keeps its own bubble in a chat opened from its cache', () => {
    const noted = reopen(
      apply(sentTurn(), [{ type: 'message.start', seq: 1 }]),
      [
        { role: 'user', row_id: 1, text: PROMPT },
        { role: 'assistant', row_id: 2, text: SAME }
      ],
      [
        { type: 'message.delta', seq: 2, payload: { text: SAME } },
        { type: 'message.interim', seq: 3, payload: { text: SAME, already_streamed: true } }
      ]
    )
    const done = apply(noted, [
      { type: 'message.delta', seq: 4, payload: { text: SAME } },
      { type: 'message.complete', seq: 5, payload: { text: SAME } }
    ])

    expect(shown(done)).toEqual([SAME, SAME])
    expect(assistants(done).map(item => item.rowId)).toEqual([2, undefined])
  })

  it('settles each onto its own row when both are history already', () => {
    const replayed = reopen(
      apply(sentTurn(), [{ type: 'message.start', seq: 1 }]),
      [
        { role: 'user', row_id: 1, text: PROMPT },
        { role: 'assistant', row_id: 2, text: SAME },
        { role: 'assistant', row_id: 3, text: SAME }
      ],
      [
        { type: 'message.delta', seq: 2, payload: { text: SAME } },
        { type: 'message.interim', seq: 3, payload: { text: SAME, already_streamed: true } },
        { type: 'message.delta', seq: 4, payload: { text: SAME } },
        { type: 'message.complete', seq: 5, payload: { text: SAME } }
      ]
    )

    expect(assistants(replayed).map(item => item.rowId)).toEqual([2, 3])
  })
})

describe('a replay that runs into the next turn', () => {
  const NEXT = 'en nu de verkoopkant'

  /**
   * The app went away after the first note. While it was away the turn finished
   * and another device sent the next prompt, whose turn writes a note with the
   * very same words as this turn's second one. History holds both turns; the
   * replay hands back the rest of this turn, the next `message.start`, and that
   * turn's frames.
   */
  function spanning(): ChatState {
    const rows: TranscriptRow[] = [
      ...ROWS,
      { role: 'user', row_id: 7, text: NEXT, timestamp: 1_790_000_006 },
      { role: 'assistant', row_id: 8, text: SECOND, timestamp: 1_790_000_007 },
      { role: 'tool', name: 'terminal', context: 'curl …', tool_call_id: 'call_2', timestamp: 1_790_000_008 },
      { role: 'assistant', row_id: 10, text: 'Klaar.', timestamp: 1_790_000_009 }
    ]

    return reopen(apply(sentTurn(), TURN.slice(0, 5)), rows, [
      ...TURN.slice(5),
      { type: 'message.start', seq: 12 },
      ...round(13, SECOND, 'call_2'),
      { type: 'message.delta', seq: 17, payload: { text: 'Klaar.' } },
      { type: 'message.complete', seq: 18, payload: { text: 'Klaar.' } }
    ])
  }

  it('settles every frame onto a row of its own turn', () => {
    const state = spanning()

    expect(shown(state)).toEqual([FIRST, SECOND, FINAL, SECOND, 'Klaar.'])
    expect(assistants(state).map(item => item.rowId)).toEqual([2, 4, 6, 8, 10])
    expect(tools(state)).toHaveLength(3)
  })

  it('stands no placeholder in for a prompt history already holds', () => {
    const users = list(spanning()).filter(item => item.kind === 'user')

    expect(users.map(item => (item.kind === 'user' ? item.text : ''))).toEqual([PROMPT, NEXT])
  })
})

describe('a turn /retry starts', () => {
  it('puts its note under its own placeholder, not into the turn it repeats', () => {
    const done = reopen(apply(sentTurn(), [{ type: 'message.start', seq: 1 }]), ROWS, TURN.slice(1))
    // `/retry` runs the turn again with no local submit: a foreign start.
    const retried = apply(done, [
      { type: 'message.start', seq: 20 },
      { type: 'message.delta', seq: 21, payload: { text: FIRST } },
      { type: 'message.interim', seq: 22, payload: { text: FIRST, already_streamed: true } }
    ])

    expect(shown(retried)).toEqual([FIRST, SECOND, FINAL, FIRST])
    expect(list(retried).filter(item => item.kind === 'user' && item.unknownAuthor)).toHaveLength(1)
    expect(assistants(retried).at(-1)?.interim).toBe(true)
    expect(assistants(retried).at(-1)?.rowId).toBeUndefined()
  })
})

describe('a second note with the same words, after the first was settled', () => {
  const CHECKING = 'Checking.'

  /** The first note's row came with history and the replay settled onto it. */
  function settled(): ChatState {
    return reopen(
      apply(sentTurn('check both'), [{ type: 'message.start', seq: 1 }]),
      [
        { role: 'user', row_id: 1, text: 'check both' },
        { role: 'assistant', row_id: 2, text: CHECKING },
        { role: 'tool', name: 'terminal', tool_call_id: 'call_a' }
      ],
      [
        { type: 'message.delta', seq: 2, payload: { text: CHECKING } },
        { type: 'message.interim', seq: 3, payload: { text: CHECKING, already_streamed: true } },
        { type: 'tool.start', seq: 4, payload: { tool_id: 'call_a', name: 'terminal' } },
        { type: 'tool.complete', seq: 5, payload: { tool_id: 'call_a', name: 'terminal' } },
        // The second, sealed by its call; the gateway sends no interim for words it delivered.
        { type: 'message.delta', seq: 6, payload: { text: CHECKING } },
        { type: 'tool.start', seq: 7, payload: { tool_id: 'call_b', name: 'terminal' } }
      ]
    )
  }

  it('marks the settled row as described', () => {
    expect(assistants(settled())[0]).toMatchObject({ id: 'r:2', seenLive: true })
  })

  it('is not folded into the settled row by a tail that has not reached its own', () => {
    const tailed = reconcileTail(settled(), rowsToItems([{ role: 'assistant', id: 2, content: CHECKING }], 'rest'))

    expect(shown(tailed)).toEqual([CHECKING, CHECKING])
  })

  it('is not folded into it by a reload that has not reached its own either', () => {
    const reloaded = reconcile(
      settled(),
      rowsToItems(
        [
          { role: 'user', row_id: 1, text: 'check both' },
          { role: 'assistant', row_id: 2, text: CHECKING },
          { role: 'tool', name: 'terminal', tool_call_id: 'call_a' }
        ],
        'rpc'
      )
    )

    expect(shown(reloaded)).toEqual([CHECKING, CHECKING])
  })
})
