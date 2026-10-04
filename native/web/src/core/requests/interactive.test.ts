/**
 * The interactive model on its own: when a request arrives and where it goes, how an
 * answer, a Skip and a refusal come out, what ends a request and what the chat says when
 * it does, what is declined and with which reason, what a reconnect makes of a request and
 * what the engine is told; and the one rule above the others: what a person typed reaches
 * the `request.answer` call and nothing else the page keeps.
 *
 * The groups mirror `secure-input.test.ts`: arrival, routing, answering, ending, restored from
 * `open_requests`, a reconnect, an answer and a withdrawal that cross, declined, stopping.
 */
import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'

import { createInteractiveStore, type InteractiveState } from '../../state/interactive'
import { createChatsStore } from '../../state/chats'
import { bindRequests, createRequestsStore } from '../../state/requests'
import { chatWith } from '../../test-support/chat-fixtures'
import {
  type FakeInteractiveGateway,
  fakeInteractiveGateway,
  recordingEngine
} from '../../test-support/interactive-gateway'
import { manualTimers, type ManualTimers } from '../../test-support/secure-input-gateway'
import type { ReplaySignal } from '../chat-controller'
import {
  ADVERTISE_INTERACTIVE_REQUESTS,
  CANNOT_SHOW_CODE,
  InteractiveModel,
  interactiveAdvert,
  REFUSED_CODE,
  showableMethods
} from './interactive'
import type { DraftAnswer, FileAnswer, FormAnswer } from './interactive-types'

/** A value nobody would type by accident: if it shows up anywhere but the call, it leaked. */
const SECRET = 'hunter2-\u00E9-ZQ7xK-do-not-keep'

/** The fake clock starts here (`manualTimers`), in seconds. */
const NOW_SECONDS = 1_000

let gw: FakeInteractiveGateway
let timers: ManualTimers
let store: StoreApi<InteractiveState>
let model: InteractiveModel
let engine: ReturnType<typeof recordingEngine>
/** Which chat holds which runtime session. */
let sessions: Record<string, string>
let chatListeners: Set<() => void>

function moveSessions(next: Record<string, string>): void {
  sessions = next

  for (const listener of chatListeners) {
    listener()
  }
}

function makeModel(status: 'ready' | 'connecting' = 'ready'): void {
  gw = fakeInteractiveGateway(status)
  engine = recordingEngine()
  model = new InteractiveModel({
    gateway: gw.gateway,
    store,
    chatFor: id => sessions[id],
    watchChats: listener => {
      chatListeners.add(listener)

      return () => chatListeners.delete(listener)
    },
    engine: engine.engine,
    failWithData: gw.failWithData,
    gatewayName: 'gw.example.test',
    now: () => timers.now(),
    timers
  })
  model.start()
}

/** The envelope every request carries; `seconds` is how long it has to live from the fake clock's now. */
const envelope = (seconds = 300): Record<string, unknown> => ({
  session_id: 'rt-1',
  v: 1,
  title: 'Hotel booking details',
  summary: 'Fill this in and I will book the best match.',
  expires_at: NOW_SECONDS + seconds,
  optional: true,
  acting_user: { id: 'oidc:1', name: 'Ada' }
})

const formParams = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...envelope(),
  fields: [
    { id: 'name', kind: 'text', label: 'Name on the booking', required: true, max_length: 20 },
    { id: 'guests', kind: 'number', label: 'Guests', min: 1, max: 12, integer: true, default: 2 }
  ],
  ...extra
})

const fileParams = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...envelope(),
  title: 'Receipt',
  summary: 'Take a photo of the receipt.',
  accept: 'image',
  capture: 'photo',
  multiple: true,
  upload: {
    dir: '/home/ada/work/uploads/hermie/2026-10-04',
    max_bytes: 10_485_760,
    max_total_bytes: 20_971_520,
    max_files: 3,
    strip_metadata: true
  },
  ...extra
})

const DRAFT_TEXT = 'Hi Bram,\n\nThe flat is free from 1 November.\n\nKind regards,\nAda'

const draftParams = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...envelope(),
  optional: false,
  title: 'Reply to Bram',
  summary: 'Approve, edit or reject it.',
  kind: 'mail',
  text: DRAFT_TEXT,
  subject: 'Re: Flat',
  recipients: ['Bram <bram@example.com>'],
  editable: true,
  ...extra
})

const requests = () => store.getState().requests
const notice = (bot: string) => store.getState().notices[bot]?.notice
const answerCalls = () => gw.calls.filter(call => call.method === 'request.answer')

const FORM_ANSWER: FormAnswer = { status: 'answered', values: { name: SECRET, guests: 2 } }
const FILE_ANSWER: FileAnswer = {
  status: 'answered',
  files: [
    {
      path: '/home/ada/work/uploads/hermie/2026-10-04/3f9c2a7b1d4e8f60-receipt.jpg',
      name: 'receipt.jpg',
      mime: 'image/jpeg',
      bytes: 10,
      sha256: 'a'.repeat(64)
    },
    {
      path: '/home/ada/work/uploads/hermie/2026-10-04/3f9c2a7b1d4e8f61-b.jpg',
      name: 'b.jpg',
      mime: 'image/jpeg',
      bytes: 11,
      sha256: 'b'.repeat(64)
    }
  ]
}

beforeEach(() => {
  timers = manualTimers()
  store = createInteractiveStore()
  sessions = { 'rt-1': 'researcher', 'rt-2': 'writer' }
  chatListeners = new Set()
  makeModel()
})

afterEach(() => {
  model.stop()
})

describe('arrival', () => {
  it.each([
    ['input.form', formParams()],
    ['input.file', fileParams()],
    ['review.draft', draftParams()]
  ])('opens %s on the chat that holds its session', (method, params) => {
    expect(gw.deliver('srq-1', method, params)).toBe(true)
    expect(requests()).toEqual([
      expect.objectContaining({
        id: 'srq-1',
        method,
        bot: 'researcher',
        sessionId: 'rt-1',
        version: 1,
        deadline: (NOW_SECONDS + 300) * 1000,
        earlierLost: null,
        refusal: null
      })
    ])
    expect(requests()[0]?.ask.method).toBe(method)
    expect(gw.replies).toEqual([])
    expect(gw.calls).toEqual([])
  })

  it('names the gateway for the sheet', () => {
    expect(store.getState().gateway).toBe('gw.example.test')
  })

  it('leaves every other method to the next handler', () => {
    for (const method of [
      'clarify',
      'approval',
      'confirm',
      'secret',
      'sudo',
      'vault.code',
      'input.signature',
      'device.scan'
    ]) {
      expect(gw.deliver(`srq-${method}`, method, { session_id: 'rt-1' })).toBe(false)
    }

    expect(gw.replies).toEqual([])
    expect(requests()).toEqual([])
  })

  it('keeps what it asks cleaned: every text the sheet draws', () => {
    gw.deliver('srq-1', 'input.form', formParams({ title: `Pay\u202E now\u0000${'x'.repeat(200)}` }))

    const ask = requests()[0]?.ask

    expect(ask?.title).not.toMatch(/\u202E/u)
    expect(ask?.title).not.toContain('\u0000')
    expect(ask?.title.endsWith('…')).toBe(true)
  })

  it('keeps a copy of one already open as one, and answers on the newest copy', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.deliver('srq-1', 'input.form', formParams(), true)

    expect(requests()).toHaveLength(1)
    expect(requests()[0]?.version).toBe(1)
  })

  it('tells the engine the question was asked, with the three words it keeps and nothing else', () => {
    gw.deliver('srq-1', 'review.draft', draftParams(), true)

    expect(engine.calls).toEqual([
      {
        call: 'asked',
        bot: 'researcher',
        id: 'srq-1',
        method: 'review.draft',
        title: 'Reply to Bram',
        summary: 'Approve, edit or reject it.',
        optional: false,
        replayed: true
      }
    ])
    expect(JSON.stringify(engine.calls)).not.toContain('Kind regards')
  })

  it('shows one that is already past its time on this clock to nobody', () => {
    gw.deliver('srq-1', 'input.form', formParams({ expires_at: NOW_SECONDS }))

    expect(requests()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'expired' })
    // Never asked of the engine; its end is said all the same, for an item a resume's snapshot may have put there.
    expect(engine.calls).toEqual([{ call: 'ended', bot: 'researcher', id: 'srq-1', reason: 'timeout' }])
    expect(gw.replies).toEqual([])
    gw.deliver('srq-1', 'input.form', formParams({ expires_at: NOW_SECONDS + 300 }), true)
    expect(requests()).toEqual([])
  })
})

describe('answering', () => {
  it('answers through request.answer with the result as given, and the gateway taking it closes the request', async () => {
    gw.deliver('srq-1', 'input.form', formParams())

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'sent' })
    expect(answerCalls()).toEqual([{ method: 'request.answer', params: { id: 'srq-1', result: FORM_ANSWER } }])
    expect(requests()).toEqual([])
    expect(timers.pending()).toBe(0)
    // And no reply on the frame itself: the answer went through the call.
    expect(gw.replies).toEqual([])
  })

  it('answers once: a second press finds it closed', async () => {
    gw.deliver('srq-1', 'input.form', formParams())

    await model.answer('srq-1', FORM_ANSWER)

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'closed' })
    await expect(model.skip('srq-1')).resolves.toEqual({ kind: 'closed' })
    expect(answerCalls()).toHaveLength(1)
  })

  it('skips with {status: skipped}, for a request that is optional', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.deliver('srq-2', 'input.file', fileParams())

    await expect(model.skip('srq-1')).resolves.toEqual({ kind: 'sent' })
    await expect(model.skip('srq-2')).resolves.toEqual({ kind: 'sent' })
    expect(answerCalls().map(call => call.params)).toEqual([
      { id: 'srq-1', result: { status: 'skipped' } },
      { id: 'srq-2', result: { status: 'skipped' } }
    ])
  })

  it('does not skip what is not optional, and never a review (there is no skip: the person rejects)', async () => {
    gw.deliver('srq-1', 'input.form', formParams({ optional: false }))
    gw.deliver('srq-2', 'review.draft', draftParams({ optional: true }))

    await expect(model.skip('srq-1')).resolves.toEqual({ kind: 'not_optional' })
    await expect(model.skip('srq-2')).resolves.toEqual({ kind: 'not_optional' })
    expect(gw.calls).toEqual([])
    expect(requests()).toHaveLength(2)
  })

  it('answers a draft with the decision', async () => {
    gw.deliver('srq-1', 'review.draft', draftParams())

    const reject: DraftAnswer = { decision: 'rejected', comment: 'Too long' }

    await expect(model.answer('srq-1', reject)).resolves.toEqual({ kind: 'sent' })
    expect(answerCalls()[0]?.params).toEqual({ id: 'srq-1', result: reject })
  })

  it('sends nothing while the connection is not ready, and keeps the request open', async () => {
    gw.status('connecting')
    gw.deliver('srq-1', 'input.form', formParams())

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'offline' })
    await expect(model.skip('srq-1')).resolves.toEqual({ kind: 'offline' })
    expect(gw.calls).toEqual([])
    expect(requests()).toHaveLength(1)

    gw.status('ready')

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'sent' })
  })

  it('takes a second answer for one still on its way as busy', async () => {
    let release: (value: unknown) => void = () => undefined

    gw.onCall.handler = () => new Promise(resolve => (release = resolve))
    gw.deliver('srq-1', 'input.form', formParams())

    const first = model.answer('srq-1', FORM_ANSWER)

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'busy' })
    release({ status: 'ok' })
    await expect(first).resolves.toEqual({ kind: 'sent' })
    expect(answerCalls()).toHaveLength(1)
  })

  describe('a refused answer (4034)', () => {
    const refuse = (reason: unknown): void => {
      gw.onCall.handler = () => {
        throw new JsonRpcGatewayError('refused', { code: REFUSED_CODE, data: { reason } })
      }
    }

    it('leaves the request open and says why, for the sheet to show next to the input', async () => {
      gw.deliver('srq-1', 'input.form', formParams())
      refuse('field:name:too_long')

      await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({
        kind: 'refused',
        reason: 'field:name:too_long'
      })
      expect(requests()).toHaveLength(1)
      expect(requests()[0]).toMatchObject({ refusal: 'field:name:too_long', version: 2 })
      // The request is still there to be corrected and answered.
      gw.onCall.handler = () => ({ status: 'ok' })

      await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'sent' })
    })

    it('cleans the reason: it is the gateway’s text, shown in the page', async () => {
      gw.deliver('srq-1', 'input.form', formParams())
      refuse('field:name:\u202Eformat')

      await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({
        kind: 'refused',
        reason: 'field:name:format'
      })
    })

    it('says "refused" when the gateway gave no reason', async () => {
      gw.deliver('srq-1', 'input.form', formParams())
      refuse(undefined)

      await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'refused', reason: 'refused' })
    })

    it('ends the request at the tenth refusal, which says too_many_attempts instead of the problem', async () => {
      gw.deliver('srq-1', 'input.form', formParams())
      refuse('too_many_attempts')

      await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'ended' })
      expect(requests()).toEqual([])
      expect(notice('researcher')).toEqual({ kind: 'withdrawn' })
      expect(engine.calls.at(-1)).toEqual({
        call: 'ended',
        bot: 'researcher',
        id: 'srq-1',
        reason: 'too_many_attempts'
      })
    })
  })

  it('leaves the request open when the call did not get through, for another try', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.onCall.handler = () => {
      throw new Error('socket closed')
    }

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'failed', message: 'socket closed' })
    expect(requests()).toHaveLength(1)

    gw.onCall.handler = () => ({ status: 'ok' })

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'sent' })
  })

  it('leaves it open for any other word from the gateway too (it is not a verdict on the answer)', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.onCall.handler = () => {
      throw new JsonRpcGatewayError('not yours', { code: 4033 })
    }

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'failed', message: 'not yours' })
    expect(requests()).toHaveLength(1)
  })

  it('ends it when the gateway says the request already ended, without claiming it expired', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.onCall.handler = () => ({ status: 'expired' })

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'ended' })
    expect(requests()).toEqual([])
    // `expired` is the gateway's word for every ending: before the deadline it was not the deadline.
    expect(notice('researcher')).toEqual({ kind: 'withdrawn' })
    expect(engine.calls.at(-1)).toEqual({ call: 'ended', bot: 'researcher', id: 'srq-1', reason: 'withdrawn' })

    // The gateway's cancel, when it comes after the reply, says why.
    gw.cancel('srq-1', 'resolved')
    expect(notice('researcher')).toEqual({ kind: 'answered_elsewhere' })
  })

  describe('an answer on its way is not overruled', () => {
    let release: (value: unknown) => void
    let reject: (error: unknown) => void

    beforeEach(() => {
      release = () => undefined
      reject = () => undefined
      gw.onCall.handler = () =>
        new Promise((resolve, fail) => {
          release = resolve
          reject = fail
        })
      gw.deliver('srq-1', 'input.form', formParams())
      engine.calls.length = 0
    })

    it('by the resolved cancel the gateway sends once this very answer settled it', async () => {
      const pending = model.answer('srq-1', FORM_ANSWER)

      gw.cancel('srq-1', 'resolved')
      // Still open while the call is out: the cancel waits for its result.
      expect(requests()).toHaveLength(1)
      release({ status: 'ok' })

      await expect(pending).resolves.toEqual({ kind: 'sent' })
      expect(requests()).toEqual([])
      expect(store.getState().notices).toEqual({})
      expect(engine.calls).toEqual([
        { call: 'answered', bot: 'researcher', id: 'srq-1', summary: { status: 'answered' } }
      ])
    })

    it('by the local deadline: an answer the gateway took is answered, one it did not ends then', async () => {
      const pending = model.answer('srq-1', FORM_ANSWER)

      timers.advance(301_000)
      expect(requests()).toHaveLength(1)
      release({ status: 'ok' })
      await expect(pending).resolves.toEqual({ kind: 'sent' })
      expect(store.getState().notices).toEqual({})

      gw.deliver('srq-2', 'input.form', { ...formParams(), expires_at: Math.floor(timers.now() / 1000) + 300 })

      const late = model.answer('srq-2', FORM_ANSWER)

      timers.advance(301_000)
      reject(new Error('socket closed'))
      await expect(late).resolves.toEqual({ kind: 'ended' })
      expect(notice('researcher')).toEqual({ kind: 'expired' })
    })

    it('lets a cancel that came while the call was out end it once the gateway says it did not take the answer', async () => {
      const pending = model.answer('srq-1', FORM_ANSWER)

      gw.cancel('srq-1', 'resolved')
      release({ status: 'expired' })

      await expect(pending).resolves.toEqual({ kind: 'ended' })
      expect(requests()).toEqual([])
      // Somebody else's answer settled it.
      expect(notice('researcher')).toEqual({ kind: 'answered_elsewhere' })

      gw.deliver('srq-2', 'input.form', formParams())

      const timedOut = model.answer('srq-2', FORM_ANSWER)

      gw.cancel('srq-2', 'timeout')
      release({ status: 'expired' })
      await expect(timedOut).resolves.toEqual({ kind: 'ended' })
      expect(notice('researcher')).toEqual({ kind: 'expired' })
    })

    it('ends it as may-not-have-arrived when a resolved cancel crossed a call that failed without a word', async () => {
      const pending = model.answer('srq-1', FORM_ANSWER)

      gw.cancel('srq-1', 'resolved')
      reject(new Error('socket closed'))

      await expect(pending).resolves.toEqual({ kind: 'ended' })
      expect(notice('researcher')).toEqual({ kind: 'may_not_have_arrived' })
    })

    it('lets a cancel that came with a refusal end it', async () => {
      const pending = model.answer('srq-1', FORM_ANSWER)

      gw.cancel('srq-1', 'timeout')
      reject(new JsonRpcGatewayError('answer refused', { code: REFUSED_CODE, data: { reason: 'field:name:required' } }))

      await expect(pending).resolves.toEqual({ kind: 'ended' })
      expect(requests()).toEqual([])
      expect(notice('researcher')).toEqual({ kind: 'expired' })
    })
  })

  describe('after a call that failed without the gateway’s word', () => {
    beforeEach(async () => {
      gw.deliver('srq-1', 'input.form', formParams())
      gw.onCall.handler = () => {
        throw new Error('socket closed')
      }
      await model.answer('srq-1', FORM_ANSWER)
    })

    it('a later "no longer waiting" says the answer may not have arrived', async () => {
      gw.onCall.handler = () => ({ status: 'expired' })

      await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'ended' })
      expect(notice('researcher')).toEqual({ kind: 'may_not_have_arrived' })
    })

    it('so does a reconnect that no longer lists it', () => {
      timers.advance(1)
      model.reconcile('rt-1', [], timers.now())

      expect(requests()).toEqual([])
      expect(notice('researcher')).toEqual({ kind: 'may_not_have_arrived' })
    })

    it('and a resolved cancel: that answer may be what settled it', () => {
      gw.cancel('srq-1', 'resolved')

      expect(notice('researcher')).toEqual({ kind: 'may_not_have_arrived' })
    })

    it('a refusal of the next answer shows the earlier one did not end it', async () => {
      gw.onCall.handler = () => {
        throw new JsonRpcGatewayError('answer refused', { code: REFUSED_CODE, data: { reason: 'field:name:required' } })
      }

      await model.answer('srq-1', FORM_ANSWER)
      gw.onCall.handler = () => ({ status: 'expired' })
      await model.answer('srq-1', FORM_ANSWER)

      expect(notice('researcher')).toEqual({ kind: 'withdrawn' })
    })
  })

  it('tells the engine how it ended: keys and numbers, never a value', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.deliver('srq-2', 'input.file', fileParams())
    gw.deliver('srq-3', 'review.draft', draftParams())
    gw.deliver('srq-4', 'review.draft', draftParams())
    gw.deliver('srq-5', 'review.draft', draftParams())
    gw.deliver('srq-6', 'input.file', fileParams())
    engine.calls.length = 0

    await model.answer('srq-1', FORM_ANSWER)
    await model.answer('srq-2', FILE_ANSWER)
    await model.answer('srq-3', { decision: 'approved', text: DRAFT_TEXT })
    // Trailing blanks do not count as an edit (the gateway removes them too).
    await model.answer('srq-4', { decision: 'approved', text: `${DRAFT_TEXT.replace('\n\n', '  \n\n')}  ` })
    await model.answer('srq-5', { decision: 'approved', text: `${DRAFT_TEXT} P.S. SECRET-EDIT` })
    await model.skip('srq-6')

    expect(engine.calls).toEqual([
      { call: 'answered', bot: 'researcher', id: 'srq-1', summary: { status: 'answered' } },
      { call: 'answered', bot: 'researcher', id: 'srq-2', summary: { status: 'answered', count: 2 } },
      { call: 'answered', bot: 'researcher', id: 'srq-3', summary: { decision: 'approved', edited: false } },
      { call: 'answered', bot: 'researcher', id: 'srq-4', summary: { decision: 'approved', edited: false } },
      { call: 'answered', bot: 'researcher', id: 'srq-5', summary: { decision: 'approved', edited: true } },
      { call: 'answered', bot: 'researcher', id: 'srq-6', summary: { status: 'skipped' } }
    ])
    expect(JSON.stringify(engine.calls)).not.toContain('SECRET')
    expect(JSON.stringify(engine.calls)).not.toContain('ZQ7xK')
  })

  it('tells the engine a rejection, and nothing of the comment', async () => {
    gw.deliver('srq-1', 'review.draft', draftParams())
    engine.calls.length = 0

    await model.answer('srq-1', { decision: 'rejected', comment: 'SECRET-COMMENT' })

    expect(engine.calls).toEqual([
      { call: 'answered', bot: 'researcher', id: 'srq-1', summary: { decision: 'rejected' } }
    ])
  })

  it('tells the engine nothing for an answer the gateway did not take', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    engine.calls.length = 0
    gw.onCall.handler = () => {
      throw new JsonRpcGatewayError('refused', { code: REFUSED_CODE, data: { reason: 'field:name:missing' } })
    }

    await model.answer('srq-1', FORM_ANSWER)

    expect(engine.calls).toEqual([])
  })
})

describe('declined', () => {
  it('cannotShow answers 4041 cannot_show with its reason, closes the request and leaves one notice', () => {
    gw.deliver('srq-1', 'input.file', fileParams())

    expect(model.cannotShow('srq-1', 'no_camera')).toBe('sent')
    expect(gw.declined).toEqual([{ id: 'srq-1', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'no_camera' }])
    expect(gw.replies).toEqual([{ id: 'srq-1', error: { code: CANNOT_SHOW_CODE, message: 'cannot_show' } }])
    expect(requests()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'cannot_show', method: 'input.file', reason: 'no_camera' })
    expect(engine.calls.at(-1)).toEqual({ call: 'ended', bot: 'researcher', id: 'srq-1', reason: 'cannot_show' })
    expect(model.cannotShow('srq-1', 'no_camera')).toBe('closed')
    expect(gw.replies).toHaveLength(1)
  })

  it('does not decline while an answer is on its way: its result decides first', async () => {
    let release: (value: unknown) => void = () => undefined

    gw.onCall.handler = () => new Promise(resolve => (release = resolve))
    gw.deliver('srq-1', 'input.form', formParams())

    const pending = model.answer('srq-1', FORM_ANSWER)

    expect(model.cannotShow('srq-1', 'no_camera')).toBe('busy')
    expect(gw.declined).toEqual([])
    release({ status: 'ok' })
    await expect(pending).resolves.toEqual({ kind: 'sent' })
  })

  it('sends only a machine reason: anything else is not_supported_on_device', () => {
    gw.deliver('srq-1', 'input.file', fileParams())
    gw.deliver('srq-2', 'input.file', fileParams())

    model.cannotShow('srq-1', 'No camera, sorry!')
    model.cannotShow('srq-2', 'upload_failed')

    expect(gw.declined.map(entry => entry.reason)).toEqual(['not_supported_on_device', 'upload_failed'])
  })

  it('sends nothing while the connection is not ready, and keeps the request open', () => {
    gw.status('connecting')
    gw.deliver('srq-1', 'input.file', fileParams())

    expect(model.cannotShow('srq-1', 'no_camera')).toBe('offline')
    expect(gw.replies).toEqual([])
    expect(requests()).toHaveLength(1)
  })

  it('answers every copy of a request it declined, and never opens it', () => {
    gw.deliver('srq-1', 'input.file', fileParams())
    model.cannotShow('srq-1', 'permission_denied')
    model.dismissNotice('researcher')
    gw.deliver('srq-1', 'input.file', fileParams(), true)

    expect(gw.declined.map(entry => entry.reason)).toEqual(['permission_denied', 'permission_denied'])
    expect(requests()).toEqual([])
    // One notice per request, however often it is re-delivered.
    expect(notice('researcher')).toBeUndefined()
  })

  it('declines a version it does not know, a frame that is not the contract’s, and a frame with no session', () => {
    gw.deliver('srq-1', 'input.form', formParams({ v: 2 }))
    gw.deliver('srq-2', 'input.form', formParams({ fields: [] }))
    gw.deliver('srq-3', 'input.form', { ...formParams(), session_id: undefined })
    gw.deliver('srq-4', 'review.draft', draftParams({ text: '' }))

    expect(gw.declined).toEqual([
      { id: 'srq-1', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'unsupported_version' },
      { id: 'srq-2', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'not_supported_on_device' },
      { id: 'srq-3', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'no_session' },
      { id: 'srq-4', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'not_supported_on_device' }
    ])
    expect(requests()).toEqual([])
    // A notice for each of those a chat holds the session of.
    expect(notice('researcher')).toEqual({
      kind: 'cannot_show',
      method: 'review.draft',
      reason: 'not_supported_on_device'
    })
    // The engine's item (a resume's snapshot may have put one there) ends for each a chat holds the session of.
    expect(engine.calls.map(call => [call.call, call.id])).toEqual([
      ['ended', 'srq-1'],
      ['ended', 'srq-2'],
      ['ended', 'srq-4']
    ])
  })

  it('declines a form with a field kind it does not know, whole, and says so (README §7)', () => {
    gw.deliver(
      'srq-1',
      'input.form',
      formParams({
        fields: [
          { id: 'name', kind: 'text', label: 'Name' },
          { id: 'sig', kind: 'signature', label: 'Sign' }
        ]
      })
    )

    expect(gw.declined).toEqual([
      { id: 'srq-1', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'not_supported_on_device' }
    ])
    expect(requests()).toEqual([])
    expect(notice('researcher')).toEqual({
      kind: 'cannot_show',
      method: 'input.form',
      reason: 'not_supported_on_device'
    })
  })

  it('without failWithData the error still goes out, without its data', () => {
    model.stop()
    gw = fakeInteractiveGateway()
    model = new InteractiveModel({
      gateway: gw.gateway,
      store,
      chatFor: id => sessions[id],
      now: () => timers.now(),
      timers
    })
    model.start()
    gw.deliver('srq-1', 'input.form', formParams({ v: 2 }))

    expect(gw.replies).toEqual([{ id: 'srq-1', error: { code: CANNOT_SHOW_CODE, message: 'cannot_show' } }])
  })
})

describe('deadlines are the request’s own', () => {
  it('counts down to expires_at, from the request, not from its arrival', () => {
    timers.advance(50_000)
    gw.deliver('srq-1', 'input.form', formParams({ expires_at: NOW_SECONDS + 120 }))
    gw.deliver('srq-2', 'input.form', formParams({ expires_at: NOW_SECONDS + 120 }), true)

    expect(requests()[0]?.deadline).toBe((NOW_SECONDS + 120) * 1000)
  })

  it('closes at the deadline with an "expired" notice, ends the engine’s item, and sends nothing', () => {
    gw.deliver('srq-1', 'input.form', formParams({ expires_at: NOW_SECONDS + 60 }))
    timers.advance(59_999)

    expect(requests()).toHaveLength(1)

    timers.advance(1)

    expect(requests()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'expired' })
    expect(gw.replies).toEqual([])
    expect(gw.calls).toEqual([])
    expect(engine.calls.at(-1)).toEqual({ call: 'ended', bot: 'researcher', id: 'srq-1', reason: 'timeout' })
  })

  it('refuses an answer pressed after the deadline even before the timer fires', async () => {
    let now = timers.now()

    model.stop()
    gw = fakeInteractiveGateway()
    engine = recordingEngine()
    model = new InteractiveModel({
      gateway: gw.gateway,
      store,
      chatFor: id => sessions[id],
      engine: engine.engine,
      now: () => now,
      // Timers that never fire: only the clock moves.
      timers: { setTimeout: () => 0, clearTimeout: () => undefined }
    })
    model.start()
    gw.deliver('srq-1', 'input.form', formParams({ expires_at: NOW_SECONDS + 60 }))
    now += 60_000

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'closed' })
    expect(gw.calls).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'expired' })
  })

  it('waits for a deadline further off than one timer can count, in steps', () => {
    const farSeconds = NOW_SECONDS + 60 * 24 * 3600

    gw.deliver('srq-1', 'input.form', formParams({ expires_at: farSeconds }))
    timers.advance(2_000_000_000)

    expect(requests()).toHaveLength(1)

    timers.advance(60 * 24 * 3600 * 1000 - 2_000_000_000)

    expect(requests()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'expired' })
  })
})

describe('request.cancel', () => {
  it('closes the request with "withdrawn", and sends nothing', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.cancel('srq-1', 'interrupted')

    expect(requests()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'withdrawn' })
    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'closed' })
    expect(gw.calls).toEqual([])
    expect(gw.replies).toEqual([])
    // The engine hears the gateway's own cancel through the chat's events: the model does not say it twice.
    expect(engine.calls.filter(call => call.call === 'ended')).toEqual([])
  })

  it('says "answered elsewhere" when another device answered it (resolved)', () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.cancel('srq-1', 'resolved')

    expect(requests()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'answered_elsewhere' })
  })

  it('says "expired" for the gateway’s own timeout', () => {
    gw.deliver('srq-1', 'input.file', fileParams())
    gw.cancel('srq-1', 'timeout')

    expect(notice('researcher')).toEqual({ kind: 'expired' })
  })

  it('ignores a copy of a withdrawn request that arrives afterwards, and a cancel that arrived first', () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.cancel('srq-1')
    gw.deliver('srq-1', 'input.form', formParams(), true)

    gw.cancel('srq-2')
    gw.deliver('srq-2', 'input.form', formParams(), true)

    expect(requests()).toEqual([])
  })
})

describe('restored from open_requests', () => {
  it('opens a re-delivered request this page never saw, with the deadline it carries', () => {
    gw.deliver('srq-1', 'input.form', formParams(), true)

    expect(requests().map(request => request.id)).toEqual(['srq-1'])
    expect(requests()[0]?.earlierLost).toBeNull()
    expect(requests()[0]?.deadline).toBe((NOW_SECONDS + 300) * 1000)
  })

  it('opens again one whose answer never arrived, and says so', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    await model.answer('srq-1', FORM_ANSWER)
    gw.deliver('srq-1', 'input.form', formParams(), true)

    expect(requests()[0]?.earlierLost).toBe('answer')

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'sent' })
  })

  it('says a lost Skip in its own words', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    await model.skip('srq-1')
    gw.deliver('srq-1', 'input.form', formParams(), true)

    expect(requests()[0]?.earlierLost).toBe('skip')
  })

  it('puts the engine’s item back too: a lost answer is asked again', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    await model.answer('srq-1', FORM_ANSWER)
    engine.calls.length = 0
    gw.deliver('srq-1', 'input.form', formParams(), true)

    expect(engine.calls.map(call => call.call)).toEqual(['asked'])
  })

  it('opens again one its chat let go of, without saying an answer was lost', () => {
    gw.deliver('srq-1', 'input.form', formParams())
    moveSessions({ 'rt-2': 'writer' })
    moveSessions({ 'rt-1': 'researcher', 'rt-2': 'writer' })
    gw.deliver('srq-1', 'input.form', formParams(), true)

    expect(requests().map(request => [request.id, request.earlierLost])).toEqual([['srq-1', null]])
  })

  it('follows the session the newest copy names', () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.deliver('srq-1', 'input.form', formParams({ session_id: 'rt-2' }), true)

    expect(requests().map(request => [request.sessionId, request.bot, request.version])).toEqual([
      ['rt-2', 'writer', 3]
    ])
  })

  it('ignores a live duplicate of one already answered', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    await model.answer('srq-1', FORM_ANSWER)
    gw.deliver('srq-1', 'input.form', formParams())

    expect(requests()).toEqual([])
  })

  it('ignores a re-delivered copy of one that expired', () => {
    gw.deliver('srq-1', 'input.form', formParams({ expires_at: NOW_SECONDS + 10 }))
    timers.advance(10_000)
    gw.deliver('srq-1', 'input.form', formParams({ expires_at: NOW_SECONDS + 400 }), true)

    expect(requests()).toEqual([])
  })
})

describe('a reconnect', () => {
  it('closes a request the gateway withdrew while the socket was down, from the replayed request.cancel', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    model.replayedCancel('srq-1', 'interrupted')

    expect(requests()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'withdrawn' })
    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'closed' })
    expect(gw.calls).toEqual([])
  })

  it("closes the requests its session's open_requests no longer lists, says why, and sends nothing", async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.deliver('srq-2', 'input.file', fileParams())
    gw.deliver('srq-3', 'review.draft', draftParams({ session_id: 'rt-2' }))
    timers.advance(1_000)

    model.reconcile('rt-1', ['srq-2'], timers.now())

    expect(requests().map(request => request.id)).toEqual(['srq-2', 'srq-3'])
    expect(notice('researcher')).toEqual({ kind: 'lapsed' })
    expect(engine.calls.at(-1)).toEqual({ call: 'ended', bot: 'researcher', id: 'srq-1', reason: 'lapsed' })
    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'closed' })
    expect(gw.calls).toEqual([])
    // And a copy that turns up later is not opened again: the gateway stopped waiting.
    gw.deliver('srq-1', 'input.form', formParams(), true)
    expect(requests().map(request => request.id)).toEqual(['srq-2', 'srq-3'])
  })

  it('keeps a request first seen after the call went out: it may be newer than the snapshot', () => {
    const askedAt = timers.now()

    gw.deliver('srq-1', 'input.form', formParams())
    model.reconcile('rt-1', [], askedAt)

    expect(requests().map(request => request.id)).toEqual(['srq-1'])
  })

  it('lets go of a request waiting for its chat quietly', () => {
    gw.deliver('srq-1', 'input.form', formParams({ session_id: 'rt-9' }))
    timers.advance(1)
    model.reconcile('rt-9', [], timers.now())
    moveSessions({ ...sessions, 'rt-9': 'researcher' })

    expect(requests()).toEqual([])
    expect(store.getState().notices).toEqual({})
  })

  it('leaves one whose answer is on its way alone', async () => {
    let release: (value: unknown) => void = () => undefined

    gw.onCall.handler = () => new Promise(resolve => (release = resolve))
    gw.deliver('srq-1', 'input.form', formParams())
    timers.advance(1)

    const pending = model.answer('srq-1', FORM_ANSWER)

    model.reconcile('rt-1', [], timers.now())
    release({ status: 'ok' })

    await expect(pending).resolves.toEqual({ kind: 'sent' })
  })

  it('hears both through watchReplays, and the passkey model’s advert hands it the same', () => {
    let hear: (signal: ReplaySignal) => void = () => undefined

    model.stop()
    gw = fakeInteractiveGateway()
    model = new InteractiveModel({
      gateway: gw.gateway,
      store,
      chatFor: id => sessions[id],
      watchReplays: listener => {
        hear = listener

        return () => undefined
      },
      now: () => timers.now(),
      timers
    })
    model.start()
    gw.deliver('srq-1', 'input.form', formParams())
    gw.deliver('srq-2', 'input.form', formParams())
    gw.deliver('srq-3', 'input.form', formParams())
    timers.advance(1)
    model.advertSettled('accepted')

    hear({ kind: 'cancel', id: 'srq-1', reason: 'timeout' })
    hear({ kind: 'open_requests', sessionId: 'rt-1', ids: ['srq-3'], askedAt: timers.now() })

    expect(requests().map(request => request.id)).toEqual(['srq-3'])
    expect(notice('researcher')).toEqual({ kind: 'lapsed' })

    gw.deliver('srq-4', 'input.form', formParams())
    timers.advance(1)
    interactiveAdvert(model).openRequests('rt-1', [], timers.now())

    expect(requests()).toEqual([])
  })
})

describe('a reconnect before the new socket’s advert is settled', () => {
  let hear: (signal: ReplaySignal) => void

  /** A page whose form is open, whose socket just went away and came back (`ready`, advert not settled yet). */
  function reconnected(): void {
    model.stop()
    gw = fakeInteractiveGateway()
    engine = recordingEngine()
    model = new InteractiveModel({
      gateway: gw.gateway,
      store,
      chatFor: id => sessions[id],
      watchReplays: listener => {
        hear = listener

        return () => undefined
      },
      engine: engine.engine,
      failWithData: gw.failWithData,
      now: () => timers.now(),
      timers
    })
    model.start()
    model.advertSettled('accepted')
    gw.deliver('srq-1', 'input.form', formParams())
    timers.advance(1)
    gw.status('connecting')
    timers.advance(1)
    gw.status('ready')
  }

  beforeEach(reconnected)

  it('holds the lists the controller hears before the advert, and drops them once it is accepted', async () => {
    // The resume and the replay ran before the advert: the gateway hid the form from this socket.
    hear({ kind: 'open_requests', sessionId: 'rt-1', ids: [], askedAt: timers.now() })
    expect(requests().map(request => request.id)).toEqual(['srq-1'])

    timers.advance(1)
    interactiveAdvert(model, { enabled: true }).settled('accepted')
    expect(requests().map(request => request.id)).toEqual(['srq-1'])

    // The list read once the advert is accepted lists it, and its re-delivered copy is the same request.
    interactiveAdvert(model, { enabled: true }).openRequests('rt-1', ['srq-1'], timers.now())
    gw.deliver('srq-1', 'input.form', formParams(), true)
    expect(requests().map(request => request.id)).toEqual(['srq-1'])
    expect(store.getState().notices).toEqual({})

    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'sent' })
  })

  it('ignores a list asked for before the advert was accepted that arrives after it', () => {
    const askedBefore = timers.now()

    timers.advance(1)
    model.advertSettled('accepted')
    hear({ kind: 'open_requests', sessionId: 'rt-1', ids: [], askedAt: askedBefore })

    expect(requests().map(request => request.id)).toEqual(['srq-1'])

    // One asked for after it counts.
    timers.advance(1)
    hear({ kind: 'open_requests', sessionId: 'rt-1', ids: [], askedAt: timers.now() })
    expect(requests()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'lapsed' })
  })

  it('counts the held lists when the advert was not accepted: this socket cannot answer them', () => {
    hear({ kind: 'open_requests', sessionId: 'rt-1', ids: [], askedAt: timers.now() })
    expect(requests()).toHaveLength(1)

    model.advertSettled('refused')
    expect(requests()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'lapsed' })
  })

  it('takes the first word per socket: a second advert on the same socket changes nothing', () => {
    hear({ kind: 'open_requests', sessionId: 'rt-1', ids: [], askedAt: timers.now() })
    model.advertSettled('accepted')
    // A re-advert (forgetPin) whose call failed, or said otherwise: the held list is gone, the acceptance stands.
    model.advertSettled('refused')
    model.advertSettled('unknown')

    expect(requests().map(request => request.id)).toEqual(['srq-1'])
    timers.advance(1)
    hear({ kind: 'open_requests', sessionId: 'rt-1', ids: ['srq-1'], askedAt: timers.now() })
    expect(requests().map(request => request.id)).toEqual(['srq-1'])
  })

  it('believes no list of a socket whose advert nobody knows the outcome of', () => {
    hear({ kind: 'open_requests', sessionId: 'rt-1', ids: [], askedAt: timers.now() })
    model.advertSettled('unknown')
    timers.advance(1)
    hear({ kind: 'open_requests', sessionId: 'rt-1', ids: [], askedAt: timers.now() })

    expect(requests().map(request => request.id)).toEqual(['srq-1'])

    // The gateway's own cancel still ends it.
    gw.cancel('srq-1', 'timeout')
    expect(requests()).toEqual([])
  })

  it('holds again on the next socket', () => {
    model.advertSettled('accepted')
    gw.status('connecting')
    gw.status('ready')
    timers.advance(1)
    hear({ kind: 'open_requests', sessionId: 'rt-1', ids: [], askedAt: timers.now() })

    expect(requests()).toHaveLength(1)
  })
})

describe('a request that ended before a chat held its session', () => {
  let holding: Set<string>

  beforeEach(() => {
    holding = new Set()
    model.stop()
    gw = fakeInteractiveGateway()
    engine = recordingEngine()
    model = new InteractiveModel({
      gateway: gw.gateway,
      store,
      chatFor: id => sessions[id],
      watchChats: listener => {
        chatListeners.add(listener)

        return () => chatListeners.delete(listener)
      },
      engine: { ...engine.engine, holds: (bot, id) => holding.has(`${bot}/${id}`) },
      failWithData: gw.failWithData,
      now: () => timers.now(),
      timers
    })
    model.start()
  })

  it('is ended on the chat once the chat shows it (a resume snapshot put it there)', () => {
    // Declined while no chat held rt-9, and past its time while no chat held rt-9.
    gw.deliver('srq-1', 'input.form', { ...formParams(), session_id: 'rt-9', v: 2 })
    gw.deliver('srq-2', 'input.form', { ...formParams(), session_id: 'rt-9', expires_at: NOW_SECONDS - 1 })
    // Waiting for its chat, and its deadline passed.
    gw.deliver('srq-3', 'input.form', { ...formParams(), session_id: 'rt-9', expires_at: NOW_SECONDS + 5 })
    timers.advance(6_000)
    expect(engine.calls).toEqual([])

    // The chat binds the session before the snapshot's items are in: nothing yet.
    moveSessions({ ...sessions, 'rt-9': 'scout' })
    expect(engine.calls).toEqual([])

    holding.add('scout/srq-1').add('scout/srq-2').add('scout/srq-3')
    moveSessions({ ...sessions })

    expect(engine.calls).toEqual([
      { call: 'ended', bot: 'scout', id: 'srq-1', reason: 'cannot_show' },
      { call: 'ended', bot: 'scout', id: 'srq-2', reason: 'timeout' },
      { call: 'ended', bot: 'scout', id: 'srq-3', reason: 'timeout' }
    ])

    // Once.
    moveSessions({ ...sessions })
    expect(engine.calls).toHaveLength(3)
  })

  it('forgets one no snapshot can list any more, and stops looking on every chat update', () => {
    const asked = vi.fn((bot: string, id: string) => holding.has(`${bot}/${id}`))

    model.stop()
    model = new InteractiveModel({
      gateway: gw.gateway,
      store,
      chatFor: id => sessions[id],
      watchChats: listener => {
        chatListeners.add(listener)

        return () => chatListeners.delete(listener)
      },
      engine: { ...engine.engine, holds: asked },
      failWithData: gw.failWithData,
      now: () => timers.now(),
      timers
    })
    model.start()
    gw.deliver('srq-1', 'input.form', { ...formParams(), session_id: 'rt-9', v: 2 })
    moveSessions({ ...sessions, 'rt-9': 'scout' })
    expect(asked).toHaveBeenCalled()

    // Its deadline (300 s) and the grace after it pass without the item ever showing.
    timers.advance(361_000)
    asked.mockClear()
    holding.add('scout/srq-1')

    for (let update = 0; update < 50; update += 1) {
      moveSessions({ ...sessions })
    }

    expect(asked).not.toHaveBeenCalled()
    expect(engine.calls).toEqual([])
  })
})

describe('an answer and a withdrawal that cross', () => {
  it('says the answer may not have arrived', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    await model.answer('srq-1', FORM_ANSWER)
    gw.cancel('srq-1', 'timeout')

    expect(notice('researcher')).toEqual({ kind: 'may_not_have_arrived' })
    // And the gateway stopped waiting: a re-delivered copy is not opened again.
    gw.deliver('srq-1', 'input.form', formParams(), true)
    expect(requests()).toEqual([])
  })

  it('says nothing for the resolved cancel that follows an answer the gateway took', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    await model.answer('srq-1', FORM_ANSWER)
    gw.cancel('srq-1', 'resolved')

    expect(store.getState().notices).toEqual({})
  })

  it('says nothing for a Skip that crossed', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    await model.skip('srq-1')
    gw.cancel('srq-1', 'timeout')

    expect(store.getState().notices).toEqual({})
  })
})

describe('routing to a chat', () => {
  it('waits for a chat to hold the session, then shows on it and tells the engine', () => {
    gw.deliver('srq-1', 'input.form', formParams({ session_id: 'rt-9' }))

    expect(requests()).toEqual([])
    expect(gw.replies).toEqual([])
    expect(engine.calls).toEqual([])

    moveSessions({ ...sessions, 'rt-9': 'researcher' })

    expect(requests().map(request => [request.id, request.bot])).toEqual([['srq-1', 'researcher']])
    expect(engine.calls.map(call => call.call)).toEqual(['asked'])
  })

  it('lets a waiting one expire quietly at its deadline', () => {
    gw.deliver('srq-1', 'input.form', formParams({ session_id: 'rt-9', expires_at: NOW_SECONDS + 30 }))
    timers.advance(30_000)
    moveSessions({ ...sessions, 'rt-9': 'researcher' })

    expect(requests()).toEqual([])
    expect(gw.replies).toEqual([])
    expect(store.getState().notices).toEqual({})
  })

  it('never declines one for waiting, however long, but only for there being too many (16)', () => {
    timers.advance(100_000)

    for (let index = 0; index < 16; index += 1) {
      gw.deliver(`srq-${index}`, 'input.form', formParams({ session_id: 'rt-9', expires_at: NOW_SECONDS + 4_000 }))
    }

    expect(gw.replies).toEqual([])

    gw.deliver('srq-16', 'input.form', formParams({ session_id: 'rt-9', expires_at: NOW_SECONDS + 4_000 }))

    expect(gw.declined).toEqual([
      { id: 'srq-16', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'too_many_waiting' }
    ])
  })

  it('moves with its session, and the engine’s item moves with it', () => {
    gw.deliver('srq-1', 'input.form', formParams())
    engine.calls.length = 0
    moveSessions({ 'rt-1': 'writer' })

    expect(requests()[0]).toMatchObject({ bot: 'writer', version: 2 })
    expect(engine.calls.map(call => [call.call, call.bot])).toEqual([
      ['ended', 'researcher'],
      ['asked', 'writer']
    ])
  })

  it('is declined with no_chat and a "withdrawn" notice when no chat holds its session any more', () => {
    gw.deliver('srq-1', 'input.form', formParams())
    moveSessions({ 'rt-2': 'writer' })

    expect(requests()).toEqual([])
    expect(gw.declined).toEqual([{ id: 'srq-1', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'no_chat' }])
    expect(notice('researcher')).toEqual({ kind: 'withdrawn' })
    expect(engine.calls.at(-1)).toEqual({ call: 'ended', bot: 'researcher', id: 'srq-1', reason: 'lapsed' })
  })

  it('keeps requests of several chats in the order they arrived', () => {
    gw.deliver('srq-a', 'input.form', formParams({ session_id: 'rt-2' }))
    gw.deliver('srq-b', 'input.file', fileParams())

    expect(requests().map(request => [request.id, request.bot])).toEqual([
      ['srq-a', 'writer'],
      ['srq-b', 'researcher']
    ])
  })
})

describe('stopping (sign-out)', () => {
  it('fails every request, open or waiting, with 4041 shutting_down, and forgets everything', () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.deliver('srq-2', 'input.file', fileParams({ session_id: 'rt-2' }))
    gw.deliver('srq-3', 'review.draft', draftParams({ session_id: 'rt-9' }))
    model.stop()

    expect(gw.declined).toEqual([
      { id: 'srq-1', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'shutting_down' },
      { id: 'srq-2', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'shutting_down' },
      { id: 'srq-3', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'shutting_down' }
    ])
    expect(store.getState().requests).toEqual([])
    expect(timers.pending()).toBe(0)
    // Stopped: nothing is taken any more, and a second stop says nothing again.
    expect(gw.deliver('srq-4', 'input.form', formParams())).toBe(false)
    model.stop()
    expect(gw.declined).toHaveLength(3)
  })

  it('does not fail what was answered', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    await model.answer('srq-1', FORM_ANSWER)
    model.stop()

    expect(gw.declined).toEqual([])
  })
})

describe('advertising', () => {
  it('lists the methods of the gateway’s list that this page can show', () => {
    expect(showableMethods(['approval', 'input.form', 'input.file', 'review.draft', 'device.scan'])).toEqual([
      'input.form',
      'input.file',
      'review.draft'
    ])
    expect(showableMethods(['approval', 'clarify'])).toEqual([])
    expect(showableMethods(['review.draft'])).toEqual(['review.draft'])
  })

  it('lists input.file only where the browser can read and upload a file', () => {
    expect(showableMethods(['input.form', 'input.file'], { file: false })).toEqual(['input.form'])
    expect(showableMethods(['input.file'], { file: true })).toEqual(['input.file'])
    // This runtime has File and FormData, like every browser.
    expect(showableMethods(['input.file'])).toEqual(['input.file'])
  })

  it('advertises the methods the sheets can show, and nothing when the switch is off', () => {
    const list = ['approval', 'input.form', 'input.file', 'review.draft']

    expect(ADVERTISE_INTERACTIVE_REQUESTS).toBe(true)
    expect(interactiveAdvert(model, { enabled: false }).methods(list)).toEqual([])
    expect(interactiveAdvert(model).methods(list)).toEqual(['input.form', 'input.file', 'review.draft'])
  })
})

describe('the queue', () => {
  it('lists the requests oldest first with their method and version, and moves with the model', async () => {
    const chats = createChatsStore()
    const queue = createRequestsStore()

    chats.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
    chats.getState().bindRuntime('researcher', 'rt-1')

    const unbind = bindRequests(chats, queue, undefined, undefined, undefined, store)

    gw.deliver('srq-1', 'input.form', formParams())
    gw.deliver('srq-2', 'review.draft', draftParams())

    expect(queue.getState().queue).toEqual([
      expect.objectContaining({
        kind: 'interactive',
        id: 'srq-1',
        method: 'input.form',
        bot: 'researcher',
        version: 1
      }),
      expect.objectContaining({
        kind: 'interactive',
        id: 'srq-2',
        method: 'review.draft',
        bot: 'researcher',
        version: 1
      })
    ])

    gw.onCall.handler = () => {
      throw new JsonRpcGatewayError('refused', { code: REFUSED_CODE, data: { reason: 'field:name:missing' } })
    }
    await model.answer('srq-1', FORM_ANSWER)

    // A refusal changes what the sheet draws: the entry's version moves.
    expect(queue.getState().queue[0]).toMatchObject({ id: 'srq-1', version: 2 })

    gw.onCall.handler = () => ({ status: 'ok' })
    await model.answer('srq-1', FORM_ANSWER)

    expect(queue.getState().queue.map(entry => entry.kind === 'interactive' && entry.id)).toEqual(['srq-2'])

    unbind()
  })
})

describe('what the engine keeps', () => {
  /** The model wired to a real chat store the way `session.ts` wires it. */
  function wired() {
    const chats = createChatsStore()

    chats.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
    chats.getState().bindRuntime('researcher', 'rt-1')

    model.stop()
    gw = fakeInteractiveGateway()
    model = new InteractiveModel({
      gateway: gw.gateway,
      store,
      chatFor: id => chats.getState().runtimeToBot[id],
      engine: {
        asked: (bot, request) =>
          chats.getState().dispatchServerRequest(bot, {
            id: request.id,
            method: request.method,
            params: { title: request.title, summary: request.summary, optional: request.optional },
            ...(request.replayed ? { replayed: true } : {})
          }),
        answered: (bot, id, summary) => chats.getState().answer(bot, id, summary),
        ended: (bot, id, reason) =>
          chats.getState().dispatchEvent(bot, { type: 'request.cancel', payload: { id, reason } })
      },
      failWithData: gw.failWithData,
      now: () => timers.now(),
      timers
    })
    model.start()

    const items = () =>
      Object.values(chats.getState().chats.researcher?.items ?? {}).filter(item => item.kind === 'request')

    return { chats, items }
  }

  it('holds one item per question: open while asked, answered with a summary, never a value', async () => {
    const { chats, items } = wired()

    gw.deliver('srq-1', 'input.form', formParams())

    expect(items()).toEqual([
      expect.objectContaining({
        requestId: 'srq-1',
        method: 'input.form',
        title: 'Hotel booking details',
        state: 'open'
      })
    ])

    await model.answer('srq-1', FORM_ANSWER)

    expect(items()).toEqual([expect.objectContaining({ state: 'answered', answerSummary: { status: 'answered' } })])
    expect(JSON.stringify(chats.getState())).not.toContain('ZQ7xK')
    expect(JSON.stringify(chats.getState())).not.toContain('hunter2')
  })

  it('holds a draft’s decision and whether it was edited, and not its text', async () => {
    const { chats, items } = wired()

    gw.deliver('srq-1', 'review.draft', draftParams())
    await model.answer('srq-1', { decision: 'approved', text: `${DRAFT_TEXT}\nSECRET-EDIT-ZQ7xK` })

    expect(items()).toEqual([
      expect.objectContaining({ state: 'answered', answerSummary: { decision: 'approved', edited: true } })
    ])
    expect(JSON.stringify(chats.getState())).not.toContain('SECRET-EDIT')
    expect(JSON.stringify(chats.getState())).not.toContain('Kind regards')
  })

  it('ends the item of a request that expired, was declined, or lapsed', () => {
    const { items } = wired()

    gw.deliver('srq-1', 'input.form', formParams({ expires_at: NOW_SECONDS + 10 }))
    gw.deliver('srq-2', 'input.file', fileParams())
    gw.deliver('srq-3', 'input.form', formParams())
    timers.advance(10_000)
    model.cannotShow('srq-2', 'no_camera')
    timers.advance(1)
    model.reconcile('rt-1', [], timers.now())

    expect(
      items().map(item => [item.requestId, item.state, item.state === 'cancelled' ? item.cancelReason : ''])
    ).toEqual([
      ['srq-1', 'cancelled', 'timeout'],
      ['srq-2', 'cancelled', 'cannot_show'],
      ['srq-3', 'cancelled', 'lapsed']
    ])
  })
})

describe('the values are never kept', () => {
  it('appear in the call and in no store, the queue and the engine included, after every kind is answered', async () => {
    const chats = createChatsStore()
    const queue = createRequestsStore()
    const unbind = bindRequests(chats, queue, undefined, undefined, undefined, store)

    chats.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
    chats.getState().bindRuntime('researcher', 'rt-1')
    gw.deliver('srq-1', 'input.form', formParams())
    gw.deliver('srq-2', 'input.file', fileParams())
    gw.deliver('srq-3', 'review.draft', draftParams())

    expect(queue.getState().queue.map(entry => entry.kind)).toEqual(['interactive', 'interactive', 'interactive'])

    gw.status('connecting')
    await expect(model.answer('srq-1', FORM_ANSWER)).resolves.toEqual({ kind: 'offline' })
    gw.status('ready')

    await model.answer('srq-1', FORM_ANSWER)
    await model.answer('srq-2', {
      status: 'answered',
      files: [
        { path: '/x/ZQ7xK-file.jpg', name: 'ZQ7xK-file.jpg', mime: 'image/jpeg', bytes: 1, sha256: 'c'.repeat(64) }
      ],
      text: 'ZQ7xK-transcript'
    })
    await model.answer('srq-3', { decision: 'approved', text: `${DRAFT_TEXT} ZQ7xK-edit` })

    const everything = JSON.stringify({
      interactive: store.getState(),
      requests: queue.getState(),
      chats: chats.getState(),
      engine: engine.calls
    })

    expect(everything).not.toContain('ZQ7xK')
    expect(everything).not.toContain('hunter2')
    // And it did go out.
    expect(JSON.stringify(gw.calls)).toContain(SECRET)
    expect(JSON.stringify(gw.calls)).toContain('ZQ7xK-file.jpg')
    expect(JSON.stringify(gw.calls)).toContain('ZQ7xK-edit')

    unbind()
  })

  it('keeps no reference to the value on the model either, even after a refusal and a retry', async () => {
    gw.deliver('srq-1', 'input.form', formParams())
    gw.onCall.handler = () => {
      throw new JsonRpcGatewayError('refused', { code: REFUSED_CODE, data: { reason: 'field:name:too_long' } })
    }
    await model.answer('srq-1', FORM_ANSWER)
    gw.status('connecting')
    await model.answer('srq-1', FORM_ANSWER)
    gw.status('ready')
    gw.onCall.handler = () => ({ status: 'ok' })
    await model.answer('srq-1', FORM_ANSWER)

    const seen = new WeakSet<object>()
    const walk = (value: unknown, depth: number): boolean => {
      if (typeof value === 'string') {
        return value.includes('ZQ7xK')
      }

      if (typeof value !== 'object' || value === null || depth > 6 || seen.has(value)) {
        return false
      }

      seen.add(value)

      // What the fake recorded is the wire, not the model.
      if (value === gw.calls || value === gw.replies) {
        return false
      }

      const entries =
        value instanceof Map ? [...value.entries()] : value instanceof Set ? [...value] : Object.values(value)

      return entries.some(entry => walk(entry, depth + 1))
    }

    expect(walk(model, 0)).toBe(false)
  })
})
