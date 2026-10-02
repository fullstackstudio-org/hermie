import type { ProbeResult } from '@hermie/gateway-client'
import { fireEvent, screen } from '@testing-library/react-native'
import { useState } from 'react'

import { emptyDraft, type OnboardingDraft } from '../src/features/onboarding'
import { SignInStep } from '../src/features/onboarding/steps/SignInStep'
import { renderScreen } from './support/render'

// The step records `signin.no_refresh` on the app's auth ring, which belongs to
// the gateway provider. Nothing else here needs the connection.
jest.mock('../src/gateway/GatewayProvider', () => ({ useGateway: () => ({ recordAuth: jest.fn() }) }))

const GATED: ProbeResult = {
  version: '2026.9.14',
  authRequired: true,
  authFlows: ['cookie', 'native_pkce'],
  providers: [{ name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false }],
  supportsNativePkce: true
}

let latest: OnboardingDraft = emptyDraft()

function Harness({ initial }: { initial: OnboardingDraft }) {
  const [draft, setDraft] = useState(initial)
  latest = draft

  return <SignInStep draft={draft} update={patch => setDraft(current => ({ ...current, ...patch }))} />
}

const draftWith = (probe: ProbeResult | null): OnboardingDraft => ({
  ...emptyDraft(),
  rawAddress: 'hermes.example.com',
  baseUrl: 'https://hermes.example.com',
  probe
})

describe('the sign-in step', () => {
  it('offers a sign-in button named after the only provider, and selects it', () => {
    renderScreen(<Harness initial={draftWith(GATED)} />)

    expect(screen.getByRole('button', { name: 'Sign in with Self-Hosted OIDC' })).toBeTruthy()
    expect(screen.queryByTestId('session-token')).toBeNull()
    expect(latest.provider?.name).toBe('self-hosted')
  })

  it('lets the user pick when the gateway offers more than one provider', () => {
    const providers = [
      { name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false },
      { name: 'local', displayName: 'Local Accounts', supportsPassword: true }
    ]
    renderScreen(<Harness initial={draftWith({ ...GATED, providers })} />)

    expect(latest.provider).toBeNull()
    fireEvent.press(screen.getByText('Local Accounts'))

    expect(latest.provider?.name).toBe('local')
    expect(screen.getByRole('button', { name: 'Sign in with Local Accounts' })).toBeTruthy()
  })

  it('asks for a session token when the gateway is not gated', () => {
    renderScreen(<Harness initial={draftWith({ ...GATED, authRequired: false, providers: [] })} />)

    const field = screen.getByTestId('session-token')
    expect(field.props.secureTextEntry).toBe(true)
    // The help line names a command, so the command is drawn as a chip and the
    // backticks are not on screen — which is exactly where they were before.
    expect(screen.getByText(/Paste the session token printed by\s+hermes serve\s*\./)).toBeTruthy()
    expect(screen.getByText('\u00a0hermes serve\u00a0')).toBeTruthy()
    expect(screen.queryByText(/`/)).toBeNull()
    expect(screen.queryByText(/^Sign in with/)).toBeNull()

    fireEvent.changeText(field, 'session-token-value')
    expect(latest.sessionToken).toBe('session-token-value')
  })

  it('blocks a gated gateway that does not advertise the native flow', () => {
    renderScreen(<Harness initial={draftWith({ ...GATED, authFlows: ['cookie'], supportsNativePkce: false })} />)

    expect(screen.getByTestId('signin-blocked')).toHaveTextContent(/too old for native sign-in/)
    expect(screen.queryByText(/^Sign in with/)).toBeNull()
    expect(screen.queryByTestId('session-token')).toBeNull()
  })

  it('blocks a gated gateway that reports no providers', () => {
    renderScreen(<Harness initial={draftWith({ ...GATED, providers: [] })} />)

    expect(screen.getByTestId('signin-blocked')).toHaveTextContent(/no identity providers/)
  })

  it('shows who signed in once tokens are held, and offers another attempt', () => {
    const signedIn: OnboardingDraft = {
      ...draftWith(GATED),
      provider: GATED.providers[0] ?? null,
      tokens: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: 4102444800,
        provider: 'self-hosted',
        userId: 'tester@example.invalid'
      }
    }
    renderScreen(<Harness initial={signedIn} />)

    expect(screen.getByTestId('signin-result')).toHaveTextContent(/Signed in as tester@example\.invalid/)
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
  })
})
