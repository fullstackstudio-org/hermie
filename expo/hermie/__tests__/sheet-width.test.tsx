/**
 * How wide a bottom sheet is allowed to get, and where it sits.
 *
 * On a phone a sheet is the window, which is right: there is nothing beside it.
 * On the wide layout there is — the chat list, which stays usable while a sheet
 * is up — and a sheet that spanned the window would lay its scrim over that list
 * and put "Allow once" and "Deny" a hand's width apart. So it is capped and
 * parked over the CONTENT COLUMN, whose left edge is the sidebar plus the gaps
 * around it.
 *
 * The numbers here are asserted at 1366 × 1024, an iPad Pro 13" in landscape,
 * because that is the window the owner actually uses and the one width at which
 * the caps bite. That could not be produced on a simulator on this machine (no
 * Simulator.app, so no rotation), which is exactly why it is pinned here.
 */
import { screen } from '@testing-library/react-native'
import { StyleSheet, useWindowDimensions, View } from 'react-native'

import { BottomSheet } from '../src/ui/BottomSheet'
import { REGULAR_LAYOUT_MIN_WIDTH, SHEET_MAX_WIDTH, SIDEBAR_WIDTH, WINDOW_GAP } from '../src/ui/tokens'
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

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

const size = (width: number, height: number) =>
  mockDimensions.mockReturnValue({ width, height, scale: 2, fontScale: 1 })

/** iPad Pro 13", landscape. */
const LANDSCAPE = { width: 1366, height: 1024 }
/** The same device, portrait — still the wide layout. */
const PORTRAIT = { width: 1032, height: 1376 }
/** iPhone 17 Pro. */
const PHONE = { width: 402, height: 874 }

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as Record<string, number | undefined>

function open() {
  renderScreen(
    <BottomSheet onRequestClose={jest.fn()} testID="sheet" visible>
      <View testID="sheet-body" />
    </BottomSheet>
  )
}

describe('a sheet on the wide layout', () => {
  it('is capped rather than spanning a landscape window', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)
    open()

    expect(flat('sheet-panel').maxWidth).toBe(SHEET_MAX_WIDTH)
  })

  it('starts where the content column starts, not at the window edge', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)
    open()

    // The sidebar and the gap on each side of it.
    expect(flat('sheet-column').paddingLeft).toBe(SIDEBAR_WIDTH + WINDOW_GAP * 2)
  })

  it('keeps the same cap in portrait, which is still the wide layout', () => {
    size(PORTRAIT.width, PORTRAIT.height)
    open()

    expect(PORTRAIT.width).toBeGreaterThanOrEqual(REGULAR_LAYOUT_MIN_WIDTH)
    expect(flat('sheet-panel').maxWidth).toBe(SHEET_MAX_WIDTH)
  })

  it('never grows past the column, however narrow that column is', () => {
    // A window only just past the threshold: the cap would be wider than what
    // is left beside the sidebar, so the column wins.
    size(REGULAR_LAYOUT_MIN_WIDTH, 900)
    open()

    expect(flat('sheet-panel').maxWidth).toBe(REGULAR_LAYOUT_MIN_WIDTH - (SIDEBAR_WIDTH + WINDOW_GAP * 2))
  })
})

describe('a sheet on a phone', () => {
  it('is the width of the window, with nothing beside it to leave room for', () => {
    size(PHONE.width, PHONE.height)
    open()

    expect(flat('sheet-panel').maxWidth).toBe(PHONE.width)
  })

  it('is never taller than most of the window', () => {
    size(PHONE.width, PHONE.height)
    open()

    expect(flat('sheet-panel').maxHeight).toBe(Math.round(PHONE.height * 0.86))
  })
})

describe('the grabber', () => {
  it('is there on an ordinary sheet', () => {
    size(PHONE.width, PHONE.height)
    open()

    // Decorative, so it is hidden from the accessibility tree on purpose.
    expect(screen.getByTestId('sheet-grabber', { includeHiddenElements: true })).toBeTruthy()
  })

  it('is there on a question too, because every sheet can now be dragged away', () => {
    size(PHONE.width, PHONE.height)
    renderScreen(
      <BottomSheet accessibilityLabel="Allow this command?" onRequestClose={jest.fn()} testID="sheet" visible>
        <View testID="sheet-body" />
      </BottomSheet>
    )

    expect(screen.getByTestId('sheet-grabber', { includeHiddenElements: true })).toBeTruthy()
  })
})
