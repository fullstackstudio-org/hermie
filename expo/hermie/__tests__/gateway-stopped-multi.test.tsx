/**
 * What the dead-connection card says on a device with more than one gateway.
 *
 * The card's whole job is to say which machine cannot be used and what can be
 * done about it. With a list, both halves of that sentence change: the machine
 * has a name the reader chose, and "use the other one" becomes a real answer
 * where it was previously nothing at all.
 *
 * The pure decision is tested first, because the card only renders what
 * `gatewayStop` decided.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ConnectionStatus, GatewayError } from '@hermie/gateway-client'

import { DebugConnectionScreen } from '../src/features/settings'
import { GatewayProvider } from '../src/gateway'
import { gatewayStop } from '../src/gateway/gateway-stop'
import { GatewayStoppedPanel } from '../src/gateway/GatewayStoppedPanel'
import { withProviders } from './support/render'

const mockDisk = new Map<string, string>()
const mockGatewayA = 'gaaaaaaaaaaaaaaaa'
const mockGatewayB = 'gbbbbbbbbbbbbbbbb'
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
      handler('ready', null)

      return () => undefined
    }
  })
}))

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    getJson: jest.fn(async (key: string) => {
      const raw = mockDisk.get(key)

      return raw === undefined ? null : JSON.parse(raw)
    }),
    setJson: jest.fn(async (key: string, value: unknown) => {
      mockDisk.set(key, JSON.stringify(value))
    }),
    keys: jest.fn(async () => [...mockDisk.keys()]),
    deleteMany: jest.fn(async (keys: readonly string[]) => {
      keys.forEach(key => mockDisk.delete(key))
    })
  }
}))

jest.mock('../src/platform/secret-store', () => ({
  secretStore: {
    get: jest.fn(async (key: string) => (key.startsWith('hermie.auth.access_token-') ? 'access-1' : null)),
    set: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined)
  }
}))

const CONFIG = { baseUrl: 'https://home.example.com', authMode: 'native_pkce' as const, userDisplayName: 'Sam' }

const entry = (id: string, name: string, address: string, addedAt: number) => ({
  id,
  name,
  address,
  authKind: 'native_pkce' as const,
  addedAt
})

function seed(count: number) {
  mockDisk.set(
    'hermie.gateways',
    JSON.stringify({
      v: 1,
      activeGatewayId: mockGatewayA,
      gateways:
        count === 1
          ? [entry(mockGatewayA, 'Home', CONFIG.baseUrl, 1)]
          : [entry(mockGatewayA, 'Home', CONFIG.baseUrl, 1), entry(mockGatewayB, 'Work', 'https://work.example.com', 2)]
    })
  )
  mockDisk.set(`hermie.gateway.config@${mockGatewayA}`, JSON.stringify(CONFIG))
}

const NOT_HERMES: GatewayError = {
  kind: 'not_hermes',
  message: 'the endpoint is not what Hermie expects'
} as GatewayError

beforeEach(() => {
  mockDisk.clear()
  mockStatusHandlers.length = 0
  jest.clearAllMocks()
})

describe('what the card decides', () => {
  const base = { status: 'disconnected' as ConnectionStatus, error: NOT_HERMES, config: CONFIG }

  it('offers another gateway, and names this one, once there are two', () => {
    const stop = gatewayStop({ ...base, gateway: { name: 'Home' }, gatewayCount: 2 })

    expect(stop?.gatewayName).toBe('Home')
    expect(stop?.actions).toContain('switchGateway')
  })

  it('offers neither on a device with one gateway', () => {
    const stop = gatewayStop({ ...base, gateway: { name: 'Home' }, gatewayCount: 1 })

    // An action that leads nowhere is worse than an action that is absent, and
    // a name with nothing to distinguish it from is a label nobody reads.
    expect(stop?.gatewayName).toBe('')
    expect(stop?.actions).not.toContain('switchGateway')
  })

  it('offers it for a signed-out session too, after the ways of fixing this one', () => {
    const stop = gatewayStop({
      status: 'needs_signin',
      error: null,
      config: CONFIG,
      gateway: { name: 'Home' },
      gatewayCount: 2
    })

    expect(stop?.actions).toEqual(['signIn', 'recheck', 'changeGateway', 'switchGateway'])
  })
})

describe('the card itself', () => {
  const show = async (count: number) => {
    seed(count)
    render(
      withProviders(
        <GatewayProvider>
          <GatewayStoppedPanel />
        </GatewayProvider>
      )
    )

    await waitFor(() => expect(mockStatusHandlers.length).toBeGreaterThan(0))

    act(() => {
      for (const handler of mockStatusHandlers) {
        handler('disconnected', NOT_HERMES)
      }
    })

    await waitFor(() => expect(screen.getByTestId('gateway-stopped-panel')).toBeTruthy())
  }

  it('names the gateway that failed and offers the other by name', async () => {
    await show(2)

    expect(screen.getByTestId('gateway-stopped-name')).toHaveTextContent('Home')
    expect(screen.getByTestId(`gateway-stopped-switch-${mockGatewayB}`)).toBeTruthy()
    // The one that is already live is not offered: it is the one that failed.
    expect(screen.queryByTestId(`gateway-stopped-switch-${mockGatewayA}`)).toBeNull()
  })

  it('says nothing about gateways on a device with one', async () => {
    await show(1)

    expect(screen.queryByTestId('gateway-stopped-name')).toBeNull()
    expect(screen.queryByTestId(`gateway-stopped-switch-${mockGatewayB}`)).toBeNull()
  })

  it('switches when the other gateway is pressed', async () => {
    await show(2)

    await act(async () => {
      fireEvent.press(screen.getByTestId(`gateway-stopped-switch-${mockGatewayB}`))
    })

    await waitFor(() => expect(JSON.parse(mockDisk.get('hermie.gateways')!).activeGatewayId).toBe(mockGatewayB))
  })
})

describe('the developer screen', () => {
  it('says whose auth ring it is printing', async () => {
    seed(2)

    render(
      withProviders(
        <GatewayProvider>
          <DebugConnectionScreen onClose={jest.fn()} />
        </GatewayProvider>
      )
    )

    // There is one ring per gateway now, so a screen that printed the events
    // without naming the machine would offer a diagnosis that could belong to
    // either of them.
    // A regex, because `toHaveTextContent` is EXACT in this library — see the
    // note in docs/platform-notes.md about the matcher that never passes.
    await waitFor(() => expect(screen.getByTestId('debug-auth-gateway')).toHaveTextContent(/gateway: Home/u))
    expect(screen.getByTestId('debug-auth-gateway')).toHaveTextContent(/https:\/\/home\.example\.com/u)
  })
})
