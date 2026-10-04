/**
 * A bot's name as the page shows it. The roster's display name is the bot's own words (it can set it), so it is
 * cleaned and bounded the way a request's text is (`displayText`): no zero-width, direction-override or other
 * invisible characters, no unbounded length. Where it stands in a line of its own (a heading, a label) the caller
 * isolates it (`<bdi>`), as the request sheets do; where it is spoken (an announcement) the cleaning is what counts.
 *
 * Falls back to the bot's route name, cleaned the same way, when the display name has nothing left to show.
 */
import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'

export function botLabel(displayName: string | undefined, bot: string): string {
  return displayText(displayName, BOT_NAME_LIMIT) || displayText(bot, BOT_NAME_LIMIT)
}
