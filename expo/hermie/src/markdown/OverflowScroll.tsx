/**
 * A row of content that is allowed to be wider than the bubble it lands in.
 *
 * ## The bug this exists for
 *
 * A table and a fenced block were already wrapped in a horizontal `ScrollView`,
 * and neither of them scrolled. The owner photographed the result on the phone:
 * a table whose cells end mid-word at the bubble's right edge, with nothing to
 * drag. The reason is one layout rule, and it is worth writing down because it
 * is invisible from the JSX:
 *
 * A bubble's body sits under `alignItems: 'flex-start'` (see `Bubble`, which
 * needs the body's natural width to place the clock). A flex item under
 * `flex-start` gets its CONTENT width, and a content width is allowed to
 * overflow its container. A `ScrollView` has no intrinsic width of its own to
 * stop that — its content IS its content — so the scroll view came out exactly
 * as wide as the table inside it. A scroll view whose frame equals its content
 * has nothing to scroll: `contentSize == bounds`, the pan recogniser never
 * fires, and the only thing that ever clipped the table was the bubble's own
 * `overflow: 'hidden'` several ancestors up.
 *
 * Measured on an iPhone 17 Pro simulator, 2026-09-21. `maxWidth` on an ancestor
 * does NOT fix it — it clamps that ancestor's reported size without handing the
 * scroll view a definite width to stretch into. Only an explicit `width` on the
 * scroll view itself makes it scroll, which is why this component demands one.
 *
 * ## What it therefore takes
 *
 * `width` is the VIEWPORT, in points, and it has to come from outside: nothing
 * under the `flex-start` boundary can measure it, because everything down there
 * is sized by this content. `Markdown` takes it as `maxContentWidth` and the
 * bubbles derive it from `useBubbleWidth` minus their own padding.
 *
 * Without a width this falls back to what the app did before — a scroll view
 * with no frame of its own — so a caller that cannot measure is no worse off
 * than it was, and no test has to pretend to lay anything out.
 *
 * ## The fade
 *
 * Hidden indicator, per the design board, which leaves a reader with no way to
 * know the row continues. So the overflowing side gets a short gradient into
 * the surface behind it, and it appears only where there IS more: both edges
 * mid-scroll, neither when the content fits. That is measured from the real
 * `contentSize` rather than from the estimate that sized the box, because an
 * affordance that lies is worse than none.
 */
import { LinearGradient } from 'expo-linear-gradient'
import { useCallback, useState, type ReactNode } from 'react'
import {
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle
} from 'react-native'

import { directTouchPanRef } from '../platform/pointer-drag'
import { withAlpha } from '../ui/tokens'

/** How wide the fade is, in points. Two characters of a monospace line. */
const FADE = 22

/** Below this, an edge counts as reached; a scroll offset is not an integer. */
const EPSILON = 1

export interface OverflowScrollProps {
  /**
   * The viewport width in points, from a caller that can actually measure one.
   *
   * Absent means "not known", not "zero": the scroll view then keeps the
   * frameless behaviour it had before this component existed.
   */
  width?: number
  /**
   * What the fade dissolves into — the surface BEHIND this row.
   *
   * No fade without it. A gradient into the wrong colour is a grey smear across
   * the last column, which is the defect `Fold` documents at its own mask.
   */
  fadeTo?: string
  contentContainerStyle?: StyleProp<ViewStyle>
  style?: StyleProp<ViewStyle>
  children: ReactNode
  testID?: string
}

export function OverflowScroll({ width, fadeTo, contentContainerStyle, style, children, testID }: OverflowScrollProps) {
  const [viewport, setViewport] = useState(0)
  const [content, setContent] = useState(0)
  const [offset, setOffset] = useState(0)

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    // Read out of the event, not inside the updater: React Native pools the
    // layout event and `nativeEvent.layout` can be null by the time one runs.
    const next = event.nativeEvent.layout.width

    setViewport(current => (Math.abs(current - next) < 0.5 ? current : next))
  }, [])

  const onContentSizeChange = useCallback((next: number) => {
    setContent(current => (Math.abs(current - next) < 0.5 ? current : next))
  }, [])

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.x

    setOffset(current => (Math.abs(current - next) < 0.5 ? current : next))
  }, [])

  const overflows = content > viewport + EPSILON
  const fadeLeft = Boolean(fadeTo) && overflows && offset > EPSILON
  const fadeRight = Boolean(fadeTo) && overflows && offset + viewport < content - EPSILON

  return (
    <View style={[{ flexGrow: 0 }, width ? { width } : null, style]} testID={testID}>
      <ScrollView
        contentContainerStyle={contentContainerStyle}
        // A table inside a transcript must not steal the list's drag: a finger
        // moving up or down over one keeps scrolling the conversation.
        directionalLockEnabled
        horizontal
        // Android's equivalent of the same rule; inert on iOS.
        nestedScrollEnabled
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
        onScroll={onScroll}
        // A Mac reader drags across a listing to select it, not to pan it.
        ref={directTouchPanRef}
        // Enough for the fades to keep up with a flick without a frame of work
        // per pixel.
        scrollEventThrottle={32}
        showsHorizontalScrollIndicator={false}
        // A horizontal `ScrollView` defaults to `flexGrow: 1`, so inside a
        // scrollable column it balloons to the viewport height instead of
        // hugging its content.
        style={{ flexGrow: 0 }}
      >
        {children}
      </ScrollView>

      {fadeLeft && fadeTo ? <EdgeFade color={fadeTo} side="left" /> : null}
      {fadeRight && fadeTo ? <EdgeFade color={fadeTo} side="right" /> : null}
    </View>
  )
}

/**
 * One edge's gradient.
 *
 * The transparent stop is the fade colour at zero alpha and NOT the keyword
 * `transparent`, which is transparent BLACK and travels through dark grey on
 * its way to an opaque colour — the dirty band `Fold` describes at its own mask.
 */
function EdgeFade({ color, side }: { color: string; side: 'left' | 'right' }) {
  const solidFirst = side === 'left'

  return (
    <LinearGradient
      colors={solidFirst ? [color, withAlpha(color, 0)] : [withAlpha(color, 0), color]}
      end={{ x: 1, y: 0.5 }}
      pointerEvents="none"
      start={{ x: 0, y: 0.5 }}
      style={{
        bottom: 0,
        position: 'absolute',
        top: 0,
        width: FADE,
        ...(side === 'left' ? { left: 0 } : { right: 0 })
      }}
    />
  )
}
