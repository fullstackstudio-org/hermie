/**
 * Setting up a gateway either happens completely or leaves nothing behind.
 *
 * The bug this suite is written from was silent and it accumulated: the
 * configuration was written first, a keychain write then rejected, and the
 * caller never reached the line that would have recorded the gateway's id. Each
 * launch minted a fresh id and left one more `hermie.gateway.config@<id>` that
 * nothing would ever read — fifty on one simulator, thirty-nine on another —
 * while the app dropped onto the Welcome screen saying nothing at all.
 *
 * So three things are checked, and they are the three halves of "never again":
 * a failure leaves the disk as it found it, it is a typed failure the wizard can
 * phrase, and the orphans already out there are reclaimed.
 */
import {
  CONFIG_KEY,
  configKeyFor,
  isSecretStoreWriteError,
  loadGatewaySetup,
  saveGatewaySetup,
  type StoredGatewayConfig
} from '../src/gateway/config'
import { namespace } from '../src/gateway/namespace'
import {
  addGateway,
  EMPTY_REGISTRY,
  GATEWAY_REGISTRY_KEY,
  type GatewayRecord,
  saveGatewayAndRegister,
  sweepOrphanGatewayConfigs
} from '../src/gateway/registry'
import { GATEWAY_A, GATEWAY_B, NS_A } from './support/gateway-namespace'

const mockDisk = new Map<string, string>()
const mockKeychain = new Map<string, string>()

/** Keys whose write rejects, and with what. Empty means the keychain behaves. */
const mockRefusals = new Map<string, string>()
/** Set when the keychain should refuse DELETES too, as a broken one would. */
let mockRefuseDeletes = false
/**
 * Set when EVERY write should refuse, which is the unsigned-build case.
 *
 * A flag rather than a `mockRejectedValue` on the double, because an
 * implementation swapped onto a shared mock outlives `clearAllMocks` and the
 * next test in the file then inherits a keychain that refuses everything.
 */
let mockRefuseAllWrites = false

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
    }),
    keys: jest.fn(async () => [...mockDisk.keys()]),
    deleteMany: jest.fn(async (keys: readonly string[]) => {
      keys.forEach(key => mockDisk.delete(key))
    })
  }
}))

jest.mock('../src/platform/secret-store', () => ({
  secretStore: {
    get: jest.fn(async (key: string) => mockKeychain.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      const refusal = mockRefuseAllWrites ? MOCK_REFUSAL : mockRefusals.get(key)

      if (refusal) {
        throw new Error(refusal)
      }

      mockKeychain.set(key, value)
    }),
    delete: jest.fn(async (key: string) => {
      if (mockRefuseDeletes) {
        throw new Error('the keychain refused the delete as well')
      }

      mockKeychain.delete(key)
    })
  }
}))

const CONFIG: StoredGatewayConfig = {
  baseUrl: 'https://hermes.example.com',
  authMode: 'session_token',
  provider: 'self-hosted'
}

/**
 * The message the secret store actually produced on the simulator, verbatim.
 *
 * Not a stand-in, because the whole point of carrying a reason through is that
 * the platform's own words reach the reader: a test with "boom" in it would
 * pass just as happily if the reason were dropped on the way. This particular
 * sentence is also the round's finding — the refusal was never about an
 * entitlement, it was the `@` in a namespaced key, which `expo-secure-store`
 * rejects before the keychain is touched. See `secret-store-keys.test.ts`.
 */
const MOCK_REFUSAL =
  'Invalid key provided to SecureStore. Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".'

beforeEach(() => {
  mockDisk.clear()
  mockKeychain.clear()
  mockRefusals.clear()
  mockRefuseDeletes = false
  mockRefuseAllWrites = false
  jest.clearAllMocks()
})

describe('a secret store that refuses', () => {
  it('writes no configuration, so the failure leaves no orphan behind', async () => {
    mockRefusals.set(NS_A.secretKey('hermie.auth.session_token'), MOCK_REFUSAL)

    await expect(
      saveGatewaySetup(NS_A, { config: CONFIG, extraHeaders: {}, sessionToken: 'devtoken' })
    ).rejects.toThrow()

    expect(mockDisk.get(configKeyFor(NS_A))).toBeUndefined()
    expect([...mockDisk.keys()]).toEqual([])
  })

  it('takes back the secrets that did land, so nothing half-written survives', async () => {
    mockRefusals.set(NS_A.secretKey('hermie.auth.session_token'), MOCK_REFUSAL)

    await expect(
      saveGatewaySetup(NS_A, {
        config: CONFIG,
        extraHeaders: { 'X-Team': 'hermie' },
        sessionToken: 'devtoken'
      })
    ).rejects.toThrow()

    // The header blob is written before the session token and would have
    // survived a bare rethrow.
    expect([...mockKeychain.keys()]).toEqual([])
  })

  it('throws a typed error carrying the platform’s own reason', async () => {
    mockRefusals.set(NS_A.secretKey('hermie.auth.session_token'), MOCK_REFUSAL)

    const error: unknown = await saveGatewaySetup(NS_A, {
      config: CONFIG,
      extraHeaders: {},
      sessionToken: 'devtoken'
    }).catch((caught: unknown) => caught)

    expect(isSecretStoreWriteError(error)).toBe(true)
    // The OSStatus sentence reaches the wizard intact; without it the screen
    // can only say that something went wrong.
    expect(isSecretStoreWriteError(error) ? error.reason : '').toBe(MOCK_REFUSAL)
  })

  it('still throws when the rollback cannot run either', async () => {
    mockRefusals.set(NS_A.secretKey('hermie.auth.session_token'), MOCK_REFUSAL)
    mockRefuseDeletes = true

    await expect(
      saveGatewaySetup(NS_A, { config: CONFIG, extraHeaders: {}, sessionToken: 'devtoken' })
    ).rejects.toThrow()

    // A store too broken to clean up after itself is exactly the store whose
    // configuration must not be written.
    expect(mockDisk.get(configKeyFor(NS_A))).toBeUndefined()
  })

  it('registers no gateway, so the list and the disk agree that nothing happened', async () => {
    /*
      Refused wholesale rather than by key, because the id this would be written
      under is minted inside `saveGatewayAndRegister` and no assertion out here
      can name it. Which is the point: an id nothing outside that call knows is
      exactly what made the orphans unfindable.
    */
    mockRefuseAllWrites = true

    await expect(
      saveGatewayAndRegister({ config: CONFIG, extraHeaders: {}, sessionToken: 'devtoken', activate: true })
    ).rejects.toThrow()

    expect(mockDisk.get(GATEWAY_REGISTRY_KEY)).toBeUndefined()
    expect([...mockDisk.keys()]).toEqual([])
  })
})

describe('a secret store that works', () => {
  it('writes the configuration, the credentials and the entry, and reads back', async () => {
    const { id } = await saveGatewayAndRegister({
      config: CONFIG,
      extraHeaders: {},
      sessionToken: 'devtoken',
      activate: true
    })

    const loaded = await loadGatewaySetup(namespace(id))

    expect(loaded?.config.baseUrl).toBe(CONFIG.baseUrl)
    expect(loaded?.hasCredentials).toBe(true)
    expect(JSON.parse(mockDisk.get(GATEWAY_REGISTRY_KEY) ?? '{}').activeGatewayId).toBe(id)
  })
})

describe('the orphan sweep', () => {
  const entry = (id: string): GatewayRecord => ({
    id,
    name: 'hermes.example.com',
    address: CONFIG.baseUrl,
    authKind: 'session_token',
    addedAt: 1
  })

  it('removes a configuration no entry claims and keeps the one that is live', async () => {
    const registry = addGateway(EMPTY_REGISTRY, entry(GATEWAY_A))

    mockDisk.set(configKeyFor(namespace(GATEWAY_A)), JSON.stringify(CONFIG))
    mockDisk.set(configKeyFor(namespace(GATEWAY_B)), JSON.stringify(CONFIG))
    mockDisk.set(configKeyFor(namespace('gdeadbeefdeadbeef')), JSON.stringify(CONFIG))

    const swept = await sweepOrphanGatewayConfigs(registry)

    expect(swept.sort()).toEqual(
      [configKeyFor(namespace(GATEWAY_B)), configKeyFor(namespace('gdeadbeefdeadbeef'))].sort()
    )
    expect(mockDisk.has(configKeyFor(namespace(GATEWAY_A)))).toBe(true)
    expect(mockDisk.has(configKeyFor(namespace(GATEWAY_B)))).toBe(false)
  })

  it('leaves the unsuffixed configuration alone, because the migration reads it', async () => {
    mockDisk.set(CONFIG_KEY, JSON.stringify(CONFIG))

    expect(await sweepOrphanGatewayConfigs(EMPTY_REGISTRY)).toEqual([])
    expect(mockDisk.has(CONFIG_KEY)).toBe(true)
  })

  it('touches no other namespaced key, however abandoned it looks', async () => {
    const stale = `hermie.chat.view@${GATEWAY_B}`

    mockDisk.set(stale, '{}')
    mockDisk.set(`hermie.gateway.auth_timeline@${GATEWAY_B}`, '{}')

    expect(await sweepOrphanGatewayConfigs(EMPTY_REGISTRY)).toEqual([])
    expect(mockDisk.has(stale)).toBe(true)
  })

  it('writes nothing at all when there is nothing to reclaim', async () => {
    const { keyValueStore } = jest.requireMock('../src/platform/key-value-store') as {
      keyValueStore: { deleteMany: jest.Mock }
    }

    expect(await sweepOrphanGatewayConfigs(EMPTY_REGISTRY)).toEqual([])
    expect(keyValueStore.deleteMany).not.toHaveBeenCalled()
  })
})
