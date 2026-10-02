/**
 * The scroll props a page's list needs to run under `PageChrome`.
 *
 * One hook, so no page computes this for itself — see the Architecture
 * Decisions in `settings-navigation.md`. It reads the chrome's own measured
 * height off the context `PageChrome` provides, so a caller never threads the
 * number through by hand and never drifts from whatever the header actually
 * measures at (a subtitle showing or not, a bigger Dynamic Type setting).
 *
 * The platform split is real, not decorative:
 *
 *  - **iOS and Mac** (the Mac build is the same `Platform.OS === 'ios'` binary,
 *    "Designed for iPad" — see `platform/runs-on-mac.ts`) get `contentInset`.
 *    React Native offsets a `ScrollView`'s sticky-header animated value by
 *    `contentInset.top`, which is the only lever that keeps a sticky section
 *    header (Activity's "TODAY", say) stopping under the glass instead of
 *    sliding out from behind it. `contentOffset` starts the list scrolled up by
 *    the same amount, so the FIRST frame already sits under the header instead
 *    of drawing one frame too high and correcting itself.
 *  - **Android and web** get `contentContainerStyle.paddingTop` instead.
 *    Neither platform gives `contentInset` the sticky-header behaviour above, so
 *    padding the content is the honest answer rather than a prop that would
 *    silently do nothing — `docs/platform-notes.md` records the trade-off: a
 *    sticky header there slides under the glass rather than stopping at it.
 *
 * `scrollIndicatorInsets` follows the same top offset on every platform. It is
 * an iOS-only `ScrollView` prop and RN ignores it elsewhere, which is why it is
 * safe to hand back unconditionally rather than branching a second time.
 */
import { Platform } from 'react-native'

import { usePageChromeHeight } from './PageChrome'

export interface PageScrollProps {
  contentInset?: { top: number }
  contentOffset?: { x: number; y: number }
  scrollIndicatorInsets?: { top: number }
  contentContainerStyle?: { paddingTop: number }
}

/** The platform split on its own, for a caller (or a test) that already has the height. */
export function pageScrollProps(headerHeight: number): PageScrollProps {
  const insets = { top: headerHeight }

  if (Platform.OS === 'ios') {
    return {
      contentInset: insets,
      contentOffset: { x: 0, y: -headerHeight },
      scrollIndicatorInsets: insets
    }
  }

  return {
    contentContainerStyle: { paddingTop: headerHeight },
    scrollIndicatorInsets: insets
  }
}

/**
 * The context-aware form, for a page that renders under a `PageChrome` and
 * wants the height it measured rather than a number of its own.
 *
 * Takes the height explicitly as a fallback path too — a caller that already
 * has the number (a test, or a layout that measures its own chrome) is not
 * made to thread it through a `PageChrome` it may not even be rendering.
 */
export function usePageScroll(headerHeight?: number): PageScrollProps {
  const measured = usePageChromeHeight()

  return pageScrollProps(headerHeight ?? measured)
}
