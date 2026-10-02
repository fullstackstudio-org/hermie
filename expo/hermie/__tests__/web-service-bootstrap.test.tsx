/**
 * The browser build as a SERVICE client
 * ([ADR-0025](../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
 *
 * Two claims, and they are the same claim seen from either end. The operator
 * chose the gateway once, through Hermie Web's own `/setup`, so the reader is
 * never asked for an address and never waits on a probe of one: the wizard
 * opens on the sign-in step, and the sign-in step draws itself from the
 * server's bootstrap. And when that bootstrap says nothing — an older Hermie
 * Web, or a gateway it could not read — the build does exactly what it did
 * before, which is why the shortcut is allowed to exist at all.
 *
 * `SignInStep.web` by its real name, as every seam test here does: under Jest
 * the shared module resolves to the native sibling, which has no cookie flow in
 * it to look at.
 */
import { probeGateway } from '@hermie/gateway-client'
import { waitFor } from '@testing-library/react-native'

import { NUMBERED_STEPS, ONBOARDING_ORDER } from '../src/features/onboarding/draft'
import { type HermieWebConfig, loadHermieWebConfig, probeFromWebConfig } from '../src/gateway/web-config'
import { SignInStep } from '../src/features/onboarding/steps/SignInStep.web'
import { renderScreen } from './support/render'

jest.mock('@hermie/gateway-client', () => ({
  ...jest.requireActual('@hermie/gateway-client'),
  probeGateway: jest.fn(),
  GatewayHttp: class {
    authMe() {
      return Promise.reject(new Error('no session'))
    }
  }
}))

// `authModeOf` only answers `cookie` in a browser, and Jest runs the native
// platform — so the branch this file is about would render nothing.
jest.mock('../src/platform/runs-in-browser', () => ({ RUNS_IN_BROWSER: true }))

jest.mock('../src/gateway/web-config', () => ({
  ...jest.requireActual('../src/gateway/web-config'),
  loadHermieWebConfig: jest.fn()
}))

const probe = jest.mocked(probeGateway)
const config = jest.mocked(loadHermieWebConfig)

const SERVED: HermieWebConfig = {
  gatewayHost: '127.0.0.1:9119',
  gatewayOrigin: 'http://127.0.0.1:9119',
  loginReturn: '/',
  version: '0.1.2',
  setupRequired: false,
  authRequired: true,
  authKinds: ['cookie'],
  providers: [{ name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: true }],
  service: { login: true, push: true, cache: true }
}

/** The same server, one release older: it answers, but knows nothing about the gateway. */
const SILENT: HermieWebConfig = {
  ...SERVED,
  authRequired: null,
  authKinds: null,
  providers: null,
  service: { login: false, push: false, cache: false }
}

const LIVE_PROBE = {
  version: '0.21.3-fake',
  authRequired: true,
  authFlows: ['cookie'],
  providers: [{ name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: true }],
  supportsNativePkce: false
}

beforeEach(() => {
  probe.mockReset()
  probe.mockResolvedValue(LIVE_PROBE)
  config.mockReset()
})

describe('the wizard in a browser', () => {
  it('has no address step, and opens on the sign-in', () => {
    expect(ONBOARDING_ORDER).toEqual(['signin', 'test', 'notifications', 'done'])
    expect(ONBOARDING_ORDER).not.toContain('address')
    // No welcome cover either: it introduces a setup the reader is not doing.
    expect(ONBOARDING_ORDER).not.toContain('welcome')
    // Every remaining step is numbered, because every one of them is theirs.
    expect(NUMBERED_STEPS).toEqual(ONBOARDING_ORDER)
  })

  /*
    The native order is not asserted here. `jest.mock` is hoisted above the
    whole file, so `RUNS_IN_BROWSER` is true for every module this suite loads
    and `jest.doMock` inside `isolateModules` cannot undo it — a test that
    appeared to check the other branch would be checking this one twice.
    `onboarding-wizard.test.tsx` walks the native order for real.
  */
})

describe('the server’s bootstrap, read as a probe', () => {
  it('carries the gateway’s auth kinds and providers', () => {
    expect(probeFromWebConfig(SERVED)).toEqual({
      version: '',
      authRequired: true,
      authFlows: ['cookie'],
      providers: SERVED.providers,
      supportsNativePkce: false
    })
  })

  it('reports native PKCE when the gateway offers it, so the step can refuse it by name', () => {
    expect(probeFromWebConfig({ ...SERVED, authKinds: ['cookie', 'native_pkce'] })?.supportsNativePkce).toBe(true)
  })

  it('answers nothing for a server that could not read the gateway', () => {
    // `null` and `[]` are different answers: an empty list is a gateway that
    // asks for nothing, and only `null` means "probe it yourself".
    expect(probeFromWebConfig(SILENT)).toBeNull()
    expect(probeFromWebConfig(null)).toBeNull()
    expect(probeFromWebConfig({ ...SERVED, authRequired: false, authKinds: [] })).toMatchObject({
      authRequired: false,
      authFlows: []
    })
  })
})

describe('the sign-in step', () => {
  const draft = {
    rawAddress: 'http://127.0.0.1:9120',
    baseUrl: 'http://127.0.0.1:9120',
    headers: [],
    frontDoor: { kind: 'none' as const },
    probe: null,
    provider: null,
    tokens: null,
    sessionToken: '',
    cookieIdentity: null,
    test: null
  }

  it('does not probe a gateway the server has already read', async () => {
    config.mockResolvedValue(SERVED)
    const update = jest.fn()

    renderScreen(<SignInStep draft={draft} update={update} />)

    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ probe: expect.anything() })))
    expect(probe).not.toHaveBeenCalled()
    expect(update.mock.calls[0]?.[0]?.probe).toMatchObject({ authFlows: ['cookie'] })
  })

  it('probes for itself when the server says nothing', async () => {
    config.mockResolvedValue(SILENT)

    renderScreen(<SignInStep draft={draft} update={jest.fn()} />)

    await waitFor(() => expect(probe).toHaveBeenCalledWith('http://127.0.0.1:9120'))
  })

  it('probes for itself when there is no Hermie Web at all', async () => {
    config.mockResolvedValue(null)

    renderScreen(<SignInStep draft={draft} update={jest.fn()} />)

    await waitFor(() => expect(probe).toHaveBeenCalledWith('http://127.0.0.1:9120'))
  })
})
