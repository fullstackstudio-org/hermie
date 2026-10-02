/**
 * Settings, whole: the category list, the stack of pages, and the one rule that
 * decides whether they sit side by side.
 *
 * **Split or stacked is a WIDTH, not a shell.** `SETTINGS_SPLIT_MIN_WIDTH` is
 * measured against this host's own box, so a narrow content column on a Mac
 * window behaves like a phone without a second code path, and a collapsed
 * sidebar that gives the column 900pt gets the master-detail layout without
 * anybody being told about it.
 *
 * **Nested or independent is decided here too.** The compact shell renders this
 * inside its own navigator, where the Settings stack is simply a nested one;
 * the wide shell has no navigator at all, so the host wraps itself in an
 * independent tree. A page never knows which it got.
 */
import {
  DefaultTheme,
  NavigationContainer,
  NavigationContext,
  NavigationIndependentTree
} from '@react-navigation/native'
import { useContext, useMemo, useState, type ReactNode } from 'react'
import { View } from 'react-native'

import { strings } from '../../../i18n/strings'
import { PageFrame, type PageChromeBack } from '../../../ui/chrome'
import { useTheme } from '../../../ui/theme'
import { SettingsCategoryList } from './SettingsCategoryList'
import { SettingsHostChromeContext, SettingsScroll } from './SettingsPage'
import { SETTINGS_ROUTE_META } from './route-meta'
import type { SettingsCategoryName, SettingsRouteName } from './route-names'
import { visibleCategories } from './routes'
import { SettingsStack } from './SettingsStack'

/** Past this, the list and the open page sit side by side. */
export const SETTINGS_SPLIT_MIN_WIDTH = 640

/** How wide the list column is when they do. */
const CATEGORY_COLUMN_WIDTH = 300

export interface SettingsHostProps {
  /**
   * Open on one page rather than on the list, with its ancestors under it.
   *
   * Development only (`--hermieOpen overlay:settings/licences`): each of these
   * is behind a tap, and a simulator this machine can only launch cannot tap.
   */
  initialRoute?: SettingsRouteName
  initialParams?: object
  /** What the ROOT's back control is, where the shell has one. A tab root has none. */
  rootBack?: PageChromeBack
  /** The root's trailing action — an overlay's close (X). */
  rootTrailing?: ReactNode
}

/** Which category a route belongs to: walk its parents until one sits under the root. */
function categoryOf(route: SettingsRouteName): SettingsCategoryName | null {
  let at: SettingsRouteName | null = route

  while (at && at !== 'Root') {
    if (SETTINGS_ROUTE_META[at].parent === 'Root') {
      return at as SettingsCategoryName
    }

    at = SETTINGS_ROUTE_META[at].parent
  }

  return null
}

export function SettingsHost({ initialRoute, initialParams, rootBack, rootTrailing }: SettingsHostProps) {
  const theme = useTheme()
  const parentNavigator = useContext(NavigationContext)
  const [width, setWidth] = useState(0)
  const [picked, setPicked] = useState<SettingsCategoryName | null>(null)
  const split = width >= SETTINGS_SPLIT_MIN_WIDTH
  const chrome = useMemo(
    () => ({ ...(rootBack ? { rootBack } : {}), ...(rootTrailing ? { rootTrailing } : {}) }),
    [rootBack, rootTrailing]
  )

  /*
    The split layout's stack has no root page, so it starts ON a category: the
    one the reader last picked, the one a dev intent asked for, or the first in
    the list.
  */
  const category = picked ?? (initialRoute ? categoryOf(initialRoute) : null) ?? visibleCategories()[0] ?? 'Account'
  const deep = initialRoute && !picked && categoryOf(initialRoute) === category ? initialRoute : category

  const navigation = useMemo(
    () => ({
      ...(split
        ? { initialRoute: deep, withRoot: false }
        : { ...(initialRoute ? { initialRoute } : {}), withRoot: true }),
      ...(initialParams && (split ? deep === initialRoute : true) ? { initialParams } : {})
    }),
    [deep, initialParams, initialRoute, split]
  )

  // Picking a category REPLACES the stack rather than pushing onto it; the
  // stack does that itself, as a `reset`, because a remount would not (see
  // `SettingsStack`). The key only separates the two LAYOUTS, which really are
  // different stacks: one has the category list at the bottom and one does not.
  const stack = <SettingsStack key={split ? 'split' : 'stacked'} {...navigation} />

  const body = split ? (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <View
        style={{
          borderRightColor: theme.hairline,
          borderRightWidth: 1,
          width: CATEGORY_COLUMN_WIDTH
        }}
        testID="settings-category-column"
      >
        <PageFrame
          {...(rootBack ? { back: rootBack } : {})}
          {...(rootTrailing ? { trailing: rootTrailing } : {})}
          title={strings.settings.title}
        >
          <SettingsScroll>
            {/*
              The sidebar shape: a search field, the account row, and the
              categories as free-standing rows with the open one filled. The
              phone's own list is the same component in its `grouped` shape —
              see `SettingsCategoryList`.
            */}
            <SettingsCategoryList current={category} onPick={setPicked} variant="sidebar" />
          </SettingsScroll>
        </PageFrame>
      </View>
      <View style={{ flex: 1 }}>{stack}</View>
    </View>
  ) : (
    stack
  )

  return (
    <SettingsHostChromeContext.Provider value={chrome}>
      <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1 }} testID="settings-host">
        {parentNavigator ? (
          body
        ) : (
          /*
            No navigator above us — the wide shell draws Settings in a panel or a
            column of its own. An independent tree gives the stack the container
            it needs without pretending to be the app's only one; the document
            title is off for the reason `CompactShell` switches it off, and the
            theme's background is transparent so the panel's glass shows through.
          */
          <NavigationIndependentTree>
            <NavigationContainer
              documentTitle={{ enabled: false }}
              theme={{ ...DefaultTheme, colors: { ...DefaultTheme.colors, background: 'transparent' } }}
            >
              {body}
            </NavigationContainer>
          </NavigationIndependentTree>
        )}
      </View>
    </SettingsHostChromeContext.Provider>
  )
}
