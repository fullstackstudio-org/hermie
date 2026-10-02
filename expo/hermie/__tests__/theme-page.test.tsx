/**
 * HERM-107: the theme picker lives under Appearance → Theme, not inline.
 *
 * Three things this file pins, all from the owner's own words ("Onder
 * apperiance zet daar gelijk de themes onder"):
 *
 *  1. Appearance shows one row for the theme that is on, and it opens `Theme`.
 *  2. `Theme` holds the preset cards AND the reader's own themes, and picking a
 *     preset there is reflected back on the Appearance row without a second
 *     navigation.
 *  3. Starting a theme from a preset, or tapping one of the reader's own, opens
 *     `ThemeEdit` — a page of its own, with its own one back control — rather
 *     than an inline editor on `Theme`.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react-native'

import { SettingsScreen } from '../src/features/settings'
import { useBotsStore } from '../src/store/bots'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen, waitForGone } from './support/render'

// Settings → Root lists every category's own summary, Gateways and
// Notifications included, whatever leaf route this file opens on — the root
// stays mounted underneath it in the stack.
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

const mockPush = {
  disable: jest.fn(async () => undefined),
  enable: jest.fn(async () => undefined),
  needsSystemSettings: false,
  openSystemSettings: jest.fn(async () => false),
  permission: jest.fn(async () => 'granted'),
  retry: jest.fn(async () => undefined)
}

jest.mock('../src/features/chats/ChatRuntime', () => ({ useChatRuntime: () => ({ push: mockPush }) }))

const page = (name: string) => screen.getByTestId(`settings-page-${name}`)

async function openAppearance() {
  renderScreen(<SettingsScreen initialRoute="Appearance" />)

  await waitFor(() => expect(page('Appearance')).toBeTruthy())
}

beforeEach(() => {
  useBotsStore.getState().reset()
  useSettingsStore.getState().reset()
})

describe('Appearance → Theme', () => {
  it('shows one row for the theme that is on, naming the live preset', async () => {
    await openAppearance()

    expect(within(page('Appearance')).getByTestId('settings-theme')).toHaveTextContent(/Blue/)
  })

  it('opens Theme, which holds the preset cards', async () => {
    await openAppearance()

    fireEvent.press(within(page('Appearance')).getByTestId('settings-theme'))

    await waitFor(() => expect(page('Theme')).toBeTruthy())
    expect(within(page('Theme')).getByTestId('theme-card-graphite')).toBeTruthy()
  })

  it('does not keep the preset cards on Appearance itself', async () => {
    await openAppearance()

    expect(within(page('Appearance')).queryByTestId('theme-card-blue')).toBeNull()
  })

  it('reflects a preset picked on Theme back on the Appearance row', async () => {
    await openAppearance()

    fireEvent.press(within(page('Appearance')).getByTestId('settings-theme'))
    await waitFor(() => expect(page('Theme')).toBeTruthy())

    fireEvent.press(within(page('Theme')).getByTestId('theme-card-graphite'))

    fireEvent.press(within(page('Theme')).getByTestId('page-back'))
    await waitForGone(() => screen.queryByTestId('settings-page-Theme'), 'the Theme page')

    expect(within(page('Appearance')).getByTestId('settings-theme')).toHaveTextContent(/Graphite/)
  })

  it('starts a theme from a preset by opening ThemeEdit, not an inline editor', async () => {
    await openAppearance()

    fireEvent.press(within(page('Appearance')).getByTestId('settings-theme'))
    await waitFor(() => expect(page('Theme')).toBeTruthy())

    expect(within(page('Theme')).queryByTestId('theme-delete')).toBeNull()

    fireEvent.press(within(page('Theme')).getByTestId('theme-new-blue'))

    await waitFor(() => expect(page('ThemeEdit')).toBeTruthy())
    expect(within(page('ThemeEdit')).getByTestId('theme-delete')).toBeTruthy()

    const backs = within(page('ThemeEdit')).getAllByTestId('page-back')

    expect(backs).toHaveLength(1)
    expect(backs[0]?.props.accessibilityLabel).toBe('Themes')
  })

  it('opens ThemeEdit for one of the reader’s own themes from its card', async () => {
    const id = useSettingsStore.getState().createUserTheme('lime', 'Poolside')

    useSettingsStore.getState().setThemeChoice({ kind: 'preset', name: 'blue' })

    await openAppearance()
    fireEvent.press(within(page('Appearance')).getByTestId('settings-theme'))
    await waitFor(() => expect(page('Theme')).toBeTruthy())

    fireEvent.press(within(page('Theme')).getByTestId(`theme-card-user-${id}`))

    await waitFor(() => expect(page('ThemeEdit')).toBeTruthy())
    expect(screen.getByTestId('theme-name').props.value).toBe('Poolside')

    // Tapping the card also applies it, same as a preset card would.
    fireEvent.press(within(page('ThemeEdit')).getByTestId('page-back'))
    await waitForGone(() => screen.queryByTestId('settings-page-ThemeEdit'), 'the ThemeEdit page')

    fireEvent.press(within(page('Theme')).getByTestId('page-back'))
    await waitForGone(() => screen.queryByTestId('settings-page-Theme'), 'the Theme page')

    expect(within(page('Appearance')).getByTestId('settings-theme')).toHaveTextContent(/Poolside/)
  })
})
