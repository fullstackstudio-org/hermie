/**
 * The empty strip under the title bar, and the seam that removes it.
 *
 * An iOS app running on a Mac is told it has an iPad's status bar: the window
 * reports a top safe-area inset of roughly 25pt that nothing occupies, because
 * the macOS title bar sits outside the app's window. `Screen` turns that inset
 * into `paddingTop`, so every screen painted an empty band between the title bar
 * and Hermie's own header.
 *
 * This is the assertion, because the fix cannot be seen from a test renderer any
 * other way: a Mac zeroes the TOP inset and leaves the other three alone. The
 * mock is the whole point — `RUNS_ON_MAC` is a native constant, so flipping the
 * module is the only way to render the Mac case at all.
 */
import { screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { Screen } from '../src/ui/primitives'
import { renderScreen } from './support/render'

// The metrics `renderScreen` provides are an iPhone 17 Pro's.
const IPHONE_TOP_INSET = 59
const IPHONE_BOTTOM_INSET = 34

jest.mock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))

const runsOnMac = jest.requireMock('../src/platform/runs-on-mac') as { RUNS_ON_MAC: boolean }

function paddingOfScreen() {
  const raw = screen.getByTestId('probe').props.style as unknown

  return StyleSheet.flatten(raw) as { paddingTop: number; paddingBottom: number }
}

describe('Screen insets', () => {
  it('honours the top inset on a phone', () => {
    runsOnMac.RUNS_ON_MAC = false
    renderScreen(<Screen testID="probe" />)

    expect(paddingOfScreen().paddingTop).toBe(IPHONE_TOP_INSET)
    expect(paddingOfScreen().paddingBottom).toBe(IPHONE_BOTTOM_INSET)
  })

  it('drops the top inset on a Mac, and keeps the rest', () => {
    runsOnMac.RUNS_ON_MAC = true
    renderScreen(<Screen testID="probe" />)

    expect(paddingOfScreen().paddingTop).toBe(0)
    // Not a blanket zero: the other three either are zero on a Mac already or
    // genuinely describe the window, and guessing at them is not a fix.
    expect(paddingOfScreen().paddingBottom).toBe(IPHONE_BOTTOM_INSET)
  })
})
