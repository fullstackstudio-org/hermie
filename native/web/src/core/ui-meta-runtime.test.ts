/**
 * `connectUiMeta`: when the page reconciles its `ui_meta`, and when it folds the
 * live roster into the arrangement (the Expo app's `ChatRuntime`, the Swift
 * app's `GatewayMetaBridge`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAppStampStore } from '../state/app-stamp'
import { createBotsStore } from '../state/bots'
import { createConnectionStore } from '../state/connection'
import { createLayoutStore } from '../state/layout'
import { createTextSizeStore } from '../state/text-size'
import { fakeVisibility } from '../test-support/fake-watchers'
import { aBot } from '../test-support/shell-stores'
import { APP_KEY, holdingGateway, newDisk, OWNER, settled } from '../test-support/ui-meta-devices'
import { connectUiMeta, type UiMetaRuntime } from './ui-meta-bridge'

const runtimes: UiMetaRuntime[] = []

afterEach(async () => {
  while (runtimes.length) {
    runtimes.pop()?.stop()
  }

  await settled()
})

const waitFor = <T>(check: () => T | Promise<T>): Promise<T> => vi.waitFor(check, { timeout: 2_000, interval: 5 })

/** A page's connection, roster and stores around a gateway that remembers, with the reads counted. */
function wired(options: { failLists?: number } = {}) {
  const gateway = holdingGateway()
  let failLists = options.failLists ?? 0
  const handlers = new Set<() => void>()
  let lists = 0
  const connection = createConnectionStore()
  const bots = createBotsStore()
  const layout = createLayoutStore()
  const visibility = fakeVisibility('visible')
  const runtime = connectUiMeta({
    gateway: {
      request: ((method: string, params?: Record<string, unknown>) => {
        lists += method === 'profiles.list' ? 1 : 0

        if (method === 'profiles.list' && failLists > 0) {
          failLists -= 1

          return Promise.reject(new Error('gateway not connected'))
        }

        return gateway.request(method, params)
      }) as never,
      on: ((type: string, handler: () => void) => {
        if (type === 'sessions.changed') {
          handlers.add(handler)
        }

        return () => handlers.delete(handler)
      }) as never
    },
    connection,
    bots,
    storage: newDisk(),
    userId: OWNER,
    stores: { layout, textSize: createTextSizeStore(), appStamp: createAppStampStore() },
    visibility,
    debounceMs: 0
  })

  runtimes.push(runtime)

  return {
    gateway,
    connection,
    bots,
    layout,
    visibility,
    runtime,
    lists: () => lists,
    emitChanged: () => handlers.forEach(handler => handler())
  }
}

describe('connectUiMeta', () => {
  it('reconciles when the connection becomes usable, not before', async () => {
    const page = wired()

    await page.runtime.hydrated
    await settled()
    expect(page.lists()).toBe(0)

    page.connection.getState().setStatus('ready', null)
    await waitFor(() => expect(page.gateway.app()).toBeDefined())
    expect(page.runtime.bridge.mode).toBe('synced')
  })

  it('reconciles again on every rise to ready, on sessions.changed and when the page is shown', async () => {
    const page = wired()

    page.connection.getState().setStatus('ready', null)
    await waitFor(() => expect(page.lists()).toBe(1))

    page.connection.getState().setStatus('reconnecting', null)
    page.connection.getState().setStatus('ready', null)
    await waitFor(() => expect(page.lists()).toBe(2))

    page.emitChanged()
    await waitFor(() => expect(page.lists()).toBe(3))

    page.visibility.set('hidden')
    page.visibility.set('visible')
    await waitFor(() => expect(page.lists()).toBe(4))
  })

  it('does not reconcile while the connection is down', async () => {
    const page = wired()

    page.emitChanged()
    page.visibility.set('hidden')
    page.visibility.set('visible')
    await settled()

    expect(page.lists()).toBe(0)
  })

  it('folds the live roster in only once the gateway’s copy has been taken', async () => {
    const page = wired()

    // A roster painted from the cache is not folded at all, and the live one
    // not before the first reconcile.
    page.bots.getState().setBots([aBot('researcher'), aBot('writer')], { fromCache: true })
    page.bots.getState().setBots([aBot('researcher'), aBot('writer')])
    await settled()
    expect(page.layout.getState().entries).toEqual([])

    page.connection.getState().setStatus('ready', null)
    await waitFor(() =>
      expect(page.layout.getState().entries).toEqual([
        { kind: 'chat', name: 'researcher' },
        { kind: 'chat', name: 'writer' }
      ])
    )
    await waitFor(() => expect(page.gateway.app()?.entries).toHaveLength(2))

    // A bot that appears later is folded in on the roster's own change.
    page.bots.getState().setBots([aBot('researcher'), aBot('writer'), aBot('postman')])
    await waitFor(() => expect(page.gateway.app()?.entries).toHaveLength(3))
    expect(Object.keys(page.gateway.meta('researcher'))).toContain(APP_KEY)
  })

  it('stops following on stop', async () => {
    const page = wired()

    page.runtime.stop()
    page.connection.getState().setStatus('ready', null)
    page.emitChanged()
    await settled()

    expect(page.lists()).toBe(0)
  })
})

/**
 * A fold on a copy that has not taken the gateway's would be sent as the
 * person's arrangement: an undated flat list against an undated section kept
 * the local copy by the offline rule, and replaced their folders.
 */
describe('folding only onto a copy that took the gateway’s', () => {
  const FOLDERS = {
    v: 1,
    entries: [{ kind: 'folder', id: 'f1' }],
    folders: [{ id: 'f1', name: 'Finance', bots: ['researcher', 'writer'] }]
  }

  it('does not fold after a first pull that failed while the roster read worked', async () => {
    const page = wired({ failLists: 1 })

    // The person's folders, undated, on the gateway.
    await page.gateway.request('profiles.configure', { name: 'researcher', ui_meta: { [APP_KEY]: FOLDERS } })

    page.bots.getState().setBots([aBot('researcher'), aBot('writer')])
    page.connection.getState().setStatus('ready', null)
    await waitFor(() => expect(page.lists()).toBe(1))
    await settled()

    expect(page.runtime.bridge.takes).toBe(0)
    expect(page.layout.getState().entries).toEqual([])
    expect(page.gateway.app()).toEqual(FOLDERS)

    // The next reconcile takes the gateway's copy, and the fold lands on it.
    page.emitChanged()
    await waitFor(() => expect(page.layout.getState().folders.map(folder => folder.name)).toEqual(['Finance']))
    await settled()

    expect(page.layout.getState().entries).toEqual([{ kind: 'folder', id: 'f1' }])
    expect(page.gateway.app()?.folders).toEqual(FOLDERS.folders)
  })

  it('does not fold a roster that arrives while the connection is down, or before the next take', async () => {
    const page = wired()

    page.bots.getState().setBots([aBot('researcher')])
    page.connection.getState().setStatus('ready', null)
    await waitFor(() => expect(page.layout.getState().entries).toHaveLength(1))

    const before = page.layout.getState().entries

    page.connection.getState().setStatus('reconnecting', null)
    page.bots.getState().setBots([aBot('researcher'), aBot('writer')])
    await settled()

    expect(page.layout.getState().entries).toBe(before)

    // Up again: the roster lands before the reconcile has taken anything.
    page.connection.getState().setStatus('ready', null)
    page.bots.getState().setBots([aBot('researcher'), aBot('writer'), aBot('postman')])

    expect(page.layout.getState().entries).toBe(before)

    // And once it has, the fold is made.
    await waitFor(() => expect(page.layout.getState().entries).toHaveLength(3))
  })
})
