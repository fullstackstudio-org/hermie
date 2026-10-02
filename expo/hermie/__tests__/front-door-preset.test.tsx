/**
 * The Cloudflare Access preset, from the field somebody pastes a service token
 * into to the places that token has to reach — and the places it must not.
 *
 * The gateway client's own suites prove the headers ride on REST, the dial and
 * the probe. What is left for the app is the part that owns the secret: where
 * it is stored, which gateway it is allowed to be sent to, whether it survives
 * a sign-out, and whether anything prints it.
 */
import { GatewayError, type ProbeResult, type ResolvedAddress } from '@hermie/gateway-client'
import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { useState } from 'react'

import { NativeSignInWebView } from '../src/features/onboarding/NativeSignInWebView'
import { draftFromConfig, effectiveHeaders, emptyDraft, type OnboardingDraft } from '../src/features/onboarding'
import { GatewayAddressStep } from '../src/features/onboarding/steps/GatewayAddressStep'
import { clearGateway, loadGatewaySetup, saveGatewaySetup, secretKeysFor } from '../src/gateway/config'
import { secretStore } from '../src/platform/secret-store'
import { renderScreen } from './support/render'

import { NS_A } from './support/gateway-namespace'

/** Every credential belongs to one gateway; this suite writes that one's. */
const KEYS = secretKeysFor(NS_A)

jest.mock('@hermie/gateway-client', () => ({
  ...jest.requireActual('@hermie/gateway-client'),
  resolveGatewayAddress: jest.fn()
}))

const { resolveGatewayAddress } = require('@hermie/gateway-client') as { resolveGatewayAddress: jest.Mock }

const SECRET = 'cf-secret-value-nobody-may-print'
const ID = 'abc123.access'

const ACCESS = {
  kind: 'cloudflare_access' as const,
  clientId: ID,
  clientSecret: SECRET,
  origin: 'https://gateway.example.com'
}

const PROBE: ProbeResult = {
  version: '2026.9.14',
  authRequired: true,
  authFlows: ['native_pkce'],
  providers: [{ name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false }],
  supportsNativePkce: true
}

const at = (baseUrl: string): ResolvedAddress => ({ ...PROBE, baseUrl, foundOverHttp: false })

let latest: OnboardingDraft = emptyDraft()

function Harness({ initial = emptyDraft() }: { initial?: OnboardingDraft }) {
  const [draft, setDraft] = useState<OnboardingDraft>(initial)
  latest = draft

  return (
    <GatewayAddressStep
      draft={draft}
      update={patch => setDraft(current => ({ ...current, ...patch }))}
      debounceMs={0}
    />
  )
}

beforeEach(async () => {
  resolveGatewayAddress.mockReset()
  resolveGatewayAddress.mockResolvedValue(at('https://gateway.example.com'))
  latest = emptyDraft()
  await clearGateway(NS_A)
})

describe('the draft', () => {
  it('folds the preset into the headers that go on the wire', () => {
    const draft: OnboardingDraft = { ...emptyDraft(), baseUrl: 'https://gateway.example.com', frontDoor: ACCESS }

    expect(effectiveHeaders(draft)).toEqual({
      'CF-Access-Client-Id': ID,
      'CF-Access-Client-Secret': SECRET
    })
  })

  it('lets the preset win over a hand-typed header of the same name', () => {
    const draft: OnboardingDraft = {
      ...emptyDraft(),
      baseUrl: 'https://gateway.example.com',
      frontDoor: ACCESS,
      headers: [{ id: 'h1', name: 'CF-Access-Client-Secret', value: 'a stale one somebody typed' }]
    }

    expect(effectiveHeaders(draft)['CF-Access-Client-Secret']).toBe(SECRET)
  })

  it('sends nothing to a cleartext gateway, whatever is in the preset', () => {
    const draft: OnboardingDraft = { ...emptyDraft(), baseUrl: 'http://gateway.example.com', frontDoor: ACCESS }

    expect(effectiveHeaders(draft)).toEqual({})
  })
})

describe('what reaches disk', () => {
  it('stores the preset as a preset, not as a copy of the headers it derives', async () => {
    await saveGatewaySetup(NS_A, {
      config: { baseUrl: 'https://gateway.example.com', authMode: 'native_pkce' },
      extraHeaders: {},
      frontDoor: ACCESS,
      sessionToken: 'st-1'
    })

    // The derived pair is NOT in the header blob: one secret, one place.
    expect(await secretStore.get(KEYS.extraHeaders)).toBeNull()

    const setup = await loadGatewaySetup(NS_A)

    expect(setup?.frontDoor).toEqual(ACCESS)
    expect(setup?.customHeaders).toEqual({})
    expect(setup?.extraHeaders).toEqual({ 'CF-Access-Client-Id': ID, 'CF-Access-Client-Secret': SECRET })
  })

  it('binds the record to the address being saved, not to whatever it was typed against', async () => {
    await saveGatewaySetup(NS_A, {
      config: { baseUrl: 'https://moved.example.com', authMode: 'native_pkce' },
      extraHeaders: {},
      frontDoor: ACCESS,
      sessionToken: 'st-1'
    })

    const setup = await loadGatewaySetup(NS_A)

    expect(setup?.frontDoor).toMatchObject({ origin: 'https://moved.example.com' })
  })

  it('refuses to hand a service token to a gateway it was not issued for', async () => {
    await secretStore.set(KEYS.frontDoor, JSON.stringify(ACCESS))
    await saveGatewaySetup(NS_A, {
      config: { baseUrl: 'https://somewhere-else.example.com', authMode: 'session_token' },
      extraHeaders: {},
      sessionToken: 'st-1'
    })
    // The save above cleared it; put a stale record back the way a restore or an
    // older build would have.
    await secretStore.set(KEYS.frontDoor, JSON.stringify(ACCESS))

    const setup = await loadGatewaySetup(NS_A)

    expect(setup?.frontDoor).toEqual({ kind: 'none' })
    expect(setup?.extraHeaders).toEqual({})
  })

  it('treats a record with no origin as one that does not belong here', async () => {
    await saveGatewaySetup(NS_A, {
      config: { baseUrl: 'https://gateway.example.com', authMode: 'session_token' },
      extraHeaders: {},
      sessionToken: 'st-1'
    })
    await secretStore.set(
      KEYS.frontDoor,
      JSON.stringify({ kind: 'cloudflare_access', clientId: ID, clientSecret: SECRET })
    )

    expect((await loadGatewaySetup(NS_A))?.frontDoor).toEqual({ kind: 'none' })
  })

  it('is deleted by a sign-out, along with the other five', async () => {
    await saveGatewaySetup(NS_A, {
      config: { baseUrl: 'https://gateway.example.com', authMode: 'native_pkce' },
      extraHeaders: {},
      frontDoor: ACCESS,
      sessionToken: 'st-1'
    })
    await clearGateway(NS_A)

    expect(await secretStore.get(KEYS.frontDoor)).toBeNull()
  })

  it('comes back into a resumed wizard, so a sign-out does not cost a retyped secret', () => {
    const resumed = draftFromConfig(
      { baseUrl: 'https://gateway.example.com', authMode: 'native_pkce' },
      { customHeaders: { 'X-Proxy': 'v' }, frontDoor: ACCESS }
    )

    expect(resumed.frontDoor).toEqual(ACCESS)
    expect(resumed.headers).toEqual([expect.objectContaining({ name: 'X-Proxy', value: 'v' })])
  })
})

describe('the address step', () => {
  it('opens Advanced by itself when a front door came back with the address', () => {
    renderScreen(<Harness initial={{ ...emptyDraft(), frontDoor: ACCESS }} />)

    expect(screen.getByTestId('cf-access-client-id')).toBeTruthy()
  })

  it('offers the Cloudflare preset and swaps the custom header rows for its fields', async () => {
    renderScreen(<Harness />)

    fireEvent.press(screen.getByText(/Advanced/))
    expect(screen.getByText('Add a header')).toBeTruthy()

    fireEvent.press(screen.getByTestId('front-door-preset-cloudflare_access'))

    await waitFor(() => expect(screen.getByTestId('cf-access-client-secret')).toBeTruthy())
    expect(screen.queryByText('Add a header')).toBeNull()
  })

  it('re-probes with the pair on it, because the edge is what refuses first', async () => {
    renderScreen(<Harness />)

    fireEvent.press(screen.getByText(/Advanced/))
    fireEvent.press(screen.getByTestId('front-door-preset-cloudflare_access'))
    fireEvent.changeText(screen.getByTestId('gateway-address'), 'https://gateway.example.com')

    await waitFor(() => expect(resolveGatewayAddress).toHaveBeenCalled())

    fireEvent.changeText(screen.getByTestId('cf-access-client-id'), ID)
    fireEvent.changeText(screen.getByTestId('cf-access-client-secret'), SECRET)

    await waitFor(() =>
      expect(resolveGatewayAddress).toHaveBeenLastCalledWith('https://gateway.example.com', {
        'CF-Access-Client-Id': ID,
        'CF-Access-Client-Secret': SECRET
      })
    )
  })

  it('drops the pair out of the draft when the reader switches back to custom headers', async () => {
    renderScreen(<Harness initial={{ ...emptyDraft(), baseUrl: 'https://gateway.example.com', frontDoor: ACCESS }} />)

    fireEvent.press(screen.getByTestId('front-door-preset-none'))

    await waitFor(() => expect(latest.frontDoor).toEqual({ kind: 'none' }))
    expect(JSON.stringify(latest)).not.toContain(SECRET)
  })

  it('says why a cleartext gateway is getting no token, rather than withholding it in silence', async () => {
    resolveGatewayAddress.mockResolvedValue(at('http://gateway.example.com'))
    renderScreen(<Harness initial={{ ...emptyDraft(), baseUrl: 'http://gateway.example.com', frontDoor: ACCESS }} />)

    expect(screen.getByText(/the service token is not being sent/)).toBeTruthy()
  })
})

describe('the sign-in web view', () => {
  it('injects a document-start script built from the values', () => {
    renderScreen(
      <NativeSignInWebView
        baseUrl="https://gateway.example.com"
        extraHeaders={{ 'CF-Access-Client-Id': ID, 'CF-Access-Client-Secret': SECRET }}
        frontDoor={ACCESS}
        onCancel={jest.fn()}
        onSuccess={jest.fn()}
        provider="self-hosted"
        visible
      />
    )

    const injected = screen.getByTestId('sign-in-webview').props.injectedJavaScriptBeforeContentLoaded as string

    // The page's own fetch has to carry them: the gateway's /login form posts
    // with fetch, and source.headers does not reach it.
    expect(injected).toContain('window.fetch')
    expect(injected).toContain(JSON.stringify(SECRET))
    expect(injected).toContain(JSON.stringify('https://gateway.example.com'))
  })

  it('injects nothing when there is no front door', () => {
    renderScreen(
      <NativeSignInWebView
        baseUrl="https://gateway.example.com"
        onCancel={jest.fn()}
        onSuccess={jest.fn()}
        provider="self-hosted"
        visible
      />
    )

    expect(screen.getByTestId('sign-in-webview').props.injectedJavaScriptBeforeContentLoaded).toBeUndefined()
  })

  it('never writes the script, or any part of the secret, to a log', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
      jest.spyOn(console, level).mockImplementation(() => {})
    )

    try {
      renderScreen(
        <NativeSignInWebView
          baseUrl="https://gateway.example.com"
          extraHeaders={{ 'CF-Access-Client-Id': ID, 'CF-Access-Client-Secret': SECRET }}
          frontDoor={ACCESS}
          onCancel={jest.fn()}
          onSuccess={jest.fn()}
          provider="self-hosted"
          visible
        />
      )

      const written = spies.flatMap(spy => spy.mock.calls.map(call => call.map(String).join(' '))).join('\n')

      expect(written).not.toContain(SECRET)
      expect(written).not.toContain(SECRET.slice(0, 6))
      expect(written).not.toContain(ID)
    } finally {
      for (const spy of spies) {
        spy.mockRestore()
      }
    }
  })
})

describe('an error nobody thought about', () => {
  it('still does not put the secret in a probe failure', async () => {
    resolveGatewayAddress.mockRejectedValue(new GatewayError('auth', 'refused', { status: 403 }))
    renderScreen(<Harness initial={{ ...emptyDraft(), frontDoor: ACCESS }} />)

    fireEvent.changeText(screen.getByTestId('gateway-address'), 'https://gateway.example.com')

    await waitFor(() => expect(screen.getByTestId('probe-error')).toBeTruthy())
    expect(screen.getByTestId('probe-error')).not.toHaveTextContent(SECRET)
  })
})
