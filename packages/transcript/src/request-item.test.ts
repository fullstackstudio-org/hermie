/**
 * The `request` item: one kind for every interactive method (`input.form`,
 * `input.file`, `review.draft`), carrying THAT a question was asked and how it
 * ended, and never what was answered. See D6 in the request-types plan.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { snapshotForCache, stateFromCache } from './cache'
import { transcriptDiagnostics } from './diagnostics'
import { exportTranscript } from './export'
import { INTERACTIVE_METHODS } from './interactive-methods'
import { reconcile } from './reconcile'
import { answerRequest, applyEvent, applyResumeSnapshot, applyServerRequest, beginLocalTurn } from './reducer'
import { rowsToItems, type TranscriptRow } from './rows-to-items'
import { openRequests, visibleItems } from './selectors'
import { turnActivity } from './turn-activity'
import { inputFileRequest, inputFormRequest, reviewDraftRequest, SESSION } from './__fixtures__/events'
import { type ChatState, createChatState, type RequestItem, type TranscriptItem } from './types'

const NOW = 1_790_000_000_000
const IDS = { storedSessionId: 'stored-1', resolvedSessionId: 'resolved-1' }

const fresh = () => createChatState('researcher', IDS.storedSessionId, IDS.resolvedSessionId)
const list = (state: ChatState): TranscriptItem[] => state.order.map(id => state.items[id]!)
const requests = (state: ChatState) => list(state).filter((item): item is RequestItem => item.kind === 'request')
const cancel = (state: ChatState, id: string, reason: string, seq = 1) =>
  applyEvent(state, { type: 'request.cancel', session_id: SESSION, seq, payload: { id, method: 'x', reason } }, NOW)

const contractFile = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../contract/requests/${name}`, import.meta.url)), 'utf8'))

describe('INTERACTIVE_METHODS', () => {
  it('is the contract’s method list, so a method the gateway adds cannot be dropped silently', () => {
    const schema = contractFile('schema.json') as { methods: Record<string, unknown> }

    expect([...INTERACTIVE_METHODS].sort()).toEqual(Object.keys(schema.methods).sort())
  })

  it('knows approval and clarify as having items of their own', () => {
    expect(INTERACTIVE_METHODS).not.toContain('approval')
    expect(INTERACTIVE_METHODS).not.toContain('clarify')
  })

  it('makes an item of every frame the contract’s examples call valid', () => {
    const examples = contractFile('examples.json') as {
      methods: Record<string, { frames: { id: string; method: string; params: Record<string, unknown> }[] }>
    }

    for (const method of INTERACTIVE_METHODS) {
      for (const frame of examples.methods[method]!.frames) {
        const state = applyServerRequest(fresh(), frame, NOW)
        const [item] = requests(state)

        expect(requests(state)).toHaveLength(1)
        expect(item).toMatchObject({ requestId: frame.id, method, state: 'open', title: frame.params.title })
      }
    }
  })
})

describe('applyServerRequest for an interactive method', () => {
  it.each([inputFormRequest, inputFileRequest, reviewDraftRequest])('opens a request item for $method', request => {
    const state = applyServerRequest(fresh(), request, NOW)
    const [item] = requests(state)

    expect(item).toMatchObject({
      kind: 'request',
      requestId: request.id,
      method: request.method,
      title: request.params.title,
      summary: request.params.summary,
      optional: request.params.optional,
      state: 'open',
      ts: NOW / 1000
    })
    expect(state.byRequestId[request.id]).toBe(item!.id)
  })

  it('keeps the item free of the sheet’s params: no value field, no field definitions, no draft text', () => {
    const [form] = requests(applyServerRequest(fresh(), inputFormRequest, NOW))
    const [draft] = requests(applyServerRequest(fresh(), reviewDraftRequest, NOW))

    expect(Object.keys(form!).sort()).toEqual(
      [
        'id',
        'kind',
        'method',
        'optional',
        'origin',
        'requestId',
        'seq',
        'state',
        'summary',
        'title',
        'ts',
        'version'
      ].sort()
    )
    expect(JSON.stringify(draft)).not.toContain('Kind regards')
    expect(JSON.stringify(draft)).not.toContain('bram@example.com')
  })

  it('cuts a title and summary the contract would never send, instead of refusing them', () => {
    const state = applyServerRequest(
      fresh(),
      { ...inputFormRequest, params: { ...inputFormRequest.params, title: 't'.repeat(200), summary: 's'.repeat(900) } },
      NOW
    )

    expect(requests(state)[0]!.title).toHaveLength(80)
    expect(requests(state)[0]!.summary).toHaveLength(500)
  })

  it('treats a missing optional as false', () => {
    const { optional: _optional, ...rest } = reviewDraftRequest.params
    const state = applyServerRequest(fresh(), { ...reviewDraftRequest, params: rest }, NOW)

    expect(requests(state)[0]!.optional).toBe(false)
  })

  it('still ignores a method it has never heard of', () => {
    const state = fresh()

    expect(applyServerRequest(state, { id: 'srq-99', method: 'input.teleport', params: {} }, NOW)).toBe(state)
  })

  it('does not draw a second card for a replayed open request', () => {
    const once = applyServerRequest(fresh(), inputFormRequest, NOW)

    expect(applyServerRequest(once, { ...inputFormRequest, replayed: true }, NOW)).toBe(once)
    expect(requests(once)).toHaveLength(1)
  })

  it('does not duplicate across a resume that lists the same request under open_requests', () => {
    const once = applyServerRequest(fresh(), inputFormRequest, NOW)
    const resumed = applyResumeSnapshot(
      once,
      { running: true, open_requests: [inputFormRequest, inputFileRequest] },
      NOW
    )

    expect(requests(resumed).map(item => item.requestId)).toEqual(['srq-9', 'srq-10'])
  })

  it('rebuilds the open request a resume snapshot holds', () => {
    const resumed = applyResumeSnapshot(fresh(), { running: true, open_requests: [reviewDraftRequest] }, NOW)

    expect(requests(resumed)).toHaveLength(1)
    expect(requests(resumed)[0]).toMatchObject({ method: 'review.draft', state: 'open' })
  })

  it('lets a new question reuse an answered one’s id (the gateway restarts srq-N per process)', () => {
    const answered = answerRequest(applyServerRequest(fresh(), inputFormRequest, NOW), 'srq-9', {
      status: 'answered'
    })
    const again = applyServerRequest(answered, { ...inputFileRequest, id: 'srq-9' }, NOW)

    expect(requests(again)).toHaveLength(2)
    expect(requests(again).map(item => item.state)).toEqual(['answered', 'open'])
    expect(requestsById(again, 'srq-9').method).toBe('input.file')
  })
})

const requestsById = (state: ChatState, requestId: string): RequestItem =>
  state.items[state.byRequestId[requestId]!] as RequestItem

describe('answerRequest for an interactive request', () => {
  const open = () => applyServerRequest(fresh(), inputFormRequest, NOW)

  it.each([
    ['input.form answered', { status: 'answered' }],
    ['input.form skipped', { status: 'skipped' }],
    ['input.file sent (2)', { status: 'answered', count: 2 }],
    ['a location shared approximately', { status: 'answered', precision: 'approximate' }],
    ['review.draft approved, edited', { decision: 'approved', edited: true }],
    ['review.draft approved', { decision: 'approved', edited: false }],
    ['review.draft rejected', { decision: 'rejected' }]
  ] as const)('records %s as keys, never as text', (_name, summary) => {
    const state = answerRequest(open(), 'srq-9', summary)

    expect(requestsById(state, 'srq-9').state).toBe('answered')
    expect(requestsById(state, 'srq-9').answerSummary).toEqual(summary)
  })

  it('keeps only the whitelisted keys, so values handed in by mistake have nowhere to land', () => {
    const state = answerRequest(open(), 'srq-9', {
      status: 'answered',
      count: 1,
      values: { name: 'Ada Lovelace' },
      text: 'secret draft body',
      files: [{ path: '/home/ada/passport.jpg' }],
      precision: 'Utrecht, Oudegracht 12'
    } as never)
    const item = requestsById(state, 'srq-9')

    expect(item.answerSummary).toEqual({ status: 'answered', count: 1 })
    expect(JSON.stringify(state)).not.toMatch(/Ada Lovelace|secret draft body|passport|Oudegracht/)
  })

  it('drops numbers that are not counts and anything that is not the closed enum', () => {
    const state = answerRequest(open(), 'srq-9', { status: 'maybe', decision: 'approved', count: -1 } as never)

    expect(requestsById(state, 'srq-9').answerSummary).toEqual({ decision: 'approved' })

    const fractional = answerRequest(open(), 'srq-9', { status: 'answered', count: 1.5, edited: 'yes' } as never)

    expect(requestsById(fractional, 'srq-9').answerSummary).toEqual({ status: 'answered' })
  })

  it('records that it was answered, and nothing more, for an answer that is no summary', () => {
    for (const answer of ['Ada Lovelace', { name: 'Ada Lovelace' }, {}] as const) {
      const state = answerRequest(open(), 'srq-9', answer as never)
      const item = requestsById(state, 'srq-9')

      expect(item.state).toBe('answered')
      expect(item.answerSummary).toBeUndefined()
      expect(JSON.stringify(state)).not.toContain('Ada Lovelace')
    }
  })

  it('answers once: a second answer, or one after a withdrawal, changes nothing', () => {
    const answered = answerRequest(open(), 'srq-9', { status: 'skipped' })

    expect(answerRequest(answered, 'srq-9', { status: 'answered', count: 3 })).toBe(answered)

    const withdrawn = cancel(open(), 'srq-9', 'timeout')

    expect(answerRequest(withdrawn, 'srq-9', { status: 'answered' })).toBe(withdrawn)
    expect(requestsById(withdrawn, 'srq-9').answerSummary).toBeUndefined()
  })

  it('lets the answer that resolved it upgrade a request the gateway closed as resolved first', () => {
    const resolved = cancel(open(), 'srq-9', 'resolved')

    expect(requestsById(resolved, 'srq-9')).toMatchObject({ state: 'cancelled', cancelReason: 'resolved' })

    const answered = answerRequest(resolved, 'srq-9', { status: 'answered' })

    expect(requestsById(answered, 'srq-9')).toMatchObject({ state: 'answered', answerSummary: { status: 'answered' } })
    expect(requestsById(answered, 'srq-9').cancelReason).toBeUndefined()
    // And only once: the item is answered now.
    expect(answerRequest(answered, 'srq-9', { status: 'skipped' })).toBe(answered)
  })

  it('does not upgrade a request withdrawn for any other reason', () => {
    for (const reason of ['timeout', 'too_many_attempts', 'turn_ended', 'lapsed', 'cannot_show']) {
      const withdrawn = cancel(open(), 'srq-9', reason)

      expect(answerRequest(withdrawn, 'srq-9', { status: 'answered' })).toBe(withdrawn)
    }
  })

  it('does nothing for a request it does not hold', () => {
    const state = open()

    expect(answerRequest(state, 'srq-404', { status: 'answered' })).toBe(state)
  })

  it('leaves approval and clarify answering exactly as it was', () => {
    const state = applyServerRequest(
      fresh(),
      { id: 'srq-7', method: 'approval', params: { request_id: 'apr-3', command: 'ls' } },
      NOW
    )
    const answered = answerRequest(state, 'srq-7', { choice: 'once' })

    expect(list(answered)[0]).toMatchObject({ kind: 'approval', state: 'answered', answer: 'once' })
  })
})

describe('request.cancel for an interactive request', () => {
  it('marks it cancelled and keeps the reason', () => {
    const state = cancel(applyServerRequest(fresh(), reviewDraftRequest, NOW), 'srq-11', 'timeout')

    expect(requestsById(state, 'srq-11')).toMatchObject({ state: 'cancelled', cancelReason: 'timeout' })
  })

  it('keeps too_many_attempts as the reason it was withdrawn for', () => {
    const state = cancel(applyServerRequest(fresh(), inputFormRequest, NOW), 'srq-9', 'too_many_attempts')

    expect(requestsById(state, 'srq-9').cancelReason).toBe('too_many_attempts')
  })

  it('does not rewrite an answered request into a cancelled one', () => {
    const answered = answerRequest(applyServerRequest(fresh(), inputFileRequest, NOW), 'srq-10', {
      status: 'answered',
      count: 1
    })
    const after = cancel(answered, 'srq-10', 'timeout')

    expect(requestsById(after, 'srq-10')).toMatchObject({ state: 'answered', answerSummary: { count: 1 } })
    expect(requestsById(after, 'srq-10').cancelReason).toBeUndefined()
  })

  it('is cancelled with the others when the turn ends under it', () => {
    const open = applyServerRequest(fresh(), inputFormRequest, NOW)
    const ended = applyEvent(
      open,
      { type: 'message.complete', session_id: SESSION, seq: 2, payload: { text: 'done', status: 'complete' } },
      NOW
    )

    expect(requestsById(ended, 'srq-9')).toMatchObject({ state: 'cancelled', cancelReason: 'turn_ended' })
  })
})

describe('selectors', () => {
  const asked = () =>
    applyServerRequest(applyServerRequest(fresh(), inputFormRequest, NOW), reviewDraftRequest, NOW + 1000)

  it('lists open requests oldest first', () => {
    const state = asked()

    expect(openRequests(state).map(item => (item as RequestItem).requestId)).toEqual(['srq-9', 'srq-11'])
  })

  it('drops a request from the list once it is settled', () => {
    const state = cancel(answerRequest(asked(), 'srq-9', { status: 'skipped' }), 'srq-11', 'timeout')

    expect(openRequests(state)).toEqual([])
  })

  it.each(['quiet', 'normal', 'verbose'] as const)('shows it in full at %s, open or settled', level => {
    const state = answerRequest(asked(), 'srq-9', { status: 'answered' })
    const shown = visibleItems(state, { level, showBotToBot: false, showThinking: false }).filter(
      row => row.item.kind === 'request'
    )

    expect(shown.map(row => row.presentation)).toEqual(['full', 'full'])
  })
})

describe('turnActivity', () => {
  it('says the turn is waiting while an interactive request is open, even with no turn running', () => {
    const open = applyServerRequest(fresh(), inputFormRequest, NOW)

    expect(open.turn.active).toBe(false)
    expect(turnActivity(open)).toEqual({ kind: 'waiting' })
  })

  it('stops waiting once the request is answered or withdrawn', () => {
    const open = applyServerRequest(fresh(), inputFormRequest, NOW)

    expect(turnActivity(answerRequest(open, 'srq-9', { status: 'skipped' }))).toEqual({ kind: 'idle' })
    expect(turnActivity(cancel(open, 'srq-9', 'timeout'))).toEqual({ kind: 'idle' })
  })
})

describe('the transcript around a request', () => {
  const rows: TranscriptRow[] = [
    { role: 'user', row_id: 1, text: 'Book me a hotel', timestamp: 1_790_000_000 },
    { role: 'assistant', row_id: 2, text: 'I will ask for the details.', timestamp: 1_790_000_020 }
  ]
  const day2: TranscriptRow[] = [
    ...rows,
    { role: 'user', row_id: 3, text: 'And a train?', timestamp: 1_790_000_000 + 86_400 },
    { role: 'assistant', row_id: 4, text: 'Checking.', timestamp: 1_790_000_000 + 86_420 }
  ]
  const at = (state: ChatState, predicate: (item: TranscriptItem) => boolean) => list(state).findIndex(predicate)
  const isRequest = (item: TranscriptItem) => item.kind === 'request'
  const says = (text: string) => (item: TranscriptItem) =>
    (item.kind === 'user' || item.kind === 'assistant') && item.text === text

  const answeredYesterday = () =>
    answerRequest(
      applyServerRequest(reconcile(fresh(), rowsToItems(rows, 'rpc')), inputFormRequest, 1_790_000_030_000),
      'srq-9',
      { status: 'answered' }
    )

  it('keeps an open request at the tail through a re-hydration, because that is where it is being asked', () => {
    const asked = applyServerRequest(reconcile(fresh(), rowsToItems(rows, 'rpc')), inputFormRequest, 1_790_000_030_000)
    const state = reconcile(asked, rowsToItems(day2, 'rpc'))

    expect(list(state).at(-1)).toMatchObject({ kind: 'request', state: 'open' })
  })

  it('keeps a settled request in the place it was settled in, like a settled clarify', () => {
    const state = reconcile(answeredYesterday(), rowsToItems(day2, 'rpc'))

    expect(at(state, isRequest)).toBeGreaterThan(at(state, says('I will ask for the details.')))
    expect(at(state, isRequest)).toBeLessThan(at(state, says('And a train?')))

    const stamped = list(state)
      .map(item => item.ts)
      .filter((ts): ts is number => ts !== undefined)

    expect(stamped).toEqual([...stamped].sort((a, b) => a - b))
  })

  it('survives the cache once settled, answer summary included, and is not cached while open', () => {
    const settled = answeredYesterday()
    const painted = stateFromCache('researcher', IDS, snapshotForCache(settled, NOW))

    expect(requests(painted)[0]).toMatchObject({ state: 'answered', answerSummary: { status: 'answered' } })
    expect(painted.byRequestId['srq-9']).toBe(requests(painted)[0]!.id)

    const open = applyServerRequest(fresh(), inputFormRequest, NOW)

    expect(requests(stateFromCache('researcher', IDS, snapshotForCache(open, NOW)))).toEqual([])
  })

  it('is not a row history can supply, so a re-hydration neither drops it nor counts it as unpaired', () => {
    const state = reconcile(answeredYesterday(), rowsToItems(day2, 'rpc'))

    expect(requests(state)).toHaveLength(1)
    expect(transcriptDiagnostics(state).unpaired).toBe(0)
  })

  it('stays a one-line record in an export, with how it ended and no values', () => {
    const state = answerRequest(applyServerRequest(fresh(), reviewDraftRequest, NOW), 'srq-11', {
      decision: 'approved',
      edited: true
    })
    const exported = exportTranscript(list(state), { botName: 'Researcher', selfName: 'Me' })

    expect(exported.text).toContain('Request — Reply to Bram (approved, edited)')
    expect(exported.text).not.toContain('Kind regards')
  })

  it('does not trip the optimistic user turn that follows it', () => {
    const state = beginLocalTurn(answeredYesterday(), 'Anything else?', undefined, NOW)

    expect(list(state).at(-1)).toMatchObject({ kind: 'user', text: 'Anything else?' })
    expect(requests(state)).toHaveLength(1)
  })
})
