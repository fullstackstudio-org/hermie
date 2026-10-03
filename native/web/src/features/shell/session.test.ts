import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { ReplaySignal } from '../../core/chat-controller'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createChatsStore } from '../../state/chats'
import { createConnectionStore } from '../../state/connection'
import { requestsStore } from '../../state/requests'
import { secureInputStore } from '../../state/secure-input'
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

/** The chat controller's replay signals, as the secure input model hears them. */
const replayListeners = new Set<(signal: ReplaySignal) => void>()
const connectGateway = vi.fn()
const connectChats = vi.fn()

vi.mock('../../core/gateway-client', () => ({
  connectGateway: (...args: unknown[]) => connectGateway(...args)
}))

vi.mock('../../core/chat-controller', () => ({
  connectChats: (...args: unknown[]) => connectChats(...args)
}))

const { startSession } = await import('./session')

beforeEach(() => {
  calls.length = 0
  replayListeners.clear()
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
  connectGateway.mockImplementation(() => ({
    bots: { watchRunning, refreshRunning },
    stores: { connection },
    // The passkey model's slice of the connection: never ready here, so it advertises nothing.
    gateway: { request: vi.fn(), onAny: () => () => {}, onRequest: () => () => {}, onStatus: () => () => {} },
    stop: clientStop
  }))
  connectChats.mockImplementation(() => ({
    stop: chatsStop,
    chats: chatStore,
    controller: {
      onReplaySignal: (listener: (signal: ReplaySignal) => void) => {
        replayListeners.add(listener)

        return () => replayListeners.delete(listener)
      }
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

  it('stops the poll, then the chats, then the client, once', () => {
    const visibility = fakeVisibility('visible')
    const session = startSession(options(visibility))

    session.stop()
    session.stop()

    expect(calls).toEqual(['poll released', 'chats stopped', 'client stopped'])
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
})
