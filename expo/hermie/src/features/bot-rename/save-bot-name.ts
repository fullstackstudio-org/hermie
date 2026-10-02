/**
 * One name change, end to end: the call, then the local move.
 *
 * Kept out of the sheet for the reason `bot-profile-controller.ts` gives next
 * door — the component stays a rendering of props, and the ORDER of the two
 * halves stays testable. The order is the whole of this module:
 *
 *  1. Ask the gateway. If it refuses, nothing local has moved and the sheet
 *     prints the refusal beside the field.
 *  2. Only if the gateway says the profile's own NAME moved, rekey the stores
 *     and the transcript cache. A `default` profile answers with a display name
 *     and an unchanged id, so there is nothing to rekey and `renameBot` is a
 *     no-op by its own first line.
 *
 * Doing it the other way round — rekeying hopefully and undoing on a refusal —
 * is the version that loses a conversation when the undo is the thing that
 * fails.
 */
import type { GatewayHttp } from '@hermie/gateway-client'

import { renameBot } from './rename-bot'
import { renameProfile } from './rename-controller'
import { renameStrings } from './strings'

export interface SaveBotNameOptions {
  http: GatewayHttp
  /** The profile as the roster last reported it. */
  bot: { name: string; displayName: string; isDefault: boolean }
  /** What the field holds now. */
  draft: string
  /** Which gateway's stored transcripts the rename moves. See `renameBot`. */
  gatewayId: string | null
}

export interface SaveBotNameResult {
  /** The profile's id AFTER the call — the new one only when it really moved. */
  name: string
  /** True when stores were rekeyed, i.e. the handle itself changed. */
  renamed: boolean
  /**
   * The gateway took the name and part of the local move did not land.
   *
   * A warning rather than an error: the rename HAPPENED, and a sheet that
   * reported it as a failure would have the reader try again against a profile
   * that has already been renamed — which answers 404.
   */
  warning: string | null
}

/**
 * Has the field been changed at all?
 *
 * Trimmed on both sides, because the gateway trims too: sending a name that
 * differs from the current one only by a space would be a write that changes
 * nothing and still moves the profile's modification time.
 */
export function botNameChanged(initial: string, draft: string): boolean {
  return initial.trim() !== draft.trim()
}

export async function saveBotName({ http, bot, draft, gatewayId }: SaveBotNameOptions): Promise<SaveBotNameResult> {
  const answer = await renameProfile(http, bot.name, draft)

  if (!answer.renamed) {
    return { name: answer.name, renamed: false, warning: null }
  }

  const moved = await renameBot(bot.name, answer.name, gatewayId)

  if (moved.ok) {
    return { name: answer.name, renamed: true, warning: null }
  }

  const parts = moved.failed.map(part => (part === 'cache' ? renameStrings.partialCache : renameStrings.partialStores))

  return { name: answer.name, renamed: true, warning: renameStrings.partial(parts) }
}
