/**
 * Writing a bot's display name where every other client can see it.
 *
 * ## Why this is the plugin's route and not core's
 *
 * `rename-controller.ts` next door argues the opposite way about renaming, and
 * both arguments are the same one applied to two different routes: use the door
 * core already serves. Core serves no door for this. `PATCH /api/profiles/{name}`
 * is the only route that touches a display name and it RENAMES the profile on
 * every profile but `default` — its directory, its wrapper script, its service
 * and the active-profile pointer — and `profiles.configure` carries
 * `description`, `ui_meta`, `model` and the skill lists and no display name at
 * all. So the app kept the name to itself, in the arrangement's `labels`, and
 * the owner looked at the profile list on the gateway and found the old one
 * still there.
 *
 * The plugin's route is that missing door:
 *
 * ```
 * PATCH /api/plugins/hermie/profiles/{name}   {"display_name": "De Onderzoeker"}
 * 200                                        {"name": "researcher", "display_name": "De Onderzoeker"}
 * ```
 *
 * It writes the name into the profile's own file, which is where
 * `profiles.list` reads a `display_name` from — so the roster's own copy
 * becomes the source of truth at the next refresh and the two agree.
 *
 * ## The local label is still written, and that is not belt-and-braces
 *
 * On a 200 the name is stored in `labels` as well, for two reasons that are
 * both about somebody other than the person pressing Save. The list has to
 * redraw NOW rather than at the next roster poll, and every copy of this app
 * older than this round reads `labels` and nothing else — so a name written
 * only to the gateway would be invisible on the reader's other phone until that
 * phone is updated. They hold the same text, so nothing has to decide which
 * wins.
 *
 * ## What each refusal means
 *
 * | Status | What the gateway is saying                                        |
 * | ------ | ----------------------------------------------------------------- |
 * | 400    | not a name the route will take: empty, or over its own limit       |
 * | 403    | this gateway account may read profiles and not write them         |
 * | 404    | no such route, or no such profile — the plugin predates it        |
 *
 * 404 is the one that is not an error. A gateway whose plugin is older than the
 * route cannot be told apart from one that has no such profile, and the useful
 * answer in both cases is the same: keep the name locally, and say out loud
 * that it did not travel. So `saveDisplayName` reports WHERE the name landed
 * rather than throwing, and only 400 and 403 are failures.
 *
 * `GatewayHttp` folds 401 and 403 together into an `auth` error, so a 403 is
 * told apart by its status and not by its kind — the same thing
 * `memory-controller.ts` has to do.
 */
import { type GatewayHttp, isGatewayError } from '@hermie/gateway-client'

import { useChatLayoutStore } from '../../store/chat-layout'
import { renameStrings } from './strings'

/** The plugin mounts at its own name, one route per profile. */
export const DISPLAY_NAME_ROUTE = '/api/plugins/hermie/profiles'

/**
 * The plugin's cap, which is NOT the 64 core's own setter applies.
 *
 * Two pieces of software, two limits, and the smaller one is the one that can
 * refuse a write — so the field uses this whenever the route is there to be
 * written to, rather than letting a reader compose a name the route will not
 * take and finding out on Save.
 */
export const PROFILE_DISPLAY_NAME_MAX = 60

/** Where a saved name actually ended up. */
export type DisplayNameHome = 'gateway' | 'app'

export interface SaveDisplayNameResult {
  /** `app` when the route was not there, whatever the advert said. */
  home: DisplayNameHome
  /** The name as it is now stored, trimmed. Empty is a name taken back. */
  displayName: string
}

/** The route said no, in a sentence the field can print. */
export class DisplayNameError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'DisplayNameError'
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export interface SaveDisplayNameOptions {
  /** Null on a connection with no REST half; the name then stays app-only. */
  http: GatewayHttp | null
  /** The profile's identifier, not its display name. */
  profile: string
  /** What the field holds. Sent trimmed. */
  draft: string
  /**
   * Does this gateway's plugin advertise `profiles.display_name`?
   *
   * Passed in rather than read here, because the advert belongs to the
   * connection and this module is meant to be callable from a test with a
   * hand-written `http` and no stores hydrated.
   */
  toGateway: boolean
}

/**
 * Save one display name: the call, then the local write.
 *
 * The order is the whole of this function, and it is the order `save-bot-name.ts`
 * argues for next door. Ask the gateway first; only once it has taken the name
 * does anything local move. Writing hopefully and undoing on a refusal is the
 * version where the undo is the thing that fails, and here it would leave the
 * list showing a name the gateway had just rejected.
 *
 * An empty draft is a name taken BACK. It is not sent — the route answers 400 to
 * an empty `display_name`, and "clear the name Hermie shows" is not a request to
 * write an empty one on the gateway — so clearing is local, and the gateway's own
 * `display_name` stays whatever it was and is what the row falls back to. Which
 * is exactly what `clearHint` promises.
 */
export async function saveDisplayName({
  http,
  profile,
  draft,
  toGateway
}: SaveDisplayNameOptions): Promise<SaveDisplayNameResult> {
  const wanted = draft.trim()
  let home: DisplayNameHome = 'app'

  if (http && toGateway && wanted) {
    home = (await patchDisplayName(http, profile, wanted)) ? 'gateway' : 'app'
  }

  useChatLayoutStore.getState().setLabel(profile, wanted)

  return { home, displayName: wanted }
}

/**
 * `PATCH /api/plugins/hermie/profiles/{name}`. True when the name landed.
 *
 * False rather than a throw on a 404: see the table above. Anything else is a
 * `DisplayNameError` the caller prints beside the field.
 */
export async function patchDisplayName(http: GatewayHttp, profile: string, displayName: string): Promise<boolean> {
  try {
    const body = await http.patch<Record<string, unknown>>(`${DISPLAY_NAME_ROUTE}/${encodeURIComponent(profile)}`, {
      display_name: displayName
    })

    // The route answers the pair it wrote. A 200 that does not carry the name
    // back is not a write this side can claim happened.
    return str(body?.display_name) === displayName
  } catch (failure) {
    if (isGatewayError(failure) && failure.status === 404) {
      return false
    }

    throw asDisplayNameError(failure)
  }
}

/** A thrown thing, as the sentence the field shows. */
export function asDisplayNameError(failure: unknown): DisplayNameError {
  if (failure instanceof DisplayNameError) {
    return failure
  }

  if (isGatewayError(failure)) {
    if (failure.status === 403) {
      return new DisplayNameError(renameStrings.displayForbidden, 403)
    }

    // In the app's own voice rather than FastAPI's, for the reason
    // `rename-controller.ts` gives: the status means one thing on this route.
    if (failure.status === 400) {
      return new DisplayNameError(renameStrings.refused, 400)
    }

    return new DisplayNameError(failure.message || renameStrings.failed, failure.status)
  }

  return new DisplayNameError(failure instanceof Error ? failure.message : renameStrings.failed)
}
