/**
 * Reauth after `--no-oidc` (`HERMIE_OIDC=0`).
 *
 * `server.test.ts`'s own `--no-oidc` suite covers the server half: `/auth/login`
 * is refused outright, whatever provider it names. This is the app half —
 * `reauth.tsx`'s `signIn`, which used to send every cookie-mode reauth there
 * unconditionally. A password user with a stopped session pressed "Sign in
 * again" and got the server's bare 403 instead of a sign-in screen.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import type { ConnectionStatus, GatewayError } from '@hermie/gateway-client'

import { GatewayProvider, GatewayStoppedPanel } from '../src/gateway'
import { reauthAtAppRoot, startCookieSignIn } from '../src/features/onboarding/cookie-sign-in'
import { type HermieWebConfig, loadHermieWebConfig } from '../src/gateway/web-config'
import { renderScreen } from './support/render'

const mockStatusHandlers: ((status: ConnectionStatus, error: GatewayError | null) => void)[] = []

jest.mock('../src/gateway/client', () => ({
  attachLifecycle: () => () => undefined,
  createTokenCoordinator: () => ({ save: jest.fn(async () => undefined) }),
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

jest.mock('../src/gateway/web-config', () => ({
  WEB_GATEWAY_BASE_URL: 'http://127.0.0.1:9120',
  loadHermieWebConfig: jest.fn()
}))

jest.mock('../src/features/onboarding/cookie-sign-in', () => ({
  ...jest.requireActual('../src/features/onboarding/cookie-sign-in'),
  startCookieSignIn: jest.fn(),
  reauthAtAppRoot: jest.fn()
}))

jest.mock('../src/platform/key-value-store', () =>
  require('./support/stored-gateway').gatewayDisk({
    baseUrl: 'http://127.0.0.1:9120',
    authMode: 'cookie',
    provider: 'self-hosted',
    version: '2026.9.14'
  })
)

jest.mock('../src/platform/secret-store', () => require('./support/stored-gateway').gatewaySecrets())

const config = jest.mocked(loadHermieWebConfig)
const startSignIn = jest.mocked(startCookieSignIn)
const atRoot = jest.mocked(reauthAtAppRoot)

const BASE_CONFIG: HermieWebConfig = {
  gatewayHost: '127.0.0.1:9119',
  gatewayOrigin: 'http://127.0.0.1:9119',
  loginReturn: '/',
  version: '0.1.2',
  setupRequired: false,
  authRequired: true,
  authKinds: ['cookie'],
  providers: [{ name: 'self-hosted', displayName: 'Local account', supportsPassword: true }],
  oidc: true,
  service: { login: true, push: true, cache: true }
}

const pushStatus = (status: ConnectionStatus, error: GatewayError | null = null) =>
  act(() => {
    for (const handler of mockStatusHandlers) {
      handler(status, error)
    }
  })

beforeEach(() => {
  mockStatusHandlers.length = 0
  jest.clearAllMocks()
})

async function renderSignedOut() {
  renderScreen(
    <GatewayProvider>
      <GatewayStoppedPanel />
    </GatewayProvider>
  )

  await waitFor(() => expect(mockStatusHandlers.length).toBeGreaterThan(0))
  pushStatus('needs_signin')
  await waitFor(() => expect(screen.getByTestId('signed-out-sign-in')).toBeTruthy())
}

describe('pressing "Sign in again" in cookie mode', () => {
  it('reloads at the app root instead of the OAuth door once OIDC is off', async () => {
    config.mockResolvedValue({ ...BASE_CONFIG, oidc: false })

    await renderSignedOut()
    fireEvent.press(screen.getByTestId('signed-out-sign-in'))

    await waitFor(() => expect(atRoot).toHaveBeenCalledTimes(1))
    expect(startSignIn).not.toHaveBeenCalled()
  })

  it('still uses the OAuth door when OIDC is on', async () => {
    config.mockResolvedValue({ ...BASE_CONFIG, oidc: true })

    await renderSignedOut()
    fireEvent.press(screen.getByTestId('signed-out-sign-in'))

    await waitFor(() => expect(startSignIn).toHaveBeenCalledWith('http://127.0.0.1:9120', 'self-hosted'))
    expect(atRoot).not.toHaveBeenCalled()
  })

  it('also uses the OAuth door when the server says nothing at all (an older Hermie Web)', async () => {
    config.mockResolvedValue(null)

    await renderSignedOut()
    fireEvent.press(screen.getByTestId('signed-out-sign-in'))

    await waitFor(() => expect(startSignIn).toHaveBeenCalledWith('http://127.0.0.1:9120', 'self-hosted'))
    expect(atRoot).not.toHaveBeenCalled()
  })
})
