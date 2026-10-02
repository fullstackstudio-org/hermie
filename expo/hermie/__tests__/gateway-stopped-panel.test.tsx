import { GatewayError, type AuthTimelineSnapshot, type ConnectionStatus } from '@hermie/gateway-client'
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { GatewayProvider, GatewayStoppedPanel } from '../src/gateway'
import { useConnectionStore } from '../src/gateway/store'
import { renderScreen } from './support/render'

const mockStatusHandlers: ((status: ConnectionStatus, error: GatewayError | null) => void)[] = []
const mockResume = jest.fn()
const mockRetryNow = jest.fn()
const mockSaveTokens = jest.fn(async () => undefined)

jest.mock('../src/gateway/client', () => ({
  attachLifecycle: () => () => undefined,
  createTokenCoordinator: () => ({ save: (...args: unknown[]) => mockSaveTokens(...(args as [])) }),
  createGatewayConnection: () => ({
    http: {},
    start: jest.fn(),
    stop: jest.fn(),
    resume: () => mockResume(),
    retryNow: () => mockRetryNow(),
    onStatus: (handler: (status: ConnectionStatus, error: GatewayError | null) => void) => {
      mockStatusHandlers.push(handler)
      handler('disconnected', null)

      return () => undefined
    }
  })
}))

// One configured gateway, in a list that names it. See `support/stored-gateway`.
jest.mock('../src/platform/key-value-store', () =>
  require('./support/stored-gateway').gatewayDisk({
    baseUrl: 'https://hermes.example.com:8443',
    authMode: 'native_pkce',
    provider: 'self-hosted',
    providerDisplayName: 'Self-Hosted OIDC',
    version: '2026.9.14',
    userDisplayName: 'tester@example.invalid'
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
  useConnectionStore.getState().setAuthTimeline({ events: [], lastSignOut: null })
})

/**
 * The signed-out state used to be a one-line banner over the chat and a small
 * "Sign in" in a corner, and a real Mac session reported the obvious: what the
 * reader saw was a chat error, and it was not clear at all that the thing to do
 * was sign in. It is a card in the content column now, and these are the same
 * three assertions the banner carried plus the ones the card owes: it names the
 * gateway, and the action is the in-place sign-in rather than the wizard.
 */
describe('the signed-out card', () => {
  /**
   * The card is only ever mounted by a shell that has decided to show it.
   *
   * `recorded` is applied after the provider has settled rather than before: the
   * provider's own startup restores the ring from disk and publishes it, so a
   * store seeded ahead of the render is replaced before anything reads it.
   */
  const renderWhenSignedOut = async (recorded?: AuthTimelineSnapshot) => {
    renderScreen(
      <GatewayProvider>
        <GatewayStoppedPanel />
      </GatewayProvider>
    )

    await waitFor(() => expect(mockStatusHandlers.length).toBeGreaterThan(0))

    if (recorded) {
      act(() => useConnectionStore.getState().setAuthTimeline(recorded))
    }

    pushStatus('needs_signin', new GatewayError('auth', 'expired'))
  }

  it('names the gateway the session expired on', async () => {
    await renderWhenSignedOut()

    expect(screen.getByTestId('signed-out-panel')).toHaveTextContent(/Signed out/)
    expect(screen.getByTestId('signed-out-panel')).toHaveTextContent(/hermes\.example\.com/)
  })

  it('offers signing in and changing gateway, and nothing else', async () => {
    await renderWhenSignedOut()

    expect(screen.getByTestId('signed-out-sign-in')).toBeTruthy()
    expect(screen.getByTestId('signed-out-change-gateway')).toBeTruthy()
  })

  /**
   * The point of the in-place flow: a refresh token can expire while the app is
   * sitting there, and sending the reader back through the whole wizard for
   * that would be rude. The web view opens where they are.
   */
  it('signs in where the reader is rather than restarting setup', async () => {
    await renderWhenSignedOut()

    expect(screen.queryByTestId('sign-in-webview')).toBeNull()

    act(() => {
      fireEvent.press(screen.getByTestId('signed-out-sign-in'))
    })

    expect(screen.getByTestId('sign-in-webview')).toBeTruthy()
  })

  /**
   * A session that ends with no explanation reads as the app's fault. The auth
   * ring knows which of the several paths to `needs_signin` was taken, and one
   * sentence is the difference between "Hermie logged me out" and "the gateway
   * would not renew the session".
   */
  it('names the cause when the auth ring recorded one', async () => {
    await renderWhenSignedOut({
      events: [{ at: 1, event: 'signin.required', reason: 'refresh_rejected' }],
      lastSignOut: { at: 1, reason: 'refresh_rejected' }
    })

    expect(screen.getByTestId('signed-out-reason')).toHaveTextContent(/rejected the saved sign-in/)
  })

  it('tells a failed renewal apart from a rejected one', async () => {
    await renderWhenSignedOut({ events: [], lastSignOut: { at: 1, reason: 'refresh_failed' } })

    expect(screen.getByTestId('signed-out-reason')).toHaveTextContent(/did not complete/)
  })

  /**
   * Silence beats a guess. A sign-out from before this build, or down a path that
   * recorded nothing, gets no sentence rather than a plausible invention.
   */
  it('says nothing at all when there is no recorded cause', async () => {
    await renderWhenSignedOut()

    expect(screen.queryByTestId('signed-out-reason')).toBeNull()
  })
})

/**
 * Every other stop, on the same card.
 *
 * The report behind these: a fresh install inherited a stored gateway address
 * from an earlier one, and all the app said was that the endpoint was not what
 * it expected — no address, nothing to press. So each kind is checked for the
 * two things that were missing, and for the sentence being the app's rather
 * than the transport's.
 */
describe('a gateway that cannot be used', () => {
  const renderWhenStopped = async (error: GatewayError) => {
    renderScreen(
      <GatewayProvider>
        <GatewayStoppedPanel />
      </GatewayProvider>
    )

    await waitFor(() => expect(mockStatusHandlers.length).toBeGreaterThan(0))
    pushStatus('disconnected', error)
  }

  it.each([
    [
      'an address it does not trust',
      new GatewayError('config', 'endpoint is not what it expects', { closeCode: 4403 })
    ],
    ['a takeover', new GatewayError('config', 'endpoint is not what it expects', { closeCode: 4408 })],
    ['chat switched off', new GatewayError('config', 'endpoint is not what it expects', { closeCode: 4404 })],
    ['a rejected certificate', new GatewayError('tls', 'endpoint is not what it expects')],
    ['something that is not a gateway', new GatewayError('not_hermes', 'endpoint is not what it expects')]
  ])('names the stored address and the ways out after %s', async (_label, error) => {
    await renderWhenStopped(error)

    expect(screen.getByTestId('gateway-stopped-panel')).toBeTruthy()

    // The address the app is stuck on, in the parts a reader checks it by.
    expect(screen.getByText('https://hermes.example.com:8443')).toBeTruthy()
    expect(screen.getByText('hermes.example.com')).toBeTruthy()
    expect(screen.getByText('8443')).toBeTruthy()
    expect(screen.getByText('https')).toBeTruthy()
    expect(screen.getByText('tester@example.invalid')).toBeTruthy()

    expect(screen.getByTestId('gateway-stopped-recheck')).toBeTruthy()
    expect(screen.getByTestId('signed-out-change-gateway')).toBeTruthy()
    expect(screen.getByTestId('gateway-stopped-sign-out')).toBeTruthy()
    // Signing in is not on offer: the credentials are not what is wrong.
    expect(screen.queryByTestId('signed-out-sign-in')).toBeNull()

    // Never the bare sentence the transport threw.
    expect(screen.queryByText('endpoint is not what it expects')).toBeNull()
  })

  it('dials on Re-check, restarting a loop that has stopped', async () => {
    await renderWhenStopped(new GatewayError('tls', 'rejected'))

    fireEvent.press(screen.getByTestId('gateway-stopped-recheck'))

    // `resume()` restarts a stopped loop; `retryNow()` resets the ladder of one
    // that is merely waiting. Each is a no-op in the other's case.
    expect(mockResume).toHaveBeenCalled()
    expect(mockRetryNow).toHaveBeenCalled()
  })

  it('stays up through the dial rather than flashing the app behind it', async () => {
    const refused = new GatewayError('config', 'refused', { closeCode: 4403 })
    await renderWhenStopped(refused)

    pushStatus('authenticating', refused)
    expect(screen.getByTestId('gateway-stopped-panel')).toBeTruthy()
    expect(screen.getByTestId('gateway-stopped-recheck')).toHaveTextContent('Checking…')

    pushStatus('ready', null)
    expect(screen.queryByTestId('gateway-stopped-panel')).toBeNull()
  })

  it('says nothing at all while a reconnect is still trying', async () => {
    await renderWhenStopped(new GatewayError('network', 'dropped'))
    pushStatus('reconnecting', new GatewayError('network', 'dropped'))

    expect(screen.queryByTestId('gateway-stopped-panel')).toBeNull()
    expect(screen.queryByTestId('signed-out-panel')).toBeNull()
  })
})
