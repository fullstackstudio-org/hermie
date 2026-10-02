/**
 * A bottom-tab navigator, built on React Navigation's own `TabRouter`.
 *
 * ## Why this is here rather than `@react-navigation/bottom-tabs`
 *
 * The Architecture Decisions call for a bottom-tab NAVIGATOR on the compact
 * shell, because "a tab root has no back button" is only reachable with a tab
 * bar on every root. What they do not call for is that package's view layer: the
 * plan replaces its `tabBar` with one of our own (`TabBar`), its header with
 * `PageChrome` (`headerShown: false` everywhere), and its animations with none.
 * What is left of `bottom-tabs` once all three are switched off is a `TabRouter`
 * and a lazy container, which is what this file is — about eighty lines against
 * a dependency, its peer requirements and a second copy of the routing rules.
 *
 * Everything that makes it a real navigator comes from React Navigation itself:
 * `TabRouter` owns the state, `useNavigationBuilder` owns the descriptors, focus
 * events and the helpers, so `useIsFocused`, `useFocusEffect`,
 * `getFocusedRouteNameFromRoute`, nested navigators and Android's back button
 * behave exactly as they would under the packaged navigator.
 *
 * ## Back, and what the OS does with it
 *
 * `backBehavior` defaults to `initialRoute` rather than the router's own
 * `firstRoute`, and the difference is the whole of the launch-argument case: with
 * `--hermieOpen overlay:settings` the Settings tab IS the initial route, so its
 * history is one entry deep, `GO_BACK` answers `null`, `canGoBack()` is false and
 * the press reaches the OS — which backgrounds the app, as a back press on a
 * launch destination should. Under `firstRoute` the same press would silently
 * jump to a Chats tab the reader never opened.
 *
 * ## Lazy, and mounted for good
 *
 * A tab is mounted the first time it is focused and stays mounted, hidden with
 * `display: 'none'`. That is what makes a tab keep its scroll position, its
 * Settings sub-stack and its in-flight loads while the reader is on another one,
 * and it is why the chat list does not pay for the Crons poll until somebody
 * opens Crons.
 */
import {
  createNavigatorFactory,
  TabRouter,
  useNavigationBuilder,
  type DefaultNavigatorOptions,
  type ParamListBase,
  type TabActionHelpers,
  type TabNavigationState,
  type TabRouterOptions
} from '@react-navigation/native'
import { useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'

import { useSafeAreaInsets } from '../../platform/safe-area'

/** Per-screen options. The bar is drawn from the shell's own list, so there are none yet. */
export type TabScreenOptions = Record<string, never>

/** No events beyond the core `focus`/`blur`/`state` that every navigator emits. */
type TabEventMap = Record<string, never>

export interface TabBarRenderProps {
  /** The focused tab's route NAME. */
  current: string
  /** Every tab's route name, in the order the screens were declared. */
  names: string[]
  /** Jump to a tab by route name. */
  onSelect: (name: string) => void
}

export type TabNavigatorProps = DefaultNavigatorOptions<
  ParamListBase,
  string | undefined,
  TabNavigationState<ParamListBase>,
  TabScreenOptions,
  TabEventMap,
  unknown
> &
  TabRouterOptions & {
    /** Draws the bar. Given the focused tab and a way to change it, nothing else. */
    tabBar: (props: TabBarRenderProps) => ReactNode
  }

function TabNavigator({ tabBar, ...options }: TabNavigatorProps) {
  const { state, descriptors, navigation, NavigationContent } = useNavigationBuilder<
    TabNavigationState<ParamListBase>,
    TabRouterOptions,
    TabActionHelpers<ParamListBase>,
    TabScreenOptions,
    TabEventMap
  >(TabRouter, { ...options, backBehavior: options.backBehavior ?? 'initialRoute' })

  const insets = useSafeAreaInsets()
  const focused = state.routes[state.index]
  const [loaded, setLoaded] = useState<string[]>(() => (focused ? [focused.key] : []))

  /*
    The bar stands on the home indicator, so the screens above it do not.

    Every page in this app pads the window's own safe area itself (`Screen`), and
    a tab screen's bottom edge is no longer the window's — it is the top of the
    bar. Without this a page would reserve the home indicator's height a second
    time, leaving a 34pt band of wallpaper between the content and the glass.
    The bar is rendered OUTSIDE this provider and keeps the real inset.
  */
  const screenInsets = useMemo(() => ({ ...insets, bottom: 0 }), [insets])

  // Adjusting state during render, which is React's own answer for "derive from
  // props": a tab that has just been focused has to render on THIS pass, and an
  // effect would draw one empty frame first.
  if (focused && !loaded.includes(focused.key)) {
    setLoaded([...loaded, focused.key])
  }

  return (
    <NavigationContent>
      <View style={{ flex: 1 }} testID="tabs">
        {/*
          Every mounted tab fills this box and all but one are `display: 'none'`
          — not unmounted, so a tab keeps its scroll position and its own
          sub-stack, and not merely transparent, so a hidden tab costs no paint.
        */}
        <SafeAreaInsetsContext.Provider value={screenInsets}>
          <View style={{ flex: 1 }}>
            {state.routes.map((route, index) => {
              const descriptor = descriptors[route.key]

              if (!descriptor || !loaded.includes(route.key)) {
                return null
              }

              const isFocused = index === state.index

              return (
                <View
                  accessibilityElementsHidden={!isFocused}
                  importantForAccessibility={isFocused ? 'auto' : 'no-hide-descendants'}
                  key={route.key}
                  style={[StyleSheet.absoluteFill, { display: isFocused ? 'flex' : 'none' }]}
                >
                  {descriptor.render()}
                </View>
              )
            })}
          </View>
        </SafeAreaInsetsContext.Provider>

        {tabBar({
          current: focused?.name ?? '',
          names: state.routeNames,
          onSelect: name => navigation.navigate(name)
        })}
      </View>
    </NavigationContent>
  )
}

export interface TabScreenProps<ParamList extends ParamListBase> {
  name: Extract<keyof ParamList, string>
  component: ComponentType
  options?: TabScreenOptions
}

export interface TabNavigatorComponents<ParamList extends ParamListBase> {
  Navigator: ComponentType<TabNavigatorProps>
  Screen: ComponentType<TabScreenProps<ParamList>>
}

const factory = createNavigatorFactory(TabNavigator) as () => TabNavigatorComponents<ParamListBase>

/**
 * `Navigator` and `Screen`, the pair every React Navigation navigator is used
 * through. Typed on the caller's own param list, exactly as
 * `createNativeStackNavigator` is.
 */
export function createTabNavigator<ParamList extends ParamListBase>(): TabNavigatorComponents<ParamList> {
  return factory() as unknown as TabNavigatorComponents<ParamList>
}
