/**
 * Making a bot, and the two things that have to happen after.
 *
 * `profiles.create` writes a profile directory and stops. It does not mint a
 * conversation, which means a freshly made bot is a roster row with no
 * `canonical_session` — and ADR-0007 says Hermie shows exactly one chat per
 * bot, resolved by title, never forked. So "create" is three steps, in this
 * order, and the order is the whole point:
 *
 *  1. `profiles.create`, which is the only step that can fail in a way the
 *     reader needs to read;
 *  2. refresh the roster, so the new row exists with the display name and the
 *     model the gateway actually stored rather than the ones we asked for;
 *  3. `BotsController.resolveCanonical` on that row — the ordinary path, the
 *     same one tapping an existing bot takes. Minting a session here directly
 *     would be a second way to make a canonical chat, and two ways is how a
 *     chat gets forked.
 *
 * Step 2 is not a nicety. `profiles.create` answers the name it stored, and
 * that name is the normalised handle, not what was typed; resolving against
 * what was typed would look up a profile that does not exist.
 *
 * There is no delete here. See {@link PROFILE_DELETE_UNAVAILABLE}.
 */
import type { ProfilesCreateParams, ProfilesCreateResult } from '@hermes/shared/gateway-contract'

import type { Bot } from '../../store/bots'
import type { ChatGateway } from '../../gateway/link'

/**
 * Why the bot profile sheet has no danger zone.
 *
 * The gateway has no profile-delete method. `tui_gateway/methods_profiles.py`
 * registers `list`, `create`, `describe`, `configure`, `set_asset`, `get_asset`
 * and `remember_onboarding` — that is the whole surface, and the generated
 * contract agrees (`packages/hermes-shared/src/gateway-contract.generated.ts`
 * has no `profiles.delete`). Deleting a profile is a CLI operation
 * (`hermes profile delete <name>`), because it removes a directory that may
 * hold memories, skills and a cron store, and upstream has deliberately not
 * exposed that over a socket.
 *
 * So the action is HIDDEN rather than shown-and-refused. A danger zone that
 * always fails teaches the reader that the app is broken; an absent one is
 * merely a missing feature, and the README and platform notes say where the
 * command lives.
 *
 * If upstream ever adds the method, the interaction with ADR-0007 is already
 * decided: a deleted profile takes its canonical chat with it, so the client
 * would have to `forget` the bot in every store and cache in the same step —
 * the roster, the chat store, the transcript cache, the mute and folder
 * entries — or the next roster refresh would paint a bot with no gateway
 * behind it.
 */
export const PROFILE_DELETE_UNAVAILABLE = 'hermes profile delete'

/** What the New-bot form collects, before it is turned into RPC params. */
export interface NewBotDraft {
  /** The handle, already normalised by `checkProfileName`. */
  handle: string
  /** What the roster shows under the name. Optional. */
  description: string
  /** `provider/model`, or empty to inherit the launch profile's pin. */
  model: string
  provider: string
  /** A bot to copy config.yaml from, or null for a fresh profile. */
  cloneFrom: string | null
}

export const EMPTY_NEW_BOT_DRAFT: NewBotDraft = {
  handle: '',
  description: '',
  model: '',
  provider: '',
  cloneFrom: null
}

/**
 * The draft as `profiles.create` params.
 *
 * Kept apart from the round trip so the mapping can be asserted without a
 * socket, because three of these rules are invisible at the call site:
 *
 *  - `model` and `provider` go together or not at all. `_pin_profile_model`
 *    only runs `if model and provider`, so sending one alone silently pins
 *    nothing while the result still says `model_set: false`.
 *  - `mirror_credentials` is left OUT rather than sent as `true`. It defaults
 *    to true upstream, and a bare create seeds a comment-only `.env` with no
 *    `auth.json` — which is a bot that cannot reach any provider. Naming it
 *    here would invite somebody to "tidy up" by setting it false.
 *  - `clone_from` is omitted, not sent as null, when there is nothing to clone.
 *    Upstream treats an omitted `clone_from` as "fresh profile + bundled
 *    skills" and a present one as a clone; `null` happens to take the same
 *    branch today, and relying on that is relying on a coincidence.
 */
export const createParamsFor = (draft: NewBotDraft): ProfilesCreateParams => {
  const description = draft.description.trim()
  const model = draft.model.trim()
  const provider = draft.provider.trim()

  return {
    name: draft.handle,
    ...(description ? { description } : {}),
    ...(draft.cloneFrom ? { clone_from: draft.cloneFrom } : {}),
    ...(model && provider ? { model, provider } : {})
  }
}

export interface CreatedBot {
  /** The handle the gateway stored, which may differ from what was typed. */
  name: string
  /** The roster row, once the refresh has seen it. */
  bot: Bot
  /** The canonical chat, resolved the ordinary way. */
  sessionId: string
  /**
   * True when the gateway said it pinned nothing and inherited nothing, which
   * is a bot with no provider behind it. The sheet says so rather than opening
   * a chat that can only answer with an error.
   */
  withoutModel: boolean
}

export interface ProfilesControllerOptions {
  gateway: ChatGateway
  /** `BotsController.refresh`, which re-reads `profiles.list`. */
  refreshRoster: () => Promise<Bot[]>
  /** `BotsController.resolveCanonical` — the ONE way a Bot Chat is found or made. */
  resolveCanonical: (bot: Bot) => Promise<{ id: string }>
}

export class ProfilesController {
  constructor(private readonly options: ProfilesControllerOptions) {}

  /**
   * Create a bot and hand back the chat to open.
   *
   * Every failure here is thrown, because there is no half-made bot worth
   * showing: if the create fails there is nothing, and if the resolve fails the
   * profile exists but has no chat, which is a state the reader has to be told
   * about rather than dropped into.
   */
  async create(draft: NewBotDraft): Promise<CreatedBot> {
    const result: ProfilesCreateResult = await this.options.gateway.request('profiles.create', createParamsFor(draft))
    // Upstream answers the name it STORED. It is the normalised handle, and
    // looking anything up by what was typed would miss.
    const name = result.name || draft.handle
    const roster = await this.options.refreshRoster()
    const bot = roster.find(entry => entry.name === name)

    if (!bot) {
      throw new Error(`The gateway made ${name} but did not list it. Pull to refresh in a moment.`)
    }

    const session = await this.options.resolveCanonical(bot)

    return {
      name,
      bot,
      sessionId: session.id,
      // `model_set` is the explicit pin; `mirrored.model_inherited` is the
      // launch profile's. Neither means the bot has nowhere to send a message.
      withoutModel: !result.model_set && !result.mirrored?.model_inherited
    }
  }
}
