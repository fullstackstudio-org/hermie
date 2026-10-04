/**
 * What the bot profile page is given by the page: the gateway's calls (`profiles.describe`, `profiles.configure`,
 * `profiles.set_asset`, `reload.mcp`) and the way to have the roster read again once a write changed what it
 * shows (a description, a picture).
 *
 * Handed in through `ChatSessionRuntime.profiles`, so a test hands in a function and needs no connection.
 */
import type { ChatGateway } from '../link'

export interface BotProfilesRuntime {
  gateway: Pick<ChatGateway, 'request'>
  /** Read the roster again: the list and the header show the new description and picture. */
  refreshRoster: () => Promise<unknown>
}
