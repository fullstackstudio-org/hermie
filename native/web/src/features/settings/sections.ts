/**
 * The Settings sections: their route names, in the order the home lists them, what each is called and
 * what is in it, and how each one's chunk is fetched.
 *
 * Titles are the catalogue's where the Expo and Swift apps already have the word (Account, Chats,
 * Appearance, About), so a switch of language moves them with everything else; the rest are the web
 * client's own (`sheet-strings.ts`). Everything is read when called, in the language in use.
 *
 * Not here: notifications (W-25) and the operator's settings, which are the plugin's configuration on
 * the gateway and never this client's to change.
 */
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { webStrings } from '../../i18n/web-strings'

/** In the order the home lists them: who you are and where, then how chats behave, then how it looks. */
export const SETTINGS_SECTIONS = [
  'account',
  'gateway',
  'passkeys',
  'mcp',
  'chats',
  'chat-list',
  'appearance',
  'about'
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

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
    case 'chats':
      return strings.app.settings.categories.chats
    case 'chat-list':
      return sheetStrings.settings.title.chatList
    case 'appearance':
      return strings.app.settings.categories.appearance
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
    case 'chats':
      return blurb.chats
    case 'chat-list':
      return blurb.chatList
    case 'appearance':
      return blurb.appearance
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
  chats: () => import('./Chats'),
  'chat-list': () => import('./Arrangement'),
  appearance: () => import('./Appearance'),
  about: () => import('./About')
} as const satisfies Record<SettingsSection, () => Promise<unknown>>

/** Ask for a section's chunk early and ignore the answer. */
export const preloadSection = (section: SettingsSection): void => void SECTION_LOADERS[section]().catch(() => undefined)
