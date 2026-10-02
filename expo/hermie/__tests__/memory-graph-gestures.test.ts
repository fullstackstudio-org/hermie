/**
 * The memory graph's pan and pinch arithmetic.
 *
 * `MemoryGraphView` holds the refs and the `PanResponder`; everything a reader
 * can actually get wrong is in `graph-gestures.ts` and is tested here. Driving
 * the responder itself would mean hand-building React Native's internal
 * `touchHistory` — an undocumented shape with no compatibility promise — and a
 * suite that depended on it would be pinning the framework rather than the app.
 */
import {
  claimsGesture,
  clampScale,
  DRAG_SLOP,
  pinchSpan,
  scaleFromPinch,
  ZOOM_MAX,
  ZOOM_MIN
} from '../src/features/memory/graph-gestures'

const at = (pageX: number, pageY: number) => ({ pageX, pageY })

describe('the span between two fingers', () => {
  it('is the distance between them', () => {
    expect(pinchSpan([at(0, 0), at(30, 40)])).toBe(50)
  })

  it('is nothing at all with one finger, which is a pan', () => {
    expect(pinchSpan([at(10, 10)])).toBeNull()
    expect(pinchSpan([])).toBeNull()
  })

  /**
   * Two touches on the same point divide to infinity. That is two fingers
   * resting together rather than a gesture with a direction in it.
   */
  it('is nothing when the two are on the same point', () => {
    expect(pinchSpan([at(100, 100), at(100, 100)])).toBeNull()
  })

  /**
   * The FIRST two, not the two furthest apart: a third finger landing mid-pinch
   * must not re-anchor the gesture to a different pair and jump the drawing.
   */
  it('reads the first two and ignores a third', () => {
    expect(pinchSpan([at(0, 0), at(0, 10), at(0, 900)])).toBe(10)
  })
})

describe('what a pinch does to the scale', () => {
  it('is a ratio against where the fingers started, not an increment', () => {
    expect(scaleFromPinch({ span: 100, scale: 1 }, 200)).toBe(2)
    expect(scaleFromPinch({ span: 100, scale: 1 }, 50)).toBe(0.5)
  })

  /** Wherever the buttons, the wheel or an earlier pinch left the scale. */
  it('is measured from the scale the fingers went down at', () => {
    expect(scaleFromPinch({ span: 100, scale: 1.5 }, 200)).toBe(3)
  })

  it('holds still while the fingers do', () => {
    expect(scaleFromPinch({ span: 120, scale: 2 }, 120)).toBe(2)
  })

  it('stops at the same limits the buttons stop at', () => {
    expect(scaleFromPinch({ span: 10, scale: 1 }, 10_000)).toBe(ZOOM_MAX)
    expect(scaleFromPinch({ span: 10_000, scale: 1 }, 1)).toBe(ZOOM_MIN)
  })

  it('does not divide by an anchor that was never a pinch', () => {
    expect(scaleFromPinch({ span: 0, scale: 1.25 }, 300)).toBe(1.25)
  })
})

describe('clamping', () => {
  it('keeps a scale between the two limits', () => {
    expect(clampScale(1)).toBe(1)
    expect(clampScale(99)).toBe(ZOOM_MAX)
    expect(clampScale(0)).toBe(ZOOM_MIN)
  })

  /** A NaN reaching the transform would blank the whole drawing. */
  it('answers a number for a value that is not one', () => {
    expect(clampScale(Number.NaN)).toBe(ZOOM_MIN)
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(ZOOM_MAX)
  })
})

describe('when a move takes the gesture from the node under the finger', () => {
  it('waits for a slop with one finger, so a tap still lands', () => {
    expect(claimsGesture(1, 0, 0)).toBe(false)
    expect(claimsGesture(1, DRAG_SLOP, 0)).toBe(false)
    expect(claimsGesture(1, DRAG_SLOP + 1, 0)).toBe(true)
  })

  /**
   * And never with two. Nobody taps a node with two fingers, so there is no tap
   * to protect — and a slop would eat the beginning of every zoom.
   */
  it('takes it at once with two, before either has travelled', () => {
    expect(claimsGesture(2, 0, 0)).toBe(true)
  })
})
