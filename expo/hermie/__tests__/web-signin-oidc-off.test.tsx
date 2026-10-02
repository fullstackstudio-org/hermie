/**
 * `HERMIE_OIDC=0` (`--no-oidc`), as the browser build reads it.
 *
 * Hermie Web's own proxy refuses the OIDC routes regardless of what the app
 * does (`packages/hermie-web/src/server.test.ts` covers that half). This file
 * is the other half: the sign-in step reads `oidc: false` off
 * `/hermie/config.json` and leaves every provider that is not a password one
 * out of the list it offers, so a reader is never shown a button that would
 * only end in that 403.
 *
 * The probe is supplied directly on the draft, the way `web-signin-resume`'s
 * own "offers the in-app form" case does: the step reads `draft.probe` for
 * what to RENDER and only ever hands a freshly computed one to `update`,
 * which this file — like that one — leaves a no-op mock. What varies here is
 * `oidc`, which the step reads off `/hermie/config.json` into its own state.
 *
 * `SignInStep.web` by its real name, as every seam test here does: under Jest
 * the shared module resolves to the native sibling, which has no cookie flow
 * to look at.
 */
import { screen, waitFor } from '@testing-library/react-native'
import { probeGateway, type AuthProvider, type ProbeResult } from '@hermie/gateway-client'

import { type HermieWebConfig, loadHermieWebConfig } from '../src/gateway/web-config'
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

jest.mock('../src/platform/runs-in-browser', () => ({ RUNS_IN_BROWSER: true }))

jest.mock('../src/gateway/web-config', () => ({
  ...jest.requireActual('../src/gateway/web-config'),
  loadHermieWebConfig: jest.fn()
}))

const probe = jest.mocked(probeGateway)
const config = jest.mocked(loadHermieWebConfig)

const BASE_CONFIG: HermieWebConfig = {
  gatewayHost: '127.0.0.1:9119',
  gatewayOrigin: 'http://127.0.0.1:9119',
  loginReturn: '/',
  version: '0.1.2',
  setupRequired: false,
  authRequired: true,
  authKinds: ['cookie'],
  providers: [],
  oidc: true,
  service: { login: true, push: true, cache: true }
}

const PASSWORD_PROVIDER: AuthProvider = { name: 'self-hosted', displayName: 'Local account', supportsPassword: true }
const SSO_PROVIDER: AuthProvider = { name: 'okta', displayName: 'Okta', supportsPassword: false }

function probeWith(providers: AuthProvider[]): ProbeResult {
  return { version: '0.1.2', authRequired: true, authFlows: ['cookie'], providers, supportsNativePkce: false }
}

function draftWith(providers: AuthProvider[]) {
  return {
    rawAddress: 'http://127.0.0.1:9120',
    baseUrl: 'http://127.0.0.1:9120',
    headers: [],
    frontDoor: { kind: 'none' as const },
    probe: probeWith(providers),
    provider: null,
    tokens: null,
    sessionToken: '',
    cookieIdentity: null,
    test: null
  }
}

beforeEach(() => {
  probe.mockReset()
  probe.mockResolvedValue(probeWith([PASSWORD_PROVIDER, SSO_PROVIDER]))
  config.mockReset()
})

describe('a gateway with both a password and an SSO provider', () => {
  it('offers both when this build has not turned OIDC off', async () => {
    config.mockResolvedValue({ ...BASE_CONFIG, oidc: true })

    renderScreen(<SignInStep draft={draftWith([PASSWORD_PROVIDER, SSO_PROVIDER])} update={jest.fn()} />)

    await waitFor(() => expect(screen.getByText('Local account')).toBeTruthy())
    expect(screen.getByText('Okta')).toBeTruthy()
  })

  it('hides the SSO provider and offers only the password one when OIDC is off', async () => {
    config.mockResolvedValue({ ...BASE_CONFIG, oidc: false })

    renderScreen(<SignInStep draft={draftWith([PASSWORD_PROVIDER, SSO_PROVIDER])} update={jest.fn()} />)

    // With one provider left, the step skips the chooser and goes straight
    // to that provider's own form — so its name is not offered as a choice,
    // and there is nothing left to choose between.
    await waitFor(() => expect(screen.getByTestId('cookie-username')).toBeTruthy())
    expect(screen.queryByText('Okta')).toBeNull()
  })

  it('reads an absent field as on, for a server too old to send it', async () => {
    const { oidc: _oidc, ...withoutOidcField } = BASE_CONFIG

    config.mockResolvedValue(withoutOidcField as HermieWebConfig)

    renderScreen(<SignInStep draft={draftWith([PASSWORD_PROVIDER, SSO_PROVIDER])} update={jest.fn()} />)

    await waitFor(() => expect(screen.getByText('Okta')).toBeTruthy())
  })
})

describe('a gateway whose only provider is OIDC/SSO', () => {
  it('is told SSO is off here, rather than shown an empty screen or blamed for having no providers', async () => {
    config.mockResolvedValue({ ...BASE_CONFIG, oidc: false })

    renderScreen(<SignInStep draft={draftWith([SSO_PROVIDER])} update={jest.fn()} />)

    await waitFor(() => expect(screen.getByTestId('signin-sso-off')).toBeTruthy())
    expect(screen.queryByTestId('signin-blocked')).toBeNull()
  })

  it('still says the ordinary thing when OIDC is on and the gateway just has no providers at all', async () => {
    config.mockResolvedValue({ ...BASE_CONFIG, oidc: true })

    renderScreen(<SignInStep draft={draftWith([])} update={jest.fn()} />)

    await waitFor(() => expect(screen.getByTestId('signin-blocked')).toBeTruthy())
    expect(screen.queryByTestId('signin-sso-off')).toBeNull()
  })
})
