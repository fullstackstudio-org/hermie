/**
 * The round trips behind the bot profile sheet.
 *
 * Split out of the sheet for the reason `bots-controller.ts` gives next door:
 * the component stays a rendering of props and this stays drivable from a test
 * with a hand-written `ChatGateway`, which is the only way the upload path is
 * testable at all without a photo library.
 *
 * ## What is written WHERE, and why it is two places rather than one
 *
 * A reader changing "this bot" in one sheet is touching two stores that have
 * nothing to do with each other, and pretending otherwise would mean moving one
 * of them:
 *
 *  - **Description and avatar go to the GATEWAY**, through `profiles.configure`
 *    and `profiles.set_asset`. They are the profile's own, every client sees
 *    them, and the TUI and the web dashboard show the same values.
 *  - **The colour is the chat list's**, and stays in `chat-layout`'s
 *    `setAccent`. It rides to the gateway on ADR-0016's `hermie-app` section
 *    like the rest of the arrangement, and it is moving to per-account storage
 *    in a parallel round — so this calls the existing setter and restructures
 *    nothing.
 *
 * Only the first of the two can fail in a way worth a message, which is why
 * this module is about those two calls and the other is one line at the call
 * site.
 *
 * ## The display name is not one of the socket calls, but it IS one of the changes
 *
 * `ProfilesConfigureParams` carries `profile`, `name`, `ui_meta`, `soul`,
 * `description`, `model`, `provider`, the skill and toolset lists — and no
 * display name. `name` there is the profile's IDENTIFIER, which is how the
 * request says which profile it means. So core offers no way to write one and
 * the name is not sent by either call above.
 *
 * It is still part of `changesFor`, and that is the whole of the bug this
 * answers. The field used to write itself into the arrangement on every
 * keystroke, which left the sheet's one button disabled while a reader typed a
 * new name into it: they had changed the only thing they came to change and the
 * control that says "save" was dead. Nothing was lost — the name was already
 * stored — but nothing said so either. A name is a change now, Save is
 * enabled by it, and Save is what commits it.
 */
import type { ProfilesConfigureResult, ProfilesSetAssetResult } from '@hermes/shared/gateway-contract'

import type { ChatGateway } from '../../gateway/link'
// The module rather than the feature's barrel: that one also exports the name
// ROWS, and this file is deliberately importable without React.
import { botNameChanged } from '../bot-rename/save-bot-name'

/** The asset name the gateway stores a profile picture under. */
export const AVATAR_ASSET = 'avatar'

export interface BotProfileGatewayOptions {
  gateway: ChatGateway
  /** The profile's identifier, not its display name. */
  botName: string
}

/**
 * Save the description.
 *
 * Sent only when it actually changed. `profiles.configure` bumps nothing it was
 * not asked about, but a write still travels and still lands in the profile's
 * file on disk, and a sheet whose Save button rewrote an unchanged description
 * would put a modification time on a profile nobody edited.
 */
export async function saveDescription(
  options: BotProfileGatewayOptions,
  description: string
): Promise<ProfilesConfigureResult> {
  return options.gateway.request('profiles.configure', {
    name: options.botName,
    description
  })
}

/**
 * Store a new profile picture.
 *
 * The bytes go up as bare base64 — the contract says "a data URL or bare base64
 * (PNG/JPEG/WebP, sniffed)" — and the gateway bumps `ui_meta_revisions.avatar`
 * as a side effect. That revision is the app's cache key for the picture
 * (`avatarCacheKey`), so the next roster read invalidates the old one by
 * itself and nothing here has to reach into the avatar cache.
 */
export async function uploadAvatar(options: BotProfileGatewayOptions, base64: string): Promise<ProfilesSetAssetResult> {
  return options.gateway.request('profiles.set_asset', {
    name: options.botName,
    asset: AVATAR_ASSET,
    data: base64
  })
}

/** Remove the profile picture. `clear` deletes rather than writing empty bytes. */
export async function clearAvatar(options: BotProfileGatewayOptions): Promise<ProfilesSetAssetResult> {
  return options.gateway.request('profiles.set_asset', {
    name: options.botName,
    asset: AVATAR_ASSET,
    clear: true
  })
}

/**
 * What the sheet has to send, given what it started with.
 *
 * A plain diff, and it is a function rather than three comparisons inside a
 * handler so that "nothing changed" is one testable answer instead of a
 * property of the order the handler happens to check things in.
 */
export interface BotProfileDraft {
  description: string
  /** A newly picked picture, `null` to remove the current one, `undefined` to leave it. */
  avatar: string | null | undefined
  /** The display name as the field holds it. */
  name: string
}

export interface BotProfileChanges {
  description: string | null
  avatar: string | null | undefined
  /**
   * The display name to store, or `null` when the field still holds the stored one.
   *
   * An EMPTY string is a change like any other — it is how a reader takes the
   * name back — so this is `string | null` and not a truthiness test. Compared
   * trimmed, through `botNameChanged`, for the reason that function gives.
   */
  name: string | null
  /** False when the reader opened the sheet and changed nothing that travels. */
  any: boolean
}

export function changesFor(initial: { description: string; name: string }, draft: BotProfileDraft): BotProfileChanges {
  const description = draft.description === initial.description ? null : draft.description
  const name = botNameChanged(initial.name, draft.name) ? draft.name.trim() : null

  return {
    description,
    avatar: draft.avatar,
    name,
    any: description !== null || draft.avatar !== undefined || name !== null
  }
}
