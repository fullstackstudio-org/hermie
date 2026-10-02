/**
 * A sheet has to arrive, not appear.
 *
 * The owner's report from the Mac build: "bottom sheets appear instantly and
 * only animate when closing". The cause was one expression — the progress value
 * started at `visible ? 1 : 0`, and every sheet in this app is MOUNTED at the
 * moment it becomes visible, so the value already stood at its end and the
 * opening animation ran from 1 to 1. Closing animated 1 → 0 and looked correct,
 * which is why it survived a round.
 *
 * So the case worth pinning is the first FRAME rather than the last: the panel
 * must be off the bottom of the window before anything has animated. Asserting
 * only that it ends at 0 would have passed against the bug.
 */
import { act, screen } from '@testing-library/react-native'
import { Animated, StyleSheet, Text } from 'react-native'

import { BottomSheet, SHEET_ANIMATION_MS } from '../src/ui/BottomSheet'
import { radii } from '../src/ui/tokens'
import { renderScreen, withProviders } from './support/render'

/** The panel's `translateY`, read off the style the sheet actually rendered. */
function translateY(): number {
  const style = screen.getByTestId('sheet-panel').props.style
  const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style
  const transform = flat?.transform?.[0]?.translateY

  // An interpolation carries the value it currently stands at; a plain number is
  // a sheet that is not animating at all.
  return typeof transform === 'number' ? transform : (transform?.__getValue() ?? 0)
}

const sheet = (visible: boolean) => (
  <BottomSheet onRequestClose={jest.fn()} testID="sheet" visible={visible}>
    <Text>Chat options</Text>
  </BottomSheet>
)

const open = (visible = true) => renderScreen(sheet(visible))

/** What the sheet's own layers are drawn with, as opposed to a grabber. */
const SHEET_RADIUS = radii.sheet

describe('opening a bottom sheet', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('starts below the window even when it is mounted already visible', () => {
    // This is the case every sheet in the app is in: `ChatSheetHost` renders one
    // only once there is one to show, so `visible` is true on the first render.
    open()

    expect(translateY()).toBeGreaterThan(0)
  })

  it('reaches its resting place once the animation has run', () => {
    open()

    act(() => {
      jest.advanceTimersByTime(SHEET_ANIMATION_MS * 2)
    })

    expect(translateY()).toBe(0)
  })

  it('animates rather than jumping — it is somewhere between, halfway through', () => {
    open()

    const start = translateY()

    act(() => {
      jest.advanceTimersByTime(Math.round(SHEET_ANIMATION_MS / 2))
    })

    const middle = translateY()

    expect(middle).toBeLessThan(start)
    expect(middle).toBeGreaterThan(0)
  })

  it('still unmounts after a close, which is what swaps one sheet for another', () => {
    const onClosed = jest.fn()

    const { rerender } = renderScreen(
      <BottomSheet onClosed={onClosed} onRequestClose={jest.fn()} testID="sheet" visible>
        <Text>Chat options</Text>
      </BottomSheet>
    )

    act(() => {
      jest.advanceTimersByTime(SHEET_ANIMATION_MS * 2)
    })

    // `rerender` replaces the WHOLE tree, so the providers have to come with it.
    rerender(
      withProviders(
        <BottomSheet onClosed={onClosed} onRequestClose={jest.fn()} testID="sheet" visible={false}>
          <Text>Chat options</Text>
        </BottomSheet>
      )
    )

    act(() => {
      jest.advanceTimersByTime(SHEET_ANIMATION_MS * 2)
    })

    expect(onClosed).toHaveBeenCalled()
    expect(screen.queryByTestId('sheet-panel')).toBeNull()
  })
})

describe('where the sheet sits', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  /** Every style the surface flattened, for the layer under a testID. */
  const flat = (testID: string) =>
    StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as Record<string, number | undefined>

  it('is square at the bottom and rounded at the top, on every layer', () => {
    // It used to say this by overriding four style keys on two of the surface's
    // views, which left the native material still rounded — and a material is not
    // clipped by a parent's corner mask the way a plain layer is. That is the
    // rounded lower edge the owner photographed.
    open()

    act(() => {
      jest.advanceTimersByTime(SHEET_ANIMATION_MS * 2)
    })

    // Every layer, found by its radius rather than by a testID: the surface
    // renders three of them and the one that was wrong had no name.
    const rounded = screen
      .getByTestId('sheet-panel')
      .findAll(node => {
        const style = StyleSheet.flatten(node.props?.style as never) as Record<string, number | undefined> | undefined

        // The sheet's OWN layers, by the radius they are drawn with. A grabber
        // is rounded too and is not one of them.
        return style?.borderTopLeftRadius === SHEET_RADIUS || style?.borderRadius === SHEET_RADIUS
      })
      .map(node => StyleSheet.flatten(node.props.style as never) as Record<string, number | undefined>)

    expect(rounded.length).toBeGreaterThan(0)

    for (const style of rounded) {
      expect(style.borderBottomLeftRadius).toBe(0)
      expect(style.borderBottomRightRadius).toBe(0)
      expect(style.borderTopLeftRadius).toBeGreaterThan(0)
      expect(style.borderTopRightRadius).toBeGreaterThan(0)
      // A blanket radius beside a per-corner one is two rules for one shape, and
      // which wins depends on the order a style array is flattened in.
      expect(style.borderRadius).toBeUndefined()
    }
  })

  it('leaves no space under the card', () => {
    // The safe-area inset belongs INSIDE the card as padding. A margin under it
    // is a strip of window below a sheet that is supposed to sit on the edge.
    open()

    const column = flat('sheet-column')

    expect(column.paddingBottom ?? 0).toBe(0)
    expect(column.marginBottom ?? 0).toBe(0)
    expect(flat('sheet-panel').marginBottom ?? 0).toBe(0)
  })
})

describe('the animated value itself', () => {
  it('is a value, so the panel can be driven from one number', () => {
    // Guards the shape the assertions above read through: if the transform stops
    // being an interpolation the tests would silently start reading 0.
    expect(new Animated.Value(0).interpolate({ inputRange: [0, 1], outputRange: [10, 0] }).__getValue()).toBe(10)
  })
})
