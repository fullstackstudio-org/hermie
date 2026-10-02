/**
 * A `KeyboardAvoidingView` that knows where on the screen it actually is.
 *
 * ## The arithmetic React Native gets wrong wherever the view is not at the top
 *
 * `KeyboardAvoidingView` decides how much room to make with one line
 * (`Libraries/Components/Keyboard/KeyboardAvoidingView.js`):
 *
 * ```js
 * return Math.max(frame.y + frame.height - keyboardY, 0)
 * ```
 *
 * `frame` is its own `onLayout` — which React Native reports **relative to the
 * parent** — and `keyboardY` is `endCoordinates.screenY`, which is in **window**
 * coordinates. The two agree only when the view's parent starts at the top of
 * the window. Every screen in this app puts something above it: `Screen` adds
 * `paddingTop: insets.top`, and in the wide layout the chat is inside a panel
 * that starts further down still.
 *
 * On an iPhone 17 Pro that is 59 points. So the padding the view made for the
 * keyboard was 59 points short, and the composer sat 59 points too low — behind
 * the keyboard, which is exactly what the owner reported and what a simulator
 * screenshot with the keyboard up shows: the field is simply not there.
 *
 * `keyboardVerticalOffset` is subtracted from `keyboardY`, so handing it the
 * distance between the window's top and this view's top makes the comparison
 * whole again. Nobody can write that number down — it depends on the safe area,
 * on whether this is the phone's stack or the iPad's panel, and on the window's
 * size — so it is MEASURED, once per layout.
 *
 * `measure` is a seam rather than a hard call to `measureInWindow` so that a test
 * renderer, which lays nothing out and answers zero for everything, can still
 * state what the view does with an answer of 59.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { KeyboardAvoidingView, View, type StyleProp, type ViewStyle } from 'react-native'

import { KEYBOARD_AVOID_BEHAVIOR } from './keyboard'

export interface KeyboardInsetProps {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  testID?: string
  /**
   * Answer where this view's top edge is in the window. The default asks the
   * platform; a test passes its own.
   */
  measure?: (view: View, report: (windowY: number) => void) => void
}

function measureInWindow(view: View, report: (windowY: number) => void): void {
  view.measureInWindow((_x, y) => report(y))
}

export function KeyboardInset({
  children,
  style,
  testID = 'keyboard-inset',
  measure = measureInWindow
}: KeyboardInsetProps) {
  const [offset, setOffset] = useState(0)
  const view = useRef<View>(null)

  const remeasure = useCallback(() => {
    const node = view.current

    if (!node) {
      return
    }

    measure(node, windowY => {
      // A window that is not on screen measures nothing, and a negative top is a
      // view being scrolled off rather than a distance to correct for.
      if (Number.isFinite(windowY) && windowY >= 0) {
        setOffset(Math.round(windowY))
      }
    })
  }, [measure])

  return (
    // `collapsable={false}`: without it this view is flattened away on the
    // native side, and a view that does not exist cannot be measured.
    <View collapsable={false} onLayout={remeasure} ref={view} style={style} testID={`${testID}-frame`}>
      <KeyboardAvoidingView
        behavior={KEYBOARD_AVOID_BEHAVIOR}
        keyboardVerticalOffset={offset}
        style={{ flex: 1 }}
        testID={testID}
      >
        {children}
      </KeyboardAvoidingView>
    </View>
  )
}
