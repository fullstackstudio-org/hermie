/**
 * The wide-window shell — an iPad or a Mac: two floating glass panels over a
 * wallpaper.
 *
 * There is no navigator here, both panels are always mounted, and a window too
 * narrow for two never reaches this component (`useLayoutMode` hands that case
 * to the compact stack). So the whole behaviour is which row is marked selected
 * and what the overlay panel is doing, which is exactly what a test can assert
 * and what a screenshot of a Mac window cannot.
 *
 * The one thing worth stating about the overlay: it COVERS the chat column, it
 * does not replace it — the list stays mounted and in place, so closing the panel
 * returns the reader to exactly where they were rather than to a rebuilt list. It
 * is DIMMED while the panel is open, and not interactive; `overlay-frame.test.tsx`
 * owns that half, and the geometry of the frame with it.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native'
import { StyleSheet, useWindowDimensions } from 'react-native'

import { RegularShell } from '../src/app/RegularShell'
import { SETTINGS_ROUTES } from '../src/features/settings/navigation'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { renderScreen, waitForGone } from './support/render'
import { resetSettledWidth } from '../src/app/useLayoutMode'

const mockEscapeListeners = new Set<() => void>()

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

/** Press Escape, the way the native module would deliver it. */
function pressEscape() {
  act(() => {
    for (const listener of [...mockEscapeListeners]) {
      listener()
    }
  })
}

/**
 * One window per test.
 *
 * The settled width is module state — one window, one answer, one timer for
 * every hook that asks about it (`app/useLayoutMode.ts`). Carrying it from one
 * test to the next would mean asking about the previous test's window.
 */
beforeEach(resetSettledWidth)

const gateway = { status: 'ready', config: { baseUrl: 'https://gateway.example.com', authMode: 'native_pkce' } }

jest.mock('../src/gateway', () => ({
  useGateway: () => gateway,
  hostOf: (url: string) => url.replace(/^https:\/\//, '')
}))

jest.mock('../src/gateway/GatewayProvider', () => ({
  useGateway: () => ({
    ...gateway,
    adoptTokens: jest.fn(),
    changeGateway: jest.fn(),
    extraHeaders: {},
    signOut: jest.fn()
  })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => null
}))

jest.mock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock
const runsOnMac = jest.requireMock('../src/platform/runs-on-mac') as { RUNS_ON_MAC: boolean }

const bot = (name: string, displayName: string): Bot => ({
  name,
  displayName,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: { id: `stored-${name}`, resolvedId: `stored-${name}`, preview: 'Hello.', lastActive: 1, messageCount: 2 }
})

const wide = () => mockDimensions.mockReturnValue({ width: 1024, height: 1366, scale: 2, fontScale: 1 })

const paddingOf = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as {
    paddingTop?: number
    paddingBottom?: number
  }

beforeEach(() => {
  runsOnMac.RUNS_ON_MAC = false
  mockEscapeListeners.clear()
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useBotsStore.getState().setBots([bot('researcher', 'Researcher'), bot('writer', 'Writer')])
  wide()
})

describe('RegularShell', () => {
  it('asks the reader to pick a bot before one is selected', () => {
    renderScreen(<RegularShell />)

    expect(screen.getByText('Pick a conversation to start reading.')).toBeTruthy()
  })

  it('marks the selected conversation in the sidebar and keeps it marked', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    expect(screen.getByTestId('bot-row-researcher').props.accessibilityState).toMatchObject({ selected: true })
    expect(screen.getByTestId('bot-row-writer').props.accessibilityState).toMatchObject({ selected: false })
  })

  it('keeps both panels mounted while a chat is open', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('bot-row-researcher'))

    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
  })

  it('drops the selection highlight while a destination is open', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('bot-row-researcher'))
    fireEvent.press(screen.getByTestId('tab-settings'))

    expect(screen.getByTestId('bot-row-researcher').props.accessibilityState).toMatchObject({ selected: false })
  })
})

describe('the overlay panel', () => {
  it('slides Activity over the chat column without unmounting anything', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('tab-activity'))

    expect(screen.getByTestId('overlay-panel')).toBeTruthy()
    expect(screen.getByTestId('activity-list')).toBeTruthy()
    // Covered, not replaced: both columns are still mounted under the dim, so
    // closing the panel restores the reader's place rather than rebuilding it.
    expect(screen.getByText('Pick a conversation to start reading.')).toBeTruthy()
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
  })

  // The panel stays mounted for its own slide-out — one that unmounted on the
  // first frame of its exit would simply vanish — so these wait for it to go.
  // `jest.after-env.js` says why the wait is allowed five seconds.
  //
  // Settings used to be the third destination in here too. HERM-102/108 moved
  // it into the content column instead (see below), so this is Activity now —
  // still an `OverlayPanel`, still this same close button, drawn by
  // `PageChrome`'s `trailing` rather than by a title row the panel no longer has.
  it('closes on the round close button', async () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('tab-activity'))
    expect(screen.getByTestId('overlay-panel')).toBeTruthy()

    fireEvent.press(screen.getByTestId('overlay-close'))

    await waitForGone(() => screen.queryByTestId('overlay-panel'), 'overlay-panel')
  })

  it('closes on a tap outside itself', async () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('tab-activity'))
    fireEvent.press(screen.getByTestId('overlay-scrim'))

    await waitForGone(() => screen.queryByTestId('overlay-panel'), 'overlay-panel')
  })
})

/**
 * Settings, since HERM-102/108: the CONTENT column, the way Boards already
 * worked, rather than the 520pt `OverlayPanel` Activity and Crons still use.
 *
 * That move is the whole point: `SETTINGS_SPLIT_MIN_WIDTH` (640) is wider than
 * the overlay ever grew, so the split layout — the category list beside the
 * page it opens — was unreachable in the shipping app until Settings had a
 * column wide enough to earn it.
 */
describe('Settings, in the content column', () => {
  it('takes the column instead of an overlay, with its own close', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('tab-settings'))

    expect(screen.getByTestId('settings-host')).toBeTruthy()
    expect(screen.getByTestId('settings-close')).toBeTruthy()
    expect(screen.queryByTestId('overlay-panel')).toBeNull()
    expect(screen.queryByTestId('overlay-frame')).toBeNull()
    // Not one of the destinations the sidebar dims for — it replaced the chat
    // column outright, the way Boards does, rather than covering it.
    expect(screen.queryByTestId('overlay-scrim')).toBeNull()
    expect(screen.queryByTestId('overlay-scrim-sidebar')).toBeNull()
    // The chat list stays selectable underneath, same as it does for Boards.
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
  })

  it('closes on its own round close button', () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('tab-settings'))
    fireEvent.press(screen.getByTestId('settings-close'))

    expect(screen.queryByTestId('settings-host')).toBeNull()
  })

  /**
   * The wide-shell twin of `compact-shell.test.tsx`'s global back count: this
   * looks for `page-back` over the WHOLE screen, not inside a page's own
   * wrapper, so a stray second back drawn by the shell rather than by the page
   * would not slip past it.
   */
  it('draws no page-back at the root, one on a deep page, and none again after switching category', async () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('tab-settings'))
    expect(screen.queryAllByTestId('page-back')).toHaveLength(0)

    fireEvent.press(screen.getByTestId('settings-account-row'))
    await waitFor(() => expect(screen.getByTestId('settings-page-Account')).toBeTruthy())

    const backs = screen.queryAllByTestId('page-back')

    expect(backs).toHaveLength(1)
    expect(backs[0]?.props.accessibilityLabel).toBe(SETTINGS_ROUTES.Root.title())

    // Past the split threshold the category list is a column beside the page,
    // and picking another category REPLACES the page rather than pushing a
    // back onto it — so the count returns to zero rather than growing.
    fireEvent(screen.getByTestId('settings-host'), 'layout', { nativeEvent: { layout: { width: 1200, height: 900 } } })
    await waitFor(() => expect(screen.getByTestId('settings-category-column')).toBeTruthy())

    fireEvent.press(within(screen.getByTestId('settings-category-column')).getByTestId('settings-cat-Appearance'))
    await waitFor(() => expect(screen.getByTestId('settings-page-Appearance')).toBeTruthy())

    expect(screen.queryAllByTestId('page-back')).toHaveLength(0)
  })

  /**
   * Split or stacked is `SettingsHost`'s OWN measured width, not the shell's —
   * `settings-routes.test.tsx` pins that against a bare `SettingsScreen`. This
   * is the same layout rule reached through the shell that mounts it, at the
   * two widths the owner's brief names: 1200pt side by side, 600pt one column.
   */
  it('splits at 1200pt and stays one column at 600pt', async () => {
    renderScreen(<RegularShell />)
    fireEvent.press(screen.getByTestId('tab-settings'))

    fireEvent(screen.getByTestId('settings-host'), 'layout', { nativeEvent: { layout: { width: 600, height: 900 } } })
    expect(screen.queryByTestId('settings-category-column')).toBeNull()
    expect(screen.getByTestId('settings-page-Root')).toBeTruthy()

    fireEvent(screen.getByTestId('settings-host'), 'layout', { nativeEvent: { layout: { width: 1200, height: 900 } } })
    await waitFor(() => expect(screen.getByTestId('settings-category-column')).toBeTruthy())
    // The first category is the split stack's own bottom page there, so the
    // list page itself is gone rather than sitting beside the column too.
    expect(screen.queryByTestId('settings-page-Root')).toBeNull()
  })

  /**
   * `OverlayPanel` used to register Escape for Settings along with Activity and
   * Crons. Settings draws a close (X) rather than a `back` now, which is not
   * something `PageChrome` answers Escape for by itself, so the shell registers
   * its own — see `RegularShell`'s comment beside `useEscapeKey(… settingsOpen)`.
   * One level at a time, same as everywhere else Escape reaches a stack.
   */
  it('answers Escape one level at a time: a deep page first, then Settings itself', async () => {
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('tab-settings'))
    fireEvent.press(screen.getByTestId('settings-account-row'))
    await waitFor(() => expect(screen.getByTestId('settings-page-Account')).toBeTruthy())

    pressEscape()
    await waitForGone(() => screen.queryByTestId('settings-page-Account'), 'the Account page')
    expect(screen.getByTestId('settings-page-Root')).toBeTruthy()

    pressEscape()
    await waitForGone(() => screen.queryByTestId('settings-host'), 'the Settings host')
  })
})

describe('the shell insets', () => {
  /**
   * Reported from a real Mac session: the empty strip under the title bar was
   * gone above the chat column and still there above the list, because the
   * sidebar carried a top padding of its own that the Mac-aware inset never
   * reached.
   *
   * The fix was structural — ONE source — and it stayed structural when the
   * panels stopped floating. There is no row to inset any more: edge to edge the
   * glass has to reach the window's edges and under the title bar, and only its
   * CONTENT may be pushed clear. So both columns apply the same `insets` object
   * to their own content box, from one hook call, and the property that mattered
   * is what is asserted — the two cannot disagree.
   */
  it('pushes both columns’ content clear of the safe area by the same amount', () => {
    renderScreen(<RegularShell />)

    // The metrics `renderScreen` provides are an iPhone 17 Pro's.
    expect(paddingOf('shell-sidebar-content').paddingTop).toBe(59)
    expect(paddingOf('shell-content-panel').paddingTop).toBe(59)
  })

  it('leaves no strip above either column on a Mac', () => {
    runsOnMac.RUNS_ON_MAC = true
    renderScreen(<RegularShell />)

    expect(paddingOf('shell-sidebar-content').paddingTop).toBe(0)
    expect(paddingOf('shell-content-panel').paddingTop).toBe(0)
  })

  /**
   * And the reason the insets moved at all: the owner rejected the floating
   * panels. No outer gutter, no gap between the columns, no rounding, and one
   * hairline where they meet — the reference is Messages on the Mac.
   */
  it('runs the columns to the window’s edges with one hairline between them', () => {
    renderScreen(<RegularShell />)

    const window = paddingOf('shell-window')

    expect(window.padding).toBeUndefined()
    expect(window.paddingTop).toBeUndefined()
    expect(window.paddingLeft).toBeUndefined()
    expect(window.gap).toBeUndefined()

    const divider = StyleSheet.flatten(screen.getByTestId('shell-divider').props.style as never) as {
      width?: number
    }

    expect(divider.width).toBe(StyleSheet.hairlineWidth)
  })
})

/**
 * What a panel is allowed to paint over the glass: nothing.
 *
 * Measured on an iPad Pro 13" simulator in the dark theme, the chat column
 * sampled `#0A1830` — `elevation.e0`, the wallpaper's own rung — while the
 * sidebar beside it sampled `#1B2744`, the panel rung. Same `GlassSurface`,
 * same variant, so the difference was the `Screen` inside the column filling it
 * with `colors.bg`. Every wide-layout destination goes through `Screen`, so
 * every one of them was painting the wallpaper's colour over the material meant
 * to refract it, and the elevation ladder collapsed to one flat field.
 */
describe('a screen inside a floating panel', () => {
  const styleOf = (testID: string) =>
    StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as {
      backgroundColor?: string
      paddingTop?: number
      paddingBottom?: number
    }

  it('paints no background of its own, so the panel stays glass', () => {
    renderScreen(<RegularShell />)

    expect(styleOf('chat-empty').backgroundColor).toBe('transparent')
  })

  it('adds no second copy of the safe-area inset the shell already applied', () => {
    renderScreen(<RegularShell />)

    const inner = styleOf('chat-empty')

    expect(inner.paddingTop).toBe(0)
    expect(inner.paddingBottom).toBe(0)
  })
})

describe('the signed-out state', () => {
  it('takes the whole content column rather than sitting under a chat error', () => {
    gateway.status = 'needs_signin'

    try {
      renderScreen(<RegularShell />)

      expect(screen.getByTestId('signed-out-panel')).toBeTruthy()
      expect(screen.queryByText('Pick a conversation to start reading.')).toBeNull()
      // The list stays: it is the half of the shell that still works.
      expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
      // …and it says so in the one place the connection speaks, which on this
      // layout is the line under the title rather than a card at the foot.
      expect(screen.getByTestId('connection-line')).toHaveTextContent('Signed out')
      expect(screen.queryByTestId('gateway-card')).toBeNull()
    } finally {
      gateway.status = 'ready'
    }
  })
})
