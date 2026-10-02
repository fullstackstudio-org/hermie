/**
 * The arithmetic behind the memory graph's pan and pinch.
 *
 * Split out of `MemoryGraphView` because a `PanResponder` is not reachable from
 * a test without hand-building React Native's `touchHistory` — an internal
 * shape with no compatibility promise, which a test that depended on it would
 * quietly inherit. What a reader can actually get wrong here is the
 * arithmetic: which two touches a span is measured between, what a pinch does
 * to the scale it started from, and when a move is allowed to take the gesture
 * away from the node under the finger. All of that is here, pure, and the
 * component is left holding nothing but the refs.
 *
 * `react-native-gesture-handler` is still not a dependency, and this is the
 * reason the choice is affordable: a pinch is two subtractions and a ratio.
 */

/** As much of a native touch as any of this needs. */
export interface GestureTouch {
  pageX: number
  pageY: number
}

/** Where a pinch began: the span between the fingers, and the scale then. */
export interface PinchAnchor {
  span: number
  scale: number
}

/** How far a finger may travel before a pan claims the gesture from a tap. */
export const DRAG_SLOP = 6

export const ZOOM_STEP = 1.35
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 4

/**
 * Below this the span is treated as no pinch at all.
 *
 * Two touches reported at the same point divide to infinity, and a span of a
 * fraction of a point is two fingers touching rather than a gesture with a
 * direction in it.
 */
const MIN_SPAN = 1

export function clampScale(value: number): number {
  // Only NaN needs saying: it survives both comparisons below and would reach
  // the SVG transform, where it blanks the whole drawing rather than clipping
  // it. An infinity clamps to a limit like any other out-of-range number.
  if (Number.isNaN(value)) {
    return ZOOM_MIN
  }

  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

/**
 * The distance between the first two touches, or `null` when there are not two.
 *
 * The FIRST two, deliberately, and not the two furthest apart: a third finger
 * landing mid-pinch should not silently re-anchor the gesture to a different
 * pair and make the drawing jump.
 */
export function pinchSpan(touches: readonly GestureTouch[]): number | null {
  if (touches.length < 2) {
    return null
  }

  const [first, second] = touches as [GestureTouch, GestureTouch]
  const span = Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY)

  return span < MIN_SPAN ? null : span
}

/**
 * The scale a pinch has reached, from the scale it started at.
 *
 * A ratio rather than an increment, because that is what a pinch means: fingers
 * twice as far apart as they started is twice the scale, wherever the scale
 * happened to be when they went down.
 */
export function scaleFromPinch(anchor: PinchAnchor, span: number): number {
  if (anchor.span < MIN_SPAN) {
    return clampScale(anchor.scale)
  }

  return clampScale(anchor.scale * (span / anchor.span))
}

/**
 * Whether a move takes the gesture away from whatever is under the finger.
 *
 * Two touches take it at once: there is no tap to protect — nobody taps a node
 * with two fingers — and asking a pinch to travel a slop first would eat the
 * beginning of every zoom. One touch has to travel, so a tap still reaches the
 * node it landed on.
 */
export function claimsGesture(touchCount: number, dx: number, dy: number): boolean {
  if (touchCount >= 2) {
    return true
  }

  return Math.hypot(dx, dy) > DRAG_SLOP
}
