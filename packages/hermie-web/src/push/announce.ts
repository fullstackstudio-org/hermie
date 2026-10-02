/**
 * The daemon saying it exists, and nothing more.
 *
 * ADR-0017: "`hermie-app.push.endpoint` in the app-wide `ui_meta` is
 * **informational**: the daemon writes its own version and a liveness stamp so
 * Settings can say whether push is available and, when it is not, say what is
 * missing. The app never dials it."
 *
 * So this writes four fields and reads nothing back. What makes it delicate is
 * not what it writes but what it must not touch. ADR-0016's rule is that a
 * `ui_meta` key is the unit of a write and is replaced WHOLE, and `hermie-app`
 * is the key that holds the chat list's order, the dividers, the archive, every
 * chat's colour, the theme — and, inside `push`, the registrations and
 * heartbeats the devices themselves wrote. A daemon that wrote its own liveness
 * stamp by sending `{"push": {...}}` would delete all of it.
 *
 * Hence: read the bag the roster already handed over, put four fields inside
 * `push`, send the whole bag back under the revision it was read at, and take
 * the conflict answer's revision if somebody got there first.
 */
import { HERMIE_APP_KEY } from './registrations'
import type { Roster } from './roster'

/** Bumped if a reader could not safely take an older shape. */
export const AVAILABILITY_VERSION = 1

export interface PushAvailability {
  /**
   * Where the browser build reads the application-server key, relative to the
   * origin it is served from. Relative on purpose: the daemon knows what it
   * serves, not what address a reverse proxy publishes it at.
   */
  endpoint: string
  vapidPublicKey: string
  /** Hermie Web's own version, so Settings can say what is running. */
  version: string
  /**
   * What this notifier can deliver to, in the plugin's capability strings
   * (`push.expo`, `push.webpush`, `push.relay`). Optional and additive: a
   * reader that predates it ignores it, and an absent list says nothing.
   */
  capabilities?: readonly string[]
  /**
   * The relay origins this daemon posts to (`--push-relays`), the same
   * additive field the plugin's advert carries. Optional; absent says nothing.
   */
  relayOrigins?: readonly string[]
  /** Unix seconds. A stamp that has stopped moving is a daemon that has stopped. */
  at: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * The `hermie-app` bag with this daemon's availability in it, and everything
 * else exactly as it was.
 *
 * Pure, and tested as such: the whole risk of this feature is a write that
 * takes somebody's chat list with it, and a pure function is the only version of
 * that risk anybody can read.
 */
export function withAvailability(
  section: Record<string, unknown> | null,
  availability: PushAvailability
): Record<string, unknown> {
  const bag = isObject(section) ? { ...section } : {}
  const push = isObject(bag.push) ? { ...bag.push } : {}

  // Ours to replace whole: a list a newer daemon left must not outlive the
  // daemon that is running now.
  delete push.capabilities
  delete push.relayOrigins

  return {
    // A bag that has never been written still has to carry the section version
    // the app's own reader checks.
    ...bag,
    v: typeof bag.v === 'number' && bag.v > 0 ? bag.v : 1,
    push: {
      ...push,
      daemonVersion: AVAILABILITY_VERSION,
      endpoint: availability.endpoint,
      vapidPublicKey: availability.vapidPublicKey,
      version: availability.version,
      ...(availability.capabilities ? { capabilities: [...availability.capabilities] } : {}),
      ...(availability.relayOrigins ? { relayOrigins: [...availability.relayOrigins] } : {}),
      at: availability.at
    }
  }
}

/** True when the bag already says exactly this, down to the stamp's minute. */
/** Two capability lists say the same, an absent one matching only an absent one. */
function sameList(stored: unknown, wanted: readonly string[] | undefined): boolean {
  if (wanted === undefined) {
    return stored === undefined
  }

  return Array.isArray(stored) && stored.length === wanted.length && wanted.every((entry, i) => stored[i] === entry)
}

export function availabilityIsCurrent(
  section: Record<string, unknown> | null,
  availability: PushAvailability,
  staleAfterSeconds: number
): boolean {
  const push = isObject(section) && isObject(section.push) ? section.push : null

  if (!push) {
    return false
  }

  const at = typeof push.at === 'number' ? push.at : 0

  return (
    push.endpoint === availability.endpoint &&
    push.vapidPublicKey === availability.vapidPublicKey &&
    push.version === availability.version &&
    sameList(push.capabilities, availability.capabilities) &&
    sameList(push.relayOrigins, availability.relayOrigins) &&
    availability.at - at < staleAfterSeconds
  )
}

export interface AnnounceLink {
  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

export interface AnnounceResult {
  /** False when there was nowhere to write, or when the write was refused twice. */
  written: boolean
  /** The revision the gateway reported, so the caller can keep its table current. */
  revision: number
}

/**
 * Write the availability, once, with the one retry a compare-and-swap asks for.
 *
 * One retry is the whole design. The conflict answer carries the revision that
 * won, so a second attempt cannot fail for the same reason; a third would only
 * help if yet another writer landed in between, and in that case leaving it for
 * the next sweep is right rather than spinning against a device that is
 * heartbeating faster than this can write.
 */
export async function announceAvailability(
  link: AnnounceLink,
  roster: Roster,
  availability: PushAvailability
): Promise<AnnounceResult> {
  if (!roster.defaultProfile) {
    // No default profile is a gateway with nowhere to keep anything app-wide.
    // Push still works; Settings simply cannot say so.
    return { written: false, revision: 0 }
  }

  let section = roster.appSection
  let revision = roster.appRevision

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = (await link.request('profiles.configure', {
      name: roster.defaultProfile,
      ui_meta: { [HERMIE_APP_KEY]: withAvailability(section, availability) },
      ui_meta_expected_revisions: { [HERMIE_APP_KEY]: revision }
    })) as { applied?: { ui_meta_revisions?: unknown; ui_meta_conflicts?: unknown } }

    const applied = isObject(result?.applied) ? result.applied : {}
    const revisions = isObject(applied.ui_meta_revisions) ? applied.ui_meta_revisions : {}
    const conflicts = isObject(applied.ui_meta_conflicts) ? applied.ui_meta_conflicts : {}
    const reported = revisions[HERMIE_APP_KEY]

    if (typeof reported === 'number') {
      revision = reported
    }

    const conflict = conflicts[HERMIE_APP_KEY]

    if (!isObject(conflict)) {
      return { written: true, revision }
    }

    if (typeof conflict.actual === 'number') {
      revision = conflict.actual
    }

    // Re-read before trying again. Taking the revision without the VALUE would
    // write this daemon's four fields over whatever the winner just stored.
    const fresh = (await link.request('profiles.list', {})) as unknown
    const rows = Array.isArray((fresh as { profiles?: unknown })?.profiles)
      ? ((fresh as { profiles: unknown[] }).profiles as Record<string, unknown>[])
      : []
    const row = rows.find(entry => entry?.name === roster.defaultProfile)
    const bag = isObject(row?.ui_meta) ? row.ui_meta : null
    section = bag && isObject(bag[HERMIE_APP_KEY]) ? (bag[HERMIE_APP_KEY] as Record<string, unknown>) : null
  }

  return { written: false, revision }
}
