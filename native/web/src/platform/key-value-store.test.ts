import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createKeyValueStore, isDeviceLocalKey, keyValuePrefix, type StorageLike } from './key-value-store'

/** A `Storage` over a map, with switches for the two ways a browser refuses. */
function memoryStorage(): StorageLike & { map: Map<string, string>; full: boolean; locked: boolean } {
  const map = new Map<string, string>()

  const storage = {
    map,
    full: false,
    locked: false,
    get length() {
      return map.size
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem(key: string, value: string) {
      if (storage.full) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }

      map.set(key, value)
    },
    removeItem(key: string) {
      if (storage.locked) {
        throw new DOMException('Access is denied.', 'SecurityError')
      }

      map.delete(key)
    }
  }

  return storage
}

/**
 * The page's `localStorage`, stubbed: Node 25 and later define a global
 * `localStorage` of their own that shadows jsdom's, so the tests bring one.
 */
let page = memoryStorage()

beforeEach(() => {
  page = memoryStorage()
  vi.stubGlobal('localStorage', page)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the key-value store', () => {
  it('writes under hermie:<base path>: in the page’s own localStorage by default', async () => {
    const store = createKeyValueStore({ namespace: '/hermes' })

    await store.set('bots.order', 'a,b')
    await store.setJson('device.scheme', { scheme: 'dark' })

    expect(store.prefix).toBe('hermie:/hermes:')
    expect(page.getItem('hermie:/hermes:bots.order')).toBe('a,b')
    expect(await store.get('bots.order')).toBe('a,b')
    expect(await store.getJson('device.scheme')).toEqual({ scheme: 'dark' })
    expect(await store.keys()).toEqual(['bots.order', 'device.scheme'])
  })

  it('keeps two base paths apart, and leaves keys that are not its own alone', async () => {
    page.setItem('hermie.language', 'nl')
    page.setItem('dashboard-theme', 'dark')
    const root = createKeyValueStore({ namespace: '/' })
    const prefixed = createKeyValueStore({ namespace: '/hermes' })

    await root.set('layout', 'wide')
    await prefixed.set('layout', 'narrow')

    expect(await root.get('layout')).toBe('wide')
    expect(await prefixed.get('layout')).toBe('narrow')
    expect(await root.keys()).toEqual(['layout'])

    root.clearIdentityBound()
    expect(page.getItem('hermie.language')).toBe('nl')
    expect(page.getItem('dashboard-theme')).toBe('dark')
    expect(await prefixed.get('layout')).toBe('narrow')
  })

  it('drops a value that is not JSON instead of failing over it', async () => {
    const store = createKeyValueStore({ namespace: '/' })
    page.setItem(`${keyValuePrefix('/')}watermarks`, '{not json')

    expect(await store.getJson('watermarks')).toBeNull()
    expect(await store.get('watermarks')).toBeNull()
  })

  it('deletes one key and several', async () => {
    const store = createKeyValueStore({ namespace: '/' })
    await store.set('a', '1')
    await store.set('b', '2')
    await store.set('c', '3')

    await store.delete('a')
    await store.deleteMany(['b', 'c'])

    expect(await store.keys()).toEqual([])
  })

  it('keeps a value the store will not take (full) for the life of the page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = memoryStorage()
    const store = createKeyValueStore({ namespace: '/', storage })

    storage.full = true
    await store.set('device.tint', 'blue')
    await store.set('device.scheme', 'dark')

    expect(await store.get('device.tint')).toBe('blue')
    expect(await store.keys()).toEqual(['device.scheme', 'device.tint'])
    expect(storage.map.size).toBe(0)
    // One line for the page, not one per write.
    expect(console.warn).toHaveBeenCalledTimes(1)

    storage.full = false
    await store.set('device.tint', 'green')
    expect(storage.map.get('hermie:/:device.tint')).toBe('green')
    expect(await store.get('device.tint')).toBe('green')
  })

  it('hides a key the store would not remove', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = memoryStorage()
    const store = createKeyValueStore({ namespace: '/', storage })

    await store.set('bots.order', 'a')
    storage.locked = true
    await store.delete('bots.order')

    expect(await store.get('bots.order')).toBeNull()
    expect(await store.keys()).toEqual([])
  })

  it('works in memory alone when the browser refuses localStorage outright', async () => {
    const store = createKeyValueStore({ namespace: '/', storage: null })

    await store.set('device.tint', 'blue')
    expect(await store.get('device.tint')).toBe('blue')
    expect(await store.keys()).toEqual(['device.tint'])
    expect(store.clearIdentityBound()).toEqual([])
    await store.delete('device.tint')
    expect(await store.get('device.tint')).toBeNull()
  })

  it('treats a localStorage getter that throws as no store', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      }
    })

    const store = createKeyValueStore({ namespace: '/' })

    await store.set('device.tint', 'blue')
    expect(await store.get('device.tint')).toBe('blue')
    expect(page.map.size).toBe(0)
  })
})

describe('sign-out sweep', () => {
  it('removes every key that is not device-local, and keeps the device ones', async () => {
    const store = createKeyValueStore({ namespace: '/' })
    await store.set('device.language', 'nl')
    await store.set('device.installationId', 'abc')
    await store.set('session.owner', 'basic:tester')
    await store.set('watermarks', '{}')
    await store.set('layout.researcher', '{}')

    const removed = store.clearIdentityBound()

    expect(removed).toEqual(['layout.researcher', 'session.owner', 'watermarks'])
    expect(await store.keys()).toEqual(['device.installationId', 'device.language'])
  })

  it('classifies by prefix, failing closed', () => {
    expect(isDeviceLocalKey('device.language')).toBe(true)
    expect(isDeviceLocalKey('devices')).toBe(false)
    expect(isDeviceLocalKey('language')).toBe(false)
  })
})
