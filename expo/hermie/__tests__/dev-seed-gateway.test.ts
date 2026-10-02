/**
 * The seeded gateway, and the two things worth pinning about it.
 *
 * **That it writes what the wizard writes.** The whole value of the argument is
 * that a screenshot taken after it shows the app a reader gets, which is only true
 * while the seed and a real setup leave the same two stores in the same state. A
 * second shape here — a flag the provider checks, a config missing a field — would
 * photograph a code path nobody ships, and nothing would say so.
 *
 * **That it does nothing in a release build.** It is the only development argument
 * that WRITES, so the `__DEV__` gate on it is load-bearing in a way the others'
 * are not: the rest choose a screen, this one puts a credential in the keychain.
 */
import { CONFIG_KEY, SECRET_KEYS } from '../src/gateway/config'

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

interface SeedRun {
  wrote: boolean
  setJson: jest.Mock
  setSecret: jest.Mock
}

/**
 * Load `seedDevGateway` with one launch-argument array in place, and hand back the
 * store mocks IT used.
 *
 * `DEV_LAUNCH_INTENT` is evaluated once at module load, so the arguments have to
 * be in place before the import — which is also the only way to drive `__DEV__`,
 * for the same reason. `resetModules` is what makes that re-import happen, and it
 * gives the fresh copy of `gateway/config` a fresh copy of the mocked stores too:
 * the ones this file could import at its top belong to the previous registry and
 * never see a call. So the assertions read the mocks back out of the same
 * registry rather than trusting the module identity.
 */
async function seedWith(argv: readonly string[], dev = true): Promise<SeedRun> {
  jest.resetModules()

  const previous = (globalThis as { __DEV__?: boolean }).__DEV__
  ;(globalThis as { __DEV__?: boolean }).__DEV__ = dev

  jest.doMock('expo', () => ({
    requireOptionalNativeModule: () => ({ devLaunchArguments: argv })
  }))

  try {
    const { seedDevGateway } = require('../src/dev/seed-gateway') as {
      seedDevGateway: () => Promise<boolean>
    }
    const { keyValueStore } = require('../src/platform/key-value-store') as {
      keyValueStore: { setJson: jest.Mock }
    }
    const { secretStore } = require('../src/platform/secret-store') as { secretStore: { set: jest.Mock } }

    const wrote = await seedDevGateway()
    // The entry the seed minted, read back off the list it wrote: every
    // namespaced key above is suffixed with this.
    const registry = keyValueStore.setJson.mock.calls
      .filter(([key]: [string]) => key === 'hermie.gateways')
      .map(([, value]: [string, { activeGatewayId: string | null }]) => value)
      .pop() ?? { activeGatewayId: null, gateways: [] }

    return {
      wrote,
      registry,
      gatewayId: registry.activeGatewayId,
      setJson: keyValueStore.setJson,
      setSecret: secretStore.set
    }
  } finally {
    ;(globalThis as { __DEV__?: boolean }).__DEV__ = previous
  }
}

describe('seeding a gateway from a launch argument', () => {
  it('writes the config and the session token the wizard would have written', async () => {
    const run = await seedWith(['--hermieGateway', 'http://localhost:9119', '--hermieToken', 'demo'])

    expect(run.wrote).toBe(true)

    // The non-secret half, in the key-value store, under the key the ordinary
    // read uses — which is now suffixed with the id of the entry the seed
    // minted. `session_token` because a draft with no probe is an ungated
    // gateway, which is what `authModeOf(null)` answers.
    expect(run.setJson).toHaveBeenCalledWith(`${CONFIG_KEY}@${run.gatewayId}`, {
      baseUrl: 'http://localhost:9119',
      authMode: 'session_token'
    })

    // And the list names it, so the next launch finds the same entry rather
    // than a configuration under an id nothing claims.
    expect(run.registry).toMatchObject({
      activeGatewayId: run.gatewayId,
      gateways: [{ address: 'http://localhost:9119', authKind: 'session_token', name: 'localhost' }]
    })

    // …and the credential, in the keychain, under the key `loadGatewaySetup`
    // reads to decide `hasCredentials`.
    expect(run.setSecret).toHaveBeenCalledWith(`${SECRET_KEYS.sessionToken}-${run.gatewayId}`, 'demo')
  })

  it('seeds the address alone when no token was given', async () => {
    const run = await seedWith(['--hermieGateway', 'http://localhost:9119'])

    expect(run.wrote).toBe(true)
    expect(run.setJson).toHaveBeenCalledWith(`${CONFIG_KEY}@${run.gatewayId}`, {
      baseUrl: 'http://localhost:9119',
      authMode: 'session_token'
    })

    // No credential, so the launch lands on the wizard's sign-in step with the
    // address already filled — the state a sign-out leaves behind, not a
    // half-written one.
    expect(run.setSecret).not.toHaveBeenCalledWith(`${SECRET_KEYS.sessionToken}-${run.gatewayId}`, expect.anything())
  })

  it('writes nothing at all when no gateway was named', async () => {
    const run = await seedWith(['--initialUrl', 'http://localhost:8081', '--hermieTheme', 'light'])

    expect(run.wrote).toBe(false)
    expect(run.setJson).not.toHaveBeenCalled()
    expect(run.setSecret).not.toHaveBeenCalled()
  })

  it('writes nothing when __DEV__ is false, whatever the process was launched with', async () => {
    const run = await seedWith(['--hermieGateway', 'http://localhost:9119', '--hermieToken', 'demo'], false)

    expect(run.wrote).toBe(false)
    expect(run.setJson).not.toHaveBeenCalled()
    expect(run.setSecret).not.toHaveBeenCalled()
  })
})
