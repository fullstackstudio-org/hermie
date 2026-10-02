/**
 * The Gateway category, and the route walk, on Hermie Web.
 *
 * Hermie Web is proxied to one gateway by the server in front of it
 * (`WEB_GATEWAY_BASE_URL`) — see `categories/Gateways.tsx`. There is nothing to
 * list, add, switch or forget there, so this is the web half of what
 * `settings-routes.test.tsx` already proves for the app: the category is
 * called by its singular name, its summary is the host alone, and
 * `GatewayDetail`/`GatewayAdd` are not part of the walk at all — a route that
 * manages more than one gateway does not belong in a build that can only ever
 * have the one.
 *
 * A separate file rather than a third dimension folded into the existing
 * walk: `WEB_GATEWAY_BASE_URL` is mocked at module load, the same way every
 * other web-flavoured suite in this app is (`gateway-stopped-web.test.tsx`,
 * `web-signin-resume.test.tsx`, …), and a Jest mock is static per file.
 */
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { Text } from 'react-native'

import { SettingsScreen } from '../src/features/settings'
import {
  isSettingsRouteVisible,
  SETTINGS_ROUTE_NAMES,
  SETTINGS_ROUTES,
  visibleSettingsRouteNames,
  type SettingsRouteName
} from '../src/features/settings/navigation'
import { useBotsStore } from '../src/store/bots'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen, waitForGone } from './support/render'

const mockEscapeListeners = new Set<() => void>()

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

// Half a megabyte of generated JSON; this suite is about the route, not the payload.
jest.mock('../src/features/settings/licences-data', () => ({
  loadLicenceData: async () => ({
    generatedBy: 'scripts/generate-third-party-licenses.mjs',
    scope: 'production dependencies of expo/hermie',
    excludesWorkspacePackages: ['@hermie/transcript'],
    packages: [{ name: 'expo', version: '54.0.37', licence: 'MIT' }],
    texts: {}
  })
}))

// What the browser build resolves to: the page's own origin, because the
// server in front of it decided the gateway — see `gateway-stopped-web.test.tsx`.
jest.mock('../src/gateway/web-config', () => ({
  WEB_GATEWAY_BASE_URL: 'http://127.0.0.1:9120',
  loadHermieWebConfig: jest.fn(async () => null)
}))

// One entry: the only shape a device can be in once a browser fixed the
// gateway for it. Unlike the app suite, there is no second gateway to add.
const mockGateway = {
  canRefresh: true,
  changeGateway: jest.fn(),
  config: { authMode: 'session_token', baseUrl: 'http://127.0.0.1:9120', version: '1.2.3' },
  connection: null,
  forgetGateway: jest.fn(),
  gatewayId: 'g1',
  http: null,
  refreshRegistry: jest.fn(async () => undefined),
  registry: {
    activeGatewayId: 'g1',
    gateways: [
      {
        addedAt: 1,
        address: 'http://127.0.0.1:9120',
        authKind: 'session_token' as const,
        id: 'g1',
        name: 'Home',
        signedInUser: 'Sam'
      }
    ]
  },
  removeGateway: jest.fn(),
  renameGateway: jest.fn(),
  signOut: jest.fn(),
  signOutOf: jest.fn(),
  status: 'ready',
  switchGateway: jest.fn()
}

jest.mock('../src/gateway', () => ({
  createGatewayConnection: () => ({
    http: { get: jest.fn(), post: jest.fn() },
    onStatus: () => () => undefined,
    start: jest.fn(),
    stop: jest.fn()
  }),
  hostOf: (url: string) => url.replace(/^https?:\/\//u, ''),
  useGateway: () => mockGateway
}))

/*
  Just enough of a push sync for the Notifications page to draw its switch —
  see `settings-routes.test.tsx` for why.
*/
const mockPush = {
  disable: jest.fn(async () => undefined),
  enable: jest.fn(async () => undefined),
  needsSystemSettings: false,
  openSystemSettings: jest.fn(async () => false),
  permission: jest.fn(async () => 'granted'),
  retry: jest.fn(async () => undefined)
}

jest.mock('../src/features/chats/ChatRuntime', () => ({ useChatRuntime: () => ({ push: mockPush }) }))

/** What a route that names something needs to be opened with. `GatewayDetail`/`GatewayAdd` never appear here: web has neither. */
const PARAMS: Partial<Record<SettingsRouteName, object>> = {
  Connector: { sessionId: 'session-1', slug: 'gmail' },
  McpServer: { name: 'files' },
  MemoryBot: { profile: 'researcher' },
  ThemeEdit: { id: 'walk-theme' }
}

const page = (name: SettingsRouteName) => screen.getByTestId(`settings-page-${name}`)

/** The two ways Settings is ever mounted — see `settings-routes.test.tsx` for what each one is. */
type Host = 'independent' | 'nested'

const HostStack = createNativeStackNavigator()

function renderHost(host: Host, name: SettingsRouteName) {
  const props = { initialRoute: name, ...(PARAMS[name] ? { initialParams: PARAMS[name] } : {}) }

  if (host === 'independent') {
    renderScreen(<SettingsScreen {...props} />)

    return
  }

  renderScreen(
    <NavigationContainer>
      <HostStack.Navigator initialRouteName="Settings" screenOptions={{ headerShown: false }}>
        <HostStack.Screen name="Bots">{() => <Text>the chat list</Text>}</HostStack.Screen>
        <HostStack.Screen name="Settings">{() => <SettingsScreen {...props} />}</HostStack.Screen>
      </HostStack.Navigator>
    </NavigationContainer>
  )
}

async function open(name: SettingsRouteName) {
  await openOn('independent', name)
}

async function openOn(host: Host, name: SettingsRouteName) {
  renderHost(host, name)

  await waitFor(() => expect(page(name)).toBeTruthy())
}

beforeEach(() => {
  mockEscapeListeners.clear()
  useBotsStore.getState().reset()
  useSettingsStore.getState().reset()
})

describe('the registry on this build', () => {
  it('drops exactly the routes that manage more than one gateway', () => {
    expect(SETTINGS_ROUTE_NAMES.filter(name => !isSettingsRouteVisible(name))).toEqual(['GatewayDetail', 'GatewayAdd'])
    expect(visibleSettingsRouteNames()).toEqual(
      SETTINGS_ROUTE_NAMES.filter(name => name !== 'GatewayDetail' && name !== 'GatewayAdd')
    )
  })
})

describe('the Gateway category', () => {
  it('is called by its singular name in the list, with the host alone as its line of state', async () => {
    await open('Root')

    const row = screen.getByTestId('settings-cat-Gateways')

    expect(row.props.accessibilityLabel).toBe('Gateway')

    const summary = screen.getByTestId('settings-cat-Gateways-summary')

    expect(summary).toHaveTextContent('127.0.0.1')
    // The bug this guards: "3 gateways" in a build that can only ever have one.
    expect(summary).not.toHaveTextContent(/gateway/i)
  })

  it('opens on a header card that says nothing about other gateways', async () => {
    await open('Gateways')

    expect(screen.getByTestId('settings-header-Gateways-title')).toHaveTextContent('Gateway')
    expect(screen.getByTestId('settings-header-Gateways-blurb')).not.toHaveTextContent(/other/i)
  })

  it('draws no list, no add row, and nothing that switches or forgets', async () => {
    await open('Gateways')

    expect(screen.queryByTestId('settings-gateways')).toBeNull()
    expect(screen.queryByTestId('gateways-add')).toBeNull()
  })

  it('still shows what it is purely informative about: the address, the version, the status and the plugin', async () => {
    await open('Gateways')

    expect(screen.getByText('http://127.0.0.1:9120')).toBeTruthy()
    expect(screen.getByText('1.2.3')).toBeTruthy()
  })
})

/*
  The walk, restricted to the routes this build actually has. Generated from
  `visibleSettingsRouteNames()` rather than `SETTINGS_ROUTE_NAMES` — the point
  of the file — so `GatewayDetail`/`GatewayAdd` are never attempted here, and a
  route added to the hidden set without a reason to hide it would shrink this
  list and fail the count assertion above instead of silently losing coverage.
*/
describe.each(['independent', 'nested'] as const)('the %s host, on Hermie Web', host => {
  describe.each(visibleSettingsRouteNames().filter(name => SETTINGS_ROUTES[name].parent !== null))('%s', name => {
    const parent = SETTINGS_ROUTES[name].parent as SettingsRouteName

    it('has exactly one back control anywhere on screen, inside the page, labelled with the page it returns to', async () => {
      await openOn(host, name)

      const backs = screen.queryAllByTestId('page-back')

      expect(backs).toHaveLength(1)
      expect(within(page(name)).getByTestId('page-back')).toBe(backs[0])
      expect(backs[0]?.props.accessibilityLabel).toBe(SETTINGS_ROUTES[parent].title())
    })

    it('goes back to its parent when that control is pressed', async () => {
      await openOn(host, name)

      fireEvent.press(within(page(name)).getByTestId('page-back'))

      await waitForGone(() => screen.queryByTestId(`settings-page-${name}`), `the ${name} page`)
      expect(page(parent)).toBeTruthy()
    })
  })
})
