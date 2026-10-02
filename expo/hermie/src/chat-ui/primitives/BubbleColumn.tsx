/**
 * How wide the column a bubble is laid out in actually is.
 *
 * The bubble cap in `design/liquid-glass-tokens.md` §4 is a percentage AND a
 * point ceiling, and the percentage is of the COLUMN — not of the window. On a
 * phone the two are the same number, which is why nobody noticed; on the wide
 * layout the window is the sidebar plus the chat panel plus three gaps, so a
 * bubble sized from the window is sized from a box it is not in.
 *
 * The previous shape tried to express the percentage in the style itself
 * (`maxWidth: '68%'` on the bubble, the point cap on the wrapper around it).
 * That silently did nothing: the wrapper is sized by its own `maxWidth` rather
 * than by a definite width, so Yoga had no base to resolve the percentage
 * against and dropped it — leaving the point cap as the only rule that ever
 * applied. Measuring the column turns both halves back into one number, and a
 * number is something a test can hold.
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'

/** Null until the first layout; the window stands in for that one frame. */
const BubbleColumnWidthContext = createContext<number | null>(null)

export function useBubbleColumnWidth(): number | null {
  return useContext(BubbleColumnWidthContext)
}

export interface BubbleColumnProps {
  children: ReactNode
  style?: StyleProp<ViewStyle>
  testID?: string
}

/**
 * Measures its own box and tells every bubble under it how wide the column is.
 *
 * The transcript is the only thing that mounts one. A bubble rendered outside a
 * column — the component gallery's own sections — falls back to the window,
 * which is what it is filling there.
 */
export function BubbleColumn({ children, style, testID }: BubbleColumnProps) {
  const [width, setWidth] = useState<number | null>(null)

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width)

    // Only on a real change: a layout pass fires on every scroll on some
    // platforms, and a state write per frame would re-render the whole list.
    setWidth(current => (current === next ? current : next))
  }, [])

  return (
    <View onLayout={onLayout} style={style} testID={testID}>
      <BubbleColumnWidthContext.Provider value={width}>{children}</BubbleColumnWidthContext.Provider>
    </View>
  )
}
