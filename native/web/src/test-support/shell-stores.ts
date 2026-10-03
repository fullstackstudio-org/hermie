/**
 * The page's stores, set to a known state for a screen test, and a roster to put
 * in them. The screens read the page's own stores (`botsStore`, `chatsStore`,
 * `connectionStore`, `pluginStore`), so a test resets them first and fills the
 * ones it is about.
 */
import { ownAuthorStore } from '../core/chats/own-author'
import { type Bot, botsStore } from '../state/bots'
import { chatsStore } from '../state/chats'
import { connectionStore } from '../state/connection'
import { pluginStore } from '../state/plugin'
import { sessionStatusStore } from '../state/session-status'
import { settingsStore } from '../state/settings'

/** Unix seconds in the past, far enough that a row's stamp is a date, not "Now" or a clock. */
export const LONG_AGO = 1_700_000_000

/** A bot as the roster holds it. `canonical` is present unless a test removes it. */
export function aBot(name: string, over: Partial<Bot> = {}): Bot {
  return {
    name,
    displayName: `${name.charAt(0).toUpperCase()}${name.slice(1)}`,
    description: '',
    model: '',
    provider: '',
    isDefault: false,
    hasAvatar: false,
    uiMetaRevision: 0,
    canonical: {
      id: `stored-${name}`,
      resolvedId: `stored-${name}`,
      preview: '',
      lastActive: LONG_AGO,
      messageCount: 3
    },
    ...over
  }
}

/** Every store the shell reads, emptied. */
export function resetShellStores(): void {
  botsStore.getState().reset()
  chatsStore.getState().reset()
  connectionStore.getState().reset()
  pluginStore.getState().reset()
  ownAuthorStore.getState().reset()
  settingsStore.getState().reset()
  sessionStatusStore.getState().reset()
}

/** Put a roster in the store as a gateway answer would, and mark every bot read. */
export function seedRoster(bots: Bot[], options: { read?: boolean } = {}): void {
  botsStore.getState().setBots(bots)

  if (options.read !== false) {
    for (const bot of bots) {
      botsStore.getState().markSeen(bot.name, bot.canonical?.lastActive ?? LONG_AGO)
    }
  }
}
