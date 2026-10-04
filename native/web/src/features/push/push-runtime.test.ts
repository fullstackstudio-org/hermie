/**
 * Web Push wired to the page: where a click lands (a route of this client's
 * router), the heartbeat while a chat is on screen, and the notifications that
 * are closed because what they said is dealt with.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatRuntime } from '../../core/chat-controller'
import { PUSH_ACTION_ALLOW, PUSH_MESSAGE_SOURCE } from '../../core/push/actions'
import type { GatewayClock } from '../../core/push/clock'
import type { PushBrowser, PushWorker, ShownNotificationHandle } from '../../core/push/platform'
import { createHashRouter } from '../../platform/hash-router'
import { createKeyValueStore } from '../../platform/key-value-store'
import type { Visibility, VisibilityWatcher } from '../../platform/visibility'
import { createBotsStore } from '../../state/bots'
import { createChatsStore } from '../../state/chats'
import { createPluginStore } from '../../state/plugin'
import { createPushStore } from '../../state/push'
import { createRequestsStore, type OpenRequest } from '../../state/requests'
import { type PushRuntime, startPush } from './push-runtime'

const settle = async (): Promise<void> => {
  for (let round = 0; round < 10; round += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function fakeVisibility(initial: Visibility = 'visible'): VisibilityWatcher & { set(next: Visibility): void } {
  let now: Visibility = initial
  const listeners = new Set<(next: Visibility) => void>()

  return {
    current: () => now,
    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    set(next) {
      now = next

      for (const listener of listeners) {
        listener(next)
      }
    }
  }
}

function fakeBrowser(shown: ShownNotificationHandle[]) {
  const listeners = new Set<(data: unknown) => void>()
  const worker: PushWorker = {
    getSubscription: async () => null,
    subscribe: async () => {
      throw new Error('not in this test')
    },
    notifications: async () => shown
  }
  const browser: PushBrowser = {
    environment: () => ({
      secure: true,
      serviceWorker: true,
      pushManager: true,
      notification: true,
      ios: false,
      standalone: false,
      chromium: true
    }),
    permission: () => 'default',
    requestPermission: async () => 'denied',
    worker: async () => worker,
    existingWorker: async () => worker,
    onMessage(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  }

  return {
    browser,
    post(data: unknown) {
      for (const listener of listeners) {
        listener(data)
      }
    }
  }
}

const runtimes: PushRuntime[] = []

afterEach(() => {
  while (runtimes.length) {
    runtimes.pop()?.stop()
  }
})

function setup(
  options: { shown?: ShownNotificationHandle[]; advert?: boolean; clock?: GatewayClock; hidden?: boolean } = {}
) {
  const router = createHashRouter(null)
  const visibility = fakeVisibility(options.hidden ? 'hidden' : 'visible')
  const chats = createChatsStore()
  const bots = createBotsStore()
  const plugin = createPluginStore()
  const store = createPushStore()
  const requests = createRequestsStore()
  const { browser, post } = fakeBrowser(options.shown ?? [])
  const controller = {
    openApprovals: vi.fn(async () => [{ request_id: 'appr-1', choices: ['once', 'deny'] }]),
    respondApproval: vi.fn(async () => undefined)
  }

  if (options.advert !== false) {
    plugin.getState().apply({
      v: 1,
      version: '0.13.0',
      capabilities: ['push.webpush'],
      modules: { push: 'on' },
      limits: {},
      relayOrigins: [],
      web: null,
      webPush: null
    } as never)
  }

  chats.getState().ensure('scout', { storedSessionId: 'stored-canonical', resolvedSessionId: 'stored-canonical' })

  const runtime = startPush({
    baseUrl: 'https://gw.example.test',
    storage: createKeyValueStore({ namespace: 'test', storage: null }),
    chats: { chats, controller: controller as unknown as ChatRuntime['controller'] },
    bots,
    plugin,
    headers: async () => ({}),
    store,
    browser,
    router,
    visibility,
    requests,
    clock: options.clock ?? { now: () => 1_790_000_000_000, measure: async () => undefined, offset: 0 }
  })

  runtimes.push(runtime)

  return { router, visibility, chats, store, requests, post, controller }
}

const click = (actionIdentifier: string, data: Record<string, unknown>) => ({
  source: PUSH_MESSAGE_SOURCE,
  response: { actionIdentifier, data }
})

describe('a click', () => {
  it('opens the bot’s chat for a notification about it', async () => {
    const { router, post } = setup()

    post(click('default', { bot: 'scout', type: 'message', sessionId: 'stored-canonical', sessionKind: 'canonical' }))
    await settle()

    expect(router.current()).toBe('#/chat/scout')
  })

  it('opens a branch in the viewer, by its stored id', async () => {
    const { router, post } = setup()

    post(click('default', { bot: 'scout', type: 'turn_done', sessionId: 'branch-1', sessionKind: 'branch' }))
    await settle()

    expect(router.current()).toBe('#/chat/scout/s/branch-1')
  })

  it('answers an Allow once the chat is attached and the gateway still lists the request', async () => {
    const { chats, controller, router, post } = setup()

    post(
      click(PUSH_ACTION_ALLOW, {
        bot: 'scout',
        type: 'request',
        method: 'approval',
        requestId: 'appr-1',
        sessionId: 'runtime-1',
        sessionKey: 'stored-canonical',
        sessionKind: 'canonical'
      })
    )
    await settle()

    expect(router.current()).toBe('#/chat/scout')
    expect(controller.respondApproval).not.toHaveBeenCalled()

    // The chat attaches to its session once it is open.
    chats.getState().bindRuntime('scout', 'runtime-1')
    await settle()

    expect(controller.openApprovals).toHaveBeenCalledWith('scout')
    expect(controller.respondApproval).toHaveBeenCalledWith('scout', 'appr-1', 'once')
  })
})

describe('the heartbeat', () => {
  it('beats while a bot’s chat is the route and the page is visible, once a device of the person is registered', async () => {
    const { router, visibility, store } = setup()

    await settle()
    router.navigate('#/chat/scout')
    // Nobody gets notifications: nothing to hold back, nothing written.
    expect(store.getState().seen).toBeNull()

    // The gateway's copy has another device's row.
    store.getState().applyRemote({}, true)
    expect(store.getState().seen).toEqual({ bot: 'scout', at: 1_790_000_000 })

    store.getState().beat('marker', 1)
    visibility.set('hidden')
    router.navigate('#/settings')
    expect(store.getState().seen?.bot).toBe('marker')
  })

  it('waits for the gateway’s clock before the first beat, and stamps it with that clock', async () => {
    let offset = 0
    let measured: () => void = () => undefined
    const clock: GatewayClock = {
      now: () => 1_790_000_000_000 + offset,
      measure: () =>
        new Promise<void>(resolve => {
          measured = () => {
            offset = -600_000
            resolve()
          }
        }),
      get offset() {
        return offset
      }
    }
    const { router, store } = setup({ clock })

    store.getState().applyRemote({}, true)
    router.navigate('#/chat/scout')
    await settle()
    // The page's clock may be ten minutes ahead: nothing is stamped with it.
    expect(store.getState().seen).toBeNull()

    measured()
    await settle()
    expect(store.getState().seen).toEqual({ bot: 'scout', at: 1_790_000_000 - 600 })
  })

  it('does not beat in a tab that is restored in the background', async () => {
    const { router, store } = setup({ hidden: true })

    store.getState().applyRemote({}, true)
    router.navigate('#/chat/scout')
    await settle()

    expect(store.getState().seen).toBeNull()
  })

  it('does not beat for a conversation in the viewer, nor on a gateway without a notifier', async () => {
    const viewer = setup()

    await settle()
    viewer.store.getState().applyRemote({}, true)
    viewer.router.navigate('#/chat/scout/s/branch-1')
    expect(viewer.store.getState().seen).toBeNull()

    const bare = setup({ advert: false })

    await settle()
    bare.store.getState().applyRemote({}, true)
    bare.router.navigate('#/chat/scout')
    expect(bare.store.getState().seen).toBeNull()
  })
})

describe('what is already dealt with', () => {
  it('closes the chat’s notifications when it comes on screen', async () => {
    const mine = { data: { bot: 'scout', type: 'message', sessionKind: 'canonical' }, close: vi.fn() }
    const branch = { data: { bot: 'scout', type: 'message', sessionKind: 'branch', sessionId: 'b' }, close: vi.fn() }
    const other = { data: { bot: 'writer', type: 'message' }, close: vi.fn() }
    const { router } = setup({ shown: [mine, branch, other] })

    router.navigate('#/chat/scout')
    await settle()

    expect(mine.close).toHaveBeenCalled()
    expect(branch.close).not.toHaveBeenCalled()
    expect(other.close).not.toHaveBeenCalled()
  })

  it('closes a request’s notification when the request leaves the queue', async () => {
    const asked = { data: { bot: 'scout', type: 'request', requestId: 'srq-1' }, close: vi.fn() }
    const { requests } = setup({ shown: [asked] })
    const entry = {
      kind: 'secure',
      key: 'secure\u0000srq-1',
      bot: 'scout',
      id: 'srq-1',
      method: 'secret'
    } as OpenRequest

    requests.getState().setQueue([entry])
    await settle()
    expect(asked.close).not.toHaveBeenCalled()

    requests.getState().setQueue([])
    await settle()
    expect(asked.close).toHaveBeenCalled()
  })
})
