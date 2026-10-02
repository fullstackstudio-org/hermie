/**
 * Settings as a native stack.
 *
 * Container-agnostic on purpose: this is a navigator and nothing else, so the
 * compact shell can nest it under its Settings tab while the wide shell wraps
 * it in an independent tree — see `SettingsHost`. Every screen comes from
 * `SETTINGS_ROUTES`, `headerShown` is off everywhere (each page draws its own
 * `PageChrome`), and the content is transparent so a page inside a glass panel
 * is the panel's own material rather than a white card over it.
 */
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { CommonActions, useNavigation } from '@react-navigation/native'
import { createContext, useContext, useEffect, useMemo, useRef, type ComponentType } from 'react'
import { View } from 'react-native'

import { StackTitleContext } from '../../../ui/chrome'
import { useGlassDepth } from '../../../ui/glass'
import { settingsChain, settingsTitle } from './route-meta'
import type { SettingsParamList, SettingsRouteName } from './route-names'
import { SETTINGS_ROUTES, visibleSettingsRouteNames } from './routes'

const Stack = createNativeStackNavigator<SettingsParamList>()

/**
 * The stack this navigator should be showing, dispatched as one `reset`.
 *
 * Two jobs, and they are the same job. A navigator takes an `initialRouteName`
 * and not a whole stack, so `--hermieOpen overlay:settings/licences` would open
 * a page whose back button has nowhere to go; the chain — Root → About →
 * Licences, from the registry's `parent` links — is reset in on mount instead.
 * And on the split layout, picking a category has to REPLACE the stack: a
 * remount would not do it, because the container keeps the state of a navigator
 * with the same screens and hands it straight back.
 *
 * Whichever mounted screen's effect runs first performs it, and `done` is what
 * stops the second one repeating it.
 */
interface PendingChain {
  routes: { name: SettingsRouteName; params?: object }[]
  done: boolean
}

/** `key` changes when a different stack is wanted, which is what re-runs the effect. */
const ChainContext = createContext<{ chain: { current: PendingChain | null }; key: string }>({
  chain: { current: null },
  key: ''
})

export interface SettingsStackProps {
  /** Where to open. Its ancestors are pushed under it, so back works from the start. */
  initialRoute?: SettingsRouteName
  initialParams?: object
  /**
   * Whether the category list is a page in this stack. `false` on the split
   * layout, where the list is a column beside it and the first category is the
   * bottom of the stack.
   */
  withRoot?: boolean
}

export function SettingsStack({ initialRoute = 'Root', initialParams, withRoot = true }: SettingsStackProps) {
  const inPanel = useGlassDepth() > 0
  const chain = useRef<PendingChain | null>(null)
  const applied = useRef<string | null>(null)
  const names = useMemo(() => visibleSettingsRouteNames(), [])
  const route = settingsChain(initialRoute, { withRoot })
  const bottom = route[0] ?? 'Root'
  const key = route.join('>')

  // Rebuilt when a DIFFERENT stack is asked for and not on every render, so a
  // reader who pushed a page does not have it reset out from under them by the
  // host re-rendering for something else entirely.
  if (applied.current !== key) {
    /*
      Nothing to do on the FIRST render of a stack that is one page deep:
      `initialRouteName` already opens it there. Every later change is a
      different stack than the one on screen — the split layout picking another
      category — and has to be reset in however short it is.
    */
    const first = applied.current === null

    applied.current = key
    chain.current = {
      done: first && route.length < 2,
      routes: route.map(name => (name === initialRoute && initialParams ? { name, params: initialParams } : { name }))
    }
  }

  const pending = useMemo(() => ({ chain, key }), [key])

  return (
    <StackTitleContext.Provider value={settingsTitle}>
      <ChainContext.Provider value={pending}>
        <Stack.Navigator
          initialRouteName={bottom}
          screenOptions={{
            // A page inside a glass panel would otherwise slide in over the one
            // below it with both readable through each other: transparent cards
            // cross-fade instead of sliding. At depth 0 `Screen` paints an
            // opaque floor, so the ordinary push is what happens there.
            ...(inPanel ? ({ animation: 'fade' } as const) : {}),
            contentStyle: { backgroundColor: 'transparent' },
            headerShown: false
          }}
        >
          {names.map(name => (
            <Stack.Screen
              component={screenFor(name)}
              key={name}
              name={name}
              {...(name === initialRoute && initialParams ? { initialParams: initialParams as never } : {})}
            />
          ))}
        </Stack.Navigator>
      </ChainContext.Provider>
    </StackTitleContext.Provider>
  )
}

/** Memoised per route name: a fresh component type per render would remount the page. */
const SCREENS = new Map<SettingsRouteName, ComponentType<object>>()

function screenFor(name: SettingsRouteName): ComponentType<object> {
  const known = SCREENS.get(name)

  if (known) {
    return known
  }

  const Page = SETTINGS_ROUTES[name].component

  /*
    The wrapper is what the route walk finds a page by (`settings-page-<Name>`),
    and where a deep entry point's stack is seeded. Both belong here rather than
    in the pages: a page should not know how it was reached.
  */
  function Screen() {
    const { chain, key } = useContext(ChainContext)
    const navigation = useNavigation()

    useEffect(() => {
      const pending = chain.current

      if (!pending || pending.done) {
        return
      }

      pending.done = true
      navigation.dispatch(CommonActions.reset({ index: pending.routes.length - 1, routes: pending.routes as never[] }))
      // `key` is the dependency that matters: it changes when a different stack
      // is wanted, which is the only time this should run again.
    }, [chain, key, navigation])

    return (
      <View style={{ flex: 1 }} testID={`settings-page-${name}`}>
        <Page />
      </View>
    )
  }

  Screen.displayName = `SettingsScreen(${name})`
  SCREENS.set(name, Screen)

  return Screen
}
