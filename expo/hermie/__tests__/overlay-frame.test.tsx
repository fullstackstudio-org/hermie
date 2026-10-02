/**
 * Where a destination panel sits, and what it dims.
 *
 * Both halves came back from a Mac window, and both are geometry a screenshot shows
 * and a component test used to miss entirely:
 *
 *  - The panel was positioned from the WINDOW — a gap plus whatever the insets said
 *    — rather than from the panel it covers. On the Mac that arithmetic landed it
 *    past the chat panel's rounded bottom corner and against the window's own edge,
 *    square. It is now the content panel's MEASURED frame, so the two share a top,
 *    a bottom, a right edge and a radius by construction.
 *  - The dim was one `absoluteFill` over the shell, which is the one shape in this
 *    layout that is wrong twice: it darkened the 14pt wallpaper gap around and
 *    between the panels, and it left the sidebar — the thing a reader can see and
 *    click through a dim — untouched. The dim now lives INSIDE each panel.
 *
 * The frame is asserted on a 1500 × 900 layout, which is the Mac window the owner
 * judges on: it is past every threshold in the layout code, so nothing here is an
 * accident of a narrow window.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'
import { StyleSheet, useWindowDimensions, type ViewStyle } from 'react-native'

import { RegularShell } from '../src/app/RegularShell'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import { SCRIM_COLOR, WINDOW_GAP } from '../src/ui/tokens'
import { renderScreen } from './support/render'
import { resetSettledWidth } from '../src/app/useLayoutMode'

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

jest.mock('../src/features/chats/ChatRuntime', () => ({ useChatRuntime: () => null }))
jest.mock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: true }))
jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

/** The owner's Mac window. Past every width threshold in the layout code. */
const MAC = { width: 1500, height: 900 }

/** The content panel's box, as its own `onLayout` would report it. */
const CONTENT_FRAME = { x: 0, y: 0, width: 1132, height: 872 }

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

const flat = (testID: string): ViewStyle =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as ViewStyle

beforeEach(() => {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useBotsStore.getState().setBots([bot('researcher', 'Researcher'), bot('writer', 'Writer')])
  mockDimensions.mockReturnValue({ ...MAC, scale: 2, fontScale: 1 })
})

/**
 * Render the shell, report the content panel's frame, and open Activity.
 *
 * This used to open Settings. HERM-102/108 moved Settings into the content
 * column instead of `OverlayPanel` (see `regular-shell.test.tsx`), so it no
 * longer produces an `overlay-frame` to measure — Activity and Crons still do,
 * and the frame geometry this file is about does not depend on which of the
 * two is open.
 */
function openActivity() {
  renderScreen(<RegularShell />)

  fireEvent(screen.getByTestId('shell-content-panel'), 'layout', { nativeEvent: { layout: CONTENT_FRAME } })
  fireEvent.press(screen.getByTestId('tab-activity'))
}

describe('the destination panel’s frame', () => {
  it('is the content panel’s measured box, not a guess from the window', () => {
    openActivity()

    expect(flat('overlay-frame')).toMatchObject({
      height: CONTENT_FRAME.height,
      left: CONTENT_FRAME.x,
      position: 'absolute',
      top: CONTENT_FRAME.y,
      width: CONTENT_FRAME.width
    })
  })

  it('shares the content panel’s top, bottom and right edges exactly', () => {
    openActivity()

    const panel = flat('overlay-panel')

    // Zero on all three, because the frame above already IS the content panel.
    expect(panel.top).toBe(0)
    expect(panel.bottom).toBe(0)
    expect(panel.right).toBe(0)

    // And specifically NOT the window gap, which is what put it inside the chat
    // panel on three sides and past it on the fourth.
    expect(panel.top).not.toBe(WINDOW_GAP)
    expect(panel.bottom).not.toBe(WINDOW_GAP)
  })

  it('fills the parent before the first layout, which is the same box', () => {
    // No `onLayout` fired: the fallback has to be right, not merely present, or
    // the panel jumps on its second frame.
    renderScreen(<RegularShell />)
    fireEvent.press(screen.getByTestId('tab-activity'))

    expect(flat('overlay-frame')).toMatchObject(StyleSheet.absoluteFill)
  })
})

describe('the dim', () => {
  it('is inside BOTH columns, in each column’s own shape', () => {
    openActivity()

    for (const id of ['overlay-scrim-dim', 'overlay-scrim-sidebar-dim']) {
      const dim = flat(id) as ViewStyle & { backgroundColor?: string }

      // Its box is its PARENT's, which is the column — so a dim cannot be a
      // different shape from the thing it dims, and cannot reach past it. The
      // radius is 0 now for the reason everything else in this shell is: the
      // owner rejected the floating panels, so neither column is a rounded shape
      // any more and a rounded dim over a square column would show its corners.
      expect(dim).toMatchObject(StyleSheet.absoluteFill)
      expect(dim.borderRadius).toBe(0)
      expect(dim.backgroundColor).toBe(SCRIM_COLOR)
      expect(dim.overflow).toBe('hidden')
    }
  })

  it('leaves the wallpaper gap alone: the panel’s own frame intercepts nothing', () => {
    openActivity()

    // The only thing the destination panel puts at the column level is the frame
    // box, and it is pass-through. Nothing in this layout paints or captures over
    // the 14pt gap between the panels any more — which a single window-wide scrim
    // did, as a dark border around two bright panels.
    expect(screen.getByTestId('overlay-frame').props.pointerEvents).toBe('box-none')
  })

  /*
    Jest's five seconds are not enough for this one, and that is about the
    machine rather than the assertions.

    It is the only case in this file that renders the shell, opens a panel,
    closes it, opens a second one and closes that — two full mount-and-settle
    cycles with a `waitFor` after each. On an idle machine it finishes in well
    under a second. On a busy one — the whole suite in parallel, or vitest
    running beside it — it went over the limit roughly one run in four and failed
    with a timeout, never with a wrong value. A flake that only ever says "too
    slow" is a budget problem, so it gets a bigger budget rather than a rewrite.
  */
  it('closes one level from either panel’s dim', async () => {
    openActivity()
    fireEvent.press(screen.getByTestId('overlay-scrim-sidebar'))

    await waitFor(() => expect(screen.queryByTestId('overlay-panel')).toBeNull())

    // Crons, this time — the other destination that still opens as an overlay.
    fireEvent.press(screen.getByTestId('tab-cron'))
    fireEvent.press(screen.getByTestId('overlay-scrim'))

    await waitFor(() => expect(screen.queryByTestId('overlay-panel')).toBeNull())
  }, 15_000)

  it('takes the taps the sidebar would have taken, so it is not interactive under a dim', () => {
    openActivity()

    // A pressable filling the panel, live while the overlay is open. That is what
    // makes the sidebar unreachable — the row underneath is still mounted and still
    // rendered, which is the point of dimming it rather than removing it.
    expect(screen.getByTestId('overlay-scrim-sidebar-dim').props.pointerEvents).toBe('auto')
    expect(screen.getByTestId('overlay-scrim-sidebar')).toBeTruthy()
    expect(screen.getByTestId('bot-row-writer')).toBeTruthy()
  })

  it('leaves both panels alone when nothing is open', () => {
    renderScreen(<RegularShell />)

    expect(screen.queryByTestId('overlay-scrim')).toBeNull()
    expect(screen.queryByTestId('overlay-scrim-sidebar')).toBeNull()
  })
})
