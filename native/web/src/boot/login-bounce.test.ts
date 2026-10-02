import { describe, expect, it, vi } from 'vitest'

import { IndexedDbChatCache, FallbackChatCache, type CachedTranscriptRow } from '../platform/chat-cache'
import { createKeyValueStore } from '../platform/key-value-store'
import { createFakeIndexedDb } from '../test-support/fake-indexed-db'
import { deriveBasePath, type ResolvedBasePath } from './base-path'
import {
  type BounceEnvironment,
  claimForOwner,
  isCarriableRoute,
  loginUrl,
  OWNER_KEY,
  restoreRoute,
  routeStashKey,
  signIn,
  signOut
} from './login-bounce'

const resolved = (pathname: string): ResolvedBasePath => {
  const basePath = deriveBasePath({ origin: 'https://gateway.example.com', pathname })

  if (!basePath.ok) {
    throw new Error(`not a client path: ${pathname}`)
  }

  return basePath
}

const ROOT = resolved('/dashboard-plugins/hermie/app/index.html')
const PREFIXED = resolved('/hermes/dashboard-plugins/hermie/app/index.html')

/** A page: a location that records where it was sent, a history, and a `sessionStorage`. */
function page(pathname: string, hash = '') {
  const stash = new Map<string, string>()
  const assigned: string[] = []
  const location = { pathname, search: '', hash, assign: (url: string) => assigned.push(url) }
  const environment: BounceEnvironment = {
    location,
    history: {
      state: null,
      replaceState(_data, _unused, url) {
        const next = new URL(String(url), 'https://gateway.example.com')
        location.pathname = next.pathname
        location.search = next.search
        location.hash = next.hash
      }
    },
    sessionStorage: {
      getItem: key => stash.get(key) ?? null,
      setItem: (key, value) => void stash.set(key, value),
      removeItem: key => void stash.delete(key)
    }
  }

  return { environment, location, stash, assigned }
}

/** A browser that has been signed out: the same tab's stash, a fresh location without the fragment. */
function afterSignIn(before: ReturnType<typeof page>, pathname: string) {
  const after = page(pathname)
  for (const [key, value] of before.stash) {
    after.stash.set(key, value)
  }

  return after
}

describe('the sign-in bounce', () => {
  it('goes to the gateway’s sign-in page with the page’s own path as next, prefix included', () => {
    expect(loginUrl(ROOT)).toBe('/login?next=%2Fdashboard-plugins%2Fhermie%2Fapp%2Findex.html')
    expect(loginUrl(PREFIXED)).toBe('/hermes/login?next=%2Fhermes%2Fdashboard-plugins%2Fhermie%2Fapp%2Findex.html')
  })

  it('carries the route across the sign-in and puts it back once', () => {
    const before = page(PREFIXED.appPath, '#/chat/researcher/s/abc')

    signIn(PREFIXED, before.environment)

    expect(before.assigned).toEqual([loginUrl(PREFIXED)])
    expect(before.stash.get(routeStashKey(PREFIXED))).toBe('#/chat/researcher/s/abc')

    // `/login` sends the browser back to `next`, which has no fragment.
    const after = afterSignIn(before, PREFIXED.appPath)

    expect(restoreRoute(PREFIXED, after.environment)).toBe('#/chat/researcher/s/abc')
    expect(after.location.hash).toBe('#/chat/researcher/s/abc')
    expect(after.location.pathname).toBe(PREFIXED.appPath)
    expect(after.stash.size).toBe(0)

    // Once: a reload does not put it back again.
    after.location.hash = ''
    expect(restoreRoute(PREFIXED, after.environment)).toBe('')
    expect(after.location.hash).toBe('')
  })

  it('lets a fragment already in the address win, and still drops the stash', () => {
    const before = page(ROOT.appPath, '#/chat/researcher')
    signIn(ROOT, before.environment)

    const after = afterSignIn(before, ROOT.appPath)
    after.location.hash = '#/settings/appearance'

    expect(restoreRoute(ROOT, after.environment)).toBe('#/settings/appearance')
    expect(after.stash.size).toBe(0)
  })

  it('carries only a route of ours', () => {
    for (const hash of ['', '#', '#/', '#token=abc', '#/chat/a b', `#/${'x'.repeat(3000)}`, '#/chat/é']) {
      expect(isCarriableRoute(hash), hash).toBe(false)
    }

    expect(isCarriableRoute('#/chat/researcher/s/20260101_abc')).toBe(true)

    const before = page(ROOT.appPath, '#access_token=abc')
    signIn(ROOT, before.environment)
    expect(before.stash.size).toBe(0)

    const tampered = page(ROOT.appPath)
    tampered.stash.set(routeStashKey(ROOT), 'javascript:alert(1)')
    expect(restoreRoute(ROOT, tampered.environment)).toBe('')
    expect(tampered.location.hash).toBe('')
  })

  it('keeps two base paths’ stashes apart', () => {
    expect(routeStashKey(ROOT)).toBe('hermie:/:route')
    expect(routeStashKey(PREFIXED)).toBe('hermie:/hermes:route')
  })

  it('still signs in when the browser refuses sessionStorage', () => {
    const tab = page(ROOT.appPath, '#/chat/researcher')
    const refusing: BounceEnvironment = {
      ...tab.environment,
      sessionStorage: {
        getItem: () => {
          throw new DOMException('denied', 'SecurityError')
        },
        setItem: () => {
          throw new DOMException('denied', 'SecurityError')
        },
        removeItem: () => {
          throw new DOMException('denied', 'SecurityError')
        }
      }
    }

    signIn(ROOT, refusing)
    expect(tab.assigned).toEqual([loginUrl(ROOT)])
    expect(restoreRoute(ROOT, { ...refusing, location: { ...tab.location, hash: '' } })).toBe('')
    expect(restoreRoute(ROOT, { ...tab.environment, sessionStorage: null })).toBe('#/chat/researcher')
  })
})

const row = (bot: string): CachedTranscriptRow => ({
  bot,
  itemsJson: '{"format":1,"items":[]}',
  lastRowId: 1,
  lastSeq: 1,
  epoch: null,
  updatedAt: 1
})

function memoryStorage() {
  const map = new Map<string, string>()

  return {
    map,
    get length() {
      return map.size
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key)
  }
}

async function signedInBrowser() {
  const idb = createFakeIndexedDb()
  const cache = new FallbackChatCache(new IndexedDbChatCache(ROOT.namespace, idb.factory))
  const storage = memoryStorage()
  const store = createKeyValueStore({ namespace: ROOT.namespace, storage })

  await cache.write(row('researcher'))
  await cache.writeBots([{ name: 'researcher', json: '{}', avatarRev: 0, updatedAt: 1 }])
  store.setSync('device.language', 'nl')
  store.setSync('device.installationId', 'abc123')
  store.setSync(OWNER_KEY, 'basic:tester')
  store.setSync('watermarks', '{"researcher":42}')
  store.setSync('layout.researcher', '{"split":0.4}')

  return { cache, store, storage }
}

describe('signing out', () => {
  it('ends the session at the gateway, clears the cache and the identity-bound settings, and leaves for /login', async () => {
    const { cache, store, storage } = await signedInBrowser()
    const tab = page(ROOT.appPath, '#/chat/researcher')
    tab.stash.set(routeStashKey(ROOT), '#/chat/researcher')
    const credentials = { signOut: vi.fn(async () => {}) }

    await signOut({ basePath: ROOT, credentials, cache, store, environment: tab.environment })

    expect(credentials.signOut).toHaveBeenCalledTimes(1)
    expect(await cache.read('researcher')).toBeNull()
    expect(await cache.readBots()).toEqual([])
    expect(await store.keys()).toEqual(['device.installationId', 'device.language'])
    expect([...storage.map.keys()].sort()).toEqual(['hermie:/:device.installationId', 'hermie:/:device.language'])
    expect(tab.stash.size).toBe(0)
    expect(tab.assigned).toEqual([loginUrl(ROOT)])
  })

  it('clears this browser even when the gateway never heard the sign-out', async () => {
    const { cache, store } = await signedInBrowser()
    const tab = page(ROOT.appPath)

    await signOut({
      basePath: ROOT,
      credentials: { signOut: () => Promise.reject(new Error('offline')) },
      cache,
      store,
      environment: tab.environment
    })

    expect(await cache.read('researcher')).toBeNull()
    expect(store.getSync('watermarks')).toBeNull()
    expect(tab.assigned).toEqual([loginUrl(ROOT)])
  })

  it('clears before it leaves, so nothing is left if the navigation is the last thing that runs', async () => {
    const { cache, store } = await signedInBrowser()
    const order: string[] = []
    const tab = page(ROOT.appPath)
    tab.environment.location.assign = () => {
      order.push(store.getSync('watermarks') === null ? 'cleared then left' : 'left first')
    }

    await signOut({
      basePath: ROOT,
      credentials: { signOut: async () => {} },
      cache,
      store,
      environment: tab.environment
    })

    expect(order).toEqual(['cleared then left'])
  })
})

describe('the owner of the stored state', () => {
  it('keeps the state for the person it was written for', async () => {
    const { cache, store } = await signedInBrowser()

    expect(await claimForOwner({ cache, store }, 'basic:tester')).toBe(false)
    expect(await cache.read('researcher')).not.toBeNull()
    expect(store.getSync('watermarks')).not.toBeNull()
  })

  it('clears it when somebody else signs in without a sign-out in between', async () => {
    const { cache, store } = await signedInBrowser()

    expect(await claimForOwner({ cache, store }, 'basic:other')).toBe(true)
    expect(await cache.read('researcher')).toBeNull()
    expect(store.getSync('watermarks')).toBeNull()
    expect(store.getSync('device.language')).toBe('nl')
    expect(store.getSync(OWNER_KEY)).toBe('basic:other')
  })

  it('clears state nobody claimed, and treats "no identity" as an owner of its own', async () => {
    const { cache, store } = await signedInBrowser()
    store.deleteSync(OWNER_KEY)

    expect(await claimForOwner({ cache, store }, undefined)).toBe(true)
    expect(await cache.read('researcher')).toBeNull()
    expect(await claimForOwner({ cache, store }, undefined)).toBe(false)
    expect(await claimForOwner({ cache, store }, 'basic:tester')).toBe(true)
  })
})
