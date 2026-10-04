// @vitest-environment node
/**
 * The worker's two events against a scope of our own making: what it shows,
 * what it closes, and where a click goes.
 */
import { describe, expect, it, vi } from 'vitest'

import { PUSH_ACTION_ALLOW, PUSH_LAUNCH_PARAM, PUSH_MESSAGE_SOURCE } from './notification'
import {
  installWorker,
  type WorkerClickEvent,
  type WorkerEvent,
  type WorkerNotification,
  type WorkerPushEvent,
  type WorkerScope,
  type WorkerWindow
} from './worker'

const SCOPE = 'https://gw.example.test/dashboard-plugins/hermie/app/'

type Listener = (event: never) => void

function scopeWith(windows: WorkerWindow[] = [], notifications: WorkerNotification[] = []) {
  const listeners = new Map<string, Listener>()
  const shown: { title: string; options: Record<string, unknown> }[] = []
  const opened: string[] = []
  const scope = {
    registration: {
      scope: SCOPE,
      showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options })
      }),
      getNotifications: vi.fn(async () => notifications)
    },
    clients: {
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async (url: string) => {
        opened.push(url)
      }),
      claim: vi.fn(async () => undefined)
    },
    navigator: { languages: ['en-GB'] },
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener)
  }

  installWorker(scope as unknown as WorkerScope)

  /** Fire an event and wait for everything it handed `waitUntil`. */
  const fire = async <E extends WorkerEvent>(type: string, event: Omit<E, 'waitUntil'>): Promise<void> => {
    const work: Promise<unknown>[] = []
    const listener = listeners.get(type)

    listener?.({ ...event, waitUntil: (promise: Promise<unknown>) => work.push(promise) } as never)
    await Promise.all(work)
  }

  return { scope, shown, opened, fire, listeners }
}

const pushOf = (payload: unknown): Omit<WorkerPushEvent, 'waitUntil'> => ({
  data: { json: () => payload }
})

describe('push', () => {
  it('shows the notification the payload describes', async () => {
    const { shown, fire } = scopeWith()

    await fire<WorkerPushEvent>(
      'push',
      pushOf({ title: 'scout', body: 'Sent you a message', data: { bot: 'scout', type: 'message', sessionId: 's1' } })
    )

    expect(shown).toEqual([
      {
        title: 'scout',
        options: expect.objectContaining({
          body: 'Sent you a message',
          tag: 'hermie:scout:s1',
          data: { bot: 'scout', type: 'message', sessionId: 's1' },
          actions: []
        })
      }
    ])
  })

  it('still shows something for a payload that is not JSON', async () => {
    const { shown, fire } = scopeWith()

    await fire<WorkerPushEvent>('push', {
      data: {
        json: () => {
          throw new SyntaxError('not JSON')
        }
      }
    })

    expect(shown).toHaveLength(1)
    expect(shown[0]?.title).toBe('Hermie')
  })

  it('shows nothing for a clearing push, and closes the notification it withdraws', async () => {
    const withdrawn = { data: { bot: 'scout', eventId: 'request:e73f568f3575f6b525d031267d258a0b' }, close: vi.fn() }
    const other = { data: { bot: 'scout', eventId: 'message:00' }, close: vi.fn() }
    const { shown, fire } = scopeWith([], [withdrawn, other])

    await fire<WorkerPushEvent>(
      'push',
      pushOf({
        data: {
          bot: 'scout',
          type: 'request',
          clear: true,
          reason: 'answered',
          replaces: 'request:e73f568f3575f6b525d031267d258a0b'
        }
      })
    )

    expect(shown).toEqual([])
    expect(withdrawn.close).toHaveBeenCalledTimes(1)
    expect(other.close).not.toHaveBeenCalled()
  })
})

describe('notificationclick', () => {
  const click = (action = ''): Omit<WorkerClickEvent, 'waitUntil'> => ({
    action,
    notification: { data: { bot: 'scout', type: 'request', requestId: 'appr-1' }, close: vi.fn() }
  })

  it('tells an open window of the client and focuses it, not another page of the origin', async () => {
    const dashboard = { url: 'https://gw.example.test/dashboard', focused: true, postMessage: vi.fn(), focus: vi.fn() }
    const client = { url: `${SCOPE}index.html#/`, postMessage: vi.fn(), focus: vi.fn(async () => undefined) }
    const { opened, fire } = scopeWith([dashboard, client])
    const event = click(PUSH_ACTION_ALLOW)

    await fire<WorkerClickEvent>('notificationclick', event)

    expect(event.notification.close).toHaveBeenCalled()
    expect(dashboard.postMessage).not.toHaveBeenCalled()
    expect(client.postMessage).toHaveBeenCalledWith({
      source: PUSH_MESSAGE_SOURCE,
      response: { actionIdentifier: PUSH_ACTION_ALLOW, data: { bot: 'scout', type: 'request', requestId: 'appr-1' } }
    })
    expect(client.focus).toHaveBeenCalled()
    expect(opened).toEqual([])
  })

  it('opens the client with the click in its address when none is open', async () => {
    const { opened, fire } = scopeWith([
      { url: 'https://gw.example.test/dashboard', postMessage: vi.fn(), focus: vi.fn() }
    ])

    await fire<WorkerClickEvent>('notificationclick', click())

    expect(opened).toHaveLength(1)

    const url = new URL(opened[0] ?? '')

    expect(url.pathname).toBe('/dashboard-plugins/hermie/app/index.html')
    expect(JSON.parse(url.searchParams.get(PUSH_LAUNCH_PARAM) ?? '')).toEqual({
      actionIdentifier: 'default',
      data: { bot: 'scout', type: 'request', requestId: 'appr-1' }
    })
  })

  it('has no fetch handler: the worker never serves the page', () => {
    const { listeners } = scopeWith()

    expect([...listeners.keys()].sort()).toEqual(['activate', 'install', 'notificationclick', 'push'])
  })
})
