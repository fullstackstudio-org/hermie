/**
 * ADR-0017's registration, from the device's side of it.
 *
 * [ADR-0017](../../../docs/adr/0017-push-through-hermie-web.md) puts a device's
 * push registration in the `hermie-app` key of the default profile's `ui_meta`
 * rather than at an endpoint: the app never talks to the daemon, so there is no
 * inbound surface and nothing on the network can make a phone buzz. The daemon's
 * READER lives in `packages/hermie-web/src/push/registrations.ts`; this is the
 * WRITER, and it is here rather than in the app because the browser build and
 * the native build both have to produce the same bytes.
 *
 * Two properties are the whole of what this module exists for, and both are
 * about a section that belongs to more than one device:
 *
 *  - **A write carries the neighbours.** ADR-0016 replaces a `ui_meta` section
 *    WHOLE — there is no merge — so a device that wrote only its own row would
 *    silently unregister every other device the moment it changed a toggle. The
 *    rows this device did not write are read back and passed through untouched,
 *    including rows whose `v` this build does not understand: carrying bytes
 *    forward needs no schema, and dropping a future build's row because it is
 *    unreadable here would turn a version skew into a phone that goes quiet.
 *  - **The address decides the shape.** `token` for `expo`, `endpoint` + `keys`
 *    for `webpush`, `relay` + `handle` + `secret` for `relay`, never two of
 *    them — the reader drops an entry that carries the fields of two transports
 *    rather than guessing which one was meant, so a writer that emitted both
 *    would be writing an entry that is ignored.
 *
 * The `relay` transport was added without bumping `v`. A reader that predates
 * it already drops a row whose transport it does not know, and every writer
 * already carries rows it did not write, so an older notifier simply does not
 * send to a relay row and an older app does not delete one. Bumping `v` would
 * have bought nothing and cost the same drop.
 *
 * Nothing here talks to a gateway. The section this builds is handed to
 * `UiMetaSync` as part of the app-wide snapshot, which is what gives it the
 * compare-and-swap, the retry and the local-only fallback for free.
 */

/** The section version this build writes. The reader checks it per row. */
export const PUSH_SECTION_VERSION = 1

/** Where the registrations sit inside the `hermie-app` key. */
export const PUSH_SECTION_KEY = 'push'

/**
 * Every event a device can ask about. A registration that names none is off.
 *
 * `dm` is deliberately NOT here any more. ADR-0017's amendment records why: a
 * bot-to-bot DM has no hook in Hermes, so the plugin — which is now the default
 * notifier — cannot produce one and does not advertise it. The type stays in
 * the wire schema, because a registration written by an older build still
 * carries it and `hermie-web --push` can still send one; what changed is that
 * this app no longer offers a switch for something that will never arrive.
 *
 * `turn_done` and `turn_failed` are the amendment's two additions, from
 * `on_session_end`. An INTERRUPTED turn is deliberately neither: somebody
 * pressed stop, and they know.
 *
 * `cron_done` and `cron_failed` are the same two events seen from inside a
 * SCHEDULED run, and they are separate types rather than a flag on `cron`
 * because they answer a different question. `cron` is the delivery — the
 * routine reported, here is what it said. The other two are the run's own
 * outcome, and the one somebody actually wants at three in the morning is
 * `cron_failed`: a routine that was supposed to happen and did not. Folding
 * them into `cron` would mean switching off the nightly digest's chatter also
 * switches off being told it stopped running.
 *
 * The order is the order the switches are drawn in, so this array is the
 * screen's running order as well as the wire's list.
 */
export const PUSH_TYPES = [
  'message',
  'request',
  'cron',
  'cron_done',
  'cron_failed',
  'turn_done',
  'turn_failed'
] as const

export type PushType = (typeof PUSH_TYPES)[number]

export type PushTransport = 'expo' | 'webpush' | 'relay'

export interface WebPushKeys {
  p256dh: string
  auth: string
}

/**
 * The push relay the project operates, and the one origin every sender's
 * allow-list starts with.
 *
 * A relay row NAMES its relay, but a sender never posts to whatever a row
 * names: it posts only to an origin on its own allow-list, and this is the
 * default content of that list. A row is data written by anybody who can write
 * `ui_meta`, and an address in it that a sender followed blindly would be a
 * request forgery with the gateway's network position behind it.
 */
export const PUSH_RELAY_ORIGIN = 'https://push.hermie.dev'

/** The platforms a relay registration can be for. The relay speaks APNs only, for now. */
export const PUSH_RELAY_PLATFORMS = ['ios', 'macos'] as const

export type PushRelayPlatform = (typeof PUSH_RELAY_PLATFORMS)[number]

/**
 * A relay address: the relay's origin, the device's public handle there, and
 * the send secret that authorises one message to that one device.
 *
 * `enc` is the device's end-to-end key (step 2 of the relay design). This build
 * neither produces nor reads it; it is carried untouched so that a writer
 * which does not understand it cannot strip it from a row that has one.
 */
export interface PushRelayAddress {
  transport: 'relay'
  relay: string
  handle: string
  secret: string
  enc?: unknown
}

/**
 * Where a notification is sent, as the platform handed it over.
 *
 * A union rather than a bag of optional fields, because "both" is the one shape
 * the daemon refuses and a type that can express it is a type that will.
 */
export type PushAddress =
  | { transport: 'expo'; token: string }
  | { transport: 'webpush'; endpoint: string; keys: WebPushKeys }
  | PushRelayAddress

/** This device's registration, before it becomes a row. */
export interface PushRegistrationInput {
  installationId: string
  /**
   * `gatewayKeyOf` the gateway this registration was made on.
   *
   * The notifier already knows which gateway it is — it is the one it is
   * connected to — so this is not there to tell it. It is there so the
   * notification it SENDS can carry the key, and so a device reading the
   * section back can tell its own row from a row it wrote against a gateway it
   * has since renamed or re-addressed. Empty when the address will not parse,
   * which reads everywhere as "no key".
   */
  gatewayKey?: string
  address: PushAddress
  /**
   * `ios`, `macos`, `android` or `web`. Informational for `expo` and `webpush`;
   * a `relay` row must say `ios` or `macos`, the platforms the relay reaches.
   */
  platform: string
  types: Record<PushType, boolean>
  /** Whether this device wants the message text as well as the bot's name. */
  preview: boolean
  /** Seconds, not milliseconds: the daemon compares it against `time.time()`. */
  updatedAt: number
}

/**
 * Who is looking at what, right now.
 *
 * ADR-0017 made `seen` a bare stamp meaning "this device is reading SOMETHING".
 * That was enough to suppress a notification for the device holding the chat
 * open and not enough to avoid suppressing one for a different chat on the same
 * device — a phone with the researcher's chat on screen was, as far as the
 * notifier could tell, reading every chat at once. The chat name is what closes
 * that, and it is the whole of the change.
 *
 * An empty `bot` is honest rather than exceptional: it is what a bare stamp off
 * an older build normalises to, and it means "looking at some chat", which is
 * exactly what that build was able to say.
 */
export interface PushSeenEntry {
  bot: string
  /** Unix seconds. */
  at: number
}

/**
 * What one chat wants, where it differs from the global types.
 *
 * PARTIAL on purpose, and that is the whole design: a type this bag does not
 * mention follows the global setting as the global setting moves. A full
 * `Record<PushType, boolean>` would freeze every type at whatever it happened
 * to be the day the reader touched one of them, which is the same mistake a
 * chat's view override would make if it copied all three switches instead of
 * the one that was changed.
 */
export type PushTypeOverrides = Partial<Record<PushType, boolean>>

/** Where the per-chat overrides sit inside the `push` section. */
export const PUSH_PER_BOT_KEY = 'perBot'

/**
 * The global types with one chat's overrides folded in.
 *
 * Stated here, in the package both sides import, so that the app's switches and
 * the notifier's decision cannot be two different rules that happen to agree.
 */
export function effectivePushTypes(
  global: Record<PushType, boolean>,
  overrides: PushTypeOverrides | undefined
): Record<PushType, boolean> {
  const out = { ...global }

  for (const type of PUSH_TYPES) {
    const override = overrides?.[type]

    if (typeof override === 'boolean') {
      out[type] = override
    }
  }

  return out
}

/** The section as it travels, which is a plain bag both sides read defensively. */
export interface PushSectionShape {
  registrations: Record<string, unknown>
  /**
   * Chat name → the types that chat overrides. Absent when nothing is overridden.
   *
   * Beside the registrations rather than inside a row, because this is a
   * decision about the READER and not about a device: somebody who silences the
   * cron deliveries of one bot means it on their phone and on their Mac. It is
   * the same argument `mutes` makes for living in the app-wide section rather
   * than on a bot's own profile.
   *
   * An ADDITIVE field and the section version is deliberately NOT bumped for
   * it. `v` is checked per ROW and an unreadable row is DROPPED — so bumping
   * would not protect this key from an older notifier, it would unregister the
   * device and make the phone go quiet. A notifier that does not know the field
   * keeps sending what the global types say, which is exactly what it did
   * before the field existed.
   */
  perBot?: Record<string, PushTypeOverrides>
  /**
   * Object per device where the gateway can read one, bare number otherwise.
   *
   * The two shapes exist at once on purpose. A plugin that predates
   * `push.seen.per_chat` reads a number and would see an object as unreadable,
   * which is a device that looks permanently away and therefore a notification
   * for every chat it is actually reading. So the app writes the shape the
   * gateway has said it can read, and reads both.
   */
  seen: Record<string, PushSeenEntry | number>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Epoch SECONDS from a millisecond clock, floored — the daemon's unit. */
export const pushStampOf = (nowMs: number): number => Math.floor(nowMs / 1000)

/** Every type off. The starting point, and what a device that never opted in sends. */
export function noPushTypes(): Record<PushType, boolean> {
  const types = {} as Record<PushType, boolean>

  for (const type of PUSH_TYPES) {
    types[type] = false
  }

  return types
}

/** Read a types bag defensively: absent means OFF, exactly as the daemon reads it. */
export function pushTypesOf(value: unknown): Record<PushType, boolean> {
  const source = isObject(value) ? value : {}
  const types = noPushTypes()

  for (const type of PUSH_TYPES) {
    types[type] = source[type] === true
  }

  return types
}

/**
 * A types bag read from THIS device's own disk, with a new type taking its
 * default rather than reading as off.
 *
 * `pushTypesOf` above is the wire's rule and it is the right one there: a
 * registration that does not name a type cannot have agreed to it, so a type
 * this build has just invented must not start notifying every device that
 * predates it. Locally the question is the opposite one. The bag on disk is
 * what the reader last CHOSE, and a type that did not exist when they chose is
 * not a refusal — it is a switch they have never been shown.
 *
 * So a key that is present and boolean wins, always: somebody who turned the
 * cron deliveries off meant it, and an upgrade must not turn them back on. A
 * key that is ABSENT takes the default, which is how the owner's rule — every
 * push type on unless it was switched off — survives the release that adds one.
 * Without it an upgrade is a phone that silently never mentions the routine
 * that stopped running, with a switch in Settings that has looked on the whole
 * time.
 */
export function adoptedPushTypes(stored: unknown, defaults: Record<PushType, boolean>): Record<PushType, boolean> {
  const source = isObject(stored) ? stored : {}
  const types = {} as Record<PushType, boolean>

  for (const type of PUSH_TYPES) {
    types[type] = typeof source[type] === 'boolean' ? (source[type] as boolean) : defaults[type] === true
  }

  return types
}

/** True when this registration has asked about nothing, which is "off". */
export const noTypeWanted = (types: Record<PushType, boolean>): boolean =>
  PUSH_TYPES.every(type => types[type] !== true)

/**
 * One device's row.
 *
 * Exported on its own so a test can assert the bytes rather than the round trip,
 * and so the browser build and the native build cannot drift into two shapes.
 */
export function pushRowFor(input: PushRegistrationInput): Record<string, unknown> {
  const common = {
    v: PUSH_SECTION_VERSION,
    platform: input.platform,
    types: { ...input.types },
    preview: input.preview,
    // Omitted rather than written empty: a row saying its gateway key is the
    // empty string is a row claiming a key, and every reader of one checks for
    // absence rather than for a falsy value.
    ...(input.gatewayKey ? { gatewayKey: input.gatewayKey } : {}),
    updatedAt: input.updatedAt
  }

  const address = input.address

  switch (address.transport) {
    case 'expo':
      return { ...common, transport: 'expo', token: address.token }

    case 'webpush':
      return {
        ...common,
        transport: 'webpush',
        endpoint: address.endpoint,
        keys: { p256dh: address.keys.p256dh, auth: address.keys.auth }
      }

    case 'relay':
      return {
        ...common,
        transport: 'relay',
        relay: address.relay,
        handle: address.handle,
        secret: address.secret,
        // Carried as it came, never rebuilt: this build does not know the
        // shape, and a writer that only kept the fields it understood would
        // strip a newer device's key the first time it touched the row.
        ...(address.enc !== undefined ? { enc: address.enc } : {})
      }
  }
}

/**
 * A relay origin, normalised, or `''` when the value is not one.
 *
 * `https:` only, no credentials, and nothing after the host and port but an
 * optional single `/`. A relay is an origin, and a value carrying a path, a
 * query, a fragment or anything the URL parser would quietly rewrite
 * (`/./`, `//`, a trailing `?`, an explicit default port) is either a mistake
 * or an attempt to make a sender post somewhere else on a host it trusts, so it
 * is refused rather than repaired. Only case is forgiven, because the parser
 * lowercases the host and the scheme and nothing else differs.
 */
export function pushRelayOriginOf(value: unknown): string {
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

/** True when `origin` is on `allowList`, both compared as normalised origins. */
export function pushRelayAllowed(origin: unknown, allowList: readonly string[]): boolean {
  const wanted = pushRelayOriginOf(origin)

  return Boolean(wanted) && allowList.some(entry => pushRelayOriginOf(entry) === wanted)
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/**
 * What a relay `handle` and `secret` may look like: base64url characters, 1 to
 * 200 of them. The relay mints `h_` plus 22 characters and 43-character
 * secrets and refuses anything over 200, so a row outside this is either
 * corrupt or not the relay's, and a sender that posted it would only learn
 * that from a refused request.
 */
export const PUSH_RELAY_CREDENTIAL = /^[A-Za-z0-9_-]{1,200}$/

const relayCredential = (value: unknown): value is string =>
  typeof value === 'string' && PUSH_RELAY_CREDENTIAL.test(value)

/**
 * The address a row names, or `null` when a sender must not use it.
 *
 * The reader's rules, stated once in the package both sides import and
 * restated in the daemon (which cannot import it): `v` must be this version;
 * an `expo` row needs a token, a `webpush` row an endpoint and both keys, a
 * `relay` row an https relay origin, a handle and a secret of 1 to 200
 * base64url characters each, and a platform it can reach. A row carrying the address fields of two transports is a confusion and
 * is refused rather than resolved in favour of one, and an unknown transport is
 * refused rather than guessed at. Validity says nothing about the allow-list:
 * whether a sender will post to a valid relay row is the sender's decision.
 */
export function pushAddressOf(value: unknown): PushAddress | null {
  if (!isObject(value) || value.v !== PUSH_SECTION_VERSION) {
    return null
  }

  /*
    Two strengths of "carries another transport's field", on purpose. The
    `expo` and `webpush` rules are the daemon's since before the relay, which
    looks for a NON-EMPTY token or endpoint, and they are kept exactly so that
    no Expo or Web Push row changes meaning. The relay's own rules are new and
    strict: any token, endpoint or handle that is present at all is a second
    address, empty or not.
  */
  const hasToken = value.token !== undefined
  const hasEndpoint = value.endpoint !== undefined
  const hasHandle = value.handle !== undefined

  switch (value.transport) {
    case 'expo':
      return nonEmptyString(value.token) && !nonEmptyString(value.endpoint) && !hasHandle
        ? { transport: 'expo', token: value.token }
        : null

    case 'webpush': {
      const keys = isObject(value.keys) ? value.keys : {}

      return nonEmptyString(value.endpoint) &&
        nonEmptyString(keys.p256dh) &&
        nonEmptyString(keys.auth) &&
        !nonEmptyString(value.token) &&
        !hasHandle
        ? { transport: 'webpush', endpoint: value.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }
        : null
    }

    case 'relay': {
      const relay = pushRelayOriginOf(value.relay)

      if (
        !relay ||
        !relayCredential(value.handle) ||
        !relayCredential(value.secret) ||
        hasToken ||
        hasEndpoint ||
        !(PUSH_RELAY_PLATFORMS as readonly unknown[]).includes(value.platform)
      ) {
        return null
      }

      return {
        transport: 'relay',
        relay,
        handle: value.handle,
        secret: value.secret,
        ...(value.enc !== undefined ? { enc: value.enc } : {})
      }
    }

    default:
      return null
  }
}

/**
 * The rows in a section that some OTHER installation wrote.
 *
 * Deliberately unvalidated. This is what a write carries forward, and a row is
 * carried because of who wrote it, not because this build can read it — see the
 * note at the top. The one thing it will not carry is a row under this device's
 * own id, which is ours to replace.
 */
export function foreignPushRows(section: unknown, installationId: string): Record<string, unknown> {
  const push = isObject(section) ? section[PUSH_SECTION_KEY] : null
  const rows = isObject(push) && isObject(push.registrations) ? push.registrations : {}
  const out: Record<string, unknown> = {}

  for (const [id, row] of Object.entries(rows)) {
    if (id && id !== installationId && row !== null && row !== undefined) {
      out[id] = row
    }
  }

  return out
}

/**
 * The `seen` entries in a section, dropping anything unreadable.
 *
 * Both shapes are accepted. A bare number is what every build before
 * `push.seen.per_chat` wrote, and it becomes an entry with no bot name — which
 * is precisely as much as it ever said.
 */
export function pushSeenOf(section: unknown): Record<string, PushSeenEntry> {
  const push = isObject(section) ? section[PUSH_SECTION_KEY] : null
  const raw = isObject(push) && isObject(push.seen) ? push.seen : {}
  const out: Record<string, PushSeenEntry> = {}

  for (const [id, value] of Object.entries(raw)) {
    if (!id) {
      continue
    }

    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[id] = { bot: '', at: Math.floor(value) }
      continue
    }

    if (isObject(value) && typeof value.at === 'number' && Number.isFinite(value.at) && value.at > 0) {
      out[id] = { bot: typeof value.bot === 'string' ? value.bot : '', at: Math.floor(value.at) }
    }
  }

  return out
}

/**
 * Read the per-chat overrides defensively: they arrive from a wire.
 *
 * A key with nothing recognisable under it is dropped rather than kept as an
 * empty bag, because an empty bag and an absent one mean the same thing and one
 * of them costs a revision every time the section is written.
 */
export function pushPerBotOf(section: unknown): Record<string, PushTypeOverrides> {
  const push = isObject(section) ? section[PUSH_SECTION_KEY] : null
  const raw =
    isObject(push) && isObject(push[PUSH_PER_BOT_KEY]) ? (push[PUSH_PER_BOT_KEY] as Record<string, unknown>) : {}
  const out: Record<string, PushTypeOverrides> = {}

  for (const [bot, value] of Object.entries(raw)) {
    if (!bot || !isObject(value)) {
      continue
    }

    const overrides: PushTypeOverrides = {}

    for (const type of PUSH_TYPES) {
      if (typeof value[type] === 'boolean') {
        overrides[type] = value[type] as boolean
      }
    }

    if (Object.keys(overrides).length) {
      out[bot] = overrides
    }
  }

  return out
}

/**
 * How long a `seen` stamp is kept before it is swept out of the section.
 *
 * It is not the daemon's suppression window — that is the daemon's to choose and
 * is much shorter. This is only about a section that would otherwise accumulate
 * one number per device that ever read a chat, for ever. A day is long enough
 * that no live device is ever dropped and short enough that a phone which was
 * reinstalled stops taking up room.
 */
export const PUSH_SEEN_TTL_SECONDS = 86_400

export interface PushSectionInput {
  /** Rows belonging to other installations, from `foreignPushRows`. */
  others: Record<string, unknown>
  /** This device's registration, or `null` when it is off. */
  own: PushRegistrationInput | null
  /** Every `seen` entry this device knows about, including its own. */
  seen: Record<string, PushSeenEntry>
  /** Chat name → the types that chat overrides. Empty writes nothing. */
  perBot?: Record<string, PushTypeOverrides>
  /** Epoch seconds. Sweeps `seen`; does NOT stamp the registration. */
  now: number
  /**
   * Whether the gateway said it can read the `{bot, at}` shape.
   *
   * False writes a bare number, which is what an older plugin understands.
   * A device's own chat name is then simply not said, rather than said into a
   * field nothing reads — see `PushSectionShape.seen`.
   */
  perChat?: boolean
}

/**
 * The whole `push` section, or `undefined` when there is nothing to say.
 *
 * `undefined` rather than an empty object on purpose: the caller spreads the
 * result into the app-wide section, and a `push: {registrations: {}, seen: {}}`
 * on a profile belonging to somebody who has never turned notifications on is a
 * key that means nothing and a revision that moves for no reason.
 */
export function pushSectionFor(input: PushSectionInput): PushSectionShape | undefined {
  const registrations: Record<string, unknown> = { ...input.others }

  if (input.own && input.own.installationId && !noTypeWanted(input.own.types)) {
    registrations[input.own.installationId] = pushRowFor(input.own)
  }

  const seen: Record<string, PushSeenEntry | number> = {}

  for (const [id, entry] of Object.entries(input.seen)) {
    // A stamp from the future is a device with a wrong clock, not a reason to
    // drop it: only the old ones are swept.
    if (entry.at > 0 && input.now - entry.at <= PUSH_SEEN_TTL_SECONDS) {
      seen[id] = input.perChat ? { bot: entry.bot, at: entry.at } : entry.at
    }
  }

  const perBot: Record<string, PushTypeOverrides> = {}

  for (const [bot, overrides] of Object.entries(input.perBot ?? {})) {
    if (bot && overrides && Object.keys(overrides).length) {
      perBot[bot] = { ...overrides }
    }
  }

  const has = Object.keys(registrations).length || Object.keys(seen).length || Object.keys(perBot).length

  if (!has) {
    return undefined
  }

  // Omitted rather than empty, for the reason the doc comment above gives about
  // the section as a whole: a key that means nothing still moves a revision.
  return { registrations, seen, ...(Object.keys(perBot).length ? { perBot } : {}) }
}
