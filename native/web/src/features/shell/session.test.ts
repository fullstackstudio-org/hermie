import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { ReplaySignal, SessionSignal } from '../../core/chat-controller'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createChatsStore } from '../../state/chats'
import { createConnectionStore } from '../../state/connection'
import { connectionsStore } from '../../state/connections'
import { noticesStore } from '../../state/notices'
import { requestsStore } from '../../state/requests'
import { sessionStatusStore } from '../../state/session-status'
import { secureInputStore } from '../../state/secure-input'
import { createUiMetaStatusStore } from '../../state/ui-meta-status'
import { chatWith } from '../../test-support/chat-fixtures'
import { fakeVisibility } from '../../test-support/fake-watchers'

const calls: string[] = []
let connection = createConnectionStore()
let chatStore = createChatsStore()
const release = vi.fn(() => void calls.push('poll released'))
const watchRunning = vi.fn(() => release)
const refreshRunning = vi.fn(async () => {})
const clientStop = vi.fn(() => void calls.push('client stopped'))
const chatsStop = vi.fn(() => void calls.push('chats stopped'))
const uiMetaStop = vi.fn(() => void calls.push('ui-meta stopped'))

/** The chat controller's replay signals, as the secure input model hears them. */
const replayListeners = new Set<(signal: ReplaySignal) => void>()
/** The chat controller's session signals, as the notices, connections and status models hear them. */
const sessionListeners = new Set<(signal: SessionSignal) => void>()
const noteReplayGap = vi.fn()
const authMe = vi.fn(async () => ({ provider: 'authentik', userId: '1', displayName: 'Ann' }))
const connectGateway = vi.fn()
const connectChats = vi.fn()
const connectUiMeta = vi.fn()

vi.mock('../../core/gateway-client', () => ({
  connectGateway: (...args: unknown[]) => connectGateway(...args)
}))

vi.mock('../../core/chat-controller', () => ({
  connectChats: (...args: unknown[]) => connectChats(...args)
}))

vi.mock('../../core/ui-meta-bridge', () => ({
  connectUiMeta: (...args: unknown[]) => connectUiMeta(...args)
}))

const { startSession } = await import('./session')
const { deviceContextStore } = await import('../../state/device-context')

beforeEach(() => {
  calls.length = 0
  replayListeners.clear()
  sessionListeners.clear()
  noteReplayGap.mockClear()
  connection = createConnectionStore()
  chatStore = createChatsStore()
  requestsStore.getState().reset()
  release.mockClear()
  watchRunning.mockClear()
  refreshRunning.mockClear()
  clientStop.mockClear()
  chatsStop.mockClear()
  connectGateway.mockReset()
  connectChats.mockReset()
  connectUiMeta.mockReset()
  uiMetaStop.mockClear()
  connectUiMeta.mockImplementation(() => ({ stop: uiMetaStop }))
  deviceContextStore.getState().reset()
  connectGateway.mockImplementation(() => ({
    bots: { watchRunning, refreshRunning },
    stores: { connection },
    // The passkey model's slice of the connection: never ready here, so it advertises nothing.
    gateway: { request: vi.fn(), onAny: () => () => {}, onRequest: () => () => {}, onStatus: () => () => {} },
    http: { authMe },
    stop: clientStop
  }))
  connectChats.mockImplementation(() => ({
    stop: chatsStop,
    chats: chatStore,
    controller: {
      onReplaySignal: (listener: (signal: ReplaySignal) => void) => {
        replayListeners.add(listener)

        return () => replayListeners.delete(listener)
      },
      onSessionSignal: (listener: (signal: SessionSignal) => void) => {
        sessionListeners.add(listener)

        return () => sessionListeners.delete(listener)
      },
      noteReplayGap
    }
  }))
})

const options = (visibility = fakeVisibility('visible')) => ({
  baseUrl: 'https://gw.example/prefix',
  credentials: { signOut: async () => {} } as never,
  author: { id: 'authentik:1', name: 'Ann' },
  storage: { tag: 'storage', prefix: 'hermie:/prefix:', getSync: () => null, setSync: () => {} } as never,
  cache: { tag: 'cache' } as never,
  visibility
})

describe('startSession', () => {
  it('connects the gateway on the boot’s session, then the chats on that client with the reader’s author', () => {
    const settings = options()
    const session = startSession(settings)

    expect(connectGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://gw.example/prefix',
        credentials: settings.credentials,
        storage: settings.storage,
        cache: settings.cache,
        visibility: settings.visibility
      })
    )
    expect(connectChats).toHaveBeenCalledWith(
      expect.objectContaining({
        client: session.client,
        cache: settings.cache,
        author: { id: 'authentik:1', name: 'Ann' },
        visibility: settings.visibility
      })
    )
    expect(connectGateway.mock.invocationCallOrder[0]).toBeLessThan(connectChats.mock.invocationCallOrder[0]!)
  })

  it('follows the person’s ui_meta on the same connection, under the key the boot’s identity names', async () => {
    const settings = { ...options(), identity: { userId: 'tester@example.invalid', email: '', displayName: 'Ann' } }
    const session = startSession(settings)

    // A chunk of its own: loaded after the session starts, not before.
    expect(connectUiMeta).not.toHaveBeenCalled()
    expect(await session.uiMeta).toEqual({ stop: uiMetaStop })

    expect(connectUiMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: session.client.gateway,
        connection,
        storage: settings.storage,
        userId: 'tester@example.invalid',
        visibility: settings.visibility
      })
    )
    expect(deviceContextStore.getState()).toMatchObject({ gated: true, userId: 'tester@example.invalid' })

    session.stop()
    expect(deviceContextStore.getState().userId).toBe('')
  })

  it('names nobody, the local-only path, when the boot read no identity', async () => {
    await startSession(options()).uiMeta

    expect(connectUiMeta).toHaveBeenCalledWith(expect.objectContaining({ userId: '' }))
  })

  describe('a ui_meta chunk that does not load', () => {
    const failing = (times: number) => {
      let left = times

      return vi.fn(async () => {
        if (left > 0) {
          left -= 1
          throw new Error('Failed to fetch dynamically imported module')
        }

        return { connectUiMeta: (...args: unknown[]) => connectUiMeta(...args) as never }
      })
    }

    it('is asked for once more, and starts when the second try works', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const status = createUiMetaStatusStore()
      const loadUiMeta = failing(1)
      const session = startSession({ ...options(), loadUiMeta, uiMetaRetryMs: 0, uiMeta: { status } })

      expect(await session.uiMeta).toEqual({ stop: uiMetaStop })
      expect(loadUiMeta).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(status.getState().state).toBe('starting')

      warn.mockRestore()
    })

    it('is said in the console and published as unavailable when the second try fails too', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const status = createUiMetaStatusStore()
      const loadUiMeta = failing(2)
      const session = startSession({ ...options(), loadUiMeta, uiMetaRetryMs: 0, uiMeta: { status } })

      expect(await session.uiMeta).toBeNull()
      expect(loadUiMeta).toHaveBeenCalledTimes(2)
      expect(connectUiMeta).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledWith(expect.stringContaining('settings sync'), expect.any(Error))
      expect(status.getState().state).toBe('unavailable')

      // And a sign-out leaves nothing of it behind.
      session.stop()
      expect(status.getState().state).toBe('starting')

      warn.mockRestore()
      error.mockRestore()
    })
  })

  it('does not start the ui_meta bridge for a session that stopped before its chunk loaded', async () => {
    const session = startSession(options())

    session.stop()

    expect(await session.uiMeta).toBeNull()
    expect(connectUiMeta).not.toHaveBeenCalled()
  })

  it('polls the running state while the page is shown, and stops while it is hidden', () => {
    const visibility = fakeVisibility('visible')

    startSession(options(visibility))
    expect(watchRunning).toHaveBeenCalledTimes(1)

    visibility.set('hidden')
    expect(release).toHaveBeenCalledTimes(1)

    visibility.set('visible')
    expect(watchRunning).toHaveBeenCalledTimes(2)
  })

  it('does not poll a page that loads hidden until it is shown', () => {
    const visibility = fakeVisibility('hidden')

    startSession(options(visibility))
    expect(watchRunning).not.toHaveBeenCalled()

    visibility.set('visible')
    expect(watchRunning).toHaveBeenCalledTimes(1)
  })

  it('reads the running state again the moment the connection becomes usable, not on every notice after', () => {
    startSession(options())

    connection.getState().setStatus('connecting', null)
    expect(refreshRunning).not.toHaveBeenCalled()

    connection.getState().setStatus('ready', null)
    expect(refreshRunning).toHaveBeenCalledTimes(1)

    connection.getState().noteRpcFailure({ method: 'x', message: 'y', at: 0 } as never)
    connection.getState().setStatus('ready', null)
    expect(refreshRunning).toHaveBeenCalledTimes(1)

    connection.getState().setStatus('reconnecting', null)
    connection.getState().setStatus('ready', null)
    expect(refreshRunning).toHaveBeenCalledTimes(2)
  })

  it('stops the poll, then the chats, then the client, once', async () => {
    const visibility = fakeVisibility('visible')
    const session = startSession(options(visibility))

    await session.uiMeta

    session.stop()
    session.stop()

    expect(calls).toEqual(['poll released', 'ui-meta stopped', 'chats stopped', 'client stopped'])
    // A page shown after sign-out starts nothing.
    visibility.set('hidden')
    visibility.set('visible')
    expect(watchRunning).toHaveBeenCalledTimes(1)
    connection.getState().setStatus('ready', null)
    expect(refreshRunning).not.toHaveBeenCalled()
  })

  it('keeps the request queue in step with the chats it started, and empties it on stop', () => {
    const session = startSession(options())

    chatStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
    chatStore.getState().dispatchServerRequest('researcher', {
      id: 'srq-1',
      method: 'approval',
      params: { command: 'ls', request_id: 'a1' }
    })

    expect(requestsStore.getState().queue.map(entry => entry.bot)).toEqual(['researcher'])

    session.stop()
    expect(requestsStore.getState().queue).toEqual([])
  })

  it('answers secret, sudo and vault prompts beside the chats, and skips the open ones before the client stops', () => {
    const handlers: ((request: ServerRequest) => boolean | void)[] = []
    const replies: unknown[] = []

    connectGateway.mockImplementation(() => ({
      bots: { watchRunning, refreshRunning },
      stores: { connection },
      gateway: {
        request: vi.fn(),
        onAny: () => () => {},
        onRequest: (handler: (request: ServerRequest) => boolean | void) => {
          handlers.push(handler)

          return () => handlers.splice(handlers.indexOf(handler), 1)
        },
        onStatus: (handler: (status: string, error: null) => void) => {
          handler('ready', null)

          return () => {}
        }
      },
      stop: () => {
        replies.push('client stopped')
        clientStop()
      }
    }))

    const session = startSession(options())

    chatStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
    chatStore.getState().bindRuntime('researcher', 'rt-1')

    const request: ServerRequest = {
      id: 'srq-1',
      method: 'sudo',
      params: { session_id: 'rt-1', command: 'ls' },
      respond: result => void replies.push(result),
      fail: () => void replies.push('failed')
    }

    expect(handlers.some(handler => handler(request) !== false)).toBe(true)
    expect(requestsStore.getState().queue.map(entry => [entry.kind, entry.bot])).toEqual([['secure', 'researcher']])
    expect(secureInputStore.getState().gateway).toBe('gw.example')

    // A withdrawal that came in a reconnect's replay reaches the model through the controller.
    const second: ServerRequest = { ...request, id: 'srq-2', respond: () => void replies.push('answered srq-2') }

    handlers.some(handler => handler(second) !== false)
    expect(secureInputStore.getState().prompts.map(prompt => prompt.id)).toEqual(['srq-1', 'srq-2'])

    for (const listener of replayListeners) {
      listener({ kind: 'cancel', id: 'srq-2', reason: 'interrupted' })
    }

    expect(secureInputStore.getState().prompts.map(prompt => prompt.id)).toEqual(['srq-1'])

    session.stop()

    expect(replies).toEqual([{ value: '' }, 'client stopped'])
    expect(replayListeners.size).toBe(0)
    expect(requestsStore.getState().queue).toEqual([])
    expect(secureInputStore.getState().prompts).toEqual([])
  })

  it('hands what the gateway says beside the transcript to its models, puts a connection card on the queue, and stops them', () => {
    const session = startSession(options())

    chatStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
    chatStore.getState().bindRuntime('researcher', 'rt-1')

    const say = (signal: SessionSignal): void => {
      for (const listener of sessionListeners) {
        listener(signal)
      }
    }

    expect(sessionStatusStore.getState().identity).toEqual({ kind: 'known', authorId: 'authentik:1', name: 'Ann' })

    say({ kind: 'notice.show', chat: undefined, payload: { text: 'Credits are low', level: 'warn', key: 'credits' } })
    expect(noticesStore.getState().notices.map(notice => [notice.id, notice.text, notice.level])).toEqual([
      ['credits', 'Credits are low', 'warn']
    ])

    say({
      kind: 'connection.request',
      chat: 'researcher',
      runtimeSessionId: 'rt-1',
      payload: {
        op_id: 'op-1',
        tool_call_id: 'tc-1',
        deadline_at: Date.now() / 1000 + 60,
        targets: [{ name: 'github', kind: 'connector', action: 'authorize', state: 'pending' }]
      }
    })
    expect(requestsStore.getState().queue.map(entry => [entry.kind, entry.bot])).toEqual([['connection', 'researcher']])

    say({ kind: 'resumed', chat: 'researcher', runtimeSessionId: 'rt-1', pendingConnection: null, hydrating: true })
    expect(requestsStore.getState().queue).toEqual([])
    expect(connectionsStore.getState().ended.researcher).toEqual({ opId: 'op-1', end: 'withdrawn' })
    expect(sessionStatusStore.getState().resumeProgress).toEqual({ researcher: { status: 'loading' } })

    session.stop()

    expect(sessionListeners.size).toBe(0)
    expect(noticesStore.getState().notices).toEqual([])
    expect(sessionStatusStore.getState().identity).toEqual({ kind: 'unknown' })
  })
})
