/**
 * The back control for a page that is a ROUTE.
 *
 * Reads the navigator the page is a screen of and answers with the route
 * directly below it: `{ label: <its title>, onPress: goBack }`, or `undefined`
 * when the page is the bottom of its own stack. That last part is deliberate
 * and is why this does not ask `canGoBack()`: a stack nested under another one
 * answers `true` at its own root (the parent can go back), and a Settings root
 * with a back control to whatever the shell pushed it over is exactly the stray
 * back HERM-101 is about. The shell decides what a root's back is, if any.
 *
 * The label is derived, never typed per page: a navigator provides
 * `StackTitleContext` (Settings provides its route registry's titles), so
 * "labelled with the previous page's name" cannot drift from the page the
 * button actually returns to.
 */
import { useNavigation, useNavigationState, useRoute } from '@react-navigation/native'
import { createContext, useContext, useMemo } from 'react'

import type { PageChromeBack } from './PageChrome'

/** Route name → the title a back control names it by. Provided by the navigator's host. */
export const StackTitleContext = createContext<(routeName: string) => string>(routeName => routeName)

/** What a back control needs to know about the page it would return to. */
export interface RouteBelow {
  name: string
  params?: object | undefined
}

/**
 * The route directly under this one in its own navigator, or `undefined` at the
 * bottom of the stack.
 *
 * Split out because two callers label the same thing differently: a Settings
 * page names it from the route registry (`useStackBack` below), while the
 * compact shell's root stack names a chat by the BOT in its params, which no
 * registry of route names can answer. Both read the stack the same way, and
 * they read it here so they cannot disagree about what "below" means.
 *
 * The router's own route object is handed back rather than a `{ name, params }`
 * copy of it, and that is not a detail: `useNavigationState` keeps a selection
 * only while `Object.is` says it is unchanged, so a selector that built a fresh
 * object would report a change on every state notification and re-render every
 * page with a back control.
 */
export function useRouteBelow(): RouteBelow | undefined {
  const route = useRoute()

  return useNavigationState(state => {
    const index = state.routes.findIndex(entry => entry.key === route.key)

    return index > 0 ? state.routes[index - 1] : undefined
  })
}

export function useStackBack(): PageChromeBack | undefined {
  const navigation = useNavigation()
  const titleOf = useContext(StackTitleContext)
  const below = useRouteBelow()?.name

  return useMemo(
    () => (below ? { label: titleOf(below), onPress: () => navigation.goBack() } : undefined),
    [below, navigation, titleOf]
  )
}
