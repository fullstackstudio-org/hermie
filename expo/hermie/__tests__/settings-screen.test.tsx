/**
 * Settings, page by page: what each category holds, and the one group that must
 * not ship.
 *
 * The connection test prints the gateway's address and identity, and the
 * component gallery is a catalogue of fixtures. Both are tools for whoever is
 * building the app; neither belongs in a release someone installs — and since
 * HERM-108 that is a whole CATEGORY that disappears rather than a group inside
 * a long screen.
 *
 * Where a back control goes is not asserted here: `settings-routes.test.tsx`
 * walks every route for that. This file is about the content of the pages.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { SettingsScreen } from '../src/features/settings'
import { GALLERY_ROW_TITLE } from '../src/features/settings/GalleryScreen'
import type { SettingsRouteName } from '../src/features/settings/navigation'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen } from './support/render'

const mockEscapeListeners = new Set<() => void>()

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

// The licence data is half a megabyte of generated JSON; this suite is about the
// row that opens it, not about the payload.
jest.mock('../src/features/settings/licences-data', () => ({
  loadLicenceData: async () => ({
    generatedBy: 'scripts/generate-third-party-licenses.mjs',
    scope: 'production dependencies of expo/hermie',
    excludesWorkspacePackages: ['@hermie/transcript'],
    packages: [{ name: 'expo', version: '54.0.37', licence: 'MIT' }],
    texts: {}
  })
}))

const HTTPS_CONFIG = { authMode: 'native_pkce', baseUrl: 'https://gateway.example.com', version: '1.2.3' }
let mockGatewayConfig: Record<string, unknown> = HTTPS_CONFIG

jest.mock('../src/gateway', () => ({
  useGateway: () => ({
    changeGateway: jest.fn(),
    config: mockGatewayConfig,
    signOut: jest.fn(),
    status: 'ready'
  })
}))

beforeEach(() => {
  mockEscapeListeners.clear()
  mockGatewayConfig = HTTPS_CONFIG
  useSettingsStore.getState().reset()
})

/** Open Settings on one page, with its ancestors under it. */
async function open(route: SettingsRouteName) {
  const view = renderScreen(<SettingsScreen initialRoute={route} />)

  await waitFor(() => expect(screen.getByTestId(`settings-page-${route}`)).toBeTruthy())

  return view
}

/** Press Escape, the way the native module would deliver it. */
function pressEscape() {
  act(() => {
    for (const listener of [...mockEscapeListeners]) {
      listener()
    }
  })
}

describe('the category list', () => {
  it('offers the developer tools in a development build', async () => {
    await open('Advanced')

    expect(screen.getByText(GALLERY_ROW_TITLE)).toBeTruthy()
    expect(screen.getByTestId('settings-connection-test')).toBeTruthy()
  })

  it('hides the whole category everywhere else', async () => {
    const previous = __DEV__

    ;(globalThis as unknown as { __DEV__: boolean }).__DEV__ = false

    try {
      await open('Root')

      expect(screen.queryByTestId('settings-cat-Advanced')).toBeNull()
      // The rest of the list is untouched. Not Account: that category has no
      // row of its own any more (the account row above the list is the only
      // way in), so a category that still keeps a plain list row proves it.
      expect(screen.getByTestId('settings-cat-Gateways')).toBeTruthy()
    } finally {
      ;(globalThis as unknown as { __DEV__: boolean }).__DEV__ = previous
    }
  })

  it('takes no part in the Escape stack while the root is on top', async () => {
    await open('Root')

    // Nothing registered: with no back control on the root, Escape belongs to
    // whatever is holding Settings.
    expect(mockEscapeListeners.size).toBe(0)
  })
})

describe('About', () => {
  it('opens the licences from a row that ships in every build', async () => {
    const view = await open('About')

    // Not behind `__DEV__`: an attribution obligation is not a developer tool.
    fireEvent.press(screen.getByTestId('settings-licences'))

    await waitFor(() => expect(view.getByTestId('licences-list')).toBeTruthy())
    expect(screen.getByText('expo')).toBeTruthy()
  })

  it('comes back to About on Escape', async () => {
    const view = await open('About')

    fireEvent.press(screen.getByTestId('settings-licences'))
    await waitFor(() => expect(view.getByTestId('licences-list')).toBeTruthy())

    pressEscape()

    await waitFor(() => expect(view.queryByTestId('licences-list')).toBeNull())
    expect(screen.getByTestId('settings-page-About')).toBeTruthy()
  })
})

/**
 * Settings names the scheme in the address either way. The extra line under it
 * is only for the case the reader can do something about: cleartext to an
 * address anybody can be on the path to.
 */
describe('Gateways and a cleartext gateway', () => {
  it('says nothing under an https address', async () => {
    await open('Gateways')

    expect(screen.getByText('https://gateway.example.com')).toBeTruthy()
    expect(screen.queryByTestId('transport-notice')).toBeNull()
  })

  it('says nothing under a tailnet address, which is the ordinary setup', async () => {
    mockGatewayConfig = { ...HTTPS_CONFIG, baseUrl: 'http://hermes.tail9f3c.ts.net' }
    await open('Gateways')

    expect(screen.getByText('http://hermes.tail9f3c.ts.net')).toBeTruthy()
    expect(screen.queryByTestId('transport-notice')).toBeNull()
  })

  it('warns under a public http address', async () => {
    mockGatewayConfig = { ...HTTPS_CONFIG, baseUrl: 'http://gateway.example.com' }
    await open('Gateways')

    expect(screen.getByTestId('transport-notice')).toHaveTextContent(/Anyone on the path/)
  })
})

/**
 * The theme picker.
 *
 * HERM-107 moved it off Appearance itself and onto the `Theme` page that
 * row opens — `theme-page.test.tsx` pins that navigation and the row's own
 * value. The cards are the part worth a test here regardless of which page
 * holds them, because they are the part that can silently stop being true:
 * each one paints the theme it names, through the same `resolveThemeFace` the
 * live window is built with. If a card ever stopped following the theme it
 * points at, a reader would pick a window they were never shown.
 */
describe('Theme', () => {
  it('offers a card per preset, and marks the one that is on', async () => {
    await open('Theme')

    for (const name of ['blue', 'graphite', 'lime']) {
      expect(screen.getByTestId(`theme-card-${name}`)).toBeTruthy()
    }

    // The card is authored with `aria-checked`, because react-native-web drops
    // an `accessibilityState` object entirely and a radio's state is `checked`
    // in ARIA rather than `selected`. React Native normalises the aria spelling
    // back into `accessibilityState` on the host node, which is why this
    // assertion did not have to move: the native announcement is unchanged.
    expect(screen.getByTestId('theme-card-blue').props.accessibilityState.checked).toBe(true)
    expect(screen.getByTestId('theme-card-lime').props.accessibilityState.checked).toBe(false)
  })

  it('switches the theme, and the preview follows', async () => {
    await open('Theme')

    fireEvent.press(screen.getByTestId('theme-card-lime'))

    expect(useSettingsStore.getState().themeChoice).toEqual({ kind: 'preset', name: 'lime' })
  })

  it('paints each card in its own theme rather than in the app’s', async () => {
    await open('Theme')

    const backgroundOf = (name: string): unknown =>
      // `style` is an array on a `View` with two style objects; the flat form is
      // what the renderer hands back here.
      screen.getByTestId(`theme-card-${name}-preview`).props.style.backgroundColor

    expect(backgroundOf('blue')).not.toBe(backgroundOf('graphite'))
    expect(backgroundOf('graphite')).not.toBe(backgroundOf('lime'))
  })

  it('shows a theme the reader made beside the presets', async () => {
    act(() => {
      useSettingsStore.getState().createUserTheme('lime', 'Studio')
    })

    await open('Theme')

    const id = useSettingsStore.getState().userThemes[0]?.id ?? ''

    expect(screen.getByTestId(`theme-card-user-${id}`)).toBeTruthy()
  })
})

describe('the theme editor', () => {
  it('keeps a colour the contrast check would refuse, and says why', async () => {
    await open('Theme')

    fireEvent.press(screen.getByTestId('theme-new-blue'))

    const id = useSettingsStore.getState().userThemes[0]?.id ?? ''
    const before = useSettingsStore.getState().userThemes[0]?.light?.accentBubble

    // The studio lime as a BUBBLE: white on it is about 1.3 : 1.
    fireEvent.changeText(screen.getByTestId('theme-colour-accentBubble'), '#C7FF4A')

    expect(screen.getByText(/measures 1\.\d+ : 1, and needs 4\.5/u)).toBeTruthy()
    expect(useSettingsStore.getState().userThemes.find(theme => theme.id === id)?.light?.accentBubble).toBe(before)
  })

  it('takes one the check would pass, and writes it', async () => {
    await open('Theme')

    fireEvent.press(screen.getByTestId('theme-new-blue'))
    fireEvent.changeText(screen.getByTestId('theme-colour-accentBubble'), '#4A7F15')

    const id = useSettingsStore.getState().userThemes[0]?.id ?? ''

    expect(useSettingsStore.getState().userThemes.find(theme => theme.id === id)?.light?.accentBubble).toBe('#4A7F15')
  })
})
