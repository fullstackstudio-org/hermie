/**
 * On a Mac, a mouse drag must select text — not scroll the list under it.
 *
 * A "Designed for iPad" app gets full pointer support, and UIKit delivers an
 * indirect-pointer drag to a `UIScrollView` as a touch. `panGestureRecognizer`
 * accepts every touch type by default, so press-and-drag anywhere on the
 * transcript pans it, which is the owner's complaint: he wants to sweep across a
 * reply and get a selection, and he gets a scroll.
 *
 * The local module narrows that one recognizer to DIRECT touches. A finger still
 * pans (an iPad in Sidecar, a touch display), and a wheel or a trackpad
 * two-finger scroll is not a touch at all — it arrives as a scroll event gated by
 * `allowedScrollTypesMask`, which nothing here changes. So scrolling keeps
 * working the way everybody actually scrolls, and only the drag stops.
 *
 * Three guards, because this runs from a `ref` callback during layout and a
 * broken reading surface would be far worse than an unfixed drag:
 *
 * - **`RUNS_ON_MAC` first.** An iPhone and an iPad are untouched, and on an iPad
 *   with a Magic Trackpad a pointer drag is a legitimate way to scroll. This is
 *   the one Mac-only behaviour in the app that a hardware question could not
 *   answer instead.
 * - **The native call is optional and awaited loosely.** A missing module, an
 *   older binary or a tag the view registry cannot resolve all read as "not
 *   applied" rather than as a failure.
 * - **Nothing throws, ever.** Both the synchronous path and the promise are
 *   swallowed.
 *
 * What this does NOT do is make a drag select text. See the 2026-09-20 section of
 * docs/platform-notes.md: React Native's `Text selectable` gives a long-press
 * edit menu and a whole-block copy, not a selectable range, so the two halves of
 * the owner's request have different ceilings. This is the half that works.
 */
import { requireOptionalNativeModule } from 'expo'
import { findNodeHandle } from 'react-native'

import { RUNS_ON_MAC } from './runs-on-mac'

type PointerDragModule = {
  useDirectTouchPanOnly?: (viewTag: number) => Promise<boolean>
}

/** A React Native scroll component: `ScrollView`, `FlatList`, `SectionList`. */
type ScrollComponent = { getScrollableNode?: () => unknown }

// A registry read, not a load: calling it twice hands back the same object.
function nativeModule(): PointerDragModule | null {
  try {
    return requireOptionalNativeModule<PointerDragModule>('HermieMac')
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return null
  }
}

const mac = nativeModule()

/**
 * The view tag of the scroll view inside a scroll component.
 *
 * `getScrollableNode()` is the documented way down from a `FlatList` or a
 * `SectionList` to the `ScrollView` it renders; a plain `ScrollView` answers it
 * too. Without that step the tag would be the list wrapper's, and the native
 * side would have to guess how far down to look.
 */
function scrollViewTag(view: unknown): number | null {
  if (!view) {
    return null
  }

  const node = (view as ScrollComponent).getScrollableNode?.() ?? view
  const tag = findNodeHandle(node as Parameters<typeof findNodeHandle>[0])

  return typeof tag === 'number' ? tag : null
}

/**
 * Stop a pointer drag panning this scroll view. A no-op everywhere but a Mac.
 *
 * Safe to call with anything, including `null` and a component that has not been
 * laid out yet, and safe to call more than once — the native side sets the same
 * value on the same recognizer.
 */
export function applyDirectTouchPan(view: unknown): void {
  if (!RUNS_ON_MAC) {
    return
  }

  try {
    const tag = scrollViewTag(view)

    if (tag === null) {
      return
    }

    void mac?.useDirectTouchPanOnly?.(tag)?.catch(() => {
      // A tag the view registry cannot resolve is not an error worth surfacing:
      // the drag keeps scrolling, which is what it did before this existed.
    })
  } catch {
    // Reading a react tag off a half-mounted component must never take a screen
    // down with it.
  }
}

/**
 * The `ref` for a scroll view that should not pan under a pointer.
 *
 * Written as a plain function rather than a hook so it can be used as
 * `ref={directTouchPanRef}` on a component that has no ref of its own, with no
 * per-render identity to stabilise. A component that already holds a ref calls
 * `applyDirectTouchPan` from its own effect instead.
 *
 * Fabric recycles a scroll component's native view, so a view mounted into this
 * list may arrive carrying another list's recognizer settings. Re-applying on
 * every `ref` call is what makes that harmless.
 */
export const directTouchPanRef = (view: unknown): void => applyDirectTouchPan(view)
