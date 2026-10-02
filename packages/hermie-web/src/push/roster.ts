/**
 * What one `profiles.list` tells the daemon.
 *
 * Three things, and they all come off the same round trip because asking twice
 * would mean two answers that can disagree:
 *
 *  - **which chats to watch** — each bot's canonical Bot Chat, resolved exactly
 *    as the app resolves one ([ADR-0007](../../../../docs/adr/0007-canonical-bot-chats-only.md)):
 *    `canonical_session.resolved_id` is the live compression tip and `id` is the
 *    registry row, so the tip is what a resume must name;
 *  - **who asked to be told** — the app-wide keys on the DEFAULT profile, which
 *    is where [ADR-0016](../../../../docs/adr/0016-ui-meta-sync.md) puts
 *    everything app-wide. There is one key PER PERSON now
 *    (`hermie-app:<user_id>`), so every one of them is read and their
 *    registrations pooled: a notifier's job is to reach every device that asked,
 *    and which person's key a device wrote itself into is not its business;
 *  - **the revision that guards a write to it**, so the availability stamp the
 *    daemon leaves behind is a compare-and-swap and not a clobber.
 *
 * Everything here is defensive. What arrives is a bag of JSON off a wire, and a
 * roster row that cannot be read costs that row rather than the sweep.
 */
import {
  HERMIE_APP_KEY,
  type PushRegistration,
  type PushSection,
  type PushType,
  readPushSection,
  relayOriginOf
} from './registrations'

export interface WatchedBot {
  /** The profile name, which is the bot's identity everywhere else. */
  name: string
  /** What a notification's title says, when the roster offers one. */
  label: string
  /** The session a resume must name: the live compression tip. */
  sessionId: string
  /** The registry row id, kept because `sessions.changed` and the app both speak it. */
  storedId: string
}

export interface Roster {
  bots: WatchedBot[]
  /** The profile `hermie-app` lives on, or empty when the gateway has no default row. */
  defaultProfile: string
  /**
   * The bare `hermie-app` bag exactly as the gateway holds it.
   *
   * The LEGACY key deliberately, and only for the availability stamp
   * `announce.ts` leaves behind. Per-person keys carry a compare-and-swap the
   * app is using, and a write from this side would make that app's next write
   * fail — the same reasoning ADR-0017's amendment gives for the plugin
   * advertising under a key of its own.
   */
  appSection: Record<string, unknown> | null
  /** The revision of `hermie-app` on the default profile; 0 when it has never been written. */
  appRevision: number
  push: PushSection
  /**
   * What the gateway's own `hermie` plugin says about push, off the DEFAULT
   * profile, or `null` when it says nothing this build can read.
   *
   * ADR-0017's amendment: the plugin is the notifier, `hermie-web --push` the
   * fallback, and the two must not both deliver the same notification to the
   * same device. Which ones the plugin can deliver is per transport and per
   * type — see `pluginDelivers`. Optional so a roster written by hand (a test)
   * reads as "no plugin".
   */
  plugin?: PluginPushAdvert | null
}

/** The part of the plugin's advert that decides what this daemon leaves to it. */
export interface PluginPushAdvert {
  /** `modules.push === 'on'`. */
  pushOn: boolean
  capabilities: string[]
  /** The relays the plugin posts to, normalised. */
  relayOrigins: string[]
  /** Epoch seconds, as the plugin wrote it; 0 when absent. */
  updatedAt: number
  /**
   * How often the plugin promises to rewrite `updatedAt`, in seconds, or 0
   * when the advert carries no promise. See `PLUGIN_HEARTBEAT_MISSES`.
   */
  heartbeat: number
}

/** The gateway plugin's advert key. Read-only from here, as from the app. */
export const HERMIE_PLUGIN_KEY = 'hermie-plugin'

/**
 * How many heartbeats an advert may miss before it is no longer believed.
 *
 * The plugin writes its advert when it loads and withdraws it only on a clean
 * unload, so a gateway that was killed and then had the plugin removed leaves
 * `modules.push: "on"` behind for ever — and a daemon that trusted it would
 * stay silent for ever. An advert that carries `heartbeat` (seconds) is
 * believed only while `now - updatedAt < PLUGIN_HEARTBEAT_MISSES × heartbeat`.
 * An advert without one is believed as it stands, which is every plugin
 * released so far; `--push-ignore-plugin` is the operator's way out of that.
 */
export const PLUGIN_HEARTBEAT_MISSES = 3

/**
 * Read the plugin's advert for push, or `null`.
 *
 * The same reading as `pluginAdvertOf` in `@hermie/gateway-client/plugin`
 * (which this package cannot import): `v` must be 1, the version this build
 * understands — an advert from the future is read as no advert, as the app
 * reads it.
 */
export function pluginPushAdvertOf(advert: unknown): PluginPushAdvert | null {
  if (!isObject(advert) || advert.v !== 1) {
    return null
  }

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  const seconds = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

  return {
    pushOn: isObject(advert.modules) && advert.modules.push === 'on',
    capabilities: strings(advert.capabilities),
    relayOrigins: [...new Set(strings(advert.relayOrigins).map(relayOriginOf).filter(Boolean))],
    updatedAt: seconds(advert.updatedAt),
    heartbeat: seconds(advert.heartbeat)
  }
}

/** Is the plugin's push module on, and — where it promised a heartbeat — still alive? */
export function pluginPushLive(plugin: PluginPushAdvert | null | undefined, now: number): boolean {
  if (!plugin?.pushOn) {
    return false
  }

  return plugin.heartbeat === 0 || now - plugin.updatedAt < PLUGIN_HEARTBEAT_MISSES * plugin.heartbeat
}

/**
 * Will the plugin deliver this type to this registration, so this daemon must not?
 *
 *  - **Web Push: never.** A browser subscribes with THIS daemon's VAPID key,
 *    and a push service delivers only to the key a subscription was made
 *    with, so nothing else can reach it.
 *  - **`dm`: never.** Hermes fires no hook for a bot-to-bot DM, so the plugin
 *    cannot produce one; this daemon reads it off the transcript.
 *  - **Expo** only when the advert lists `push.expo`.
 *  - **Relay** only when the advert lists `push.relay` AND the row's relay is
 *    on the plugin's own `relayOrigins` — a row the plugin will not post to is
 *    a row this daemon still serves.
 */
export function pluginDelivers(
  plugin: PluginPushAdvert | null | undefined,
  registration: PushRegistration,
  type: PushType,
  now: number
): boolean {
  if (!plugin || type === 'dm' || !pluginPushLive(plugin, now)) {
    return false
  }

  switch (registration.transport) {
    case 'webpush':
      return false

    case 'expo':
      return plugin.capabilities.includes('push.expo')

    case 'relay':
      return (
        plugin.capabilities.includes('push.relay') &&
        plugin.relayOrigins.includes(relayOriginOf(registration.relay ?? ''))
      )
  }
}

/** Every app-wide key on one profile: the per-person ones, then the legacy one. */
function appKeysOf(bag: Record<string, unknown>): string[] {
  const perPerson = Object.keys(bag)
    .filter(key => key.startsWith(`${HERMIE_APP_KEY}:`))
    .sort()

  // The legacy key is a FALLBACK, not another source. A device that has been
  // migrated wrote itself into a person's key and left its old row behind;
  // pooling both would send to that device twice, which is the one failure a
  // notifier must not have. So the bare key counts only while no person has one.
  return perPerson.length > 0 ? perPerson : [HERMIE_APP_KEY]
}

/**
 * Pool the registrations of every app-wide key, one row per installation.
 *
 * A person is not the unit here: a device is. The same installation appearing
 * under two keys — somebody who signed in as themselves on a gateway that once
 * held an anonymous arrangement — is one phone, and it is notified once. The
 * NEWEST row wins, because that is the one whose token was most recently proved.
 */
function pooledPush(bag: Record<string, unknown>): PushSection {
  const byInstallation = new Map<string, PushSection['registrations'][number]>()
  const seen: Record<string, number> = {}

  for (const key of appKeysOf(bag)) {
    // The key NAMES the person: `hermie-app:<user_id>`. The legacy bare key
    // names nobody, and a row out of it carries `''` — which every
    // service-level rule reads as "this service has decided nothing about
    // whoever this is", the same answer a person nobody has configured gets.
    const owner = key.startsWith(`${HERMIE_APP_KEY}:`) ? key.slice(HERMIE_APP_KEY.length + 1) : ''
    const section = readPushSection(isObject(bag[key]) ? bag[key] : null, owner)

    for (const registration of section.registrations) {
      const held = byInstallation.get(registration.installationId)

      if (!held || registration.updatedAt >= held.updatedAt) {
        byInstallation.set(registration.installationId, registration)
      }
    }

    for (const [installationId, stamp] of Object.entries(section.seen)) {
      // The LATEST heartbeat, so a chat somebody is reading on one of their
      // devices stays suppressed however many keys mention it.
      seen[installationId] = Math.max(seen[installationId] ?? 0, stamp)
    }
  }

  return {
    registrations: [...byInstallation.values()].sort((a, b) => a.installationId.localeCompare(b.installationId)),
    seen
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function readRoster(result: unknown): Roster {
  const rows = Array.isArray((result as { profiles?: unknown } | null)?.profiles)
    ? ((result as { profiles: unknown[] }).profiles as Record<string, unknown>[])
    : []
  const bots: WatchedBot[] = []
  let defaultProfile = ''
  let appSection: Record<string, unknown> | null = null
  let appRevision = 0
  let push: PushSection = { registrations: [], seen: {} }
  // The DEFAULT profile's advert only: it is the profile `hermie-app` lives on,
  // and an advert on some other profile is not one this daemon can tell from a
  // leftover.
  let plugin: PluginPushAdvert | null = null

  for (const row of rows) {
    const name = str(row?.name)

    if (!name) {
      continue
    }

    if (row.is_default === true) {
      plugin = pluginPushAdvertOf(isObject(row.ui_meta) ? row.ui_meta[HERMIE_PLUGIN_KEY] : null)
    }

    const canonical = isObject(row.canonical_session) ? row.canonical_session : null
    // `resolved_id` first: a chat that has been compressed lives on under a new
    // id, and resuming the registry row would attach to the wrong end of it.
    const sessionId = canonical ? str(canonical.resolved_id) || str(canonical.id) : ''

    if (sessionId) {
      bots.push({
        name,
        label: str(row.display_name) || name,
        sessionId,
        storedId: canonical ? str(canonical.id) || sessionId : sessionId
      })
    }

    if (row.is_default === true) {
      defaultProfile = name
      const bag = isObject(row.ui_meta) ? row.ui_meta : null
      appSection = bag && isObject(bag[HERMIE_APP_KEY]) ? (bag[HERMIE_APP_KEY] as Record<string, unknown>) : null
      const revisions = isObject(row.ui_meta_revisions) ? row.ui_meta_revisions : {}
      const revision = revisions[HERMIE_APP_KEY]
      appRevision = typeof revision === 'number' && Number.isFinite(revision) ? revision : 0
      push = pooledPush(bag ?? {})
    }
  }

  // A stable order, so a run's log reads the same twice; object key order off a
  // wire is not a promise anybody made.
  bots.sort((a, b) => a.name.localeCompare(b.name))

  return { bots, defaultProfile, appSection, appRevision, push, plugin }
}
