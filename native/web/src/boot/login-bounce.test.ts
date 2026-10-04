import { describe, expect, it, vi } from 'vitest'

import { IndexedDbChatCache, FallbackChatCache, type CachedTranscriptRow } from '../platform/chat-cache'
import { createKeyValueStore } from '../platform/key-value-store'
import { createFakeIndexedDb } from '../test-support/fake-indexed-db'
import { deriveBasePath, type ResolvedBasePath } from './base-path'
import {
  type BounceEnvironment,
  claimForOwner,
  createEnrolStash,
  enrolStashKey,
  forgetToken,
  isCarriableRoute,
  loginUrl,
  OWNER_KEY,
  reauthLoginUrl,
  reauthSignIn,
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

describe('forgetting the token of a gateway without sign-in', () => {
  it('clears what signing out clears, and goes nowhere', async () => {
    const { cache, store, storage } = await signedInBrowser()
    const tab = page(ROOT.appPath, '#/chat/researcher')
    tab.stash.set(routeStashKey(ROOT), '#/chat/researcher')

    await forgetToken({ basePath: ROOT, cache, store, environment: tab.environment })

    expect(await cache.read('researcher')).toBeNull()
    expect(await cache.readBots()).toEqual([])
    expect([...storage.map.keys()].sort()).toEqual(['hermie:/:device.installationId', 'hermie:/:device.language'])
    expect(tab.stash.size).toBe(0)
    // There is no gateway sign-in page to go to: the caller asks for the token.
    expect(tab.assigned).toEqual([])
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

describe('the sign-in bounce of a self-enrolment', () => {
  const GRANT = 'R3JhbnRJZDEyMzQ1Njc4OQ'
  const LOGIN_PATH = `/auth/login?provider=self-hosted&reauth=${GRANT}`

  it('goes to the gateway’s login_path with the page’s own path as next', () => {
    expect(reauthLoginUrl(ROOT, LOGIN_PATH)).toBe(`${LOGIN_PATH}&next=%2Fdashboard-plugins%2Fhermie%2Fapp%2Findex.html`)
  })

  it('keeps a prefix the gateway put in the path, and replaces a next it did not ask for', () => {
    expect(reauthLoginUrl(PREFIXED, `/hermes${LOGIN_PATH}&next=%2Fevil`)).toBe(
      `/hermes${LOGIN_PATH}&next=%2Fhermes%2Fdashboard-plugins%2Fhermie%2Fapp%2Findex.html`
    )
  })

  it.each([
    ['another origin', `https://evil.example/auth/login?reauth=${GRANT}`],
    ['a protocol-relative URL', `//evil.example/auth/login?reauth=${GRANT}`],
    ['a backslash path', `/\\evil.example/auth/login?reauth=${GRANT}`],
    ['a path that is not the sign-in page', `/api/auth/passkeys?reauth=${GRANT}`],
    ['a relative path', `auth/login?reauth=${GRANT}`],
    ['nothing', '']
  ])('goes nowhere for %s', (_name, path) => {
    const before = page(ROOT.appPath, '#/settings/passkeys')

    expect(reauthLoginUrl(ROOT, path)).toBeNull()
    expect(reauthSignIn(ROOT, path, before.environment)).toBe(false)
    expect(before.assigned).toEqual([])
    expect(before.stash.size).toBe(0)
  })

  it('carries the route across the sign-in the way signIn does, and leaves with the grant on the URL', () => {
    const before = page(ROOT.appPath, '#/settings/passkeys')

    expect(reauthSignIn(ROOT, LOGIN_PATH, before.environment)).toBe(true)
    expect(before.assigned).toEqual([`${LOGIN_PATH}&next=${encodeURIComponent(ROOT.appPath)}`])
    expect(before.stash.get(routeStashKey(ROOT))).toBe('#/settings/passkeys')

    const after = afterSignIn(before, ROOT.appPath)

    expect(restoreRoute(ROOT, after.environment)).toBe('#/settings/passkeys')
  })
})

describe('the self-enrolment stash', () => {
  const GRANT = 'R3JhbnRJZDEyMzQ1Njc4OQ'

  it('keeps the grant id and its deadline in this tab, under its own key next to the route’s', () => {
    const tab = page(ROOT.appPath)
    const stash = createEnrolStash(ROOT, tab.environment)

    expect(stash.read()).toBeNull()
    expect(stash.write({ grantId: GRANT, expiresAt: 1_790_000_600 })).toBe(true)
    expect(enrolStashKey(ROOT)).toBe(`hermie:${ROOT.namespace}:passkey-enrol`)
    expect([...tab.stash.keys()]).toEqual([enrolStashKey(ROOT)])
    // Nothing but the id and the deadline.
    expect(JSON.parse(tab.stash.get(enrolStashKey(ROOT)) ?? '{}')).toEqual({
      grant_id: GRANT,
      expires_at: 1_790_000_600
    })
    expect(stash.read()).toEqual({ grantId: GRANT, expiresAt: 1_790_000_600 })

    stash.clear()

    expect(stash.read()).toBeNull()
    expect(tab.stash.size).toBe(0)
  })

  it('survives the trip through the sign-in page (the same tab)', () => {
    const before = page(ROOT.appPath, '#/settings/passkeys')

    createEnrolStash(ROOT, before.environment).write({ grantId: GRANT, expiresAt: 1_790_000_600 })
    reauthSignIn(ROOT, `/auth/login?provider=self-hosted&reauth=${GRANT}`, before.environment)

    const after = afterSignIn(before, ROOT.appPath)

    expect(createEnrolStash(ROOT, after.environment).read()).toEqual({ grantId: GRANT, expiresAt: 1_790_000_600 })
  })

  it('keeps two base paths’ stashes apart', () => {
    const tab = page(ROOT.appPath)

    createEnrolStash(ROOT, tab.environment).write({ grantId: GRANT, expiresAt: 1 })

    expect(createEnrolStash(PREFIXED, tab.environment).read()).toBeNull()
  })

  it.each([
    ['not JSON', 'nope'],
    ['no deadline', JSON.stringify({ grant_id: GRANT })],
    ['a deadline that is not a number', JSON.stringify({ grant_id: GRANT, expires_at: '9' })],
    ['an id that is not one', JSON.stringify({ grant_id: 'a b', expires_at: 9 })],
    ['an extra secret field is ignored but the rest is not an object', 'null']
  ])('is not a stash when it holds %s, and is removed', (_name, raw) => {
    const tab = page(ROOT.appPath)

    tab.stash.set(enrolStashKey(ROOT), raw)

    expect(createEnrolStash(ROOT, tab.environment).read()).toBeNull()
    expect(tab.stash.has(enrolStashKey(ROOT))).toBe(false)
  })

  it('reports that nothing was kept when the browser refuses sessionStorage', () => {
    const tab = page(ROOT.appPath)
    const refusing: BounceEnvironment = {
      ...tab.environment,
      sessionStorage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
        removeItem: () => {
          throw new Error('denied')
        }
      }
    }
    const stash = createEnrolStash(ROOT, refusing)

    expect(stash.write({ grantId: GRANT, expiresAt: 9 })).toBe(false)
    expect(stash.read()).toBeNull()
    expect(() => stash.clear()).not.toThrow()

    const none = createEnrolStash(ROOT, { ...tab.environment, sessionStorage: null })

    expect(none.write({ grantId: GRANT, expiresAt: 9 })).toBe(false)
  })

  it('is cleared by signing out and by forgetting the token', async () => {
    for (const leave of ['signOut', 'forgetToken'] as const) {
      const { cache, store } = await signedInBrowser()
      const tab = page(ROOT.appPath)

      createEnrolStash(ROOT, tab.environment).write({ grantId: GRANT, expiresAt: 9 })

      if (leave === 'signOut') {
        await signOut({
          basePath: ROOT,
          credentials: { signOut: async () => undefined },
          cache,
          store,
          environment: tab.environment
        })
      } else {
        await forgetToken({ basePath: ROOT, cache, store, environment: tab.environment })
      }

      expect(tab.stash.size).toBe(0)
    }
  })
})
