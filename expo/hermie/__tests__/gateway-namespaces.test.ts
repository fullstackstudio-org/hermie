/**
 * Nothing belonging to one gateway reaches another.
 *
 * This is the suite the whole namespace idea exists for, so the cases are
 * written as the failure they prevent rather than as the mechanism: sign in to
 * A, sign in to B, look back at A, and find A exactly as it was left with
 * nothing of B's in it. Every store that is keyed by a BOT NAME gets the same
 * treatment, because bot names are a gateway's own and two gateways can each
 * have a `researcher`.
 *
 * The chat cache is the one place that is checked by the statements it issues
 * rather than by a round trip. There is no SQLite engine in this environment,
 * and the thing that could leak is not the data — it is `DELETE FROM bots` with
 * no `WHERE` on it, which a recording double catches exactly.
 */
import { loadGatewaySetup, saveGatewaySetup, clearCredentials, secretKeysFor } from '../src/gateway/config'
import type { ChatCache } from '../src/platform/chat-cache'
import { AUTH_TIMELINE_KEY, createPersistentAuthTimeline } from '../src/gateway/auth-timeline'
import { migrateGatewayStorage } from '../src/gateway/migrate'
import { CHAT_LAYOUT_KEY } from '../src/store/chat-layout'
import { BOT_LAST_SEEN_KEY, useBotsStore } from '../src/store/bots'
import { INSTALLATION_KEY, PUSH_KEY, usePushStore } from '../src/store/push'
import { APPEARANCE_KEY, CHAT_VIEW_KEY, useSettingsStore } from '../src/store/settings'
import { GATEWAY_A, GATEWAY_B, NS_A, NS_B } from './support/gateway-namespace'

const mockDisk = new Map<string, string>()
const mockKeychain = new Map<string, string>()
/** Every statement the chat cache issued, with its parameters. */
const mockSql: { sql: string; params: unknown[] }[] = []

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async (key: string) => mockDisk.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      mockDisk.set(key, value)
    }),
    delete: jest.fn(async (key: string) => {
      mockDisk.delete(key)
    }),
    getJson: jest.fn(async (key: string) => {
      const raw = mockDisk.get(key)

      return raw === undefined ? null : JSON.parse(raw)
    }),
    setJson: jest.fn(async (key: string, value: unknown) => {
      mockDisk.set(key, JSON.stringify(value))
    })
  }
}))

jest.mock('../src/platform/secret-store', () => ({
  secretStore: {
    get: jest.fn(async (key: string) => mockKeychain.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      mockKeychain.set(key, value)
    }),
    delete: jest.fn(async (key: string) => {
      mockKeychain.delete(key)
    })
  }
}))

/**
 * A database that records rather than executes.
 *
 * Enough to answer the question that matters — which key was written, and what
 * a `DELETE` was scoped to — without a SQL engine. `getAllAsync` answering an
 * empty list is right for every case here: the interesting assertions are all
 * about what went OUT.
 */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async (sql: string) => {
      mockSql.push({ sql, params: [] })
    }),
    runAsync: jest.fn(async (sql: string, ...params: unknown[]) => {
      mockSql.push({ sql, params })
    }),
    getFirstAsync: jest.fn(async (sql: string, ...params: unknown[]) => {
      mockSql.push({ sql, params })

      return null
    }),
    getAllAsync: jest.fn(async (sql: string, ...params: unknown[]) => {
      mockSql.push({ sql, params })

      return []
    }),
    withTransactionAsync: jest.fn(async (body: () => Promise<void>) => body())
  }))
}))

const TOKENS_A = {
  accessToken: 'access-A',
  refreshToken: 'refresh-A',
  expiresAt: 4_102_444_800,
  provider: 'self-hosted',
  userId: 'sam'
}
const TOKENS_B = { ...TOKENS_A, accessToken: 'access-B', refreshToken: 'refresh-B', userId: 'robin' }

const CONFIG_A = { baseUrl: 'https://a.example.com', authMode: 'native_pkce' as const }
const CONFIG_B = { baseUrl: 'https://b.example.com', authMode: 'native_pkce' as const }

/** The stores serialise their writes; this waits for the one just queued. */
const settled = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  mockDisk.clear()
  mockKeychain.clear()
  mockSql.length = 0
  useSettingsStore.getState().reset()
  useBotsStore.getState().reset()
  usePushStore.getState().reset()
})

describe('two gateways, two sign-ins', () => {
  it('keeps each gateway’s tokens under its own keys', async () => {
    await saveGatewaySetup(NS_A, { config: CONFIG_A, extraHeaders: {}, tokens: TOKENS_A })
    await saveGatewaySetup(NS_B, { config: CONFIG_B, extraHeaders: {}, tokens: TOKENS_B })

    expect(mockKeychain.get(secretKeysFor(NS_A).accessToken)).toBe('access-A')
    expect(mockKeychain.get(secretKeysFor(NS_B).accessToken)).toBe('access-B')
    // The bare name belongs to nobody now, and nothing may be written under it.
    expect(mockKeychain.get('hermie.auth.access_token')).toBeUndefined()
  })

  it('reads back the gateway it was asked about, not the one signed in to last', async () => {
    await saveGatewaySetup(NS_A, { config: CONFIG_A, extraHeaders: {}, tokens: TOKENS_A })
    await saveGatewaySetup(NS_B, { config: CONFIG_B, extraHeaders: {}, tokens: TOKENS_B })

    expect((await loadGatewaySetup(NS_A))?.config.baseUrl).toBe('https://a.example.com')
    expect((await loadGatewaySetup(NS_B))?.config.baseUrl).toBe('https://b.example.com')
  })

  it('leaves A signed in when B signs out', async () => {
    await saveGatewaySetup(NS_A, { config: CONFIG_A, extraHeaders: {}, tokens: TOKENS_A })
    await saveGatewaySetup(NS_B, { config: CONFIG_B, extraHeaders: {}, tokens: TOKENS_B })

    await clearCredentials(NS_B)

    expect((await loadGatewaySetup(NS_A))?.hasCredentials).toBe(true)
    expect((await loadGatewaySetup(NS_B))?.hasCredentials).toBe(false)
    // And the address survives the sign-out, as it always did.
    expect((await loadGatewaySetup(NS_B))?.config.baseUrl).toBe('https://b.example.com')
  })
})

describe('two gateways, two sets of preferences', () => {
  it('does not carry a per-chat override across', async () => {
    await useSettingsStore.getState().hydrate(NS_A)
    useSettingsStore.getState().setChatView('researcher', { level: 'verbose' })
    await settled()

    // Both gateways have a `researcher`. That is the whole point of the case.
    await useSettingsStore.getState().hydrate(NS_B)

    expect(useSettingsStore.getState().perChat.researcher).toBeUndefined()

    await useSettingsStore.getState().hydrate(NS_A)

    expect(useSettingsStore.getState().perChat.researcher).toEqual({ level: 'verbose' })
  })

  it('keeps light-or-dark on the device, whichever gateway is live', async () => {
    await useSettingsStore.getState().hydrate(NS_A)
    useSettingsStore.getState().setAppearance('dark')
    // One gateway-scoped write beside it, so the assertion below is about what
    // that blob does NOT contain rather than about it not existing.
    useSettingsStore.getState().setDefaults({ level: 'verbose' })
    await settled()

    useSettingsStore.getState().reset()
    await useSettingsStore.getState().hydrateAppearance()

    // Written where no gateway id can reach it, and read back without one —
    // which is the whole point: `ThemeProvider` sits above the gateway and has
    // no id to ask with. `hideHandleWhenNamed` rides along under the same key
    // (HERM-110) at whatever it already was — the reset above leaves it at its
    // default.
    expect(mockDisk.get(APPEARANCE_KEY)).toBe(JSON.stringify({ appearance: 'dark', hideHandleWhenNamed: true }))
    expect(mockDisk.get(NS_A.key(CHAT_VIEW_KEY))).not.toContain('appearance')
    expect(useSettingsStore.getState().appearance).toBe('dark')
  })

  it('does not carry a read watermark across', async () => {
    await useBotsStore.getState().hydrateLastSeen(NS_A)
    useBotsStore.getState().markSeen('researcher', 1_700_000_000)
    await settled()

    await useBotsStore.getState().hydrateLastSeen(NS_B)

    expect(useBotsStore.getState().lastSeen.researcher).toBeUndefined()

    await useBotsStore.getState().hydrateLastSeen(NS_A)

    expect(useBotsStore.getState().lastSeen.researcher).toBe(1_700_000_000)
  })

  it('gives each gateway its own auth ring', async () => {
    const ringA = await createPersistentAuthTimeline(NS_A)
    ringA.record({ event: 'ws.closed', closeCode: 4401 })

    const ringB = await createPersistentAuthTimeline(NS_B)

    expect(ringB.snapshot().events).toEqual([])
    expect(mockDisk.has(NS_A.key(AUTH_TIMELINE_KEY))).toBe(true)
    expect(mockDisk.has(AUTH_TIMELINE_KEY)).toBe(false)
  })
})

describe('the push registration', () => {
  it('is per gateway, and the installation id is not', async () => {
    await usePushStore.getState().hydrate(NS_A)

    const id = usePushStore.getState().installationId

    usePushStore.getState().setEnabled(true)
    await settled()

    await usePushStore.getState().hydrate(NS_B)

    // A registration is only meaningful for the gateway it was made on…
    expect(usePushStore.getState().enabled).toBe(false)
    // …and the id is this DEVICE's, so it is the same one on both.
    expect(usePushStore.getState().installationId).toBe(id)

    await usePushStore.getState().hydrate(NS_A)

    expect(usePushStore.getState().enabled).toBe(true)
    expect(usePushStore.getState().installationId).toBe(id)
    expect(mockDisk.get(INSTALLATION_KEY)).toBe(JSON.stringify({ installationId: id }))
  })
})

describe('the cached transcripts and roster', () => {
  it('keys every row by the gateway, and scopes the roster’s replacement to it', async () => {
    const { chatCacheFor } = require('../src/platform/chat-cache') as {
      chatCacheFor: (id: string) => ChatCache
    }

    await chatCacheFor(GATEWAY_A).write({
      bot: 'researcher',
      itemsJson: '[]',
      lastRowId: 1,
      lastSeq: 1,
      epoch: null,
      updatedAt: 1
    })
    await chatCacheFor(GATEWAY_B).read('researcher')
    await chatCacheFor(GATEWAY_B).writeBots([{ name: 'researcher', json: '{}', avatarRev: 0, updatedAt: 1 }])

    const wrote = mockSql.find(entry => entry.sql.includes('INSERT INTO transcripts'))
    const read = mockSql.find(entry => entry.sql.includes('SELECT * FROM transcripts'))
    const cleared = mockSql.find(entry => entry.sql.startsWith('DELETE FROM bots'))

    expect(wrote?.params[0]).toBe(`${GATEWAY_A}:researcher`)
    expect(read?.params[0]).toBe(`${GATEWAY_B}:researcher`)
    // The one that could empty every other gateway's cached list.
    expect(cleared?.sql).toContain('WHERE ns = ?')
    expect(cleared?.params).toEqual([GATEWAY_B])
  })

  it('never issues a roster read that is not scoped to one gateway', async () => {
    const { chatCacheFor } = require('../src/platform/chat-cache') as {
      chatCacheFor: (id: string) => ChatCache
    }

    await chatCacheFor(GATEWAY_A).readBots()

    const reads = mockSql.filter(entry => entry.sql.includes('FROM bots'))

    expect(reads).not.toHaveLength(0)

    for (const read of reads) {
      expect(read.sql).toContain('ns = ?')
    }
  })
})

describe('the one-time move off the unsuffixed keys', () => {
  const legacy = () => {
    mockDisk.set('hermie.gateway.config', JSON.stringify(CONFIG_A))
    mockDisk.set('hermie.gateway.auth_timeline', JSON.stringify({ events: [{ event: 'dial.start' }] }))
    mockDisk.set('hermie.bots.last_seen', JSON.stringify({ researcher: 7 }))
    mockDisk.set(CHAT_VIEW_KEY, JSON.stringify({ defaults: {}, perChat: {}, appearance: 'dark' }))
    mockDisk.set(PUSH_KEY, JSON.stringify({ installationId: 'ilegacy', enabled: true, types: {}, preview: false }))
    mockDisk.set(CHAT_LAYOUT_KEY, JSON.stringify({ [CONFIG_A.baseUrl]: { entries: [], archived: [], accents: {} } }))
    mockKeychain.set('hermie.auth.access_token', 'access-legacy')
    mockKeychain.set('hermie.auth.refresh_token', 'refresh-legacy')
  }

  it('carries the configuration, the ring and the watermarks under the first gateway’s id', async () => {
    legacy()

    await migrateGatewayStorage(NS_A, CONFIG_A.baseUrl)

    expect(mockDisk.has(NS_A.key('hermie.gateway.config'))).toBe(true)
    expect(mockDisk.has(NS_A.key(AUTH_TIMELINE_KEY))).toBe(true)
    expect(mockDisk.get(NS_A.key(BOT_LAST_SEEN_KEY))).toBe(JSON.stringify({ researcher: 7 }))
    // Moved, not copied: a key left behind is one a later build adopts as
    // "the one nobody claimed".
    expect(mockDisk.has('hermie.gateway.config')).toBe(false)
    expect(mockDisk.has('hermie.bots.last_seen')).toBe(false)
  })

  it('splits the two fields that were never about a gateway out to their own keys', async () => {
    legacy()

    await migrateGatewayStorage(NS_A, CONFIG_A.baseUrl)

    expect(mockDisk.get(APPEARANCE_KEY)).toBe(JSON.stringify({ appearance: 'dark' }))
    expect(mockDisk.get(INSTALLATION_KEY)).toBe(JSON.stringify({ installationId: 'ilegacy' }))
    expect(JSON.parse(mockDisk.get(NS_A.key(CHAT_VIEW_KEY))!)).not.toHaveProperty('appearance')
    expect(JSON.parse(mockDisk.get(NS_A.key(PUSH_KEY))!)).not.toHaveProperty('installationId')
    // The registration itself still moves across, switch and all.
    expect(JSON.parse(mockDisk.get(NS_A.key(PUSH_KEY))!).enabled).toBe(true)
  })

  it('re-keys the arrangement from the address it was stored under to the id', async () => {
    legacy()

    await migrateGatewayStorage(NS_A, CONFIG_A.baseUrl)

    const layouts = JSON.parse(mockDisk.get(CHAT_LAYOUT_KEY)!)

    expect(Object.keys(layouts)).toEqual([GATEWAY_A])
  })

  it('moves the keychain items, leaving nothing under the bare names', async () => {
    legacy()

    await migrateGatewayStorage(NS_A, CONFIG_A.baseUrl)

    expect(mockKeychain.get(secretKeysFor(NS_A).accessToken)).toBe('access-legacy')
    expect(mockKeychain.get(secretKeysFor(NS_A).refreshToken)).toBe('refresh-legacy')
    expect(mockKeychain.has('hermie.auth.access_token')).toBe(false)
    expect(mockKeychain.has('hermie.auth.refresh_token')).toBe(false)
  })

  it('leaves a device with nothing stored with nothing stored', async () => {
    await migrateGatewayStorage(NS_B, 'https://b.example.com')

    expect(mockDisk.size).toBe(0)
    expect(mockKeychain.size).toBe(0)
  })
})
