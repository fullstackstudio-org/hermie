/**
 * The Settings sections: their route names, in the order the home lists them, what each is called and
 * what is in it, and how each one's chunk is fetched.
 *
 * Titles are the catalogue's where the Expo and Swift apps already have the word (Account, Chats,
 * Appearance, About), so a switch of language moves them with everything else; the rest are the web
 * client's own (`sheet-strings.ts`). Everything is read when called, in the language in use.
 *
 * Not here: the operator's settings, which are the plugin's configuration on the gateway and never this
 * client's to change.
 */
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { webStrings } from '../../i18n/web-strings'
import { hasVoice } from '../../platform/voice-capabilities'

/** In the order the home lists them: who you are and where, then how chats behave, then how it looks. */
export const SETTINGS_SECTIONS = [
  'account',
  'gateway',
  'passkeys',
  'mcp',
  'memory',
  'skills',
  'mcp-servers',
  'chats',
  'notifications',
  'chat-list',
  'appearance',
  'voice',
  'about'
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/**
 * The sections the home lists: all of them, but Voice only where the browser can do either half of it (read aloud,
 * or take dictation). A browser with neither has nothing there to set, and a section that only says so is noise;
 * the address still opens a page that says it, for a link that was shared.
 */
export const listedSections = (): readonly SettingsSection[] =>
  SETTINGS_SECTIONS.filter(section => section !== 'voice' || hasVoice())

export const isSettingsSection = (value: string | undefined): value is SettingsSection =>
  (SETTINGS_SECTIONS as readonly (string | undefined)[]).includes(value)

export function sectionTitle(section: SettingsSection): string {
  switch (section) {
    case 'account':
      return strings.app.settings.categories.account
    case 'gateway':
      return sheetStrings.settings.title.gateway
    case 'passkeys':
      return webStrings.passkeys.settings.title
    case 'mcp':
      return webStrings.mcp.settings.title
    case 'memory':
      return strings.memory.botsTitle
    case 'skills':
      return strings.skills.settings.row
    case 'mcp-servers':
      return strings.mcp.settings.row
    case 'chats':
      return strings.app.settings.categories.chats
    case 'notifications':
      return strings.app.settings.categories.notifications
    case 'chat-list':
      return sheetStrings.settings.title.chatList
    case 'appearance':
      return strings.app.settings.categories.appearance
    case 'voice':
      return strings.app.settings.categories.voice
    case 'about':
      return strings.app.settings.categories.about
  }
}

export function sectionBlurb(section: SettingsSection): string {
  const blurb = sheetStrings.settings.blurb

  switch (section) {
    case 'account':
      return blurb.account
    case 'gateway':
      return blurb.gateway
    case 'passkeys':
      return blurb.passkeys
    case 'mcp':
      return blurb.mcp
    case 'memory':
      return strings.memory.botsHint
    case 'skills':
      return strings.skills.settings.hint
    case 'mcp-servers':
      return strings.mcp.settings.hint
    case 'chats':
      return blurb.chats
    case 'notifications':
      return blurb.notifications
    case 'chat-list':
      return blurb.chatList
    case 'appearance':
      return blurb.appearance
    case 'voice':
      return strings.app.settings.categories.blurb.voice
    case 'about':
      return blurb.about
  }
}

/**
 * How each section's chunk is fetched. The host renders from these and the home asks for one early
 * when its link is pointed at or focused, so the dynamic import is written once per section.
 */
export const SECTION_LOADERS = {
  account: () => import('./Account'),
  gateway: () => import('./Gateway'),
  passkeys: () => import('./Passkeys'),
  mcp: () => import('./MCP'),
  memory: () => import('./Memory'),
  skills: () => import('./Skills'),
  'mcp-servers': () => import('./McpServers'),
  chats: () => import('./Chats'),
  notifications: () => import('./Notifications'),
  'chat-list': () => import('./Arrangement'),
  appearance: () => import('./Appearance'),
  voice: () => import('./Voice'),
  about: () => import('./About')
} as const satisfies Record<SettingsSection, () => Promise<unknown>>

/** Ask for a section's chunk early and ignore the answer. */
export const preloadSection = (section: SettingsSection): void => void SECTION_LOADERS[section]().catch(() => undefined)
