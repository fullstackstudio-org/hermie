/**
 * The devices that asked to be told, as they appear on the gateway.
 *
 * [ADR-0017](../../../../docs/adr/0017-push-through-hermie-web.md) puts a
 * device's push registration in its own `ui_meta` section rather than at an
 * endpoint on this process: the app never talks to the daemon, so there is no
 * inbound surface and nothing on the network can make a phone buzz. What
 * reaches this module is therefore a bag of JSON that came off a gateway, and
 * it is read the way anything off a wire is read — one unreadable entry costs
 * that entry and nothing else.
 *
 * The schema is ADR-0017's, and `v` is checked rather than assumed. A reader
 * that meets a version it does not know DROPS that registration instead of
 * guessing at a shape: the cost is one device that stops being notified until
 * it is updated, and the alternative is sending a token somewhere it does not
 * belong.
 */

/** The section version this build writes and accepts. */
export const PUSH_SECTION_VERSION = 1

/** Where the registrations sit inside the `hermie-app` key. */
export const PUSH_SECTION_KEY = 'push'

/**
 * The app-wide `ui_meta` key, on the default profile.
 *
 * [ADR-0016](../../../../docs/adr/0016-ui-meta-sync.md) put it there because the
 * default row is the one every client can find without being told which bot to
 * ask, and ADR-0017 hangs `push` off it for the same reason.
 */
export const HERMIE_APP_KEY = 'hermie-app'

/**
 * Every event a device can ask about. A registration that names none is off.
 *
 * `dm` is still here although the app no longer offers a switch for it: this
 * daemon CAN produce one — it reads the inbound row itself and a bot-to-bot
 * header is right there in it — and a registration written by a build that
 * still asked for it is a device that still wants it.
 *
 * `cron_done` and `cron_failed` are the finer grain of `cron`, and they exist
 * for the case `cron` alone cannot say: a routine whose chatter is noise but
 * whose failure is not. `cron` stays the coarse switch and keeps meaning what
 * it always meant, so a device that asked only for it goes on being told about
 * scheduled runs — see `watcher.ts`, where the two audiences are joined.
 */
export const PUSH_TYPES = ['message', 'request', 'dm', 'cron', 'cron_done', 'cron_failed'] as const

export type PushType = (typeof PUSH_TYPES)[number]

export type PushTransport = 'expo' | 'webpush' | 'relay'

/** The platforms a relay row can be for: the relay speaks APNs only. */
const RELAY_PLATFORMS: readonly string[] = ['ios', 'macos']

/** A relay handle or secret: 1 to 200 base64url characters, as `@hermie/gateway-client` says. */
const RELAY_CREDENTIAL = /^[A-Za-z0-9_-]{1,200}$/

export interface WebPushKeys {
  p256dh: string
  auth: string
}

export interface PushRegistration {
  /** The installation that wrote it; the key it was stored under. */
  installationId: string
  /**
   * The person whose `hermie-app:<user_id>` section this row came out of, or
   * `''` for the legacy anonymous key.
   *
   * Not on the wire and not the app's: it is the KEY NAME, carried alongside
   * the row so that a service-level decision about one person — "this account
   * may not be notified", "this account may only reach these bots" — has
   * somebody to be about. Without it the pool is a list of devices with no
   * owner, which is all a notifier ever needed and not enough for an operator.
   */
  owner: string
  transport: PushTransport
  /** Expo only: the push token, which is the whole address. */
  token?: string
  /** Web Push only: the subscription endpoint and its keys. */
  endpoint?: string
  keys?: WebPushKeys
  /**
   * Relay only: the relay's origin as the ROW names it (normalised), the
   * device's handle there and the send secret. The origin is a claim, not an
   * instruction: `relay.ts` posts only to an origin on its own allow-list.
   */
  relay?: string
  handle?: string
  secret?: string
  /** Relay only: the device's end-to-end key, carried and never interpreted. */
  enc?: unknown
  platform: string
  types: Record<PushType, boolean>
  /**
   * Whether this device gets the message text as well as the bot's name.
   *
   * The EFFECTIVE value, not the row's: a relay row reads as `false` whatever
   * it says. The relay design's privacy rule is that message text never crosses
   * the relay in plaintext, and this build cannot encrypt for a row's `enc`, so
   * every relay registration is sent the bot name and the event type only.
   * Deciding it here, where the row is read, puts the relay rows in the
   * no-preview pass of the one send loop every transport shares.
   */
  preview: boolean
  updatedAt: number
}

export interface PushSection {
  registrations: PushRegistration[]
  /** installation id → the last time that device said a chat was on screen. */
  seen: Record<string, number>
}

const EMPTY: PushSection = { registrations: [], seen: {} }

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function typesOf(value: unknown): Record<PushType, boolean> {
  const source = (value ?? {}) as Record<string, unknown>
  const out = {} as Record<PushType, boolean>

  for (const type of PUSH_TYPES) {
    // Absent means OFF. A device that has never heard of a type cannot have
    // agreed to it, and a new event kind must not start notifying every
    // registration that predates it.
    out[type] = source[type] === true
  }

  return out
}

/**
 * A relay origin, normalised, or `''`.
 *
 * The second copy of `pushRelayOriginOf` in `@hermie/gateway-client` — this
 * package cannot import it, for the reason `./gateway-key.ts` gives. The rule
 * is short enough to restate and the shared vectors in
 * `contract/gateway/vectors/push.json` are how the two prove they agree:
 * `https:` only, no credentials, nothing after the host and port but an
 * optional `/`, and nothing the URL parser would have to rewrite.
 */
export function relayOriginOf(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    return ''
  }

  let url: URL

  try {
    url = new URL(value)
  } catch {
    return ''
  }

  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    return ''
  }

  const spelled = value.toLowerCase()

  return spelled === url.origin || spelled === `${url.origin}/` ? url.origin : ''
}

/**
 * Read one registration, or nothing.
 *
 * The address is what decides: an `expo` entry is useless without its token, a
 * `webpush` one without its endpoint AND both keys, and a `relay` one without
 * an https relay origin, a handle and a secret of 1 to 200 base64url
 * characters each, and an Apple platform. An entry
 * that carries the fields of two transports is a confusion rather than a choice
 * — it is dropped rather than resolved in favour of one. The same rules as
 * `pushAddressOf` in `@hermie/gateway-client`.
 */
export function pushRegistrationOf(installationId: string, value: unknown, owner = ''): PushRegistration | null {
  if (!installationId || !value || typeof value !== 'object') {
    return null
  }

  const row = value as Record<string, unknown>

  if (num(row.v) !== PUSH_SECTION_VERSION) {
    return null
  }

  const transport = str(row.transport)
  const token = str(row.token)
  const endpoint = str(row.endpoint)
  const keys = (row.keys ?? {}) as Record<string, unknown>
  const p256dh = str(keys.p256dh)
  const auth = str(keys.auth)
  // Presence, not truthiness, for the fields of ANOTHER transport: an empty
  // handle beside a token is still a row that names two addresses.
  const hasToken = row.token !== undefined
  const hasEndpoint = row.endpoint !== undefined
  const hasHandle = row.handle !== undefined

  const common = {
    installationId,
    owner,
    platform: str(row.platform) || 'unknown',
    types: typesOf(row.types),
    preview: row.preview === true,
    updatedAt: num(row.updatedAt)
  }

  if (transport === 'expo') {
    return token && !endpoint && !hasHandle ? { ...common, transport: 'expo', token } : null
  }

  if (transport === 'webpush') {
    return endpoint && p256dh && auth && !token && !hasHandle
      ? { ...common, transport: 'webpush', endpoint, keys: { auth, p256dh } }
      : null
  }

  if (transport === 'relay') {
    const relay = relayOriginOf(row.relay)
    const handle = str(row.handle)
    const secret = str(row.secret)

    if (
      !relay ||
      !RELAY_CREDENTIAL.test(handle) ||
      !RELAY_CREDENTIAL.test(secret) ||
      hasToken ||
      hasEndpoint ||
      !RELAY_PLATFORMS.includes(str(row.platform))
    ) {
      return null
    }

    return {
      ...common,
      // The relay design's privacy rule — see `PushRegistration.preview`.
      preview: false,
      transport: 'relay',
      relay,
      handle,
      secret,
      ...(row.enc !== undefined ? { enc: row.enc } : {})
    }
  }

  return null
}

/** Read the whole `push` section out of a `hermie-app` bag. */
export function readPushSection(section: unknown, owner = ''): PushSection {
  const push = (section as { push?: unknown } | null)?.push

  if (!push || typeof push !== 'object') {
    return EMPTY
  }

  const body = push as Record<string, unknown>
  const rows = (body.registrations ?? {}) as Record<string, unknown>
  const registrations: PushRegistration[] = []

  for (const [installationId, value] of Object.entries(rows)) {
    const registration = pushRegistrationOf(installationId, value, owner)

    if (registration) {
      registrations.push(registration)
    }
  }

  const rawSeen = (body.seen ?? {}) as Record<string, unknown>
  const seen: Record<string, number> = {}

  for (const [installationId, value] of Object.entries(rawSeen)) {
    /*
      Two shapes. A bare number is what every app before `push.seen.per_chat`
      wrote; `{bot, at}` is what a newer one writes where the gateway said it
      could be read. This daemon suppresses on "somebody is reading SOMETHING",
      which is what the number always meant, so it takes `at` and ignores the
      chat name — over-suppressing in the direction ADR-0017 already chose,
      rather than reading a newer section as a device that looks away for ever.
    */
    const at =
      value && typeof value === 'object' && !Array.isArray(value) ? num((value as { at?: unknown }).at) : num(value)

    if (at > 0) {
      seen[installationId] = at
    }
  }

  // A stable order, so a run's log and a test read the same twice. The gateway
  // hands back an object, and object key order is not a promise anybody made.
  registrations.sort((a, b) => a.installationId.localeCompare(b.installationId))

  return { registrations, seen }
}

/** The registrations that asked about this kind of event. */
export function registrationsFor(section: PushSection, type: PushType): PushRegistration[] {
  return section.registrations.filter(registration => registration.types[type])
}

/**
 * The registrations that asked about ANY of these, each named once.
 *
 * One fact can answer to two switches. A scheduled run that finished is both
 * "the routine reported" (`cron`) and "the run ended" (`cron_done`), and the
 * two exist precisely so that somebody can want one without the other — so the
 * audience is the union and not the intersection, or adding the finer type
 * would have silenced the coarse one for every device that had it on.
 *
 * Deduped by installation, because the union is where one device would
 * otherwise be sent the same notification twice for the same event.
 */
export function registrationsForAny(section: PushSection, types: readonly PushType[]): PushRegistration[] {
  return section.registrations.filter(registration => types.some(type => registration.types[type]))
}

/**
 * Was any device looking at a chat within the window?
 *
 * The gateway cannot be asked who is attached — `session.active_list` reports
 * the CALLING connection's own session and nobody else's — so ADR-0017 makes
 * this a heartbeat the app writes and this reads. It is a heuristic and it
 * fails towards a redundant notification for a chat somebody is already
 * reading, which is the right direction.
 */
export function someoneAttached(section: PushSection, now: number, windowSeconds: number): boolean {
  return Object.values(section.seen).some(at => now - at <= windowSeconds)
}
