/**
 * What the share extension needs to send something itself, decided by the app.
 *
 * The third versioned file in the shared container, beside `widget-snapshot.json`
 * and the outbox — and the one that made ADR-0026 possible without giving an
 * extension a mind of its own. The snapshot already tells the sheet WHICH bots
 * exist; this tells it which conversation each of those bots is, and in which
 * words to report what happened.
 *
 * ## Why the session id has to come from here
 *
 * "Send this to Ada" is not enough to submit a prompt. `prompt.submit` addresses
 * a session, and working out which session is a bot's chat is three decisions
 * the app makes and an extension must not: the canonical chat is found by a
 * title convention over `session.list`, the reader may have switched that bot to
 * a private chat of their own, and a bot with no chat yet needs one minted. The
 * last of those is the dangerous one — `bots-controller` FAILS CLOSED on a
 * failed lookup precisely because minting a second forever-chat cannot be
 * undone. An extension repeating that reasoning from a three-second process with
 * a stale roster would get it wrong occasionally and permanently.
 *
 * So the app writes down the answer it already has. The extension spells the id
 * back and resumes it; if the id is not here, or the gateway refuses it, the
 * entry stays and the app delivers it later. That is the same shape as every
 * other consequence in ADR-0023: the surface is one app launch out of date, and
 * being out of date costs latency rather than correctness.
 *
 * ## Why the sentences are here too
 *
 * A share extension has no access to the app's translations — it is a separate
 * binary, with its own bundle, and the app's i18n is a JavaScript module inside
 * a JavaScript runtime that is not running. Two sentences therefore travel in
 * this file, already in the reader's language, and the extension draws whichever
 * it needs. Hard-coded English in Swift would have been a fourth place where the
 * app's voice is decided, and it would have been the only one that could not be
 * translated at all.
 *
 * Nothing here is secret. A session id is opaque, a profile name is already in
 * the snapshot next to a preview of its last message, and the sentences are
 * sentences. The CREDENTIAL does not live here — see `delivery-credential.ts`,
 * which puts it in the keychain for exactly this reason.
 */

/** Bumped when a field changes meaning or goes. Adding an OPTIONAL one is free. */
export const SHARE_TARGETS_VERSION = 1

/** The file in the App Group container. Also spelled in `HermieShareTargets.swift`. */
export const SHARE_TARGETS_FILE = 'share-targets.json'

/**
 * The most targets written.
 *
 * The same number as the sheet's own roster, because a target nobody can pick is
 * a target nobody can use: the sheet lists `WIDGET_BOT_LIMIT` bots from the
 * snapshot, so a target beyond that is bytes in a container for a row that does
 * not exist. Written generously rather than exactly, in case the two lists ever
 * diverge — an extra entry costs about eighty bytes.
 */
export const SHARE_TARGETS_LIMIT = 24

/** One bot's chat, as the app resolved it. */
export interface ShareTarget {
  /** The profile name. The same string the manifest's `bot` carries. */
  bot: string
  /**
   * The DURABLE registry id to resume — `BotCanonicalSession.id`.
   *
   * Never the runtime id and never the compression-lineage tip: resuming is what
   * turns the durable id into the other two, and an extension that resumed a
   * runtime id would bind a session that no longer exists.
   */
  session: string
}

/** The two sentences a sheet has to be able to say, in the reader's language. */
export interface ShareTargetsCopy {
  /** "Sent to Ada". Takes the bot's display label, and `{bot}` is where it goes. */
  sent: string
  /** What is true when delivery did not happen. No placeholder. */
  queued: string
  /** Shown while the attempt is in flight. No placeholder. */
  sending: string
}

export interface ShareTargets {
  version: number
  /** Unix SECONDS. Only ever read by a person working out how stale this is. */
  generatedAt: number
  /**
   * Which gateway these belong to, when the app knows.
   *
   * Carried for the same reason `WidgetSnapshot.gatewayKey` carries it: the file
   * survives a change of gateway, and a session id from the previous one names
   * something the current one has never heard of. The extension compares it with
   * the credential record's own gateway and sends nothing when the two disagree
   * — which is a one-launch staleness, not a failure.
   */
  gatewayKey?: string
  copy: ShareTargetsCopy
  targets: ShareTarget[]
}

export interface ShareTargetsInput {
  /** Every bot with a resolved canonical chat. Ones without are skipped. */
  bots: readonly { name: string; session: string }[]
  copy: ShareTargetsCopy
  gatewayKey?: string
  /** Milliseconds, as `Date.now()` gives them. Stored as seconds. */
  now: number
}

/** The placeholder `copy.sent` carries, substituted by whoever draws it. */
export const SHARE_TARGET_BOT_PLACEHOLDER = '{bot}'

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * The file's contents, from what the app knows.
 *
 * A bot with no session id is left out rather than written with an empty one: an
 * empty id is a resume the gateway would refuse, and the extension would then
 * have tried, failed and left the entry — which is the same outcome as not
 * offering the target, reached a round trip later and with a failure in a log.
 */
export function buildShareTargets(input: ShareTargetsInput): ShareTargets {
  const targets: ShareTarget[] = []
  const seen = new Set<string>()

  for (const bot of input.bots) {
    if (!bot.name || !bot.session || seen.has(bot.name) || targets.length >= SHARE_TARGETS_LIMIT) {
      continue
    }

    seen.add(bot.name)
    targets.push({ bot: bot.name, session: bot.session })
  }

  return {
    version: SHARE_TARGETS_VERSION,
    generatedAt: Math.floor(input.now / 1000),
    ...(input.gatewayKey ? { gatewayKey: input.gatewayKey } : {}),
    copy: input.copy,
    targets
  }
}

/** The bytes. Stable field order, so an unchanged roster produces an unchanged file. */
export function serialiseShareTargets(targets: ShareTargets): string {
  return JSON.stringify(targets)
}

/**
 * Read the file back — which only a test and the developer screen ever do.
 *
 * The extension is the real reader and it is Swift. This exists so that the
 * format has one description that can be exercised without a phone, in the same
 * way `parseShareManifest` describes the direction that travels the other way.
 */
export function parseShareTargets(json: string): ShareTargets | null {
  let raw: unknown

  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }

  if (!isObject(raw) || num(raw.version) !== SHARE_TARGETS_VERSION) {
    return null
  }

  const copy = isObject(raw.copy) ? raw.copy : {}
  const gatewayKey = str(raw.gatewayKey)

  const targets = (Array.isArray(raw.targets) ? raw.targets : [])
    .map(entry => (isObject(entry) ? { bot: str(entry.bot), session: str(entry.session) } : { bot: '', session: '' }))
    .filter(entry => entry.bot && entry.session)
    .slice(0, SHARE_TARGETS_LIMIT)

  return {
    version: SHARE_TARGETS_VERSION,
    generatedAt: num(raw.generatedAt),
    ...(gatewayKey ? { gatewayKey } : {}),
    copy: { sent: str(copy.sent), queued: str(copy.queued), sending: str(copy.sending) },
    targets
  }
}
