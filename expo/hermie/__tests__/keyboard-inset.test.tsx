/**
 * The composer, and the keyboard it kept disappearing behind.
 *
 * `KeyboardAvoidingView` makes room for the keyboard with one line:
 *
 * ```js
 * Math.max(frame.y + frame.height - keyboardY, 0)
 * ```
 *
 * `frame` is its own `onLayout`, which React Native reports RELATIVE TO THE
 * PARENT; `keyboardY` is `endCoordinates.screenY`, which is in WINDOW
 * coordinates. Wherever anything sits above the view — `Screen`'s safe-area
 * padding on a phone, a whole panel in the wide layout — the two are out by
 * exactly that distance and the view makes too little room.
 *
 * The numbers below are an iPhone 17 Pro's: an 874pt window, a 59pt top inset,
 * a 34pt bottom one, and a keyboard whose top edge is at 538. The view is
 * therefore 781 tall with its own top at window y 59, and the room it needs is
 * 302 — while the untouched arithmetic asks for 243. Fifty-nine points, which is
 * the composer.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Keyboard, Text, type View } from 'react-native'

import { KeyboardInset } from '../src/ui/KeyboardInset'
import { withProviders } from './support/render'

/**
 * The keyboard's own notifications, taken at the seam the view subscribes on.
 *
 * `Keyboard` is a native event emitter with nothing to emit in this
 * environment, so the listeners are captured as they are registered and called
 * by hand. That IS the view's contract: it is the only thing it listens to.
 */
const listeners = new Map<string, (event: unknown) => void>()

beforeEach(() => {
  listeners.clear()
  jest.spyOn(Keyboard, 'addListener').mockImplementation((type: string, listener: (event: never) => void) => {
    listeners.set(type, listener as (event: unknown) => void)

    return { remove: () => listeners.delete(type) }
  })
})

afterEach(() => jest.restoreAllMocks())

const WINDOW_Y = 59
const HEIGHT = 781
const KEYBOARD_TOP = 538

/** A measurement the test renderer cannot make: where this view is in the window. */
const measuring = (windowY: number) => (_view: View, report: (y: number) => void) => report(windowY)

function inset(windowY: number) {
  return render(
    withProviders(
      <KeyboardInset measure={measuring(windowY)} testID="inset">
        <Text>composer</Text>
      </KeyboardInset>
    )
  )
}

/**
 * The layout pass, on both halves.
 *
 * The outer frame's is what asks where the view is in the window; the avoiding
 * view's own is what tells it how big it is. Both happen in one pass on a
 * device, and both are needed for the arithmetic to have all its numbers.
 *
 * `await act`: the avoiding view's own update is async — it awaits an
 * accessibility query before it decides — so its state lands on a microtask.
 */
async function laidOut(height = HEIGHT): Promise<void> {
  const layout = { nativeEvent: { layout: { height, width: 402, x: 0, y: 0 } }, persist: () => {} }

  await act(async () => {
    fireEvent(screen.getByTestId('inset-frame'), 'layout', layout)
    fireEvent(screen.getByTestId('inset'), 'layout', layout)
  })
}

/** The keyboard arriving, with its top edge at `screenY`. */
async function keyboardTo(screenY: number): Promise<void> {
  await act(async () => {
    listeners.get('keyboardWillShow')?.({
      duration: 250,
      easing: 'keyboard',
      endCoordinates: { height: 874 - screenY, screenX: 0, screenY, width: 402 },
      startCoordinates: { height: 0, screenX: 0, screenY: 874, width: 402 }
    })
  })
}

/** …and going again. */
async function keyboardGone(): Promise<void> {
  await act(async () => {
    listeners.get('keyboardWillHide')?.({
      duration: 250,
      easing: 'keyboard',
      endCoordinates: { height: 0, screenX: 0, screenY: 874, width: 402 },
      startCoordinates: { height: 336, screenX: 0, screenY: KEYBOARD_TOP, width: 402 }
    })
  })
}

/** The room the avoiding view has made at the bottom right now. */
function room(): number {
  const styles = screen.getByTestId('inset').props.style as { paddingBottom?: number }[]

  return styles.reduce((found, style) => style?.paddingBottom ?? found, 0)
}

describe('the room the composer gets', () => {
  it('reaches the keyboard from a view that starts below the window’s top', async () => {
    inset(WINDOW_Y)
    await laidOut()
    await keyboardTo(KEYBOARD_TOP)

    // 781 - (538 - 59). Without the offset it would be 243 and the composer
    // would sit 59 points inside the keyboard.
    expect(room()).toBe(HEIGHT - (KEYBOARD_TOP - WINDOW_Y))
  })

  it('asks for nothing extra from a view that is already at the top', async () => {
    inset(0)
    await laidOut()
    await keyboardTo(KEYBOARD_TOP)

    expect(room()).toBe(HEIGHT - KEYBOARD_TOP)
  })

  it('gives the room back when the keyboard goes', async () => {
    inset(WINDOW_Y)
    await laidOut()
    await keyboardTo(KEYBOARD_TOP)

    await keyboardGone()

    expect(room()).toBe(0)
  })

  it('ignores a measurement of a view that is not on screen', async () => {
    // A window in the background measures nothing, and a view scrolled off the
    // top measures negative. Neither is a distance to correct for.
    for (const windowY of [-40, Number.NaN]) {
      inset(windowY)
      await laidOut()
      await keyboardTo(KEYBOARD_TOP)

      expect(room()).toBe(HEIGHT - KEYBOARD_TOP)
      screen.unmount()
    }
  })
})
