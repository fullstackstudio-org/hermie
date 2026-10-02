/**
 * What a launch can tell you when the credentials are not there any more.
 *
 * The owner was dropped back into the sign-in step three times in one day,
 * every time straight after `/Applications/Hermie.app` was replaced, and never
 * after a plain quit and relaunch. The gateway ADDRESS survived each time, so
 * the key-value store was intact and only the keychain came back empty.
 *
 * That shape is exactly what a changed keychain access group looks like, and
 * also exactly what a genuinely empty keychain looks like: `SecItemCopyMatching`
 * answers `errSecItemNotFound` for both, and `expo-secure-store` turns both into
 * `null`. The two can only be told apart by whether the read THREW, and nothing
 * used to write that down — so the investigation had to be done from first
 * principles rather than read off the ring.
 */
import { configKeyFor, loadGatewaySetup, secretKeysFor } from '../src/gateway/config'
import { keyValueStore } from '../src/platform/key-value-store'
import { secretStore } from '../src/platform/secret-store'

import { NS_A } from './support/gateway-namespace'

/** Every credential belongs to one gateway; this suite reads that one's. */
const KEYS = secretKeysFor(NS_A)
const CONFIG_KEY = configKeyFor(NS_A)

jest.mock('../src/platform/secret-store', () => ({
  secretStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined)
  }
}))

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    getJson: jest.fn(async () => null),
    setJson: jest.fn(async () => undefined)
  }
}))

const CONFIG = {
  baseUrl: 'https://hermes.example.com',
  authMode: 'native_pkce' as const,
  provider: 'self-hosted',
  version: '2026.9.14'
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(keyValueStore.getJson as jest.Mock).mockImplementation(async (key: string) => (key === CONFIG_KEY ? CONFIG : null))
})

describe('reading the stored credentials', () => {
  it('reports an empty keychain as empty, with nothing to explain', async () => {
    const setup = await loadGatewaySetup(NS_A)

    expect(setup?.config.baseUrl).toBe('https://hermes.example.com')
    expect(setup?.hasCredentials).toBe(false)
    expect(setup?.credentialError).toBeUndefined()
  })

  it('reports a keychain that REFUSED, rather than swallowing it as empty', async () => {
    ;(secretStore.get as jest.Mock).mockRejectedValue(new Error('A required entitlement isn’t present.'))

    const setup = await loadGatewaySetup(NS_A)

    // The address still survives, which is what puts the wizard on the sign-in
    // step rather than on the cover.
    expect(setup?.config.baseUrl).toBe('https://hermes.example.com')
    expect(setup?.hasCredentials).toBe(false)
    expect(setup?.credentialError).toMatch(/entitlement/)
  })

  it('never lets a throwing keychain strand the launch', async () => {
    ;(secretStore.get as jest.Mock).mockRejectedValue(new Error('keychain is locked'))

    // The whole point: this resolves. It used to reject, and the rejection
    // escaped an un-awaited `reload()` and left the app on the splash for ever.
    await expect(loadGatewaySetup(NS_A)).resolves.not.toBeNull()
  })

  it('still reads a credential that IS there', async () => {
    ;(secretStore.get as jest.Mock).mockImplementation(async (key: string) =>
      key === KEYS.accessToken ? 'access-1' : null
    )

    const setup = await loadGatewaySetup(NS_A)

    expect(setup?.hasCredentials).toBe(true)
    expect(setup?.credentialError).toBeUndefined()
  })
})

describe('whether the stored sign-in can be renewed', () => {
  it('says no when there is an access token and nothing to rotate it with', async () => {
    // What a provider without `offline_access` leaves behind. The session works
    // and then stops, and this is the only stored evidence of why.
    ;(secretStore.get as jest.Mock).mockImplementation(async (key: string) =>
      key === KEYS.accessToken ? 'access-1' : null
    )

    const setup = await loadGatewaySetup(NS_A)

    expect(setup?.hasCredentials).toBe(true)
    expect(setup?.canRefresh).toBe(false)
  })

  it('says yes when the refresh token is there', async () => {
    ;(secretStore.get as jest.Mock).mockImplementation(async (key: string) =>
      key === KEYS.accessToken ? 'access-1' : key === KEYS.refreshToken ? 'refresh-1' : null
    )

    expect((await loadGatewaySetup(NS_A))?.canRefresh).toBe(true)
  })

  it('says yes for a session-token gateway, which has nothing to rotate', async () => {
    // Answering false would warn a correctly configured gateway about a refresh
    // token it was never going to have.
    ;(keyValueStore.getJson as jest.Mock).mockImplementation(async (key: string) =>
      key === CONFIG_KEY ? { ...CONFIG, authMode: 'session_token' } : null
    )
    ;(secretStore.get as jest.Mock).mockImplementation(async (key: string) =>
      key === KEYS.sessionToken ? 'token-1' : null
    )

    expect((await loadGatewaySetup(NS_A))?.canRefresh).toBe(true)
  })
})
