/**
 * The switch itself: "Shared Bot Chat" or "My chat", per bot. Ported from the Expo app's
 * `features/user-chats/user-chat-switch.ts`, with the import paths changed and nothing else.
 *
 * Two halves that have no business knowing about each other (the directory, which resolves sessions over a
 * socket, and the arrangement store, which remembers what the reader asked for) joined here into the one object
 * the roster and the chat controller take. Neither half imports the other, and a test can hand the controller a
 * literal instead of either.
 */
import type { Bot, BotCanonicalSession } from '../../state/bots'
import type { CurrentResolution } from '../bots-controller'
import type { ChatChoice, UserChatSwitch } from '../chat-controller'

export interface UserChatSwitchParts {
  available: () => boolean
  title: () => string
  chose: (botName: string) => boolean
  cached: (botName: string) => BotCanonicalSession | null
  resolve: (bot: Bot) => Promise<BotCanonicalSession>
  remember: (botName: string, choice: ChatChoice) => void
  /**
   * Sub-chats. All three optional, so the switch keeps building without them; a switch without `target` is one
   * where every bot is on its group chat unless the old two-position switch moved it.
   */
  target?: (botName: string) => string | null | undefined
  resolveTarget?: (bot: Bot) => Promise<CurrentResolution>
  rememberCurrent?: (botName: string, storedId: string | null, options?: { chore?: boolean }) => void
}

export function userChatSwitch(parts: UserChatSwitchParts): UserChatSwitch {
  return {
    get available() {
      return parts.available()
    },
    get title() {
      return parts.title()
    },
    chose: parts.chose,
    cached: parts.cached,
    resolve: parts.resolve,
    remember: parts.remember,
    ...(parts.target ? { target: parts.target } : {}),
    ...(parts.resolveTarget ? { resolveTarget: parts.resolveTarget } : {}),
    ...(parts.rememberCurrent ? { rememberCurrent: parts.rememberCurrent } : {})
  }
}
