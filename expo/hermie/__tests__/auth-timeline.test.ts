import type { TokenSet } from '@hermie/gateway-client'

import { AUTH_TIMELINE_KEY, createPersistentAuthTimeline } from '../src/gateway/auth-timeline'
import { createSecretTokenStore } from '../src/gateway/client'
import { secretKeysFor } from '../src/gateway/config'
import { useConnectionStore } from '../src/gateway/store'
import { keyValueStore } from '../src/platform/key-value-store'
import { secretStore } from '../src/platform/secret-store'
import { NS_A } from './support/gateway-namespace'

/** Every credential and every ring belongs to one gateway; this is that one. */
const KEYS = secretKeysFor(NS_A)
const RING_KEY = NS_A.key(AUTH_TIMELINE_KEY)

const mockWrites: string[] = []
let mockFailWrites: Set<string>

jest.mock('../src/platform/secret-store', () => ({
  secretStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async (key: string) => {
      mockWrites.push(key)

      if (mockFailWrites.has(key)) {
        throw new Error(`keychain refused ${key}`)
      }
    }),
    delete: jest.fn(async () => undefined)
  }
}))

jest.mock('../src/platform/key-value-store', () => {
  const values = new Map<string, string>()

  return {
    keyValueStore: {
      get: jest.fn(async (key: string) => values.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => void values.set(key, value)),
      delete: jest.fn(async (key: string) => void values.delete(key)),
      getJson: jest.fn(async (key: string) => {
        const raw = values.get(key)

        return raw === undefined ? null : JSON.parse(raw)
      }),
      setJson: jest.fn(async (key: string, value: unknown) => void values.set(key, JSON.stringify(value)))
    }
  }
})

const tokens = (over: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'at-2',
  refreshToken: 'rt-2',
  expiresAt: 1_800_000_000,
  provider: 'self-hosted',
  userId: 'tester',
  ...over
})

beforeEach(async () => {
  mockWrites.length = 0
  mockFailWrites = new Set()
  jest.clearAllMocks()
  await keyValueStore.delete(RING_KEY)
  useConnectionStore.getState().setAuthTimeline({ events: [], lastSignOut: null })
})

/**
 * Three keys, three writes, and therefore a partial write to reason about.
 *
 * Rotation makes the two partial outcomes wildly unequal: the refresh token just
 * spent is dead at the identity provider, so landing the new ACCESS token without
 * the new REFRESH token leaves a session that works until the access token lapses
 * and then cannot be renewed at all — and on a provider with reuse detection,
 * presenting that dead token revokes the session outright. The reverse lands a
 * usable refresh token beside a stale access token, which recovers by itself.
 */
describe('the secret token store', () => {
  it('writes the refresh token before anything else', async () => {
    await createSecretTokenStore(NS_A).save(tokens())

    expect(mockWrites[0]).toBe(KEYS.refreshToken)
    expect(mockWrites).toHaveLength(3)
  })

  it('does not overwrite the access token when the refresh token could not be stored', async () => {
    mockFailWrites.add(KEYS.refreshToken)

    await expect(createSecretTokenStore(NS_A).save(tokens())).rejects.toThrow('keychain refused')

    // The store still holds a consistent older pair rather than a new access
    // token beside a refresh token the gateway has already rotated away.
    expect(mockWrites).toEqual([KEYS.refreshToken])
    expect(secretStore.set).toHaveBeenCalledTimes(1)
  })
})

describe('the persistent auth timeline', () => {
  it('publishes every event to the connection store', async () => {
    const timeline = await createPersistentAuthTimeline(NS_A)

    timeline.record({ event: 'dial.start' })
    timeline.record({ event: 'ws.closed', closeCode: 4401 })

    expect(useConnectionStore.getState().authTimeline.events.map(entry => entry.event)).toEqual([
      'dial.start',
      'ws.closed'
    ])
  })

  /**
   * The restart is the point. A sign-out is normally followed by one, so a ring
   * that lives only in memory is empty exactly when it is asked the question it
   * was built for.
   */
  it('survives the restart that follows a sign-out', async () => {
    const before = await createPersistentAuthTimeline(NS_A)

    before.record({ event: 'refresh.failed', kind: 'auth', status: 401 })
    before.record({ event: 'token.cleared', reason: 'refresh_rejected' })
    before.signOut('rejected_after_refresh')

    expect(before.signOutReason).toBe('refresh_rejected')

    // A fresh process reading the same key-value store.
    const after = await createPersistentAuthTimeline(NS_A)

    expect(after.signOutReason).toBe('refresh_rejected')
    expect(after.snapshot().events.map(entry => entry.event)).toContain('signin.required')
  })

  it('keeps the ring out of the secret store', async () => {
    const timeline = await createPersistentAuthTimeline(NS_A)

    timeline.record({ event: 'dial.start' })

    expect(secretStore.set).not.toHaveBeenCalled()
    expect(keyValueStore.setJson).toHaveBeenCalledWith(RING_KEY, expect.anything())
  })

  it('starts empty rather than failing when the stored ring cannot be read', async () => {
    ;(keyValueStore.getJson as jest.Mock).mockRejectedValueOnce(new Error('unreadable'))

    const timeline = await createPersistentAuthTimeline(NS_A)

    expect(timeline.snapshot().events).toEqual([])
  })

  /**
   * Nothing recorded may be a credential, because the whole value of the ring is
   * that it can be pasted into an issue without anybody having to check first.
   */
  it('records no token values', async () => {
    const timeline = await createPersistentAuthTimeline(NS_A)

    timeline.record({ event: 'token.served', expiresIn: 3599 })
    timeline.record({ event: 'refresh.ok', expiresIn: 3600 })

    const written = JSON.stringify(useConnectionStore.getState().authTimeline)

    expect(written).not.toContain('at-')
    expect(written).not.toContain('rt-')
    expect(written).toContain('3599')
  })
})
