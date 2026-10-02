/**
 * What a tap OUTSIDE a bottom sheet lands on.
 *
 * The owner's report from build 163: on a Mac and on an iPad, tapping beside a
 * sheet does not close it. The sheet's own dismissal tests were green, because
 * they press the backdrop by `testID` — which proves the handler is wired and
 * says nothing about whether a finger can reach it.
 *
 * Two facts decide that, and this file pins both:
 *
 *  - **The scrim covers the whole modal.** It used to be a `flex: 1` sibling
 *    above the panel in a column, so it was exactly the leftover space ABOVE the
 *    sheet. On a phone that is the entire backdrop; on the wide layout the panel
 *    is capped and parked over the content column, so most of the visible
 *    backdrop is beside it, where the scrim was not.
 *  - **The column beside the panel takes no touch.** It spans the window so the
 *    panel can be centred in the content column, and a plain transparent `View`
 *    absorbs a tap exactly as an opaque one does.
 *
 * **What this file cannot do.** There is no hit testing here: the test renderer
 * has no layout engine, so "press at x, y" is not a thing that can be asked. The
 * two properties above ARE the hit test — React Native decides by z-order and by
 * `pointerEvents` — so asserting them is asserting the outcome, one step removed.
 * The tap itself was driven on an iPad simulator; see docs/platform-notes.md.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { StyleSheet, useWindowDimensions, View } from 'react-native'

import { BottomSheet } from '../src/ui/BottomSheet'
import { renderScreen } from './support/render'
import { resetSettledWidth } from '../src/app/useLayoutMode'

beforeEach(resetSettledWidth)

jest.mock('react-native/Libraries/Utilities/useWindowDimensions')

const mockDimensions = useWindowDimensions as unknown as jest.Mock

const size = (width: number, height: number) =>
  mockDimensions.mockReturnValue({ width, height, scale: 2, fontScale: 1 })

/** iPad Pro 13" in landscape — the window the owner reported from. */
const LANDSCAPE = { width: 1366, height: 1024 }
/** iPhone 17 Pro, where the defect was invisible. */
const PHONE = { width: 402, height: 874 }

const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as Record<string, unknown>

function open(onRequestClose = jest.fn()) {
  renderScreen(
    <BottomSheet onRequestClose={onRequestClose} testID="sheet" visible>
      <View testID="sheet-body" />
    </BottomSheet>
  )

  return onRequestClose
}

describe('the scrim', () => {
  it.each([
    ['the wide layout', LANDSCAPE],
    ['a phone', PHONE]
  ])('fills the whole modal on %s, not the space the panel left over', (_name, window) => {
    size(window.width, window.height)
    open()

    const style = flat('sheet-backdrop')

    expect(style.position).toBe('absolute')
    expect([style.top, style.right, style.bottom, style.left]).toEqual([0, 0, 0, 0])
  })

  it('is not laid out in the column that holds the panel', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)
    open()

    // `flex: 1` beside the panel is the defect itself: it makes the scrim mean
    // "whatever height is left" instead of "everywhere".
    expect(flat('sheet-backdrop').flex).toBeUndefined()
  })

  it('still closes the sheet when it is the thing that was pressed', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)
    const onRequestClose = open()

    fireEvent.press(screen.getByTestId('sheet-backdrop'))

    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })
})

describe('the column the panel is centred in', () => {
  it('lets a touch beside the panel through to the scrim', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)
    open()

    // `box-none`: the column itself is not a touch target, its children still
    // are. Anything else — including the default — swallows the tap.
    expect(screen.getByTestId('sheet-column').props.pointerEvents).toBe('box-none')
  })

  it('leaves the panel itself receiving touches', () => {
    size(LANDSCAPE.width, LANDSCAPE.height)
    open()

    expect(screen.getByTestId('sheet-panel').props.pointerEvents).toBeUndefined()
  })
})

/*
  Escape is the OTHER way out of a sheet and it is not re-tested here: it has
  never gone through the backdrop, it is `useEscapeKey` all the way down, and
  `escape-key.test.tsx` already drives it through the same seam the native module
  delivers it on — including the rule this fix must not disturb, that the
  topmost sheet takes the key and nothing under it sees it.
*/
