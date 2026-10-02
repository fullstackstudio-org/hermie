/**
 * "Change gateway": the way off an address that cannot be used.
 *
 * Two halves, and the seam between them is the whole point. Pressing it drops
 * NOTHING — the reader may be checking a stored address against the one the
 * gateway publishes rather than moving house, and a wizard that signed them out
 * on the way in would charge them a sign-in for looking. The credentials are
 * dropped at the other end, and only if a different address is actually saved.
 */
import { type ConnectionStatus, type GatewayError, type ProbeResult } from '@hermie/gateway-client'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'

import { useOwnAuthorStore } from '../src/features/chats/own-author'
import { OnboardingNavigator } from '../src/features/onboarding'
import { GatewayProvider, useGateway } from '../src/gateway'
import { renderScreen, withProviders } from './support/render'

const mockStatusHandlers: ((status: ConnectionStatus, error: GatewayError | null) => void)[] = []

jest.mock('../src/gateway/client', () => ({
  attachLifecycle: () => () => undefined,
  createTokenCoordinator: () => ({ save: jest.fn(async () => undefined) }),
  endGatewaySession: jest.fn(async () => undefined),
  createGatewayConnection: () => ({
    http: {},
    start: jest.fn(),
    stop: jest.fn(),
    resume: jest.fn(),
    retryNow: jest.fn(),
    onStatus: (handler: (status: ConnectionStatus, error: GatewayError | null) => void) => {
      mockStatusHandlers.push(handler)
      handler('disconnected', null)

      return () => undefined
    }
  })
}))

jest.mock('@hermie/gateway-client', () => ({
  ...jest.requireActual('@hermie/gateway-client'),
  probeGateway: jest.fn()
}))

jest.mock('../src/features/onboarding/test-connection', () => ({
  CONNECTION_TEST_TIMEOUT_MS: 30_000,
  runConnectionTest: jest.fn()
}))

/**
 * One gateway on disk, and a list that names it.
 *
 * The mock has to be key-aware now: every stored thing is suffixed with the
 * entry's id, and the entry itself lives under `hermie.gateways`. A mock that
 * answered the same configuration to every key would have the registry read
 * that configuration as a list of gateways and find none.
 */
const mockGatewayId = 'gaaaaaaaaaaaaaaaa'
const mockStoredConfig = {
  baseUrl: 'https://hermes.example.com:8443',
  authMode: 'native_pkce',
  provider: 'self-hosted',
  version: '2026.9.14'
}
const mockStoredRegistry = {
  v: 1,
  activeGatewayId: mockGatewayId,
  gateways: [
    {
      id: mockGatewayId,
      name: 'hermes.example.com',
      address: mockStoredConfig.baseUrl,
      authKind: 'native_pkce',
      addedAt: 1
    }
  ]
}

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    getJson: jest.fn(async (key: string) => {
      if (key === 'hermie.gateways') {
        return mockStoredRegistry
      }

      return key === `hermie.gateway.config@${mockGatewayId}` ? mockStoredConfig : null
    }),
    setJson: jest.fn(async () => undefined),
    // The one live configuration and nothing else, so the launch sweep finds
    // nothing to reclaim.
    keys: jest.fn(async () => ['hermie.gateways', `hermie.gateway.config@${mockGatewayId}`]),
    deleteMany: jest.fn(async () => undefined)
  }
}))

jest.mock('../src/platform/secret-store', () => ({
  secretStore: {
    // `-`, not `@`: see `SECRET_NAMESPACE_SEPARATOR` in `gateway/namespace.ts`.
    get: jest.fn(async (key: string) => (key === `hermie.auth.access_token-${mockGatewayId}` ? 'access-1' : null)),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined)
  }
}))

const { probeGateway } = require('@hermie/gateway-client') as { probeGateway: jest.Mock }
const { secretStore } = require('../src/platform/secret-store') as { secretStore: { delete: jest.Mock } }
const { keyValueStore } = require('../src/platform/key-value-store') as {
  keyValueStore: { delete: jest.Mock; setJson: jest.Mock }
}

const GATED: ProbeResult = {
  version: '2026.9.14',
  authRequired: true,
  authFlows: ['native_pkce'],
  providers: [{ name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false }],
  supportsNativePkce: true
}

beforeEach(() => {
  mockStatusHandlers.length = 0
  jest.clearAllMocks()
  probeGateway.mockResolvedValue(GATED)
  useOwnAuthorStore.getState().reset()
})

/** The provider's answer, read the way the app's own root reads it. */
function Harness({ onRead }: { onRead: (value: ReturnType<typeof useGateway>) => void }) {
  onRead(useGateway())

  return null
}

describe('pressing Change gateway', () => {
  it('opens setup on the address step without dropping anything', async () => {
    let gateway: ReturnType<typeof useGateway> | null = null

    renderScreen(
      <GatewayProvider>
        <Harness onRead={value => (gateway = value)} />
      </GatewayProvider>
    )

    await waitFor(() => expect(gateway?.phase).toBe('connected'))

    await act(async () => {
      await gateway?.changeGateway()
    })

    expect(gateway?.phase).toBe('onboarding')
    // The step the wizard opens on, and the address it opens with.
    expect(gateway?.resumeIntent).toBe('address')
    expect(gateway?.resumeConfig?.baseUrl).toBe('https://hermes.example.com:8443')

    // Nothing is thrown away on the way in: the trip is cancellable.
    expect(secretStore.delete).not.toHaveBeenCalled()
    expect(keyValueStore.delete).not.toHaveBeenCalled()
  })

  it('forgets both halves when the reader asks for that instead', async () => {
    let gateway: ReturnType<typeof useGateway> | null = null

    renderScreen(
      <GatewayProvider>
        <Harness onRead={value => (gateway = value)} />
      </GatewayProvider>
    )

    await waitFor(() => expect(gateway?.phase).toBe('connected'))

    await act(async () => {
      await gateway?.forgetGateway()
    })

    expect(gateway?.resumeConfig).toBeNull()
    expect(gateway?.resumeIntent).toBe('fresh')
    expect(secretStore.delete).toHaveBeenCalled()
    expect(keyValueStore.delete).toHaveBeenCalled()
  })
})

describe('the wizard it opens', () => {
  const resumeConfig = {
    baseUrl: 'https://hermes.example.com:8443',
    authMode: 'native_pkce' as const,
    provider: 'self-hosted'
  }

  it('fills the stored address in and offers a way back out', async () => {
    const onCancel = jest.fn()

    render(
      withProviders(
        <OnboardingNavigator
          initialStep="address"
          onCancel={onCancel}
          onComplete={jest.fn()}
          probeDebounceMs={0}
          resumeConfig={resumeConfig}
        />
      )
    )

    const field = await screen.findByTestId('gateway-address')

    expect(field.props.value).toBe('https://hermes.example.com:8443')

    fireEvent.press(screen.getByTestId('onboarding-cancel'))
    expect(onCancel).toHaveBeenCalled()
  })

  /**
   * The other end of the seam. Saving the SAME address is a reader who checked
   * and stayed, and their sign-in has to survive it; saving a different one
   * makes the stored tokens credentials for a gateway this app no longer talks
   * to, and leaving them in the keychain hands the next sign-in a credential
   * from somewhere else.
   */
  it.each([
    ['keeps the sign-in when the address is unchanged', 'https://hermes.example.com:8443', false],
    ['drops it when a different gateway is applied', 'https://other.example.com', true]
  ])('%s', async (_label, baseUrl, cleared) => {
    const onComplete = jest.fn()

    render(
      withProviders(
        <OnboardingNavigator
          gatewayId={mockGatewayId}
          initialDraft={{
            rawAddress: baseUrl,
            baseUrl,
            headers: [],
            probe: GATED,
            provider: GATED.providers[0] ?? null,
            tokens: {
              accessToken: 'access-2',
              refreshToken: 'refresh-2',
              expiresAt: 4102444800,
              provider: 'self-hosted',
              userId: 'tester@example.invalid'
            },
            sessionToken: '',
            test: null
          }}
          initialStep="done"
          onComplete={onComplete}
          resumeConfig={resumeConfig}
        />
      )
    )

    fireEvent.press(screen.getByRole('button', { name: 'Start chatting' }))

    await waitFor(() => expect(onComplete).toHaveBeenCalled())

    // The access token is the one that would belong to the wrong gateway. (A
    // save always deletes the extra-headers key when there are none, so the
    // count says nothing on its own.)
    const deleted = secretStore.delete.mock.calls.map(([key]: [string]) => key)

    expect(deleted.includes(`hermie.auth.access_token-${mockGatewayId}`)).toBe(cleared)
    expect(keyValueStore.setJson).toHaveBeenCalled()
  })
})

/**
 * HERM-83 polish: the id a gateway signed the reader in AS does not survive
 * the two acts that actually end that: signing out of it, and forgetting it
 * outright. Neither is "the connection was merely rebuilt" — the case
 * `own-author.ts` now deliberately keeps the last answer for, across a launch
 * and across a reconnect — so both are asserted here rather than left to that
 * safer default.
 */
describe('signing out or forgetting a gateway forgets who the reader was on it', () => {
  it('clears the remembered author on sign-out', async () => {
    useOwnAuthorStore.getState().set(mockGatewayId, { id: 'authentik:previous-owner' })

    let gateway: ReturnType<typeof useGateway> | null = null

    renderScreen(
      <GatewayProvider>
        <Harness onRead={value => (gateway = value)} />
      </GatewayProvider>
    )

    await waitFor(() => expect(gateway?.phase).toBe('connected'))

    await act(async () => {
      await gateway?.signOut()
    })

    expect(useOwnAuthorStore.getState().byGateway[mockGatewayId]).toBeUndefined()
  })

  it('clears it on forgetGateway too', async () => {
    useOwnAuthorStore.getState().set(mockGatewayId, { id: 'authentik:previous-owner' })

    let gateway: ReturnType<typeof useGateway> | null = null

    renderScreen(
      <GatewayProvider>
        <Harness onRead={value => (gateway = value)} />
      </GatewayProvider>
    )

    await waitFor(() => expect(gateway?.phase).toBe('connected'))

    await act(async () => {
      await gateway?.forgetGateway()
    })

    expect(useOwnAuthorStore.getState().byGateway[mockGatewayId]).toBeUndefined()
  })
})
