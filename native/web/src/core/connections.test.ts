import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChatsStore } from '../state/chats'
import { createConnectionsStore } from '../state/connections'
import { chatWith } from '../test-support/chat-fixtures'
import type { SessionSignal } from './chat-controller'
import { authorisationLink, connectionTarget, ConnectionsModel, isTargetOpen } from './connections'

const NOW = 1_800_000_000_000

const request = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  op_id: 'op-1',
  tool_call_id: 'tc-1',
  deadline_at: NOW / 1000 + 120,
  timeout_seconds: 120,
  targets: [
    {
      name: 'github',
      kind: 'connector',
      action: 'authorize',
      state: 'pending',
      connect_url: 'https://auth.example/gh'
    },
    { name: 'notion-mcp', kind: 'mcp', action: 'install', state: 'pending' }
  ],
  ...over
})

function setup() {
  const listeners = new Set<(signal: SessionSignal) => void>()
  const store = createConnectionsStore()
  const chats = createChatsStore()
  const request$ = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({ status: 'ok' }))
  const model = new ConnectionsModel({
    gateway: { request: request$ as never },
    store,
    chats,
    now: () => Date.now(),
    watchSignals: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  })
  const say = (signal: SessionSignal): void => {
    for (const listener of listeners) {
      listener(signal)
    }
  }
  const ask = (payload: Record<string, unknown>, chat = 'researcher', runtimeSessionId = 'rt-1'): void =>
    say({ kind: 'connection.request', chat, runtimeSessionId, payload })
  const card = (chat = 'researcher') => store.getState().cards[chat]

  chats.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
  chats.getState().bindRuntime('researcher', 'rt-1')
  model.start()

  return { model, store, chats, say, ask, card, request: request$, listeners }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('authorisation links', () => {
  it('passes a plain https link, and names its host as the browser reads it', () => {
    expect(authorisationLink('  https://auth.example/connect?state=1  ')).toEqual({
      url: 'https://auth.example/connect?state=1',
      host: 'auth.example'
    })
    expect(authorisationLink('https://auth.example:8443/x')?.host).toBe('auth.example:8443')
    // An international name is shown in the spelling that cannot pass for another.
    expect(authorisationLink('https://bücher.example/x')?.host).toBe('xn--bcher-kva.example')
  })

  it('refuses everything else', () => {
    for (const raw of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://auth.example/x',
      'https://trusted.example@elsewhere.example/x',
      'https://user:pass@auth.example/x',
      'file:///etc/passwd',
      '//auth.example/x',
      'auth.example/x',
      '',
      '   ',
      `https://auth.example/${'x'.repeat(5000)}`,
      42,
      null
    ]) {
      expect(authorisationLink(raw), String(raw).slice(0, 40)).toBeNull()
    }
  })
})

describe('reading a row', () => {
  it('keeps a row with a name, cleans its texts, and says when its link was refused', () => {
    expect(
      connectionTarget({
        name: ' github‮ ',
        kind: 'connector',
        action: 'authorize',
        state: 'pending',
        detail: 'Needs\u0007 repo scope',
        instructions: 'Sign in\n\n\nwith your work account',
        connect_url: 'javascript:alert(1)'
      })
    ).toEqual({
      name: 'github‮',
      label: 'github',
      kind: 'connector',
      action: 'authorize',
      state: 'pending',
      detail: 'Needs repo scope',
      instructions: 'Sign in\nwith your work account',
      link: null,
      linkRefused: true,
      opened: false
    })
    expect(connectionTarget({ kind: 'mcp' })).toBeNull()
    expect(connectionTarget('github')).toBeNull()
  })

  it('tells an open row from a resolved one', () => {
    expect(isTargetOpen({ state: 'pending' })).toBe(true)
    expect(isTargetOpen({ state: 'initiated' })).toBe(true)
    expect(isTargetOpen({ state: 'not_connected' })).toBe(true)
    expect(isTargetOpen({ state: 'connected' })).toBe(false)
    expect(isTargetOpen({ state: 'skipped' })).toBe(false)
  })
})

describe('the connection cards', () => {
  it('opens a card for a request on a chat’s session, with the gateway’s deadline', () => {
    const { ask, card } = setup()

    ask(request())

    expect(card()).toMatchObject({
      chat: 'researcher',
      runtimeSessionId: 'rt-1',
      opId: 'op-1',
      toolCallId: 'tc-1',
      deadline: NOW + 120_000,
      answer: { kind: 'idle' }
    })
    expect(card()?.targets.map(target => [target.name, target.link?.host ?? null])).toEqual([
      ['github', 'auth.example'],
      ['notion-mcp', null]
    ])
  })

  it('shows nothing for a request without an op id, a tool call, a deadline, a named row or a session', () => {
    const { ask, store } = setup()

    ask(request({ op_id: '' }))
    ask(request({ tool_call_id: undefined }))
    ask(request({ deadline_at: 0 }))
    ask(request({ targets: [{ kind: 'mcp' }] }))
    ask(request(), 'researcher', '')

    expect(store.getState().cards).toEqual({})
  })

  it('moves a card with a newer update only, and merges what the update carries', () => {
    const { ask, say, card } = setup()

    ask(request({ seq: 1 }))
    say({
      kind: 'connection.update',
      chat: 'researcher',
      payload: {
        op_id: 'op-1',
        seq: 2,
        deadline_at: NOW / 1000 + 300,
        targets: [{ name: 'github', state: 'initiated', detail: 'Waiting for GitHub', instructions: null }]
      }
    })
    // An older frame moves nothing.
    say({
      kind: 'connection.update',
      chat: 'researcher',
      payload: { op_id: 'op-1', seq: 2, targets: [{ name: 'github', state: 'failed' }] }
    })
    // Another operation, or an account's, is not this card's.
    say({ kind: 'connection.update', chat: 'researcher', payload: { op_id: 'op-9', seq: 9, targets: [] } })
    say({
      kind: 'connection.update',
      chat: 'researcher',
      payload: { op_id: 'op-1', seq: 10, owner: { type: 'account' }, settled: true }
    })

    expect(card()?.seq).toBe(2)
    expect(card()?.deadline).toBe(NOW + 300_000)
    expect(card()?.targets[0]).toMatchObject({ state: 'initiated', detail: 'Waiting for GitHub', instructions: null })
    expect(card()?.targets[0]?.link?.url).toBe('https://auth.example/gh')
  })

  it('withdraws a card the gateway settles, and says how it ended', () => {
    const { ask, say, card, store } = setup()

    ask(request())
    say({
      kind: 'connection.update',
      chat: 'researcher',
      payload: { op_id: 'op-1', settled: true, settled_by: 'all_resolved' }
    })

    expect(card()).toBeUndefined()
    expect(store.getState().ended.researcher).toEqual({ opId: 'op-1', end: 'settled' })

    ask(request({ op_id: 'op-2' }))
    expect(store.getState().ended.researcher).toBeUndefined()
    say({
      kind: 'connection.update',
      chat: 'researcher',
      payload: { op_id: 'op-2', settled: true, settled_by: 'deadline' }
    })
    expect(store.getState().ended.researcher).toEqual({ opId: 'op-2', end: 'deadline' })
  })

  it('withdraws a card when its deadline passes on this page’s clock, and never shows one already past', () => {
    const { ask, card, store } = setup()

    ask(request({ deadline_at: NOW / 1000 + 5 }))
    vi.advanceTimersByTime(4_999)
    expect(card()).toBeDefined()

    vi.advanceTimersByTime(1)
    expect(card()).toBeUndefined()
    expect(store.getState().ended.researcher).toEqual({ opId: 'op-1', end: 'deadline' })

    ask(request({ op_id: 'op-late', deadline_at: NOW / 1000 - 1 }))
    expect(card()).toBeUndefined()
  })

  it('restores a card from a resume, moves it to the resumed session, and withdraws it when the resume names none', () => {
    const { say, card, store } = setup()

    say({
      kind: 'resumed',
      chat: 'researcher',
      runtimeSessionId: 'rt-1',
      pendingConnection: request(),
      hydrating: false
    })
    expect(card()?.opId).toBe('op-1')

    say({
      kind: 'resumed',
      chat: 'researcher',
      runtimeSessionId: 'rt-2',
      pendingConnection: request(),
      hydrating: false
    })
    expect(card()?.runtimeSessionId).toBe('rt-2')

    say({ kind: 'resumed', chat: 'researcher', runtimeSessionId: 'rt-2', pendingConnection: null, hydrating: false })
    expect(card()).toBeUndefined()
    expect(store.getState().ended.researcher).toEqual({ opId: 'op-1', end: 'withdrawn' })
  })

  it('withdraws a card whose chat lets go of its session', () => {
    const { ask, card, chats } = setup()

    ask(request())
    chats.getState().dropRuntime('researcher')

    expect(card()).toBeUndefined()
  })

  it('remembers which links were opened from here, also across a newer copy of the same operation', () => {
    const { ask, model, card } = setup()

    ask(request({ seq: 1 }))
    model.markOpened('researcher', 'github')
    expect(card()?.targets[0]?.opened).toBe(true)

    ask(request({ seq: 2 }))
    expect(card()?.targets[0]?.opened).toBe(true)
  })
})

describe('answering a card', () => {
  it('skips one row and cancels the whole card with connection.respond, naming the runtime session', async () => {
    const { ask, model, request: call, card } = setup()

    ask(request(), 'researcher#own-1')

    // A card for another chat key answers under the bot's profile.
    expect(await model.skip('researcher#own-1', 'github')).toBe(true)
    expect(await model.cancel('researcher#own-1')).toBe(true)

    expect(call.mock.calls).toEqual([
      [
        'connection.respond',
        {
          profile: 'researcher',
          session_id: 'rt-1',
          owner: { type: 'session', session_id: 'rt-1' },
          op_id: 'op-1',
          result: { targets: [{ name: 'github', status: 'skipped' }] }
        }
      ],
      [
        'connection.respond',
        {
          profile: 'researcher',
          session_id: 'rt-1',
          owner: { type: 'session', session_id: 'rt-1' },
          op_id: 'op-1',
          result: { settled_by: 'continue' }
        }
      ]
    ])
    expect(card('researcher#own-1')?.answer).toEqual({ kind: 'idle' })
  })

  it('says why an answer did not go out, and answers nothing for a row or a card it does not hold', async () => {
    const { ask, model, request: call, card } = setup()

    ask(request())
    call.mockRejectedValueOnce(new Error('gateway not connected'))

    const sending = model.skip('researcher', 'github')

    expect(card()?.answer).toEqual({ kind: 'sending', what: 'skip', target: 'github' })
    expect(await sending).toBe(false)
    expect(card()?.answer).toEqual({ kind: 'failed', message: 'gateway not connected' })

    expect(await model.skip('researcher', 'nobody')).toBe(false)
    expect(await model.cancel('writer')).toBe(false)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('stops hearing, and lets every card go, when it stops', () => {
    const { ask, model, store, listeners } = setup()

    ask(request())
    model.stop()

    expect(store.getState().cards).toEqual({})
    expect(listeners.size).toBe(0)
    vi.advanceTimersByTime(200_000)
    expect(store.getState().ended).toEqual({})
  })
})
