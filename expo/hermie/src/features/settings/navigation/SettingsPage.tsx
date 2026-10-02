/**
 * One Settings page: `PageFrame` with the route's own title and the ONE back
 * control the route is entitled to.
 *
 * A page never decides its back for itself. `useSettingsBack` asks the stack
 * (`useStackBack`: the route below, labelled with its registry title) and only
 * the stack's own root falls back to what the SHELL handed the host — nothing
 * on a tab root, a close on an overlay. That is the whole of HERM-101's fix
 * for Settings: a page cannot forget its back button, and cannot grow a second
 * one, because it never draws one.
 */
import { createContext, useContext, type ReactNode } from 'react'
import { ScrollView, View, type ScrollViewProps } from 'react-native'

import { directTouchPanRef } from '../../../platform/pointer-drag'
import { PageFrame, useFramedScroll, useStackBack, type PageChromeBack } from '../../../ui/chrome'
import { useTheme } from '../../../ui/theme'
import { FORM_MAX_WIDTH } from '../../../ui/tokens'
import { isSettingsCategory } from './category-look'
import { CategoryHeaderCard } from './CategoryHeaderCard'
import { settingsTitle } from './route-meta'
import type { SettingsRouteName } from './route-names'

export interface SettingsHostChrome {
  /** The back control of the stack's own root, when the shell has one to give. */
  rootBack?: PageChromeBack
  /** The trailing action of the root — a close on a shell that shows Settings as a panel. */
  rootTrailing?: ReactNode
}

export const SettingsHostChromeContext = createContext<SettingsHostChrome>({})

/** The back control a Settings route draws: the stack's, or the shell's at the root. */
export function useSettingsBack(route: SettingsRouteName): PageChromeBack | undefined {
  const stack = useStackBack()
  const host = useContext(SettingsHostChromeContext)

  if (stack) {
    return stack
  }

  return route === 'Root' ? host.rootBack : undefined
}

export interface SettingsPageProps {
  route: SettingsRouteName
  /** Overrides the registry title — a gateway's own name on its page, say. */
  title?: string
  subtitle?: string
  trailing?: ReactNode
  /**
   * `false` when the page brings its own scroller. The default wraps the
   * content in the form-width column every Settings page uses.
   */
  scroll?: boolean
  children: ReactNode
}

export function SettingsPage({ route, title, subtitle, trailing, scroll = true, children }: SettingsPageProps) {
  const back = useSettingsBack(route)
  const host = useContext(SettingsHostChromeContext)
  /*
    A CATEGORY page opens with a header card — the mark, the name and one
    sentence — and the card is the page's heading, so the bar above it draws none.
    A page with a `title` of its own is not a category page (a gateway's own name
    on `GatewayDetail`), and neither is anything deeper in the stack: those keep
    the centred title they have always had.

    The back control is not affected in either case. It belongs to the route and
    the chrome draws exactly one, which is what `settings-routes.test.tsx` walks.
  */
  const category = title === undefined && isSettingsCategory(route) ? route : null

  return (
    <PageFrame
      {...(back ? { back } : {})}
      {...(subtitle ? { subtitle } : {})}
      title={title ?? settingsTitle(route)}
      {...(category ? { titleHidden: true } : {})}
      {...(trailing ? { trailing } : route === 'Root' && host.rootTrailing ? { trailing: host.rootTrailing } : {})}
    >
      {scroll ? (
        <SettingsScroll>
          {category ? <CategoryHeaderCard category={category} /> : null}
          {children}
        </SettingsScroll>
      ) : (
        children
      )}
    </PageFrame>
  )
}

/**
 * The column every Settings page scrolls in: centred, capped at the form width,
 * and running under the chrome through `useFramedScroll`.
 */
export function SettingsScroll({ children, ...rest }: { children: ReactNode } & Omit<ScrollViewProps, 'children'>) {
  const theme = useTheme()
  const scroll = useFramedScroll(theme.space.lg)

  return (
    <ScrollView
      ref={directTouchPanRef}
      {...scroll.props}
      {...rest}
      contentContainerStyle={{
        alignSelf: 'center',
        gap: theme.space.xl,
        maxWidth: FORM_MAX_WIDTH,
        padding: theme.space.lg,
        paddingTop: scroll.paddingTop,
        width: '100%'
      }}
    >
      {children}
      <View style={{ height: theme.space.xxl }} />
    </ScrollView>
  )
}
