/**
 * Signing in again, after signing out.
 *
 * `draftFromConfig` synthesises a probe from the stored gateway so the wizard
 * can open straight on the sign-in step. A preference file knows the auth MODE;
 * it cannot know whether the provider takes a password, and the entry it makes
 * says `false`. The step read `draft.probe ?? (await probeGateway(baseUrl))`,
 * so on every resume it believed that fabricated answer, never asked the
 * gateway, and offered the redirect and nothing else — the in-app form, the one
 * the password manager fills, was unreachable for exactly the visitor who had
 * used it before.
 *
 * The `.web` half by its real name, as every seam test here does: the native
 * sibling has no password form to look for.
 */
import { screen, waitFor } from '@testing-library/react-native'
import { probeGateway } from '@hermie/gateway-client'

import { draftFromConfig } from '../src/features/onboarding/draft'
import { SignInStep } from '../src/features/onboarding/steps/SignInStep.web'
import { renderScreen } from './support/render'

jest.mock('@hermie/gateway-client', () => ({
  ...jest.requireActual('@hermie/gateway-client'),
  probeGateway: jest.fn(),
  // No session yet, which is the ordinary state one screen after a sign-out.
  // Left real, this reaches `fetch` and the test hangs rather than fails.
  GatewayHttp: class {
    authMe() {
      return Promise.reject(new Error('no session'))
    }
  }
}))

// `authModeOf` only answers `cookie` in a browser, and Jest runs the native
// platform — so the whole branch this file is about would render nothing.
jest.mock('../src/platform/runs-in-browser', () => ({ RUNS_IN_BROWSER: true }))

/*
  A Hermie Web that answers, and says nothing about the gateway.

  `probeFromWebConfig` is kept REAL — the step asks it first now (ADR-0025), and
  a stubbed-away one would make this suite prove nothing about the path it is
  written for. `authKinds: null` is the honest older-server answer, and it is
  what sends the step to the live probe this file is about.
*/
jest.mock('../src/gateway/web-config', () => ({
  ...jest.requireActual('../src/gateway/web-config'),
  loadHermieWebConfig: jest.fn().mockResolvedValue({
    gatewayHost: '127.0.0.1:9119',
    gatewayOrigin: 'http://127.0.0.1:9119',
    loginReturn: '/',
    version: '0.1.0',
    setupRequired: false,
    authRequired: null,
    authKinds: null,
    providers: null,
    service: { login: false, push: false, cache: false }
  })
}))

const probe = jest.mocked(probeGateway)

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
})

describe('resuming the wizard after a sign-out', () => {
  it('asks the gateway rather than believing the stored config', async () => {
    // Exactly what a sign-out leaves behind, including the `supportsPassword`
    // nobody could have known.
    const resumed = draftFromConfig({
      baseUrl: 'http://127.0.0.1:9120',
      authMode: 'cookie',
      provider: 'self-hosted',
      providerDisplayName: 'Self-Hosted OIDC',
      version: '0.21.3-fake'
    })

    expect(resumed.probe?.providers[0]?.supportsPassword).toBe(false)

    renderScreen(<SignInStep draft={resumed} update={jest.fn()} />)

    await waitFor(() => expect(probe).toHaveBeenCalledWith('http://127.0.0.1:9120'))
  })

  it('offers the in-app form once the gateway says the provider takes a password', async () => {
    renderScreen(
      <SignInStep
        draft={{ ...draftFromConfig({ baseUrl: 'http://127.0.0.1:9120', authMode: 'cookie' }), probe: LIVE_PROBE }}
        update={jest.fn()}
      />
    )

    await waitFor(() => expect(screen.getByTestId('cookie-username')).toBeTruthy())
    expect(screen.getByTestId('cookie-password')).toBeTruthy()
    expect(screen.getByTestId('cookie-password-submit')).toBeTruthy()
  })
})

describe('a gateway that is not gated at all', () => {
  it('is told what the actual limit is, rather than shown a dead Continue', async () => {
    probe.mockResolvedValue({
      version: '0.21.3-fake',
      authRequired: false,
      authFlows: [],
      providers: [],
      supportsNativePkce: false
    })

    renderScreen(
      <SignInStep
        draft={draftFromConfig({ baseUrl: 'http://127.0.0.1:9220', authMode: 'session_token' })}
        update={jest.fn()}
      />
    )

    // This build keeps no bearer token — there is no keychain in a browser —
    // so there is nothing for the step to collect and the wizard cannot go on.
    // It used to render nothing at all: a Continue that could never be pressed,
    // with no reason anywhere on the screen.
    await waitFor(() => expect(screen.getByText(/cannot be used from a browser/)).toBeTruthy())
  })

  it('is not accused of being too old for browser sign-in', async () => {
    // `authModeOf` answers `session_token` here, and the blocked notice tested
    // `!== 'cookie'` — so an ungated gateway was told it requires a sign-in it
    // cannot complete, directly under a lead saying it requires none.
    probe.mockResolvedValue({
      version: '0.21.3-fake',
      authRequired: false,
      authFlows: [],
      providers: [],
      supportsNativePkce: false
    })

    renderScreen(
      <SignInStep
        draft={draftFromConfig({ baseUrl: 'http://127.0.0.1:9220', authMode: 'session_token' })}
        update={jest.fn()}
      />
    )

    await waitFor(() => expect(probe).toHaveBeenCalled())
    expect(screen.queryByText(/too old for browser sign-in/)).toBeNull()
  })

  it('still says so when the gateway is gated and has no cookie flow', async () => {
    probe.mockResolvedValue({
      version: '2026.1.1',
      authRequired: true,
      authFlows: ['native_pkce'],
      providers: [{ name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false }],
      supportsNativePkce: true
    })

    renderScreen(
      <SignInStep
        draft={draftFromConfig({ baseUrl: 'http://127.0.0.1:9220', authMode: 'native_pkce' })}
        update={jest.fn()}
      />
    )

    await waitFor(() => expect(screen.getByTestId('signin-blocked')).toBeTruthy())
  })
})
