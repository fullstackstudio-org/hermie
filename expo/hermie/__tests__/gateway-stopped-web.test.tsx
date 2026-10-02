/**
 * The same card in a browser, where there is no address to change.
 *
 * Hermie Web serves the app and proxies ONE gateway onto its own origin, and
 * the wizard there has no address step at all — see `docs/web.md` and
 * `ONBOARDING_ORDER`. A "Change gateway" button would be a button that opens a
 * step that does not exist, so the card says where the decision actually lives
 * instead of offering a dead end.
 */
import { GatewayError, type ConnectionStatus } from '@hermie/gateway-client'
import { act, screen, waitFor } from '@testing-library/react-native'

import { GatewayProvider, GatewayStoppedPanel } from '../src/gateway'
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

// What the browser build resolves to: the page's own origin, because the server
// in front of it is the thing that picked the gateway.
jest.mock('../src/gateway/web-config', () => ({
  WEB_GATEWAY_BASE_URL: 'http://127.0.0.1:9120',
  loadHermieWebConfig: jest.fn(async () => null)
}))

// One configured gateway, in a list that names it. See `support/stored-gateway`.
jest.mock('../src/platform/key-value-store', () =>
  require('./support/stored-gateway').gatewayDisk({
    baseUrl: 'http://127.0.0.1:9120',
    authMode: 'cookie',
    version: '2026.9.14'
  })
)

jest.mock('../src/platform/secret-store', () => require('./support/stored-gateway').gatewaySecrets())

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

async function renderStopped() {
  renderScreen(
    <GatewayProvider>
      <GatewayStoppedPanel />
    </GatewayProvider>
  )

  await waitFor(() => expect(mockStatusHandlers.length).toBeGreaterThan(0))
  pushStatus('disconnected', new GatewayError('config', 'refused', { closeCode: 4403 }))
}

describe('the stopped card in a browser', () => {
  it('explains that the server decides the gateway, instead of offering setup', async () => {
    await renderStopped()

    expect(screen.getByTestId('gateway-stopped-fixed')).toHaveTextContent(/served by Hermie Web, which decides/)
    expect(screen.queryByTestId('signed-out-change-gateway')).toBeNull()
  })

  it('still says what went wrong and still offers a re-check', async () => {
    await renderStopped()

    expect(screen.getByTestId('gateway-stopped-sentence')).toHaveTextContent(/does not trust this address/)
    expect(screen.getByTestId('gateway-stopped-recheck')).toBeTruthy()
  })

  /**
   * The scheme and port of this page are the PROXY's, and saying they are the
   * gateway's is the defect `GatewayAddressRow.web.tsx` exists to fix. The row
   * that knows how to answer "which gateway am I on" here is the whole block.
   */
  it('leaves the proxy’s own scheme and port off the address block', async () => {
    await renderStopped()

    expect(screen.queryByText('Scheme')).toBeNull()
    expect(screen.queryByText('Port')).toBeNull()
    expect(screen.getByText('Address')).toBeTruthy()
  })
})
