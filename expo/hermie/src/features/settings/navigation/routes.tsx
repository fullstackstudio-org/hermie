/**
 * The Settings routes: what each one is called, where it sits, and what draws it.
 *
 * One table, and everything else reads it — the navigator declares its screens
 * from here, a back control is labelled from here, the dev launch intent
 * resolves a page name against it, and `settings-routes.test.tsx` WALKS it: for
 * every route with a parent it navigates there, presses the one `page-back` and
 * asserts it landed on the parent. A page added to `SettingsParamList` without
 * an entry here does not compile, and one added here without a working back
 * does not pass.
 */
import type { ComponentType } from 'react'

import * as About from '../categories/About'
import * as Account from '../categories/Account'
import * as Advanced from '../categories/Advanced'
import * as Appearance from '../categories/Appearance'
import * as Capabilities from '../categories/Capabilities'
import * as ChatsMessages from '../categories/ChatsMessages'
import * as Gateways from '../categories/Gateways'
import * as Memory from '../categories/Memory'
import * as Notifications from '../categories/Notifications'
import * as Privacy from '../categories/Privacy'
import * as Theme from '../categories/Theme'
import * as Voice from '../categories/Voice'
import { GatewayAddPage, GatewayDetailPage } from '../GatewaysScreen'
import { LicencesPage } from './LicencesPage'
import { LockThresholdPage } from './LockThresholdPage'
import { isSettingsRouteVisible, SETTINGS_ROUTE_META, type SettingsRouteMeta } from './route-meta'
import { SETTINGS_CATEGORIES, type SettingsCategoryName, type SettingsRouteName } from './route-names'
import { SettingsRoot } from './SettingsRoot'

export interface SettingsRoute extends SettingsRouteMeta {
  component: ComponentType<Record<string, never>>
}

const COMPONENTS: Record<SettingsRouteName, ComponentType<Record<string, never>>> = {
  Root: SettingsRoot,

  Account: Account.Page,

  Gateways: Gateways.Page,
  GatewayDetail: GatewayDetailPage,
  GatewayAdd: GatewayAddPage,

  ChatsMessages: ChatsMessages.Page,
  Notifications: Notifications.Page,

  Memory: Memory.Page,
  MemoryBot: Memory.BotPage,

  Appearance: Appearance.Page,
  Theme: Theme.Page,
  ThemeEdit: Theme.EditPage,

  Privacy: Privacy.Page,
  LockThreshold: LockThresholdPage,
  Voice: Voice.Page,

  Capabilities: Capabilities.Page,
  Skills: Capabilities.SkillsPage,
  Mcp: Capabilities.McpPage,
  McpServer: Capabilities.McpServerPage,
  Connectors: Capabilities.ConnectorsPage,
  Connector: Capabilities.ConnectorPage,
  Boards: Capabilities.BoardsPage,

  Advanced: Advanced.Page,
  ConnectionTest: Advanced.ConnectionTestPage,
  Gallery: Advanced.GalleryPage,

  About: About.Page,
  Licences: LicencesPage
}

export const SETTINGS_ROUTES = Object.fromEntries(
  (Object.keys(COMPONENTS) as SettingsRouteName[]).map(name => [
    name,
    { ...SETTINGS_ROUTE_META[name], component: COMPONENTS[name] }
  ])
) as Record<SettingsRouteName, SettingsRoute>

/**
 * Every route this build actually has, in registry order.
 *
 * What the stack registers screens from — a route hidden on Hermie Web
 * (`isSettingsRouteVisible`) gets no screen there, so it cannot be navigated
 * to even by something that still names it, such as a stale dev launch intent.
 */
export function visibleSettingsRouteNames(): SettingsRouteName[] {
  return (Object.keys(SETTINGS_ROUTES) as SettingsRouteName[]).filter(isSettingsRouteVisible)
}

/**
 * What a category DOES, as opposed to what it looks like.
 *
 * The mark, the colour and the one-sentence description live in
 * `category-look.ts` instead of here, and that split is not tidiness: a category
 * PAGE draws its own mark on its header card, and a page cannot read this table —
 * `routes.tsx` imports every page, so the other direction is a cycle. Same reason
 * `route-meta.ts` holds the titles.
 */
export interface SettingsCategory {
  /** One line of where this category STANDS, read from the stores it owns. */
  useSummary: () => string
  /** `undefined` where the category is always there. Static: no hook, no store. */
  visible?: () => boolean
}

const CATEGORIES: Record<SettingsCategoryName, SettingsCategory> = {
  Account: { useSummary: Account.useSummary },
  Gateways: { useSummary: Gateways.useSummary },
  ChatsMessages: { useSummary: ChatsMessages.useSummary },
  Notifications: { useSummary: Notifications.useSummary },
  Memory: { useSummary: Memory.useSummary },
  Appearance: { useSummary: Appearance.useSummary },
  Privacy: { useSummary: Privacy.useSummary },
  Voice: { useSummary: Voice.useSummary, visible: Voice.isVoiceAvailable },
  Capabilities: { useSummary: Capabilities.useSummary },
  Advanced: { useSummary: Advanced.useSummary, visible: Advanced.isAdvancedVisible },
  About: { useSummary: About.useSummary }
}

export const settingsCategory = (name: SettingsCategoryName): SettingsCategory => CATEGORIES[name]

/**
 * The categories this build shows, in list order.
 *
 * Grouped the way the list draws them, so that hiding one (no voice on this
 * platform, no Advanced in a release build) cannot leave a group with a divider
 * and nothing under it.
 */
const GROUPS: readonly (readonly SettingsCategoryName[])[] = [
  ['Account', 'Gateways'],
  ['ChatsMessages', 'Notifications', 'Memory'],
  ['Appearance', 'Privacy', 'Voice'],
  ['Capabilities'],
  ['Advanced', 'About']
]

export function visibleCategoryGroups(): SettingsCategoryName[][] {
  return GROUPS.map(group => group.filter(name => CATEGORIES[name].visible?.() !== false)).filter(
    group => group.length > 0
  )
}

/** Every category this build shows, flat — what the list and the split column walk. */
export function visibleCategories(): SettingsCategoryName[] {
  return SETTINGS_CATEGORIES.filter(name => CATEGORIES[name].visible?.() !== false)
}
