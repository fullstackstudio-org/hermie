/**
 * Hiding and showing the wide layout's chat list.
 *
 * Three things are being held to their rules here, and they are three different
 * kinds of claim:
 *
 *  - **The default is a function, not a state machine.** `resolveSidebarCollapsed`
 *    takes a stored choice and a window width and answers. That shape is what makes
 *    the owner's "never flip on its own while the reader is looking at the same
 *    window size" true by construction rather than by vigilance, so it is asserted
 *    directly: one width cannot produce two answers.
 *  - **What the shell draws.** A rail instead of the list, the destinations still on
 *    it, and the content column keeping the points the list gave up.
 *  - **The narrow window's overlay.** Below 900pt Show must lay the list OVER the
 *    chat rather than push it aside again — the whole reason the collapse exists is
 *    that the chat column has nothing left to give at that width — and picking a
 *    chat must take it away again.
 *
 * The keyboard and the Mac menu bar are here too, because they are the two ways in
 * that no screenshot can show.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { AppState, StyleSheet, Text, useWindowDimensions } from 'react-native'

import { RegularShell } from '../src/app/RegularShell'
import { setMenuBar } from '../src/platform/desktop-shortcuts'
import { type Bot, useBotsStore } from '../src/store/bots'
import { resolveSidebarCollapsed, useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { strings } from '../src/i18n/strings'
import {
  SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_NARROW
} from '../src/ui/tokens'
import { renderScreen, withProviders, waitForGone } from './support/render'
import { resetSettledWidth, useLayoutMode, useSidebarState } from '../src/app/useLayoutMode'

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

// `mock`-prefixed, which is the only way a `jest.mock` factory may reach out of scope.
const mockShortcutListeners = new Set<(action: string) => void>()

jest.mock('../src/platform/desktop-shortcuts', () => ({
  subscribeToShortcuts: (handler: (event: { action: string; typing: boolean }) => void) => {
    mockShortcutListeners.add(handler)

    return () => mockShortcutListeners.delete(handler)
  },
  setMenuBar: jest.fn(),
  isMenuBarInstalled: jest.fn(() => false)
}))

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

/** iPad Pro 11" portrait: the band the overlay exists for. */
const NARROW = { width: 834, height: 1210 }
/** iPad Pro 13" landscape: room for both panels. */
const WIDE = { width: 1376, height: 1032 }

const size = ({ width, height }: { width: number; height: number }) =>
  mockDimensions.mockReturnValue({ width, height, scale: 2, fontScale: 1 })

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

// The overlay stays mounted for its own slide-out, so every "it went away" waits.
// `jest.after-env.js` says why the wait is allowed five seconds.
const sidebarWidthOf = () =>
  (StyleSheet.flatten(screen.getByTestId('shell-sidebar').props.style as never) as { width?: number }).width

/** A keystroke or a menu selection, which arrive as the same action. */
const press = (action: string) => {
  act(() => {
    for (const listener of [...mockShortcutListeners]) {
      // Typing: false — these arrive from the menu bar's own key equivalents, or
      // from a keyboard with nothing focused. The typing gate has its own tests.
      listener({ action, typing: false })
    }
  })
}

beforeEach(() => {
  mockShortcutListeners.clear()
  ;(setMenuBar as jest.Mock).mockClear()
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useBotsStore.getState().setBots([bot('researcher', 'Researcher'), bot('writer', 'Writer')])
  size(WIDE)
})

describe('resolveSidebarCollapsed', () => {
  it('starts collapsed below the band and expanded at or above it, with nothing on record', () => {
    expect(resolveSidebarCollapsed(undefined, SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH - 1)).toBe(true)
    expect(resolveSidebarCollapsed(undefined, SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH)).toBe(false)
  })

  it('lets an explicit choice win at every width, which is what "remember it" means', () => {
    expect(resolveSidebarCollapsed(false, 400)).toBe(false)
    expect(resolveSidebarCollapsed(true, 4000)).toBe(true)
  })

  /**
   * The owner's second rule, asserted as the property that makes it true: the
   * answer is a function of the width, so the same width cannot produce two of
   * them and there is no path by which a still window changes its own mind.
   */
  it('answers the same thing every time for one window width', () => {
    for (const choice of [undefined, true, false] as const) {
      for (const width of [700, 834, 899, 900, 1032, 1376]) {
        expect(resolveSidebarCollapsed(choice, width)).toBe(resolveSidebarCollapsed(choice, width))
      }
    }
  })
})

describe('the width the collapse reads', () => {
  /**
   * The owner's report: the sidebar collapsed by itself on the Mac.
   *
   * Nothing was flipping. `resolveSidebarCollapsed` is a comparison against one
   * number and a still window cannot produce two answers — the NUMBER was the
   * problem. A window going to the background, a sheet being presented and a live
   * resize each push intermediate widths through `useWindowDimensions`, and one of
   * them dipping under 900 for a frame is indistinguishable, to a function that
   * compares, from the window really being dragged narrow.
   */
  function shell() {
    return renderScreen(<RegularShell />)
  }

  /** Re-render the shell at `next`, the way a dimensions change does. */
  function resizeTo(next: { width: number; height: number }, view: ReturnType<typeof shell>) {
    act(() => {
      size(next)
      view.rerender(withProviders(<RegularShell />))
    })
  }

  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('ignores a width that only passes through on the way somewhere else', () => {
    const view = shell()

    expect(sidebarWidthOf()).toBe(SIDEBAR_WIDTH)

    // A resize animation: three frames under the threshold, none of them held.
    for (const width of [1100, 860, 700]) {
      resizeTo({ width, height: WIDE.height }, view)
      act(() => jest.advanceTimersByTime(40))
    }

    resizeTo(WIDE, view)
    act(() => jest.advanceTimersByTime(300))

    expect(sidebarWidthOf()).toBe(SIDEBAR_WIDTH)
  })

  it('takes a width the window actually settled on', () => {
    const view = shell()

    resizeTo(NARROW, view)
    act(() => jest.advanceTimersByTime(300))

    expect(sidebarWidthOf()).toBe(SIDEBAR_RAIL_WIDTH)
  })

  /**
   * A window that is not on screen measures nothing. Committing that would
   * collapse the sidebar while the owner is in another app and hand it back to
   * them collapsed — which is exactly what they described.
   */
  it('never takes a measurement of a window that is not there', () => {
    const view = shell()

    for (const width of [0, -1, Number.NaN]) {
      resizeTo({ width, height: WIDE.height }, view)
      act(() => jest.advanceTimersByTime(300))

      expect(sidebarWidthOf()).toBe(SIDEBAR_WIDTH)
    }
  })

  /**
   * And the other half of the owner's rule, which is already true by
   * construction: once there is an explicit Hide or Show on record, no width
   * changes it. `resolveSidebarCollapsed` reads the choice first.
   */
  it('leaves an explicit choice alone however the window is resized', () => {
    const view = shell()

    act(() => useChatLayoutStore.getState().setSidebarCollapsed(false))

    resizeTo(NARROW, view)
    act(() => jest.advanceTimersByTime(300))

    expect(sidebarWidthOf()).toBe(SIDEBAR_WIDTH_NARROW)
  })
})

/**
 * The report this round: it is STILL closing itself on the Mac.
 *
 * The previous round settled the width the collapse reads and the width the
 * sidebar is measured at, and left the one that picks the SHELL on the live
 * measurement. So a transition that reported 690pt for a frame swapped the whole
 * regular shell for the compact stack and back — and everything the shell holds
 * is state: which chat is selected, whether the temporary list is up, which
 * panel is open. A remount is not a sidebar closing; it is all of that going at
 * once, which is what it looks like from the outside.
 */
describe('a width that only passes through', () => {
  function Probe() {
    const mode = useLayoutMode()
    const { collapsed, overlays } = useSidebarState()

    return (
      <Text testID="probe">{`${mode}/${collapsed ? 'collapsed' : 'open'}/${overlays ? 'overlay' : 'beside'}`}</Text>
    )
  }

  const state = () => screen.getByTestId('probe').props.children

  function widthIs(width: number, view: ReturnType<typeof renderScreen>, holdMs: number) {
    act(() => {
      size({ width, height: WIDE.height })
      view.rerender(withProviders(<Probe />))
    })
    act(() => jest.advanceTimersByTime(holdMs))
  }

  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('leaves the shell and the sidebar alone across 1200 → 690 → 1200 inside 300ms', () => {
    size({ width: 1200, height: WIDE.height })

    const view = renderScreen(<Probe />)

    expect(state()).toBe('regular/open/beside')

    // 690 is under BOTH breakpoints: the shell's 700 and the collapse's 900. It
    // is held for longer than a frame and still nowhere near long enough to be a
    // window the owner resized.
    widthIs(690, view, 100)
    expect(state()).toBe('regular/open/beside')

    widthIs(1200, view, 300)
    expect(state()).toBe('regular/open/beside')
  })

  it('is unmoved by the window going away and coming back', () => {
    size({ width: 1200, height: WIDE.height })

    const view = renderScreen(<Probe />)

    // A window that is not on screen measures nothing, and a Mac window has been
    // seen to report exactly this on the way out and back.
    act(() => {
      AppState.currentState = 'background'
      AppState.emit?.('change', 'background')
    })
    widthIs(0, view, 200)
    expect(state()).toBe('regular/open/beside')

    act(() => {
      AppState.currentState = 'active'
      AppState.emit?.('change', 'active')
    })
    widthIs(1200, view, 300)

    expect(state()).toBe('regular/open/beside')
  })

  it('still follows a window the owner really did resize', () => {
    // The guard must not become "the width never matters": dragging a Mac window
    // narrow and leaving it there is a different thing, and it collapses.
    size({ width: 1200, height: WIDE.height })

    const view = renderScreen(<Probe />)

    widthIs(834, view, 300)
    expect(state()).toBe('regular/collapsed/overlay')

    widthIs(600, view, 300)
    expect(state()).toBe('compact/collapsed/overlay')
  })
})

describe('the layout store', () => {
  it('keeps "never chosen" apart from "chose to show"', () => {
    expect(useChatLayoutStore.getState().sidebarCollapsed).toBeUndefined()

    useChatLayoutStore.getState().setSidebarCollapsed(false)

    expect(useChatLayoutStore.getState().sidebarCollapsed).toBe(false)
  })

  it('persists the choice per gateway and reads it back', async () => {
    await useChatLayoutStore.getState().load('https://one.example.com')
    useChatLayoutStore.getState().setSidebarCollapsed(true)

    // A second gateway is a different arrangement, so it starts with no choice.
    await useChatLayoutStore.getState().load('https://two.example.com')
    expect(useChatLayoutStore.getState().sidebarCollapsed).toBeUndefined()

    await useChatLayoutStore.getState().load('https://one.example.com')
    expect(useChatLayoutStore.getState().sidebarCollapsed).toBe(true)
  })
})

describe('the wide window', () => {
  it('starts with the list showing and hides it on the header button', () => {
    renderScreen(<RegularShell />)

    expect(screen.getByTestId('bots-list')).toBeTruthy()
    expect(sidebarWidthOf()).toBe(SIDEBAR_WIDTH)

    fireEvent.press(screen.getByTestId('chat-header-sidebar'))

    expect(screen.queryByTestId('bots-list')).toBeNull()
    expect(screen.getByTestId('sidebar-rail')).toBeTruthy()
    expect(sidebarWidthOf()).toBe(SIDEBAR_RAIL_WIDTH)
  })

  it('shows it again in place rather than as an overlay', () => {
    useChatLayoutStore.getState().setSidebarCollapsed(true)
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('sidebar-rail-show'))

    expect(screen.getByTestId('bots-list')).toBeTruthy()
    expect(screen.queryByTestId('sidebar-overlay')).toBeNull()
    expect(sidebarWidthOf()).toBe(SIDEBAR_WIDTH)
  })

  it('keeps every destination reachable from the rail', () => {
    useChatLayoutStore.getState().setSidebarCollapsed(true)
    renderScreen(<RegularShell />)

    for (const key of ['activity', 'cron', 'settings']) {
      expect(screen.getByTestId(`sidebar-rail-${key}`)).toBeTruthy()
    }

    fireEvent.press(screen.getByTestId('sidebar-rail-cron'))

    expect(screen.getByTestId('overlay-panel')).toBeTruthy()
  })

  /**
   * The rail is a variant of `BotsScreen` precisely so these keep working. A ⌘3
   * that stops once you hide the list is worse than one that never existed.
   */
  it('still answers ⌘1…9 while the list is hidden', () => {
    useChatLayoutStore.getState().setSidebarCollapsed(true)
    renderScreen(<RegularShell />)

    press('chat2')

    // A chat is open rather than the "pick one" placeholder, which is the whole
    // claim: the rail kept the registration the rows used to own.
    expect(screen.queryByTestId('chat-empty')).toBeNull()
    expect(screen.getByTestId('chat-header')).toBeTruthy()
  })
})

describe('the narrow window', () => {
  it('starts collapsed, because at 834pt the chat column has nothing to spare', () => {
    size(NARROW)
    renderScreen(<RegularShell />)

    expect(screen.getByTestId('sidebar-rail')).toBeTruthy()
    expect(sidebarWidthOf()).toBe(SIDEBAR_RAIL_WIDTH)
  })

  it('brings the list back OVER the chat rather than beside it', () => {
    size(NARROW)
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('sidebar-rail-show'))

    expect(screen.getByTestId('sidebar-overlay')).toBeTruthy()
    expect(screen.getByTestId('bots-list')).toBeTruthy()
    // The panel behind it is still the rail: the chat was never pushed aside.
    expect(sidebarWidthOf()).toBe(SIDEBAR_RAIL_WIDTH)
  })

  it('is the sidebar width, not the rail width, that the overlay takes', () => {
    size(NARROW)
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('sidebar-rail-show'))

    const overlay = StyleSheet.flatten(screen.getByTestId('sidebar-overlay').props.style as never) as {
      width?: number
    }

    expect(overlay.width).toBe(SIDEBAR_WIDTH_NARROW)
  })

  it('closes on the chat the reader picked, which was the errand', async () => {
    size(NARROW)
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('sidebar-rail-show'))
    fireEvent.press(screen.getByTestId('bot-row-writer'))

    await waitForGone(() => screen.queryByTestId('sidebar-overlay'), 'sidebar-overlay')
    // …and the chat it was opened to pick is the one now in the column.
    expect(screen.queryByTestId('chat-empty')).toBeNull()
    expect(screen.getByTestId('chat-header')).toBeTruthy()
  })

  it('closes on a tap outside itself', async () => {
    size(NARROW)
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('sidebar-rail-show'))
    fireEvent.press(screen.getByTestId('sidebar-overlay-scrim'))

    await waitForGone(() => screen.queryByTestId('sidebar-overlay'), 'sidebar-overlay')
  })

  /**
   * Escape goes back ONE level, and the level is whatever opened last. With a
   * destination panel already up, the temporary list opened after it, so the first
   * Escape takes the list and the panel stays — which is the rule the whole Escape
   * stack exists to make fall out of mount order rather than out of a coordinator.
   */
  it('gives Escape the temporary list before the destination panel under it', async () => {
    size(NARROW)
    renderScreen(<RegularShell />)

    fireEvent.press(screen.getByTestId('sidebar-rail-activity'))
    expect(screen.getByTestId('overlay-panel')).toBeTruthy()

    // From the rail, because at this width the list is hidden and the rail is the
    // only sidebar control on screen.
    fireEvent.press(screen.getByTestId('sidebar-rail-show'))
    expect(screen.getByTestId('sidebar-overlay')).toBeTruthy()

    press('close')

    await waitForGone(() => screen.queryByTestId('sidebar-overlay'), 'sidebar-overlay')
    expect(screen.getByTestId('overlay-panel')).toBeTruthy()
  })
})

describe('the keyboard and the menu bar', () => {
  it('hides and shows on the toggleSidebar action, whichever of the two sent it', () => {
    renderScreen(<RegularShell />)

    expect(screen.getByTestId('bots-list')).toBeTruthy()

    press('toggleSidebar')
    expect(screen.getByTestId('sidebar-rail')).toBeTruthy()

    press('toggleSidebar')
    expect(screen.getByTestId('bots-list')).toBeTruthy()
  })

  it('names the item for what the keystroke will do, not for where the sidebar is', () => {
    renderScreen(<RegularShell />)

    const titlesOf = () => ((setMenuBar as jest.Mock).mock.calls.at(-1) ?? [])[0] as { toggleSidebar?: string }

    expect(titlesOf().toggleSidebar).toBe(strings.menuBar.hideSidebar)

    fireEvent.press(screen.getByTestId('chat-header-sidebar'))

    expect(titlesOf().toggleSidebar).toBe(strings.menuBar.showSidebar)
  })

  /**
   * One control at a time, which is the decision an iPad forced.
   *
   * With a button in the chat column AND one on the rail, a collapsed window drew
   * two identical sidebar icons about 90pt apart doing the same thing. So the chat
   * column's button exists only while the list is showing and always says Hide,
   * and the rail's exists only while it is hidden and always says Show. Neither
   * has to describe a state the other is in.
   */
  it('puts exactly one sidebar control on screen, and labels it for what it does', () => {
    renderScreen(<RegularShell />)

    expect(screen.getByTestId('chat-header-sidebar').props.accessibilityLabel).toBe('Hide sidebar')
    expect(screen.queryByTestId('sidebar-rail-show')).toBeNull()

    fireEvent.press(screen.getByTestId('chat-header-sidebar'))

    expect(screen.queryByTestId('chat-header-sidebar')).toBeNull()
    expect(screen.getByTestId('sidebar-rail-show').props.accessibilityLabel).toBe('Show sidebar')
  })
})

describe('the rail badge', () => {
  it('carries the unread total, which the hidden rows would otherwise have said', () => {
    useChatLayoutStore.getState().setSidebarCollapsed(true)
    useBotsStore.getState().setBots([bot('researcher', 'Researcher'), bot('writer', 'Writer')])
    renderScreen(<RegularShell />)

    // No transcript is loaded in this test, so there is nothing unread to count and
    // the badge must be absent rather than a zero.
    expect(screen.queryByTestId('sidebar-rail-unread')).toBeNull()
  })
})
