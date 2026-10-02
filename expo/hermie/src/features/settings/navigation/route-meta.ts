/**
 * What each Settings route is CALLED and where it sits, without the page itself.
 *
 * The page components live in `routes.tsx`. The split exists because a page
 * needs its own title and its parent's (the back label), and a page importing
 * the registry that imports the page would be a cycle.
 *
 * `parent` is required on every entry — `null` only for `Root` — so a route
 * without one does not compile. It is what `settings-routes.test.tsx` walks: a
 * route's back control must be labelled with its parent's title and must land
 * on its parent.
 */
import { WEB_GATEWAY_BASE_URL } from '../../../gateway/web-config'
import { strings } from '../../../i18n/strings'
import { connectorStrings } from '../../connectors/strings'
import { kanbanStrings } from '../../kanban/strings'
import { mcpStrings } from '../../mcp/strings'
import { memoryStrings } from '../../memory/strings'
import { skillStrings } from '../../skills/strings'
import { GALLERY_ROW_TITLE } from '../GalleryScreen'
import type { SettingsRouteName } from './route-names'

export interface SettingsRouteMeta {
  /** Called, not read: the strings follow the language picked at runtime. */
  title: () => string
  parent: SettingsRouteName | null
}

const category = strings.settings.categories

export const SETTINGS_ROUTE_META: Record<SettingsRouteName, SettingsRouteMeta> = {
  Root: { title: () => strings.settings.title, parent: null },

  Account: { title: () => category.account, parent: 'Root' },

  // Hermie Web is proxied to one gateway by the server in front of it, so the
  // category is called by the singular of the thing it shows there.
  Gateways: { title: () => (WEB_GATEWAY_BASE_URL ? category.gateway : category.gateways), parent: 'Root' },
  GatewayDetail: { title: () => strings.settings.gateways.detailTitle, parent: 'Gateways' },
  GatewayAdd: { title: () => strings.settings.gateways.add, parent: 'Gateways' },

  ChatsMessages: { title: () => category.chats, parent: 'Root' },
  Notifications: { title: () => category.notifications, parent: 'Root' },

  Memory: { title: () => category.memory, parent: 'Root' },
  MemoryBot: { title: () => memoryStrings.title, parent: 'Memory' },

  Appearance: { title: () => category.appearance, parent: 'Root' },
  Theme: { title: () => strings.settings.themes.title, parent: 'Appearance' },
  ThemeEdit: { title: () => strings.settings.themes.editPageTitle, parent: 'Theme' },

  Privacy: { title: () => category.privacy, parent: 'Root' },
  LockThreshold: { title: () => strings.settings.lock.label, parent: 'Privacy' },
  Voice: { title: () => category.voice, parent: 'Root' },

  Capabilities: { title: () => category.capabilities, parent: 'Root' },
  Skills: { title: () => skillStrings.title, parent: 'Capabilities' },
  Mcp: { title: () => mcpStrings.title, parent: 'Capabilities' },
  McpServer: { title: () => mcpStrings.detail.title, parent: 'Mcp' },
  Connectors: { title: () => connectorStrings.title, parent: 'Capabilities' },
  Connector: { title: () => connectorStrings.detail.title, parent: 'Connectors' },
  Boards: { title: () => kanbanStrings.title, parent: 'Capabilities' },

  Advanced: { title: () => category.advanced, parent: 'Root' },
  ConnectionTest: { title: () => strings.settings.connectionTest, parent: 'Advanced' },
  Gallery: { title: () => GALLERY_ROW_TITLE, parent: 'Advanced' },

  About: { title: () => category.about, parent: 'Root' },
  Licences: { title: () => strings.settings.licences, parent: 'About' }
}

export function settingsTitle(name: string): string {
  return SETTINGS_ROUTE_META[name as SettingsRouteName]?.title() ?? name
}

/**
 * Routes that only make sense with more than one gateway to manage — a list,
 * adding one, or acting on one by id. Hermie Web is proxied to a single
 * gateway by the server in front of it (`WEB_GATEWAY_BASE_URL`), so none of
 * that exists there; the rows that would lead to them are already hidden
 * (`categories/Gateways.tsx`), and this is the same question asked for the
 * registry itself.
 */
const HIDDEN_ON_WEB: ReadonlySet<SettingsRouteName> = new Set(['GatewayDetail', 'GatewayAdd'])

/** Whether `name` belongs in the build actually running, not just in the registry. */
export function isSettingsRouteVisible(name: SettingsRouteName): boolean {
  return !(WEB_GATEWAY_BASE_URL && HIDDEN_ON_WEB.has(name))
}

/**
 * Every route UNDER `name`, at any depth, in registry order.
 *
 * What the sidebar's search reads. A reader looking for the licences types
 * "licence", and the word is on a page two levels down from About — so a search
 * over the eleven category names alone would answer nothing while the thing sat
 * right there in the registry. Derived from the same `parent` links the back
 * walk uses, so a route added anywhere is searchable the moment it exists —
 * except a route this build does not have, which must not be searchable either.
 */
export function settingsDescendants(name: SettingsRouteName): SettingsRouteName[] {
  return (Object.keys(SETTINGS_ROUTE_META) as SettingsRouteName[]).filter(
    route => route !== name && isSettingsRouteVisible(route) && settingsChain(route, { withRoot: true }).includes(name)
  )
}

/**
 * The routes from the top of the stack down to `name`, top first.
 *
 * `Root` is left out when the stack has no root of its own — the split layout,
 * where the category list is a column beside the stack rather than a page in it.
 */
export function settingsChain(name: SettingsRouteName, { withRoot }: { withRoot: boolean }): SettingsRouteName[] {
  const chain: SettingsRouteName[] = []
  let at: SettingsRouteName | null = name

  while (at) {
    chain.unshift(at)
    at = SETTINGS_ROUTE_META[at].parent
  }

  return withRoot ? chain : chain.filter(entry => entry !== 'Root')
}
