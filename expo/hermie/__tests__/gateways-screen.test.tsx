/**
 * Settings → Gateways: the list, and the four things it can do.
 *
 * The cases are chosen for what a mistake would cost rather than for coverage.
 * Switching tears a live socket down, so the test is that it writes the pointer
 * and re-reads; ADDING must NOT do that, so the test is that the pointer did
 * not move; and removing takes a keychain item and a cache with it, so the test
 * is what is left on disk afterwards rather than what is left on screen.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'
import type { ConnectionStatus, GatewayError } from '@hermie/gateway-client'

import { GatewayTitle } from '../src/features/bots/GatewayTitle'
import { SettingsScreen } from '../src/features/settings'
import { GatewayProvider, useGateway } from '../src/gateway'
import { withProviders } from './support/render'

/** A decorative mark is hidden from accessibility, so a query has to say so. */
const HIDDEN = { includeHiddenElements: true } as const

const mockDisk = new Map<string, string>()
const mockKeychain = new Map<string, string>()

const mockGatewayA = 'gaaaaaaaaaaaaaaaa'
const mockGatewayB = 'gbbbbbbbbbbbbbbbb'

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
      handler('ready', null)

      return () => undefined
    }
  })
}))

jest.mock('../src/platform/key-value-store', () => ({
  keyValueStore: {
    get: jest.fn(async (key: string) => mockDisk.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      mockDisk.set(key, value)
    }),
    delete: jest.fn(async (key: string) => {
      mockDisk.delete(key)
    }),
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
    get: jest.fn(async (key: string) => mockKeychain.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      mockKeychain.set(key, value)
    }),
    delete: jest.fn(async (key: string) => {
      mockKeychain.delete(key)
    })
  }
}))

const entry = (id: string, name: string, address: string, addedAt: number) => ({
  id,
  name,
  address,
  authKind: 'native_pkce' as const,
  signedInUser: 'Sam',
  addedAt
})

function seed(activeGatewayId = mockGatewayA) {
  mockDisk.set(
    'hermie.gateways',
    JSON.stringify({
      v: 1,
      activeGatewayId,
      gateways: [
        entry(mockGatewayA, 'Home', 'https://home.example.com', 1),
        entry(mockGatewayB, 'Work', 'https://work.example.com', 2)
      ]
    })
  )

  for (const [id, address] of [
    [mockGatewayA, 'https://home.example.com'],
    [mockGatewayB, 'https://work.example.com']
  ]) {
    mockDisk.set(`hermie.gateway.config@${id}`, JSON.stringify({ baseUrl: address, authMode: 'native_pkce' }))
    mockDisk.set(`hermie.chat.view@${id}`, JSON.stringify({ defaults: {}, perChat: {} }))
    mockKeychain.set(`hermie.auth.access_token-${id}`, `access-${id}`)
  }

  mockDisk.set(
    'hermie.chats.layout',
    JSON.stringify({ [mockGatewayA]: { entries: [], archived: [], accents: {} }, [mockGatewayB]: {} })
  )
}

const registry = () => JSON.parse(mockDisk.get('hermie.gateways')!)

/** The provider's answer, read the way the app's own root reads it. */
function Harness({ onRead }: { onRead: (value: ReturnType<typeof useGateway>) => void }) {
  onRead(useGateway())

  return null
}

/**
 * Settings → Gateways, opened the way a dev intent opens it: the list is a page
 * in the Settings stack now (HERM-108) rather than a screen of its own.
 */
async function openList() {
  let gateway: ReturnType<typeof useGateway> | null = null

  render(
    withProviders(
      <GatewayProvider>
        <Harness onRead={value => (gateway = value)} />
        <SettingsScreen initialRoute="Gateways" />
      </GatewayProvider>
    )
  )

  await waitFor(() => expect(screen.getByTestId(`gateway-row-${mockGatewayA}`)).toBeTruthy())

  return () => gateway
}

beforeEach(() => {
  mockDisk.clear()
  mockKeychain.clear()
  jest.clearAllMocks()
  seed()
})

describe('the list', () => {
  it('names every gateway and marks the one that is connected', async () => {
    await openList()

    expect(screen.getByText('Home')).toBeTruthy()
    expect(screen.getByText('Work')).toBeTruthy()
    expect(screen.getByTestId(`gateway-active-${mockGatewayA}`)).toBeTruthy()
    expect(screen.queryByTestId(`gateway-active-${mockGatewayB}`)).toBeNull()
  })

  it('shows the address and who is signed in on each row', async () => {
    await openList()

    expect(screen.getByText('https://work.example.com · Signed in as Sam')).toBeTruthy()
  })
})

describe('switching', () => {
  it('moves the pointer and redials', async () => {
    const read = await openList()

    await act(async () => {
      fireEvent.press(screen.getByTestId(`gateway-switch-${mockGatewayB}`))
    })

    await waitFor(() => expect(registry().activeGatewayId).toBe(mockGatewayB))
    // The provider's own copy follows, which is what every other screen reads.
    await waitFor(() => expect(read()?.gatewayId).toBe(mockGatewayB))
  })

  /**
   * The act is on the row, in words.
   *
   * The footer under the list has always said that a tap connects, and the owner
   * still read the list as a list of things to look at. A word on the row is a
   * control; a sentence under the list is a caption.
   */
  it('offers the switch as a labelled action on every row that is not live', async () => {
    const read = await openList()

    expect(screen.getByTestId(`gateway-use-${mockGatewayB}`)).toHaveTextContent('Use this gateway')
    // Not on the live row: there the tick says the act has already happened.
    expect(screen.queryByTestId(`gateway-use-${mockGatewayA}`)).toBeNull()
    expect(screen.getByTestId(`gateway-tick-${mockGatewayA}`, HIDDEN)).toBeTruthy()

    await act(async () => {
      fireEvent.press(screen.getByTestId(`gateway-use-${mockGatewayB}`))
    })

    await waitFor(() => expect(registry().activeGatewayId).toBe(mockGatewayB))
    await waitFor(() => expect(read()?.gatewayId).toBe(mockGatewayB))
  })

  it('does nothing when the gateway is already the live one', async () => {
    await openList()

    // The row for the live gateway is not pressable at all: the whole of what
    // a tap would do has already happened.
    expect(screen.getByTestId(`gateway-switch-${mockGatewayA}`).props.accessibilityState.disabled).toBe(true)
    expect(registry().activeGatewayId).toBe(mockGatewayA)
  })
})

describe('adding another', () => {
  it('opens setup and leaves the live gateway alone', async () => {
    await openList()

    await act(async () => {
      fireEvent.press(screen.getByTestId('gateways-add'))
    })

    // The wizard, on its cover step, over a gateway that is still connected.
    expect(screen.getByTestId('onboarding-card')).toBeTruthy()
    expect(registry().activeGatewayId).toBe(mockGatewayA)
  })

  /**
   * The wizard's first step is not under the glass header.
   *
   * It does not scroll under the chrome — it is a card with a field and a button
   * at the top — so it clears the header with a spacer, and the spacer's height
   * is the seam this asserts on. The bug it replaces was silent and total:
   * `usePageChromeHeight()` was called in the component that RENDERS the frame,
   * one level above the context that carries the measurement, so it read the
   * default 0 for ever. The wizard drew under the header and the header took
   * the taps meant for the field.
   */
  it('keeps the wizard’s first step clear of the glass header', async () => {
    await openList()

    await act(async () => {
      fireEvent.press(screen.getByTestId('gateways-add'))
    })

    // A layout pass, which a test renderer never performs by itself.
    act(() => {
      fireEvent(screen.getByTestId('page-chrome'), 'layout', {
        nativeEvent: { layout: { height: 96, width: 402, x: 0, y: 0 } }
      })
    })

    const spacer = screen.getByTestId('page-chrome-spacer')

    expect(StyleSheet.flatten(spacer.props.style).height).toBe(96)
  })
})

describe('one gateway’s own page', () => {
  const openWork = async () => {
    const read = await openList()

    await act(async () => {
      fireEvent.press(screen.getByTestId(`gateway-manage-${mockGatewayB}`))
    })

    return read
  }

  it('renames it on this device and nowhere else', async () => {
    await openWork()

    fireEvent.changeText(screen.getByTestId('gateway-name'), 'The Pi')

    await act(async () => {
      fireEvent.press(screen.getByTestId('gateway-rename'))
    })

    await waitFor(() =>
      expect(registry().gateways.find((row: { id: string }) => row.id === mockGatewayB).name).toBe('The Pi')
    )
  })

  it('signs out of a gateway that is not live without touching the one that is', async () => {
    await openWork()

    await act(async () => {
      fireEvent.press(screen.getByTestId('gateway-sign-out'))
    })

    await waitFor(() => expect(mockKeychain.has(`hermie.auth.access_token-${mockGatewayB}`)).toBe(false))
    // The live gateway's credential is untouched, and B keeps its address.
    expect(mockKeychain.get(`hermie.auth.access_token-${mockGatewayA}`)).toBe(`access-${mockGatewayA}`)
    expect(mockDisk.has(`hermie.gateway.config@${mockGatewayB}`)).toBe(true)
  })

  it('asks before removing, and then removes everything that gateway left here', async () => {
    await openWork()

    await act(async () => {
      fireEvent.press(screen.getByTestId('gateway-remove'))
    })

    // Nothing has happened yet: the first press only asks.
    expect(mockDisk.has(`hermie.gateway.config@${mockGatewayB}`)).toBe(true)

    await act(async () => {
      fireEvent.press(screen.getByTestId('gateway-remove-confirm'))
    })

    await waitFor(() => expect(registry().gateways).toHaveLength(1))

    expect(mockDisk.has(`hermie.gateway.config@${mockGatewayB}`)).toBe(false)
    expect(mockDisk.has(`hermie.chat.view@${mockGatewayB}`)).toBe(false)
    expect(mockKeychain.has(`hermie.auth.access_token-${mockGatewayB}`)).toBe(false)
    expect(Object.keys(JSON.parse(mockDisk.get('hermie.chats.layout')!))).toEqual([mockGatewayA])

    // And the live gateway is exactly as it was.
    expect(mockDisk.has(`hermie.gateway.config@${mockGatewayA}`)).toBe(true)
    expect(mockKeychain.get(`hermie.auth.access_token-${mockGatewayA}`)).toBe(`access-${mockGatewayA}`)
    expect(registry().activeGatewayId).toBe(mockGatewayA)
  })
})

describe('the chat list’s title, and the switch behind it', () => {
  const renderTitle = () =>
    render(
      withProviders(
        <GatewayProvider>
          <GatewayTitle />
        </GatewayProvider>
      )
    )

  it('becomes the gateway’s name once there is more than one to tell apart', async () => {
    renderTitle()

    await waitFor(() => expect(screen.getByTestId('bots-gateway-switch')).toHaveTextContent('Home'))
  })

  it('lists every gateway with the live one ticked, and switches on a tap', async () => {
    renderTitle()

    await waitFor(() => expect(screen.getByTestId('bots-gateway-switch')).toBeTruthy())
    fireEvent.press(screen.getByTestId('bots-gateway-switch'))

    await waitFor(() => expect(screen.getByTestId(`bots-gateway-choice-${mockGatewayA}`)).toBeTruthy())
    expect(screen.getByTestId(`bots-gateway-choice-${mockGatewayB}`)).toBeTruthy()
    /*
      The tick is on the live one and on nothing else. Asked for with hidden
      elements included, because a mark beside a label it repeats is hidden FROM
      ACCESSIBILITY on purpose — the row says which one it is through
      `aria-selected`, and `Icon` keeps itself out of the tree so it cannot say
      it twice.
    */
    expect(screen.getByTestId(`bots-gateway-active-${mockGatewayA}`, HIDDEN)).toBeTruthy()
    expect(screen.queryByTestId(`bots-gateway-active-${mockGatewayB}`, HIDDEN)).toBeNull()

    await act(async () => {
      fireEvent.press(screen.getByTestId(`bots-gateway-choice-${mockGatewayB}`))
    })

    await waitFor(() => expect(registry().activeGatewayId).toBe(mockGatewayB))
  })

  it('is the screen’s own name, with nothing to press, when there is one gateway', async () => {
    mockDisk.set(
      'hermie.gateways',
      JSON.stringify({
        v: 1,
        activeGatewayId: mockGatewayA,
        gateways: [entry(mockGatewayA, 'Home', 'https://home.example.com', 1)]
      })
    )

    renderTitle()

    // A control whose menu has one row in it teaches the reader to stop pressing
    // things.
    await waitFor(() => expect(screen.getByText('Chats')).toBeTruthy())
    expect(screen.queryByTestId('bots-gateway-switch')).toBeNull()
  })
})
