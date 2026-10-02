/**
 * The one round trip behind the name field.
 *
 * ## Why this is core's route and not the plugin's
 *
 * The obvious place to put a rename would have been a route on the Hermie
 * plugin, and the plugin's own `docs/DESIGN.md` §8 says why it is not there: it
 * would be a second, worse door to something core already serves. So this
 * calls `PATCH /api/profiles/{name}` on the dashboard server, behind the same
 * auth as every other REST call the app makes, with `new_name` as the only body
 * key (`ProfileRename` in `hermes_cli/web_models.py`).
 *
 * Not `POST …/rename`, and not a WebSocket method: `profiles.configure` carries
 * `description`, `ui_meta`, `model` and the skill lists and no display name,
 * and `groups.rename` / `pet.rename` / `session.title` rename other things
 * entirely. This one call is the app's only profile work that leaves the
 * socket.
 *
 * ## The answer says which of two things happened
 *
 * `default` cannot be renamed — its home IS the installation root — so Hermes
 * turns the call into a presentation-only display name, keeps the canonical id
 * and reports both:
 *
 * ```json
 * {"ok": true, "name": "default", "display_name": "Jurist", "path": "/…/.hermes"}
 * ```
 *
 * Any other profile is really renamed, and answers WITHOUT `display_name`:
 *
 * ```json
 * {"ok": true, "name": "jurist", "path": "/…/.hermes/profiles/jurist"}
 * ```
 *
 * `renamed` below is that difference, read off the answer rather than guessed
 * from `isDefault` on our side. The caller needs it because a real rename
 * changes the key every store in this app holds the bot under, and a display
 * name changes nothing at all.
 *
 * ## What the setter actually validates
 *
 * `.strip()` and a 64-character maximum, and nothing else
 * (`hermes_cli/profiles.py::set_profile_display_name`). No character set and no
 * uniqueness: two profiles may carry the same display name, and one may equal
 * another's canonical id. So this module does not pre-validate beyond trimming
 * — inventing a rule the gateway does not have would refuse names that work.
 */
import { type GatewayHttp, isGatewayError } from '@hermie/gateway-client'

import { renameStrings } from './strings'

/** The `.strip()`-and-64 the setter applies, so the field can say so first. */
export const PROFILE_NAME_MAX = 64

export interface ProfileRenameAnswer {
  /** The profile's id AFTER the call. Unchanged when only a label was set. */
  name: string
  /** Present only when the gateway kept the id and set a label instead. */
  displayName: string | null
  path: string
  /** True when the profile's own NAME moved, which is what stores are keyed on. */
  renamed: boolean
}

/**
 * What went wrong, in a form the sheet can print.
 *
 * `GatewayHttp` classifies by status and drops the body, so core's `detail` is
 * not reachable from here. That is deliberate rather than a loss: the three
 * statuses this route answers mean one thing each — 400 is "not a name I will
 * take", 404 is "no such profile" — and a sentence in the app's own voice reads
 * better than FastAPI's.
 */
export class ProfileRenameError extends Error {
  constructor(
    message: string,
    /** The HTTP status, when there was one. */
    readonly status?: number
  ) {
    super(message)
    this.name = 'ProfileRenameError'
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Set a profile's name, or its label when the profile is `default`.
 *
 * `newName` is sent trimmed. An empty string clears the display name — the key
 * is removed from `profile.yaml` and the label falls back to the id — but
 * `rename_profile` refuses an empty new name for `default` before the setter
 * sees it, so clearing THAT one is not reachable over this route and is refused
 * here instead of being sent and coming back a 400.
 */
export async function renameProfile(http: GatewayHttp, profile: string, newName: string): Promise<ProfileRenameAnswer> {
  const wanted = newName.trim()

  if (!wanted && profile === 'default') {
    throw new ProfileRenameError(renameStrings.clearRefused)
  }

  let body: Record<string, unknown>

  try {
    body = await http.patch<Record<string, unknown>>(`/api/profiles/${encodeURIComponent(profile)}`, {
      new_name: wanted
    })
  } catch (failure) {
    throw asRenameError(failure, profile)
  }

  const name = str(body.name) || profile
  // A key that is present and a key that is absent are the whole difference
  // between a label and a rename, so `in` rather than a truthiness test: an
  // empty `display_name` is a CLEARED label, not a rename.
  const carriesLabel = body !== null && typeof body === 'object' && 'display_name' in body

  return {
    name,
    displayName: carriesLabel ? str(body.display_name) : null,
    path: str(body.path),
    renamed: !carriesLabel && name !== profile
  }
}

/** A thrown thing, as the sentence the field shows. */
export function asRenameError(failure: unknown, profile: string): ProfileRenameError {
  if (failure instanceof ProfileRenameError) {
    return failure
  }

  if (isGatewayError(failure)) {
    /*
      404 on this path is "no such profile", which is core's `FileNotFoundError`
      branch — NOT "this gateway has no such endpoint". `GatewayHttp` cannot
      tell those apart and words it as the second, so the sentence is replaced
      rather than passed through. A gateway too old to have the route answers
      404 too and gets the same line, which is as close to true as anything
      reachable from here: from the app's side, a profile the gateway will not
      name is a profile the gateway does not have.
    */
    if (failure.status === 404) {
      return new ProfileRenameError(renameStrings.missing(profile), 404)
    }

    if (failure.status === 400) {
      return new ProfileRenameError(renameStrings.refused, 400)
    }

    return new ProfileRenameError(failure.message || renameStrings.failed, failure.status)
  }

  return new ProfileRenameError(failure instanceof Error ? failure.message : renameStrings.failed)
}
