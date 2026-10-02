/**
 * Every Settings page has exactly ONE back control, and it goes where it says.
 *
 * This is the proof HERM-101 asked for, and it is generated from the registry
 * rather than written per page: for every route with a parent, open it, assert
 * there is exactly one `page-back` on the page, assert it is labelled with the
 * parent's title, press it, and assert the parent is what is left. A page added
 * to `SETTINGS_ROUTES` without a working back cannot pass this file, and a page
 * added without an entry does not compile.
 *
 * The inventory at the end is the other half: every control the old
 * `SettingsScreen` carried is still reachable on some page, so "one long screen
 * became twelve" did not quietly drop a setting.
 */
import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { Text } from 'react-native'

import { SETTINGS_ROUTE_NAMES, SETTINGS_ROUTES, type SettingsRouteName } from '../src/features/settings/navigation'
import { SettingsScreen } from '../src/features/settings'
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

const mockGateway = {
  canRefresh: true,
  changeGateway: jest.fn(),
  config: { authMode: 'session_token', baseUrl: 'https://gateway.example.com', version: '1.2.3' },
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
        address: 'https://gateway.example.com',
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
  Just enough of a push sync for the Notifications page to draw its switch: the
  section renders nothing at all without one, and this suite is about the page
  being reachable rather than about what the daemon does.
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

/** What a route that names something needs to be opened with. */
const PARAMS: Partial<Record<SettingsRouteName, object>> = {
  Connector: { sessionId: 'session-1', slug: 'gmail' },
  GatewayDetail: { id: 'g1' },
  McpServer: { name: 'files' },
  MemoryBot: { profile: 'researcher' },
  // No user theme has to exist for this: `ThemeEditScreen` falls back to a
  // preset the same way `resolveThemeFace` does, which is what makes the walk
  // reach it without first creating one through `Theme`.
  ThemeEdit: { id: 'walk-theme' }
}

const page = (name: SettingsRouteName) => screen.getByTestId(`settings-page-${name}`)

/**
 * The two ways Settings is ever mounted, reduced to the one thing that
 * changes its behaviour: whether a `NavigationContext` is already above it.
 *
 * `'independent'` is the wide shell (`RegularShell`): Settings sits in the
 * content column with no navigator over it, so `SettingsHost` wraps itself in
 * one of its own. `'nested'` is the compact shell's Settings TAB: an ambient
 * stack is already there (`CompactTabs` inside `CompactShell`'s root stack),
 * so `SettingsHost` reuses it instead — and, being a tab root, the shell hands
 * it no `rootBack` either, which this mirrors.
 */
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

/** Open Settings straight on one route, with its ancestors under it, on the independent host. */
async function open(name: SettingsRouteName) {
  await openOn('independent', name)
}

/** As `open`, but on either host — what the dual-host walk below drives. */
async function openOn(host: Host, name: SettingsRouteName) {
  renderHost(host, name)

  await waitFor(() => expect(page(name)).toBeTruthy())
}

beforeEach(() => {
  mockEscapeListeners.clear()
  useBotsStore.getState().reset()
  useSettingsStore.getState().reset()
})

describe('the route registry', () => {
  it('gives every route a parent, and only the root none', () => {
    for (const name of SETTINGS_ROUTE_NAMES) {
      expect(SETTINGS_ROUTES[name].parent === null).toBe(name === 'Root')
    }
  })

  it('names every route in the reader’s language', () => {
    for (const name of SETTINGS_ROUTE_NAMES) {
      expect(SETTINGS_ROUTES[name].title()).not.toBe('')
    }
  })
})

describe('the root', () => {
  it.each(['independent', 'nested'] as const)(
    'has no back control of its own anywhere on screen, on the %s host',
    async host => {
      await openOn(host, 'Root')

      // Whole screen, not `within(page('Root'))`: a back drawn by the SHELL
      // rather than the page would be invisible to a page-scoped query.
      expect(screen.queryAllByTestId('page-back')).toHaveLength(0)
    }
  )

  it('lists the categories, each with a line of its own state', async () => {
    await open('Root')

    // Account has no row of its own here (HERM-108's follow-up): the account
    // row above the list is the only way into it.
    expect(screen.getByTestId('settings-account-row')).toBeTruthy()
    expect(screen.queryByTestId('settings-cat-Account')).toBeNull()
    expect(screen.getByTestId('settings-cat-Gateways-summary')).toHaveTextContent('gateway.example.com · 1 gateway')
  })
})

/*
  The walk, on both hosts. A route whose back only works nested in the phone's
  tabs, or only as the wide shell's independent tree, is exactly the defect
  HERM-101 left behind — back as a per-screen convention rather than a
  property of the route — so a route that only passes on one host is a
  finding, not a pass. One `it` per route per host, generated: a failure names
  the page AND the host that lost its back rather than a list that stopped
  halfway.

  The count is taken over the WHOLE render, not `within(page(name))`: an
  earlier review found a second back drawn by the shell that a page-scoped
  query could not see.
*/
describe.each(['independent', 'nested'] as const)('the %s host', host => {
  describe.each(SETTINGS_ROUTE_NAMES.filter(name => SETTINGS_ROUTES[name].parent !== null))('%s', name => {
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

    it('answers Escape the same way', async () => {
      await openOn(host, name)

      act(() => {
        for (const listener of [...mockEscapeListeners]) {
          listener()
        }
      })

      await waitForGone(() => screen.queryByTestId(`settings-page-${name}`), `the ${name} page`)
      expect(page(parent)).toBeTruthy()
    })
  })
})

/**
 * Split or stacked is the HOST's own width, not the shell it is in: a narrow
 * content column on a Mac window behaves like a phone, and a wide one gets the
 * list and a page side by side.
 */
describe('the split layout', () => {
  /** Report a width the way a real layout pass would. */
  function layout(width: number) {
    fireEvent(screen.getByTestId('settings-host'), 'layout', { nativeEvent: { layout: { width, height: 800 } } })
  }

  it('stays one column under the threshold', async () => {
    await open('Root')

    act(() => layout(600))

    expect(screen.queryByTestId('settings-category-column')).toBeNull()
    expect(page('Root')).toBeTruthy()
  })

  it('puts the list beside the first category above it', async () => {
    await open('Root')

    act(() => layout(1200))

    await waitFor(() => expect(screen.getByTestId('settings-category-column')).toBeTruthy())
    // The first category IS the stack's bottom page there, so the list page
    // itself is gone and the category has no back control.
    expect(screen.queryByTestId('settings-page-Root')).toBeNull()
    expect(within(page('Account')).queryByTestId('page-back')).toBeNull()
  })

  it('replaces the page beside it when another category is picked', async () => {
    await open('Root')

    act(() => layout(1200))
    await waitFor(() => expect(screen.getByTestId('settings-category-column')).toBeTruthy())

    fireEvent.press(within(screen.getByTestId('settings-category-column')).getByTestId('settings-cat-Appearance'))

    await waitFor(() => expect(page('Appearance')).toBeTruthy())
    expect(screen.queryByTestId('settings-page-Account')).toBeNull()
    expect(within(page('Appearance')).queryByTestId('page-back')).toBeNull()
  })
})

/**
 * Nested under a navigator instead of owning one.
 *
 * The compact shell pushes Settings onto its own stack, so the Settings stack is
 * a NESTED navigator there and an independent tree everywhere else. Two things
 * have to hold in the nested case, and neither is obvious: the root must not
 * grow a back control of its own from the stack above it (that is HERM-75's
 * "‹ Bots"), and the back the SHELL hands in must be the only one on it.
 */
describe('nested under another navigator', () => {
  const Stack = createNativeStackNavigator()

  function nest(rootBack?: { label: string; onPress: () => void }) {
    renderScreen(
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Settings" screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Bots">{() => <Text>the chat list</Text>}</Stack.Screen>
          <Stack.Screen name="Settings">{() => <SettingsScreen {...(rootBack ? { rootBack } : {})} />}</Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>
    )
  }

  it('leaves the root without a back control when the shell gives it none', async () => {
    nest()

    await waitFor(() => expect(page('Root')).toBeTruthy())
    expect(within(page('Root')).queryByTestId('page-back')).toBeNull()
  })

  it('draws the shell’s own back on the root, and only that one', async () => {
    const onPress = jest.fn()

    nest({ label: 'Chats', onPress })

    await waitFor(() => expect(page('Root')).toBeTruthy())

    const backs = within(page('Root')).getAllByTestId('page-back')

    expect(backs).toHaveLength(1)
    expect(backs[0]?.props.accessibilityLabel).toBe('Chats')

    fireEvent.press(backs[0] as never)
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('pushes its own pages inside the stack it is nested in', async () => {
    nest({ label: 'Chats', onPress: jest.fn() })

    await waitFor(() => expect(page('Root')).toBeTruthy())
    fireEvent.press(screen.getByTestId('settings-cat-Appearance'))

    await waitFor(() => expect(page('Appearance')).toBeTruthy())
    expect(within(page('Appearance')).getByTestId('page-back').props.accessibilityLabel).toBe(
      SETTINGS_ROUTES.Root.title()
    )
  })
})

/**
 * The inventory: one long screen became twelve pages, and nothing fell out.
 *
 * Each of these is a control the old `SettingsScreen` carried, named by the
 * testID a test somewhere already knows it by.
 */
describe('every setting still has a home', () => {
  it.each([
    ['ChatsMessages', 'settings-verbosity'],
    ['ChatsMessages', 'settings-bot-to-bot'],
    ['ChatsMessages', 'settings-thinking'],
    ['ChatsMessages', 'settings-bot-names'],
    ['ChatsMessages', 'settings-hide-handle'],
    ['Privacy', 'settings-app-lock'],
    ['Memory', 'settings-memory'],
    ['Gateways', 'settings-gateways'],
    ['Notifications', 'settings-push-enabled'],
    ['Appearance', 'settings-appearance'],
    ['Appearance', 'settings-language'],
    ['Appearance', 'settings-text-size'],
    ['Appearance', 'settings-theme'],
    ['Advanced', 'settings-connection-test'],
    ['Advanced', 'settings-gallery'],
    ['About', 'settings-licences']
  ])('%s holds %s', async (route, testID) => {
    await open(route as SettingsRouteName)

    await waitFor(() => expect(screen.getByTestId(testID)).toBeTruthy())
  })
})

/** HERM-110: the order row is moot, and says so, while the switch above it is on. */
describe('the bot-name order while Hide profile name is on', () => {
  it('is disabled by default, and enabled once the switch is turned off', async () => {
    await open('ChatsMessages')

    expect(useSettingsStore.getState().hideHandleWhenNamed).toBe(true)
    expect(screen.getByTestId('settings-bot-names-profile').props.accessibilityState.disabled).toBe(true)

    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-hide-handle'))
    })

    expect(useSettingsStore.getState().hideHandleWhenNamed).toBe(false)
    expect(screen.getByTestId('settings-bot-names-profile').props.accessibilityState.disabled).toBe(false)
  })
})
