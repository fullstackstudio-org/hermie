/**
 * What this browser keeps about Web Push, and what it forgets.
 */
import { describe, expect, it } from 'vitest'

import { createKeyValueStore } from '../platform/key-value-store'
import { botPushTypes, createPushStore, PUSH_INSTALLATION_KEY, PUSH_SETTINGS_KEY } from './push'

const disk = () => createKeyValueStore({ namespace: 'test', storage: null })

const ADDRESS = {
  transport: 'webpush' as const,
  endpoint: 'https://push.example.test/1',
  keys: { p256dh: 'p', auth: 'a' },
  applicationServerKey: 'BB4V0uA3Mhr24OQdSBvpiQbXxekA10YihCyW0_L4zE616vb3_kTg5WvgJ_rP5L6QUdFKymkHRs2SDtj8M9czWIw'
}

describe('the push store', () => {
  it('mints an installation id once, and keeps it across a sign-out of the browser', () => {
    const browser = disk()
    const first = createPushStore()

    first.getState().hydrate(browser)

    const id = first.getState().installationId

    expect(id).toMatch(/^i[0-9a-f]{16}$/u)
    expect(PUSH_INSTALLATION_KEY.startsWith('device.')).toBe(true)

    // A sign-out clears what is the person's; the id is the browser's.
    browser.clearIdentityBound()

    const again = createPushStore()

    again.getState().hydrate(browser)
    expect(again.getState().installationId).toBe(id)
  })

  it('keeps the switch, the types, the preview and the key under the person, never the address', () => {
    const browser = disk()
    const store = createPushStore()

    store.getState().hydrate(browser)
    store.getState().setEnabled(true)
    store.getState().setType('cron', false)
    store.getState().setPreview(true)
    store.getState().setAddress(ADDRESS, 1_790_000_000)

    const stored = JSON.parse(browser.getSync(PUSH_SETTINGS_KEY) ?? '{}') as Record<string, unknown>

    expect(stored).toEqual({
      enabled: true,
      types: expect.objectContaining({ message: true, cron: false }),
      preview: true,
      subscribedKey: ADDRESS.applicationServerKey
    })
    expect(JSON.stringify(stored)).not.toContain('push.example.test')

    const next = createPushStore()

    next.getState().hydrate(browser)
    expect(next.getState()).toMatchObject({ enabled: true, preview: true, address: null })
    expect(next.getState().types.cron).toBe(false)
    expect(next.getState().types.turn_failed).toBe(true)

    browser.clearIdentityBound()

    const signedOut = createPushStore()

    signedOut.getState().hydrate(browser)
    expect(signedOut.getState().enabled).toBe(false)
  })

  it('turns every type on with the switch when none was chosen, and drops the address with it off', () => {
    const store = createPushStore()

    store.getState().hydrate(disk())
    store.getState().setEnabled(true)
    expect(Object.values(store.getState().types).every(Boolean)).toBe(true)

    store.getState().setAddress(ADDRESS, 5)
    store.getState().setEnabled(false)
    expect(store.getState().address).toBeNull()
    expect(store.getState().updatedAt).toBe(0)
  })

  it('overrides one type for one chat, and follows the global type again when told', () => {
    const store = createPushStore()

    store.getState().hydrate(disk())
    store.getState().setEnabled(true)
    store.getState().setBotType('scout', 'cron', false)

    expect(store.getState().perBot).toEqual({ scout: { cron: false } })
    expect(botPushTypes(store.getState(), 'scout').cron).toBe(false)
    expect(botPushTypes(store.getState(), 'writer').cron).toBe(true)

    store.getState().setBotType('scout', 'cron', null)
    expect(store.getState().perBot).toEqual({})

    store.getState().setBotType('scout', 'message', false)
    store.getState().resetBotTypes('scout')
    expect(store.getState().perBot).toEqual({})
  })

  it('forgets this browser’s registration on retire, and keeps the id', () => {
    const store = createPushStore()

    store.getState().hydrate(disk())
    store.getState().setEnabled(true)
    store.getState().setAddress(ADDRESS, 5)
    store.getState().beat('scout', 5)

    const id = store.getState().installationId

    store.getState().retire()

    expect(store.getState()).toMatchObject({ enabled: false, address: null, seen: null, subscribedKey: '' })
    expect(store.getState().installationId).toBe(id)
  })
})
