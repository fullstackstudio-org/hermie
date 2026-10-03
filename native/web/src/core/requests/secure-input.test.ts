/**
 * The secure input model on its own: what each prompt answers, when it ends and
 * what it says when it does, where it is shown, the requests only the desktop app
 * can answer, and the one rule above the others: what a person types reaches the
 * request's reply and nothing else the page keeps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'

import { createChatsStore } from '../../state/chats'
import { bindRequests, createRequestsStore } from '../../state/requests'
import { createSecureInputStore, type SecureInputState } from '../../state/secure-input'
import { chatWith } from '../../test-support/chat-fixtures'
import {
  fakeSecureGateway,
  type FakeSecureGateway,
  manualTimers,
  type ManualTimers
} from '../../test-support/secure-input-gateway'
import {
  answerText,
  COMMAND_LIMIT,
  displayText,
  GATEWAY_TIMEOUT_MS,
  MARKS_PER_CHARACTER,
  readAsk,
  SecureInputModel
} from './secure-input'
import type { ReplaySignal } from '../chat-controller'
import { UNSUPPORTED_CODE } from './unsupported'

/** A value nobody would type by accident: if it shows up anywhere but a reply, it leaked. */
const SECRET = 'hunter2-é-ZQ7xK-do-not-keep'

let gw: FakeSecureGateway
let timers: ManualTimers
let store: StoreApi<SecureInputState>
let model: SecureInputModel
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
  gw = fakeSecureGateway(status)
  model = new SecureInputModel({
    gateway: gw.gateway,
    store,
    chatFor: id => sessions[id],
    watchChats: listener => {
      chatListeners.add(listener)

      return () => chatListeners.delete(listener)
    },
    gatewayName: 'gw.example.test',
    now: () => timers.now(),
    timers
  })
  model.start()
}

const prompts = () => store.getState().prompts
const notice = (bot: string) => store.getState().notices[bot]?.notice

beforeEach(() => {
  timers = manualTimers()
  store = createSecureInputStore()
  sessions = { 'rt-1': 'researcher', 'rt-2': 'writer' }
  chatListeners = new Set()
  makeModel()
})

afterEach(() => {
  model.stop()
})

describe('answering', () => {
  it.each([
    ['secret', { env_var: 'OPENAI_API_KEY', prompt: 'Your key' }],
    ['sudo', { command: 'apt install jq' }],
    ['vault.unlock_prompt', { backend: 'bitwarden', display_name: 'Bitwarden' }]
  ])('answers %s with {value} as typed, spaces kept', (method, params) => {
    gw.deliver('srq-1', method, { session_id: 'rt-1', ...params })

    expect(model.answer('srq-1', ` ${SECRET} `)).toBe('sent')
    expect(gw.replies).toEqual([{ id: 'srq-1', result: { value: ` ${SECRET} ` } }])
    expect(prompts()).toEqual([])
  })

  it('answers a code without the spaces and dashes typed to read it in groups', () => {
    gw.deliver('srq-1', 'vault.code', { session_id: 'rt-1', site: 'github.com', hint: 'From your app' })

    expect(model.answer('srq-1', ' 123 - 456 ')).toBe('sent')
    expect(gw.replies).toEqual([{ id: 'srq-1', result: { value: '123456' } }])
  })

  it('answers a login with the JSON string {identifier, password}, the identifier trimmed', () => {
    gw.deliver('srq-1', 'vault.save_login', { session_id: 'rt-1', origin: 'https://github.com', site: 'GitHub' })

    expect(model.answer('srq-1', SECRET, '  alex@example.test ')).toBe('sent')

    const reply = gw.replies[0] as unknown as { result: { value: string } }

    expect(typeof reply.result.value).toBe('string')
    expect(JSON.parse(reply.result.value)).toEqual({ identifier: 'alex@example.test', password: SECRET })
  })

  it('sends nothing for an answer that answers nothing', () => {
    gw.deliver('srq-1', 'secret', { session_id: 'rt-1', env_var: 'X', prompt: '' })
    gw.deliver('srq-2', 'vault.code', { session_id: 'rt-1' })
    gw.deliver('srq-3', 'vault.save_login', { session_id: 'rt-1', origin: 'o', site: 's' })

    expect(model.answer('srq-1', '')).toBe('empty')
    expect(model.answer('srq-2', ' - ')).toBe('empty')
    expect(model.answer('srq-3', SECRET, '   ')).toBe('empty')
    expect(model.answer('srq-3', '', 'alex')).toBe('empty')
    expect(gw.replies).toEqual([])
    expect(prompts()).toHaveLength(3)
  })

  it('skips with the empty string', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1', command: 'ls' })

    expect(model.skip('srq-1')).toBe('sent')
    expect(gw.replies).toEqual([{ id: 'srq-1', result: { value: '' } }])
  })

  it('answers once: a second press finds it closed', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })

    expect(model.answer('srq-1', SECRET)).toBe('sent')
    expect(model.answer('srq-1', SECRET)).toBe('closed')
    expect(model.skip('srq-1')).toBe('closed')
    expect(gw.replies).toHaveLength(1)
  })

  it('sends nothing while the connection is not ready, and keeps the prompt open', () => {
    gw.status('connecting')
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })

    expect(model.answer('srq-1', SECRET)).toBe('offline')
    expect(model.skip('srq-1')).toBe('offline')
    expect(gw.replies).toEqual([])
    expect(prompts()).toHaveLength(1)

    gw.status('ready')

    expect(model.answer('srq-1', SECRET)).toBe('sent')
  })

  it('leaves every other method to the next handler', () => {
    expect(gw.deliver('srq-1', 'clarify', { session_id: 'rt-1' })).toBe(false)
    expect(gw.deliver('srq-2', 'approval', { session_id: 'rt-1' })).toBe(false)
    expect(gw.deliver('srq-3', 'confirm', { session_id: 'rt-1' })).toBe(false)
    expect(gw.replies).toEqual([])
  })

  it('declines a prompt that names no session', () => {
    gw.deliver('srq-1', 'secret', { env_var: 'X', prompt: 'p' })

    expect(gw.replies).toEqual([{ id: 'srq-1', error: { code: UNSUPPORTED_CODE, message: expect.any(String) } }])
    expect(prompts()).toEqual([])
  })
})

describe('deadlines follow the gateway', () => {
  it.each([
    ['secret', 300],
    ['sudo', 120],
    ['vault.unlock_prompt', 120],
    ['vault.code', 180],
    ['vault.save_login', 180]
  ])('%s: a live one counts down %i s from its arrival', (method, seconds) => {
    gw.deliver('srq-1', method, { session_id: 'rt-1' })

    expect(prompts()[0]?.deadline).toBe(timers.now() + seconds * 1000)
  })

  it('closes at the deadline with an "expired" notice, and sends nothing', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    timers.advance(GATEWAY_TIMEOUT_MS.sudo - 1)

    expect(prompts()).toHaveLength(1)

    timers.advance(1)

    expect(prompts()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'expired' })
    expect(gw.replies).toEqual([])
  })

  it('refuses an answer pressed after the deadline even before the timer fires', () => {
    let now = timers.now()

    model.stop()
    gw = fakeSecureGateway()
    model = new SecureInputModel({
      gateway: gw.gateway,
      store,
      chatFor: id => sessions[id],
      now: () => now,
      // Timers that never fire: only the clock moves.
      timers: { setTimeout: () => 0, clearTimeout: () => undefined }
    })
    model.start()
    gw.deliver('srq-1', 'vault.code', { session_id: 'rt-1' })
    now += GATEWAY_TIMEOUT_MS.vault_code

    expect(model.answer('srq-1', '123456')).toBe('closed')
    expect(gw.replies).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'expired' })
  })

  it('refuses an answer to one first seen re-delivered once its own end has passed, even before the timer fires', () => {
    let now = timers.now()

    model.stop()
    gw = fakeSecureGateway()
    model = new SecureInputModel({
      gateway: gw.gateway,
      store,
      chatFor: id => sessions[id],
      now: () => now,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined }
    })
    model.start()
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' }, true)
    now += GATEWAY_TIMEOUT_MS.sudo

    expect(model.answer('srq-1', SECRET)).toBe('closed')
    expect(gw.replies).toEqual([])
  })

  it('shows no countdown for one first seen re-delivered, and closes it a whole timeout after it arrived', () => {
    gw.deliver('srq-1', 'vault.code', { session_id: 'rt-1' }, true)

    expect(prompts()[0]?.deadline).toBeNull()

    timers.advance(GATEWAY_TIMEOUT_MS.vault_code)

    expect(prompts()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'expired' })
  })

  it('keeps one deadline across a re-delivered copy, whose reply goes out on the newest copy', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })

    const deadline = prompts()[0]?.deadline

    timers.advance(10_000)
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' }, true)

    expect(prompts()).toHaveLength(1)
    expect(prompts()[0]?.deadline).toBe(deadline)
    expect(model.answer('srq-1', SECRET)).toBe('sent')
    expect(gw.replies).toEqual([{ id: 'srq-1', result: { value: SECRET } }])
  })
})

describe('request.cancel', () => {
  it('closes the prompt with "withdrawn", and sends nothing', () => {
    gw.deliver('srq-1', 'secret', { session_id: 'rt-1', env_var: 'X', prompt: 'p' })
    gw.cancel('srq-1', 'interrupted')

    expect(prompts()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'withdrawn' })
    expect(model.answer('srq-1', SECRET)).toBe('closed')
    expect(gw.replies).toEqual([])
  })

  it('says "expired" for the gateway\'s own timeout', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    gw.cancel('srq-1', 'timeout')

    expect(notice('researcher')).toEqual({ kind: 'expired' })
  })

  it('ignores a copy of a withdrawn request that arrives afterwards, and a cancel that arrived first', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    gw.cancel('srq-1')
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' }, true)

    gw.cancel('srq-2')
    gw.deliver('srq-2', 'sudo', { session_id: 'rt-1' }, true)

    expect(prompts()).toEqual([])
  })
})

describe('restored from open_requests', () => {
  it('opens a re-delivered request this page never saw', () => {
    gw.deliver('srq-1', 'secret', { session_id: 'rt-1', env_var: 'X', prompt: 'p' }, true)

    expect(prompts().map(prompt => prompt.id)).toEqual(['srq-1'])
    expect(prompts()[0]?.earlierLost).toBeNull()
  })

  it('opens again one whose answer never arrived, and says so', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    model.answer('srq-1', SECRET)
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' }, true)

    expect(prompts()[0]?.earlierLost).toBe('answer')
    expect(model.answer('srq-1', 'again')).toBe('sent')
    expect(gw.replies.at(-1)).toEqual({ id: 'srq-1', result: { value: 'again' } })
  })

  it('says a lost Skip in its own words', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    model.skip('srq-1')
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' }, true)

    expect(prompts()[0]?.earlierLost).toBe('skip')
  })

  it('opens again one its chat let go of, without saying an answer was lost', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    moveSessions({ 'rt-2': 'writer' })
    moveSessions({ 'rt-1': 'researcher', 'rt-2': 'writer' })
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' }, true)

    expect(prompts().map(prompt => [prompt.id, prompt.earlierLost])).toEqual([['srq-1', null]])
  })

  it('follows the session the newest copy names', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-2' }, true)

    expect(prompts().map(prompt => [prompt.sessionId, prompt.bot])).toEqual([['rt-2', 'writer']])
  })

  it('ignores a live duplicate of one already answered', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    model.answer('srq-1', SECRET)
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })

    expect(prompts()).toEqual([])
  })

  it('ignores a re-delivered copy of one that expired', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    timers.advance(GATEWAY_TIMEOUT_MS.sudo)
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' }, true)

    expect(prompts()).toEqual([])
  })
})

describe('a reconnect', () => {
  it('closes a prompt the gateway withdrew while the socket was down, from the replayed request.cancel', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    model.replayedCancel('srq-1', 'interrupted')

    expect(prompts()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'withdrawn' })
    expect(model.answer('srq-1', SECRET)).toBe('closed')
    expect(gw.replies).toEqual([])
  })

  it("closes the prompts its session's open_requests no longer lists, says why, and sends nothing", () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    gw.deliver('srq-2', 'secret', { session_id: 'rt-1', env_var: 'X', prompt: 'p' })
    gw.deliver('srq-3', 'sudo', { session_id: 'rt-2' })
    timers.advance(1_000)

    model.reconcile('rt-1', ['srq-2'], timers.now())

    expect(prompts().map(prompt => prompt.id)).toEqual(['srq-2', 'srq-3'])
    expect(notice('researcher')).toEqual({ kind: 'lapsed' })
    expect(model.answer('srq-1', SECRET)).toBe('closed')
    expect(gw.replies).toEqual([])
    // And a copy that turns up later is not opened again: the gateway stopped waiting.
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' }, true)
    expect(prompts().map(prompt => prompt.id)).toEqual(['srq-2', 'srq-3'])
  })

  it('keeps a prompt first seen after the call went out: it may be newer than the snapshot', () => {
    const askedAt = timers.now()

    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    model.reconcile('rt-1', [], askedAt)

    expect(prompts().map(prompt => prompt.id)).toEqual(['srq-1'])
  })

  it('lets go of a prompt waiting for its chat quietly', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-9' })
    timers.advance(1)
    model.reconcile('rt-9', [], timers.now())
    moveSessions({ ...sessions, 'rt-9': 'researcher' })

    expect(prompts()).toEqual([])
    expect(store.getState().notices).toEqual({})
  })

  it('hears both through watchReplays', () => {
    let hear: (signal: ReplaySignal) => void = () => undefined

    model.stop()
    gw = fakeSecureGateway()
    model = new SecureInputModel({
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
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    gw.deliver('srq-2', 'sudo', { session_id: 'rt-1' })
    timers.advance(1)

    hear({ kind: 'cancel', id: 'srq-1', reason: 'timeout' })
    hear({ kind: 'open_requests', sessionId: 'rt-1', ids: [], askedAt: timers.now() })

    expect(prompts()).toEqual([])
    expect(notice('researcher')).toEqual({ kind: 'lapsed' })
  })
})

describe('an answer and a withdrawal that cross', () => {
  it('says the answer may not have arrived', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    model.answer('srq-1', SECRET)
    gw.cancel('srq-1', 'timeout')

    expect(notice('researcher')).toEqual({ kind: 'may_not_have_arrived' })
    // And the gateway stopped waiting: a re-delivered copy is not opened again.
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' }, true)
    expect(prompts()).toEqual([])
  })

  it('says nothing for a Skip that crossed', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    model.skip('srq-1')
    gw.cancel('srq-1', 'timeout')

    expect(store.getState().notices).toEqual({})
  })
})

describe('routing to a chat', () => {
  it('waits for a chat to hold the session, then shows on it', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-9' })

    expect(prompts()).toEqual([])
    expect(gw.replies).toEqual([])

    moveSessions({ ...sessions, 'rt-9': 'researcher' })

    expect(prompts().map(prompt => [prompt.id, prompt.bot])).toEqual([['srq-1', 'researcher']])
  })

  it('lets a waiting one expire quietly at its deadline', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-9' })
    timers.advance(GATEWAY_TIMEOUT_MS.sudo)
    moveSessions({ ...sessions, 'rt-9': 'researcher' })

    expect(prompts()).toEqual([])
    expect(gw.replies).toEqual([])
  })

  it('declines one more than it can hold waiting', () => {
    for (let index = 0; index < 16; index += 1) {
      gw.deliver(`srq-${index}`, 'sudo', { session_id: 'rt-9' })
    }

    expect(gw.replies).toEqual([])

    gw.deliver('srq-16', 'sudo', { session_id: 'rt-9' })

    expect(gw.replies).toEqual([{ id: 'srq-16', error: { code: UNSUPPORTED_CODE, message: expect.any(String) } }])
  })

  it('moves with its session', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    moveSessions({ 'rt-1': 'writer' })

    expect(prompts()[0]?.bot).toBe('writer')
  })

  it('is skipped with a "withdrawn" notice when no chat holds its session any more', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    moveSessions({ 'rt-2': 'writer' })

    expect(prompts()).toEqual([])
    expect(gw.replies).toEqual([{ id: 'srq-1', result: { value: '' } }])
    expect(notice('researcher')).toEqual({ kind: 'withdrawn' })
  })

  it('keeps prompts of several chats in the order they arrived', () => {
    gw.deliver('srq-a', 'sudo', { session_id: 'rt-2' })
    gw.deliver('srq-b', 'secret', { session_id: 'rt-1', env_var: 'X', prompt: 'p' })

    expect(prompts().map(prompt => [prompt.id, prompt.bot])).toEqual([
      ['srq-a', 'writer'],
      ['srq-b', 'researcher']
    ])
  })
})

describe('what only the desktop app can answer', () => {
  it.each(['preview.act', 'preview.read', 'terminal.read', 'window.read', 'tour'])(
    'declines %s with -32601 and leaves one notice on its chat',
    method => {
      expect(gw.deliver('srq-1', method, { session_id: 'rt-1' })).toBe(true)
      expect(gw.replies).toEqual([
        { id: 'srq-1', error: { code: UNSUPPORTED_CODE, message: `not supported by this client: ${method}` } }
      ])
      expect(notice('researcher')).toEqual({ kind: 'unsupported', method })
      expect(prompts()).toEqual([])
    }
  )

  it('leaves one notice per request however often it is re-delivered, and answers every copy', () => {
    gw.deliver('srq-1', 'terminal.read', { session_id: 'rt-1' })
    model.dismissNotice('researcher')
    gw.deliver('srq-1', 'terminal.read', { session_id: 'rt-1' }, true)

    expect(notice('researcher')).toBeUndefined()
    expect(gw.replies).toHaveLength(2)
  })

  it('holds the notice of one for a session no chat holds yet for a while, then drops it', () => {
    gw.deliver('srq-1', 'tour', { session_id: 'rt-9' })
    moveSessions({ ...sessions, 'rt-9': 'researcher' })

    expect(notice('researcher')).toEqual({ kind: 'unsupported', method: 'tour' })

    gw.deliver('srq-2', 'tour', { session_id: 'rt-8' })
    timers.advance(15_000)
    moveSessions({ ...sessions, 'rt-8': 'writer' })

    expect(notice('writer')).toBeUndefined()
  })

  it('takes a notice away', () => {
    gw.deliver('srq-1', 'window.read', { session_id: 'rt-1' })
    model.dismissNotice('researcher')

    expect(store.getState().notices).toEqual({})
  })
})

describe('stopping (sign-out)', () => {
  it('answers every open prompt with the empty string and forgets everything', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    gw.deliver('srq-2', 'secret', { session_id: 'rt-2', env_var: 'X', prompt: 'p' })
    model.stop()

    expect(gw.replies).toEqual([
      { id: 'srq-1', result: { value: '' } },
      { id: 'srq-2', result: { value: '' } }
    ])
    expect(store.getState().prompts).toEqual([])
    expect(timers.pending()).toBe(0)
    // Stopped: nothing is taken any more.
    expect(gw.deliver('srq-3', 'sudo', { session_id: 'rt-1' })).toBe(false)
  })
})

describe('the value is never kept', () => {
  it('appears in the reply and in no store, the queue included, after every kind is answered', () => {
    const chats = createChatsStore()
    const requests = createRequestsStore()

    chats.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
    chats.getState().bindRuntime('researcher', 'rt-1')

    const unbind = bindRequests(chats, requests, undefined, store)

    gw.deliver('srq-1', 'secret', { session_id: 'rt-1', env_var: 'X', prompt: 'p' })
    gw.deliver('srq-2', 'sudo', { session_id: 'rt-1' })
    gw.deliver('srq-3', 'vault.unlock_prompt', { session_id: 'rt-1', backend: 'b', display_name: 'B' })
    gw.deliver('srq-4', 'vault.code', { session_id: 'rt-1' })
    gw.deliver('srq-5', 'vault.save_login', { session_id: 'rt-1', origin: 'o', site: 's' })

    expect(requests.getState().queue.map(entry => entry.kind)).toEqual([
      'secure',
      'secure',
      'secure',
      'secure',
      'secure'
    ])

    // While open, the stores already hold every field they will; one sheet is offline for a moment.
    gw.status('connecting')
    expect(model.answer('srq-1', SECRET)).toBe('offline')
    gw.status('ready')

    model.answer('srq-1', SECRET)
    model.answer('srq-2', SECRET)
    model.answer('srq-3', SECRET)
    model.answer('srq-4', 'ZQ7xK999')
    model.answer('srq-5', SECRET, 'alex-ZQ7xK-identifier')

    const everything = JSON.stringify({
      secure: store.getState(),
      requests: requests.getState(),
      chats: chats.getState()
    })

    expect(everything).not.toContain('ZQ7xK')
    expect(everything).not.toContain('hunter2')
    // And it did go out.
    expect(JSON.stringify(gw.replies)).toContain(SECRET)
    expect(JSON.stringify(gw.replies)).toContain('ZQ7xK999')

    unbind()
  })

  it('keeps no reference to the value on the model either', () => {
    gw.deliver('srq-1', 'sudo', { session_id: 'rt-1' })
    gw.status('connecting')
    model.answer('srq-1', SECRET)
    gw.status('ready')
    model.answer('srq-1', SECRET)

    const seen = new WeakSet<object>()
    const walk = (value: unknown, depth: number): boolean => {
      if (typeof value === 'string') {
        return value.includes('ZQ7xK')
      }

      if (typeof value !== 'object' || value === null || depth > 6 || seen.has(value)) {
        return false
      }

      seen.add(value)

      // The replies the fake recorded are the wire, not the model.
      if (value === gw.replies) {
        return false
      }

      const entries =
        value instanceof Map ? [...value.entries()] : value instanceof Set ? [...value] : Object.values(value)

      return entries.some(entry => walk(entry, depth + 1))
    }

    expect(walk(model, 0)).toBe(false)
  })
})

describe('reading a request', () => {
  it('cleans and bounds what it shows', () => {
    const ask = readAsk('sudo', { command: `rm -rf /\u202Egnp.exe\u0000\n\n\n${'x'.repeat(2000)}` })

    expect(ask?.kind).toBe('sudo')

    const command = ask?.kind === 'sudo' ? ask.command : ''

    expect(command).not.toContain('\u202E')
    expect(command).not.toContain('\u0000')
    expect(command).not.toContain('\n\n')
    expect([...command].length).toBeLessThanOrEqual(COMMAND_LIMIT + 1)
    expect(command.endsWith('…')).toBe(true)
  })

  it('names the password manager by its display name, else its backend; a login by its site, else its origin', () => {
    expect(readAsk('vault.unlock_prompt', { backend: 'bw', display_name: '' })).toEqual({
      kind: 'vault_unlock',
      name: 'bw'
    })
    expect(readAsk('vault.save_login', { origin: 'https://a.test', site: '' })).toEqual({
      kind: 'vault_save_login',
      site: 'https://a.test',
      origin: 'https://a.test'
    })
    expect(readAsk('clarify', {})).toBeNull()
  })

  it('treats anything but a string as empty', () => {
    expect(readAsk('secret', { env_var: 42, prompt: { html: '<b>x</b>' } })).toEqual({
      kind: 'secret',
      envVar: '',
      prompt: ''
    })
  })
})

describe('displayText', () => {
  it('drops controls, bidirectional overrides and private-use characters', () => {
    expect(displayText('a\u0007b\u202Ec\u2066d\uE000e\u200Bf', 100)).toBe('abcdef')
  })

  it('folds blanks: runs of spaces to one, runs of line breaks to one, trimmed', () => {
    expect(displayText('  one \t two\r\n\r\n\n three  ', 100)).toBe('one two\nthree')
  })

  it(`keeps at most ${MARKS_PER_CHARACTER} combining marks on a character`, () => {
    expect(displayText(`e${'\u0301'.repeat(40)}x`, 100)).toBe(`e${'\u0301'.repeat(MARKS_PER_CHARACTER)}x`)
  })

  it('cuts at the limit with an ellipsis, and reads a bounded amount of a huge text', () => {
    expect(displayText('abcdef', 3)).toBe('abc…')
    expect(displayText(' '.repeat(1_000_000) + 'x', 10)).toBe('…')
  })
})

describe('answerText', () => {
  it('builds the login JSON in memory and nothing for half a login', () => {
    const ask = { kind: 'vault_save_login', site: 's', origin: 'o' } as const

    expect(answerText(ask, 'pw', 'me')).toBe('{"identifier":"me","password":"pw"}')
    expect(answerText(ask, 'pw', '')).toBeNull()
  })
})
