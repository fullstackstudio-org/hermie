/**
 * How wide the sidebar is, and why that is a SECOND breakpoint.
 *
 * 344 was one number for every window from 700pt up. On an iPad Pro 13" in
 * portrait that is a third of the screen (344 of 1032) and on an 11" it is two
 * fifths (344 of 834) — and all of it comes out of the single column that has to
 * hold prose. Measured on an 11" before this change, the chat column was 448pt
 * and a bubble capped at ~305pt, which is NARROWER than the same bubble on an
 * iPhone 17 Pro (314pt): a tablet reading worse than a phone.
 *
 * Asserted here rather than on a simulator because the PAIR is the point — one
 * number is not a breakpoint — and because a Mac window drags through every
 * width in between, which no screenshot covers.
 */
import { screen } from '@testing-library/react-native'
import { StyleSheet, useWindowDimensions } from 'react-native'

import { RegularShell } from '../src/app/RegularShell'
import { resolveBubbleWidth } from '../src/chat-ui'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatLayoutStore } from '../src/store/chat-layout'
import { useChatsStore } from '../src/store/chats'
import {
  BUBBLE_MAX,
  REGULAR_LAYOUT_MIN_WIDTH,
  SIDEBAR_WIDE_MIN_WIDTH,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_NARROW,
  sidebarWidth,
  WINDOW_GAP
} from '../src/ui/tokens'
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

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => null
}))

jest.mock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

const size = (width: number, height: number) =>
  mockDimensions.mockReturnValue({ width, height, scale: 2, fontScale: 1 })

/** iPad Pro 13", portrait and landscape. */
const PORTRAIT_13 = { width: 1032, height: 1376 }
const LANDSCAPE_13 = { width: 1376, height: 1032 }
/** iPad Pro 11", portrait — the narrowest window that ships as the wide layout. */
const PORTRAIT_11 = { width: 834, height: 1210 }
/** iPhone 17 Pro, for the comparison the whole change is about. */
const PHONE_WIDTH = 402

const bot = (name: string, displayName: string): Bot => ({
  name,
  displayName,
  description: '',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0
})

const sidebarStyle = () =>
  StyleSheet.flatten(screen.getByTestId('shell-sidebar').props.style as never) as Record<string, number | undefined>

/** The chat column beside the sidebar: the window less the sidebar, the gap and both margins. */
const columnFor = (windowWidth: number) => windowWidth - (sidebarWidth(windowWidth) + WINDOW_GAP * 3)

beforeEach(() => {
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useChatLayoutStore.getState().reset()
  useBotsStore.getState().setBots([bot('researcher', 'Researcher'), bot('writer', 'Writer')])
})

describe('the sidebar width rule', () => {
  it('is the narrow width below the threshold and the full one at or above it', () => {
    expect(sidebarWidth(SIDEBAR_WIDE_MIN_WIDTH - 1)).toBe(SIDEBAR_WIDTH_NARROW)
    expect(sidebarWidth(SIDEBAR_WIDE_MIN_WIDTH)).toBe(SIDEBAR_WIDTH)
  })

  it('reaches the narrow end of the regular shell, which is where it matters', () => {
    expect(sidebarWidth(REGULAR_LAYOUT_MIN_WIDTH)).toBe(SIDEBAR_WIDTH_NARROW)
  })

  it('is two different numbers, so it is a breakpoint rather than one number twice', () => {
    expect(SIDEBAR_WIDTH_NARROW).toBeLessThan(SIDEBAR_WIDTH)
  })
})

describe('the shell applies it', () => {
  /**
   * 834pt now STARTS collapsed — it is under `SIDEBAR_AUTO_COLLAPSE_MAX_WIDTH`,
   * which is the lever this file's own measurement asked for — so the width rule is
   * asserted with the list explicitly shown. Which of the two widths a shown
   * sidebar takes is still the question here; whether it is shown at all is
   * `sidebar-collapse.test.tsx`.
   */
  it('gives an 11" portrait window the narrow sidebar', () => {
    size(PORTRAIT_11.width, PORTRAIT_11.height)
    useChatLayoutStore.getState().setSidebarCollapsed(false)
    renderScreen(<RegularShell />)

    expect(sidebarStyle().width).toBe(SIDEBAR_WIDTH_NARROW)
  })

  it('gives a 13" portrait window the narrow one too — 1032 is still under the threshold', () => {
    size(PORTRAIT_13.width, PORTRAIT_13.height)
    renderScreen(<RegularShell />)

    expect(sidebarStyle().width).toBe(SIDEBAR_WIDTH_NARROW)
  })

  it('gives a 13" landscape window the full one', () => {
    size(LANDSCAPE_13.width, LANDSCAPE_13.height)
    renderScreen(<RegularShell />)

    expect(sidebarStyle().width).toBe(SIDEBAR_WIDTH)
  })
})

describe('what the chat column gets back', () => {
  it('hands the 11" portrait column the points the sidebar gave up', () => {
    expect(columnFor(PORTRAIT_11.width)).toBe(492)
    // 448 was the measured column before the change.
    expect(columnFor(PORTRAIT_11.width)).toBeGreaterThan(448)
  })

  it('lifts the 11" bubble cap back above an iPhone 17 Pro’s', () => {
    const phone = resolveBubbleWidth(BUBBLE_MAX.compact, PHONE_WIDTH)

    expect(resolveBubbleWidth(BUBBLE_MAX.regular, columnFor(PORTRAIT_11.width))).toBeGreaterThan(phone)
  })

  it('leaves a landscape window on the point ceiling, where the cap was never the problem', () => {
    expect(resolveBubbleWidth(BUBBLE_MAX.regular, columnFor(LANDSCAPE_13.width))).toBe(BUBBLE_MAX.regular.points)
  })
})
