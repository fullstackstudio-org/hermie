/**
 * The Settings routes by NAME, and nothing else.
 *
 * Split from `routes.tsx` so that something which only needs to spell a route —
 * the dev launch parser in `src/dev/launch-intent.ts`, which must stay a pure
 * module a Node test can import — never pulls in every page Settings can draw.
 * `routes.tsx` keys its registry on this type, so the two cannot disagree.
 */

/** What each route needs to be opened with. `undefined` = nothing. */
export type SettingsParamList = {
  Root: undefined
  Account: undefined
  Gateways: undefined
  GatewayDetail: { id: string }
  GatewayAdd: undefined
  ChatsMessages: undefined
  Notifications: undefined
  Memory: undefined
  MemoryBot: { profile: string }
  Appearance: undefined
  Theme: undefined
  ThemeEdit: { id: string }
  Privacy: undefined
  LockThreshold: undefined
  Voice: undefined
  Capabilities: undefined
  Skills: undefined
  Mcp: undefined
  McpServer: { name: string }
  Connectors: undefined
  Connector: { sessionId: string; slug: string }
  Boards: undefined
  Advanced: undefined
  ConnectionTest: undefined
  Gallery: undefined
  About: undefined
  Licences: undefined
}

export type SettingsRouteName = keyof SettingsParamList

/**
 * Every route, in registry order. A `Record` rather than an array literal so
 * that a route added to `SettingsParamList` and forgotten here does not compile.
 */
const ROUTE_SET: Record<SettingsRouteName, true> = {
  Root: true,
  Account: true,
  Gateways: true,
  GatewayDetail: true,
  GatewayAdd: true,
  ChatsMessages: true,
  Notifications: true,
  Memory: true,
  MemoryBot: true,
  Appearance: true,
  Theme: true,
  ThemeEdit: true,
  Privacy: true,
  LockThreshold: true,
  Voice: true,
  Capabilities: true,
  Skills: true,
  Mcp: true,
  McpServer: true,
  Connectors: true,
  Connector: true,
  Boards: true,
  Advanced: true,
  ConnectionTest: true,
  Gallery: true,
  About: true,
  Licences: true
}

export const SETTINGS_ROUTE_NAMES = Object.keys(ROUTE_SET) as SettingsRouteName[]

/** The categories, in the order the category list shows them. */
export const SETTINGS_CATEGORIES = [
  'Account',
  'Gateways',
  'ChatsMessages',
  'Notifications',
  'Memory',
  'Appearance',
  'Privacy',
  'Voice',
  'Capabilities',
  'Advanced',
  'About'
] as const satisfies readonly SettingsRouteName[]

export type SettingsCategoryName = (typeof SETTINGS_CATEGORIES)[number]

/**
 * A route name from a loosely spelled string — a dev launch argument, say.
 *
 * Case-insensitive on the route's own name, plus the spellings the old
 * boolean pages were opened by (`themes`, `connection`, `licenses`), so the
 * screenshot scripts written against them keep working.
 */
const ALIASES: Record<string, SettingsRouteName> = {
  connection: 'ConnectionTest',
  'connection-test': 'ConnectionTest',
  licenses: 'Licences',
  themes: 'Theme',
  chats: 'ChatsMessages',
  'chats-messages': 'ChatsMessages',
  mcp: 'Mcp',
  boards: 'Boards',
  kanban: 'Boards',
  lock: 'LockThreshold',
  'require-unlock': 'LockThreshold'
}

export function settingsRouteFrom(value: string): SettingsRouteName | undefined {
  const key = value.trim().toLowerCase()

  if (!key) {
    return undefined
  }

  return ALIASES[key] ?? SETTINGS_ROUTE_NAMES.find(name => name.toLowerCase() === key)
}
