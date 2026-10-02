/**
 * The seam that stops a mouse drag scrolling a list on a Mac.
 *
 * What the fix actually does is native and cannot be reached from here: it
 * narrows a `UIScrollView`'s `panGestureRecognizer` to direct touches, and the
 * simulators on this machine deliver a mouse as a finger, so the behaviour itself
 * is not reproducible in any test on this hardware (see the 2026-09-20 section of
 * docs/platform-notes.md).
 *
 * What IS worth holding still is everything around it, because all of it is
 * reasoning the next reader would otherwise have to redo: that an iPhone and an
 * iPad never make the call at all, that the tag handed over is the scroll view's
 * and not the list wrapper's, and that no failure anywhere in the chain can take
 * a screen down — this runs from a `ref` callback during layout, so a throw here
 * is a blank chat rather than an unfixed drag.
 */
import { applyDirectTouchPan, directTouchPanRef } from '../src/platform/pointer-drag'

const mockUseDirectTouchPanOnly = jest.fn<Promise<boolean>, [number]>()

/**
 * Read through a getter, not captured.
 *
 * The seam asks the registry for the module ONCE, at its own module load, and
 * Babel hoists both that load and these `jest.mock` calls above this file's
 * `const`s — so a factory that captured the spy would hand over `undefined`, and
 * every assertion below would then pass for the wrong reason.
 */
jest.mock('expo', () => ({
  requireOptionalNativeModule: () => ({
    get useDirectTouchPanOnly() {
      return mockUseDirectTouchPanOnly
    }
  })
}))

jest.mock('../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))

const runsOnMac = jest.requireMock('../src/platform/runs-on-mac') as { RUNS_ON_MAC: boolean }

/**
 * A scroll component, as React Native hands one to a `ref`.
 *
 * `getScrollableNode()` is the step down from a `FlatList` to the `ScrollView` it
 * renders. `findNodeHandle` returns a number it is given unchanged, so a number
 * stands in for the native node here.
 */
const scrollComponent = (tag: number) => ({ getScrollableNode: () => tag })

beforeEach(() => {
  runsOnMac.RUNS_ON_MAC = false
  mockUseDirectTouchPanOnly.mockReset()
  mockUseDirectTouchPanOnly.mockResolvedValue(true)
})

describe('on a Mac', () => {
  beforeEach(() => {
    runsOnMac.RUNS_ON_MAC = true
  })

  it('restricts the pan of the scroll view inside the list, not of the list', () => {
    applyDirectTouchPan(scrollComponent(77))

    expect(mockUseDirectTouchPanOnly).toHaveBeenCalledWith(77)
  })

  /** A `ScrollView` is its own scrollable node, so there is nothing to step down to. */
  it('takes the view itself when it has no scrollable node', () => {
    applyDirectTouchPan(12)

    expect(mockUseDirectTouchPanOnly).toHaveBeenCalledWith(12)
  })

  it('applies again every time the ref is called, because Fabric recycles the view', () => {
    directTouchPanRef(scrollComponent(5))
    directTouchPanRef(scrollComponent(5))

    expect(mockUseDirectTouchPanOnly).toHaveBeenCalledTimes(2)
  })

  it('asks for nothing when the ref is being detached', () => {
    directTouchPanRef(null)

    expect(mockUseDirectTouchPanOnly).not.toHaveBeenCalled()
  })

  it('asks for nothing for a component that has no native node yet', () => {
    applyDirectTouchPan({ getScrollableNode: () => null })

    expect(mockUseDirectTouchPanOnly).not.toHaveBeenCalled()
  })
})

/**
 * The gate, and the only one that could not be a hardware question instead: on an
 * iPad with a trackpad a pointer drag is a legitimate way to scroll, so this is
 * about the operating system and not about what is plugged in.
 */
describe('everywhere else', () => {
  it('makes no native call at all on an iPhone or an iPad', () => {
    applyDirectTouchPan(scrollComponent(77))
    directTouchPanRef(scrollComponent(77))

    expect(mockUseDirectTouchPanOnly).not.toHaveBeenCalled()
  })
})

describe('never taking a screen down with it', () => {
  beforeEach(() => {
    runsOnMac.RUNS_ON_MAC = true
  })

  it('swallows a rejected promise, which is what an unresolvable tag looks like', async () => {
    mockUseDirectTouchPanOnly.mockRejectedValue(new Error('view not found'))

    expect(() => applyDirectTouchPan(scrollComponent(9))).not.toThrow()

    // Let the rejection settle: an unhandled one fails the suite on its own.
    await Promise.resolve()
  })

  it('swallows a native call that throws synchronously', () => {
    mockUseDirectTouchPanOnly.mockImplementation(() => {
      throw new Error('no module')
    })

    expect(() => applyDirectTouchPan(scrollComponent(9))).not.toThrow()
  })

  it('swallows a component that throws while being read', () => {
    const hostile = {
      getScrollableNode: () => {
        throw new Error('not mounted')
      }
    }

    expect(() => applyDirectTouchPan(hostile)).not.toThrow()
    expect(() => directTouchPanRef(hostile)).not.toThrow()
  })

  it('reports nothing back, so no caller can come to depend on the answer', () => {
    expect(applyDirectTouchPan(scrollComponent(1))).toBeUndefined()
    expect(directTouchPanRef(scrollComponent(1))).toBeUndefined()
  })
})
