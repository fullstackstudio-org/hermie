/**
 * A whole page under `PageChrome`: the screen, the content, and the header
 * floating over it — with the header's measured height handed to the CONTENT.
 *
 * `PageChrome` measures itself, but the context it provides reaches only its
 * own subtree, and a page's list is a sibling of the header rather than a child
 * of it. This frame closes that gap: the chrome reports its height up through
 * `PageChromeReportContext`, and the frame provides it to everything inside, so
 * a list anywhere in `children` can call `usePageScroll()` (or
 * `useFramedScroll()`) and get the right inset without threading a number.
 *
 * The content is laid out in a plain `flex: 1` view with the chrome as its last
 * child: last, so it draws on top of whatever scrolls under it, and inside a
 * view of its own rather than directly in `Screen`, so the chrome's
 * `top: 0` is the top of the page's content box — under the status bar that
 * `Screen` already pads for — rather than the top of the window.
 */
import { useState, type ReactNode, type Ref } from 'react'
import { ScrollView, StyleSheet, View, type ScrollViewProps } from 'react-native'

import { Screen } from '../primitives/Screen'
import {
  PageChrome,
  PageChromeHeightContext,
  PageChromeReportContext,
  usePageChromeHeight,
  type PageChromeProps
} from './PageChrome'
import { usePageScroll, type PageScrollProps } from './usePageScroll'

export interface PageFrameProps extends PageChromeProps {
  children: ReactNode
}

export function PageFrame({ children, ...chrome }: PageFrameProps) {
  const [height, setHeight] = useState(0)

  return (
    <Screen padded={false}>
      <PageChromeReportContext.Provider value={setHeight}>
        <PageChromeHeightContext.Provider value={height}>
          <View style={{ flex: 1 }}>
            {children}
            <PageChrome {...chrome} />
          </View>
        </PageChromeHeightContext.Provider>
      </PageChromeReportContext.Provider>
    </Screen>
  )
}

export interface FramedScroll {
  /** Spread onto the `ScrollView`: the inset, offset and indicator props. */
  props: Omit<PageScrollProps, 'contentContainerStyle'>
  /**
   * The content's top padding: the header's height where the platform pads
   * rather than insets (Android, web), plus the page's own `gap`.
   */
  paddingTop: number
}

/**
 * `usePageScroll`, for a list whose content container already has padding of
 * its own.
 *
 * `usePageScroll` hands Android and web a `contentContainerStyle` whose only
 * key is `paddingTop`, which would REPLACE a page's `padding: space.lg` on that
 * one side rather than add to it. This keeps the two apart: the scroll props go
 * on the view, and the caller puts `paddingTop` into its own style.
 */
export function useFramedScroll(gap = 0): FramedScroll {
  const { contentContainerStyle, ...props } = usePageScroll()

  return { props, paddingTop: (contentContainerStyle?.paddingTop ?? 0) + gap }
}

/**
 * Empty space exactly as tall as the chrome, for content that does not scroll
 * under it — a tab strip pinned at the top of a page, a board whose columns
 * scroll sideways. It keeps the first thing on the page out from behind the
 * glass without the page having to know how tall the glass is.
 */
export function PageChromeSpacer({ testID = 'page-chrome-spacer' }: { testID?: string } = {}) {
  return <View style={{ height: usePageChromeHeight() }} testID={testID} />
}

/**
 * A `ScrollView` that runs under the chrome, for a page that already has a
 * scroller with a style of its own.
 *
 * The caller's `contentContainerStyle` is kept as written; only its top padding
 * grows by what the platform needs — the header's height on Android and web,
 * nothing on iOS, where `contentInset` does the job — so a page that pads its
 * content by `space.lg` keeps exactly that gap under the glass.
 */
export function PageScrollView({ contentContainerStyle, ref, ...rest }: ScrollViewProps & { ref?: Ref<ScrollView> }) {
  const { contentContainerStyle: inset, ...scroll } = usePageScroll()
  const flat = StyleSheet.flatten(contentContainerStyle) ?? {}
  const own = flat.paddingTop ?? flat.paddingVertical ?? flat.padding ?? 0

  return (
    <ScrollView
      ref={ref}
      {...scroll}
      {...rest}
      contentContainerStyle={[flat, { paddingTop: (inset?.paddingTop ?? 0) + (typeof own === 'number' ? own : 0) }]}
    />
  )
}
