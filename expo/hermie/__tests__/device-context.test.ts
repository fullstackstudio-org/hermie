/**
 * Who the gateway says this device's reader is.
 *
 * HERM-119 removed the `context` section this store used to also carry (a
 * person's name, device, timezone, locale and free text, rendered by the
 * gateway-side plugin into a bot's system prompt). What is left is the
 * narrower identity that `UserChatDirectory`, `SidebarIdentity` and
 * `UiMetaBridge.setUser` still depend on, plus the one-time cleanup of what an
 * older build left on disk.
 */
import { keyValueStore } from '../src/platform/key-value-store'
import { effectiveDisplayName, OWNER_USER_ID, useDeviceContextStore } from '../src/store/device-context'

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    getJson: jest.fn(async () => null),
    setJson: jest.fn(async () => undefined)
  }
}))

const store = () => useDeviceContextStore.getState()

beforeEach(() => {
  store().reset()
  jest.mocked(keyValueStore.delete).mockClear()
})

describe('hydrate', () => {
  it('clears out whatever a build before HERM-119 left under the old key', async () => {
    await store().hydrate()

    expect(keyValueStore.delete).toHaveBeenCalledWith('hermie.context')
    expect(store().loaded).toBe(true)
  })

  it('only does that once', async () => {
    await store().hydrate()
    await store().hydrate()

    expect(keyValueStore.delete).toHaveBeenCalledTimes(1)
  })
})

describe('setIdentity', () => {
  it('records who the gateway says this is', () => {
    store().setIdentity({
      baseUrl: 'https://gateway.example',
      gated: true,
      userId: 'oidc:7f3a',
      displayName: 'Sebas',
      email: ''
    })

    expect(store().userId).toBe('oidc:7f3a')
    expect(store().displayName).toBe('Sebas')
    expect(store().gated).toBe(true)
  })

  it('is a no-op when nothing about the identity actually changed', () => {
    const identity = {
      baseUrl: 'https://gateway.example',
      gated: true,
      userId: 'oidc:7f3a',
      displayName: 'Sebas',
      email: ''
    }

    store().setIdentity(identity)
    const first = store()
    store().setIdentity(identity)

    expect(store()).toBe(first)
  })
})

describe('retire and reset', () => {
  it('retire forgets the identity', () => {
    store().setIdentity({
      baseUrl: 'https://gateway.example',
      gated: true,
      userId: 'oidc:7f3a',
      displayName: 'Sebas',
      email: ''
    })
    store().retire()

    expect(store().userId).toBe('')
    expect(store().baseUrl).toBe('')
  })

  it('reset also forgets that the store hydrated', async () => {
    await store().hydrate()
    store().reset()

    expect(store().loaded).toBe(false)
  })
})

/**
 * The bug Sebas hit on TestFlight: the name read empty on a gateway whose
 * `/api/auth/me` answers with a subject and neither a display name nor an
 * address. These pin the fallback ladder that fixed it, unrelated to whether
 * the removed context section still exists.
 */
describe('effectiveDisplayName', () => {
  const name = (patch: { displayName?: string; email?: string; userId?: string }): string =>
    effectiveDisplayName({ displayName: '', email: '', userId: '', ...patch })

  it('is the gateway’s own display name when there is one', () => {
    expect(name({ displayName: 'Sebas', email: 'sebas@example.invalid', userId: 'oidc:7f3a' })).toBe('Sebas')
  })

  it('falls back to the local part of the address', () => {
    expect(name({ email: 'sebas@example.invalid', userId: 'oidc:7f3a' })).toBe('sebas')
  })

  it('falls back last to the user id, with the provider prefix taken off', () => {
    expect(name({ userId: 'authentik:7f3a-ce10' })).toBe('7f3a-ce10')
  })

  it('leaves a subject that is a URL alone rather than cutting at its scheme', () => {
    expect(name({ userId: 'https://issuer.example/users/7f3a' })).toBe('https://issuer.example/users/7f3a')
  })

  it('shows the owner id of a gateway with no accounts as it is', () => {
    expect(name({ userId: OWNER_USER_ID })).toBe(OWNER_USER_ID)
  })

  it('is empty only when the gateway has named nobody at all', () => {
    expect(name({})).toBe('')
  })

  it('is cut at its cap', () => {
    expect(name({ displayName: 'a'.repeat(200) })).toHaveLength(80)
  })
})
