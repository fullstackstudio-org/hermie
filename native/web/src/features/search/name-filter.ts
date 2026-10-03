/**
 * The instant half of the chats field: which bots' names hold what was typed.
 *
 * Matched on this device, in the reader's own case rules (`toLocaleLowerCase`),
 * against the name the list shows and the profile name behind it, so a bot
 * renamed to "Ada" is still found as `researcher`. Whitespace at the ends of the
 * query is not part of it; an empty query matches every bot.
 */
import type { Bot } from '../../state/bots'

export function matchesName(bot: Pick<Bot, 'name' | 'displayName'>, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()

  if (!needle) {
    return true
  }

  return bot.displayName.toLocaleLowerCase().includes(needle) || bot.name.toLocaleLowerCase().includes(needle)
}

/** The bots whose names match, in the order they came. */
export function filterByName<T extends Pick<Bot, 'name' | 'displayName'>>(bots: readonly T[], query: string): T[] {
  return query.trim() ? bots.filter(bot => matchesName(bot, query)) : [...bots]
}
