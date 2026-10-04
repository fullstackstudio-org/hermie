/**
 * This browser's Web Push registration as a `ui_meta` row, the VAPID key it was
 * made with, and the push map a write of the app section carries (plan W13).
 *
 * The row is `pushRowFor`'s (`@hermie/gateway-client/push`, the bytes every
 * client writes) plus three fields only a browser row carries:
 *
 *  - `applicationServerKey`: the VAPID public key the subscription was made with,
 *    base64url without padding. The plugin skips a row that names another key
 *    (the push service would refuse it with a 403 anyway) and tries a row that
 *    names none; a 403 retires the row until it is written again with a newer
 *    `updatedAt` (plugin P-3).
 *  - `clears: true`, in a Chromium-based browser only: this worker understands a
 *    clearing push (`data.clear`) and closes the notification it withdraws
 *    (`src/sw/notification.ts`). A clearing push is `{data}` with nothing to show,
 *    and how a browser treats a push that shows nothing under `userVisibleOnly`
 *    has been checked in Chromium only (it may show its own "updated in the
 *    background" notice). Safari and Firefox are left without the field, and so
 *    without clearing pushes, until they are checked by hand on a gateway.
 *  - `requestMethods: true`: this worker reads a request's `method` and offers
 *    Allow and Deny for an approval only, so the plugin may send it the other
 *    request methods (`contract/push/contract.json`, `requests`).
 *
 * **Which subscription is kept.** The advert's key is the one the plugin signs
 * with. A subscription made with any other key is useless (every send is
 * refused), and a browser refuses a second subscription with a different key
 * while the first exists, so the rule is `subscriptionStep`: none, subscribe; the
 * advert's key, keep; another key, or one that cannot be told, unsubscribe and
 * subscribe again.
 *
 * **The push map.** `ui_meta` replaces a section whole, so a write carries every
 * other device's row and heartbeat as the gateway holds them (`foreignPushRows`,
 * `pushSeenOf`), this browser's row and heartbeat as it holds them, and the
 * person's per-chat overrides. While this browser has not yet looked at its own
 * subscription on this launch, the row the gateway holds for it is carried as it
 * is: a write made in that moment (a chat moved, a mute lapsed) would otherwise
 * take the registration away until the check put it back. Fields of the map this
 * build does not know are carried too.
 */
import {
  type PushAddress,
  type PushRegistrationInput,
  pushRowFor,
  pushSeenOf,
  type PushSeenEntry,
  type PushType,
  type PushTypeOverrides,
  foreignPushRows,
  noTypeWanted,
  pushPerBotOf,
  pushSectionFor
} from '@hermie/gateway-client/push'

/** What a browser row names as its platform: informational, the transport decides. */
export const WEB_PUSH_PLATFORM = 'web'

/** The shape the plugin accepts for `applicationServerKey`: 80 to 100 base64url characters. */
export const APPLICATION_SERVER_KEY = /^[A-Za-z0-9_-]{80,100}$/u

/** An uncompressed P-256 point: 65 bytes, the first 0x04. */
const P256_POINT_BYTES = 65
const P256_UNCOMPRESSED = 0x04

/** Bytes as base64url, without padding. */
export function base64UrlOf(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

/**
 * base64url (or base64, padded or not) as bytes, or `null` when it is not that.
 *
 * Backed by an `ArrayBuffer` this function allocated: `applicationServerKey`
 * takes a `BufferSource` that is not shared memory.
 */
export function bytesOfBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  const trimmed = value.trim()

  if (!/^[A-Za-z0-9_+/-]*={0,2}$/u.test(trimmed)) {
    return null
  }

  const plain = trimmed.replace(/=+$/u, '').replace(/-/gu, '+').replace(/_/gu, '/')

  if (plain.length % 4 === 1) {
    return null
  }

  let binary: string

  try {
    binary = atob(plain.padEnd(plain.length + ((4 - (plain.length % 4)) % 4), '='))
  } catch {
    return null
  }

  const bytes = new Uint8Array(new ArrayBuffer(binary.length))

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

/** The advert's VAPID public key as the bytes `pushManager.subscribe` wants, or `null` when it is not a P-256 point. */
export function applicationServerKeyBytes(publicKey: string): Uint8Array<ArrayBuffer> | null {
  const bytes = bytesOfBase64Url(publicKey)

  return bytes && bytes.length === P256_POINT_BYTES && bytes[0] === P256_UNCOMPRESSED ? bytes : null
}

/** A key in the one spelling a row carries: base64url, no padding. `''` when it is not a P-256 point. */
export function canonicalKey(publicKey: string): string {
  const bytes = applicationServerKeyBytes(publicKey)

  return bytes ? base64UrlOf(bytes) : ''
}

/** Whether two spellings name the same key. Two unreadable values are not the same key. */
export function sameKey(a: string, b: string): boolean {
  const left = canonicalKey(a)

  return left !== '' && left === canonicalKey(b)
}

/** What to do with the subscription this browser holds, given the key the plugin signs with. */
export type SubscriptionStep = 'keep' | 'subscribe' | 'resubscribe'

/**
 * @param held the key the browser's subscription was made with: `null` when
 *   there is no subscription, `''` when there is one and its key cannot be told
 *   (a browser that does not report it, and nothing remembered).
 * @param advertKey the key in the advert.
 */
export function subscriptionStep(held: string | null, advertKey: string): SubscriptionStep {
  if (held === null) {
    return 'subscribe'
  }

  return sameKey(held, advertKey) ? 'keep' : 'resubscribe'
}

/** A browser subscription as the row names it, with the key it was made with. */
export type WebPushAddress = Extract<PushAddress, { transport: 'webpush' }> & {
  /** base64url, no padding: the VAPID public key the subscription was made with. */
  applicationServerKey: string
}

/** `PushSubscription.toJSON()` as an address, or `null` when it lacks the endpoint or either key. */
export function addressOfSubscription(json: unknown, applicationServerKey: string): WebPushAddress | null {
  const value = json && typeof json === 'object' ? (json as { endpoint?: unknown; keys?: unknown }) : {}
  const keys = value.keys && typeof value.keys === 'object' ? (value.keys as { p256dh?: unknown; auth?: unknown }) : {}
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint : ''
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : ''
  const auth = typeof keys.auth === 'string' ? keys.auth : ''
  const key = canonicalKey(applicationServerKey)

  // The reader drops a `webpush` row missing either key, so a half-formed
  // subscription is worth nothing; and a row must name a key it can be checked by.
  return endpoint && p256dh && auth && key
    ? { transport: 'webpush', endpoint, keys: { p256dh, auth }, applicationServerKey: key }
    : null
}

/** This browser's registration, before it becomes a row. */
export interface WebRegistrationInput {
  installationId: string
  /** `gatewayKeyOf` the gateway's base URL; empty writes none. */
  gatewayKey: string
  address: WebPushAddress
  types: Record<PushType, boolean>
  preview: boolean
  /** Unix seconds, on the gateway's clock where it is known (`clock.ts`). */
  updatedAt: number
  /** Whether to ask for clearing pushes: a Chromium-based browser only (see the top of this file). */
  clears: boolean
}

/** The row: `pushRowFor`'s, plus the fields a browser row carries (see the top of this file). */
export function registrationRowOf(input: WebRegistrationInput): Record<string, unknown> {
  const registration: PushRegistrationInput = {
    installationId: input.installationId,
    ...(input.gatewayKey ? { gatewayKey: input.gatewayKey } : {}),
    address: { transport: 'webpush', endpoint: input.address.endpoint, keys: { ...input.address.keys } },
    platform: WEB_PUSH_PLATFORM,
    types: input.types,
    preview: input.preview,
    updatedAt: input.updatedAt
  }
  const row = pushRowFor(registration)
  const key = canonicalKey(input.address.applicationServerKey)

  return {
    ...row,
    ...(APPLICATION_SERVER_KEY.test(key) ? { applicationServerKey: key } : {}),
    ...(input.clears ? { clears: true } : {}),
    requestMethods: true
  }
}

/** Everything the push map is built from. */
export interface PushMapInput {
  /** The push map the gateway holds (the app section's `push`), as it came; `undefined` when there is none. */
  gateway: unknown
  installationId: string
  /** This browser's registration, or `null` when it has none to write. */
  own: WebRegistrationInput | null
  /**
   * True while this browser has not looked at its own subscription on this
   * launch: the gateway's row for it is carried rather than dropped.
   */
  carryOwn: boolean
  /** This browser's heartbeat, or `null`. */
  seen: PushSeenEntry | null
  /** The person's per-chat overrides, as the store holds them. */
  perBot: Record<string, PushTypeOverrides>
  /** Unix seconds: sweeps old heartbeats. */
  now: number
  /** Whether the plugin reads `{bot, at}` heartbeats (`push.seen.per_chat`). */
  perChat: boolean
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The members of the push map `pushSectionFor` writes; every other member is carried. */
const BUILT_MEMBERS = new Set(['registrations', 'seen', 'perBot'])

/** The push map a write carries, or `undefined` when there is nothing to say. */
export function pushMapOf(input: PushMapInput): Record<string, unknown> | undefined {
  const section = { push: isObject(input.gateway) ? input.gateway : {} }
  const others = foreignPushRows(section, input.installationId)
  const gatewayOwn = isObject(section.push.registrations) ? section.push.registrations[input.installationId] : undefined

  if (input.own && input.installationId && !noTypeWanted(input.own.types)) {
    others[input.installationId] = registrationRowOf(input.own)
  } else if (input.carryOwn && input.installationId && gatewayOwn !== undefined && gatewayOwn !== null) {
    others[input.installationId] = gatewayOwn
  }

  const seen = pushSeenOf(section)
  // This browser is the only writer of its own heartbeat, so what it holds replaces the gateway's copy
  // outright: a copy stamped ahead (a clock that was wrong when it was written) must not outlive it.
  if (input.installationId && input.seen) {
    seen[input.installationId] = input.seen
  }

  const built = pushSectionFor({
    others,
    own: null,
    seen,
    perBot: input.perBot,
    now: input.now,
    perChat: input.perChat
  })

  const carried: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(section.push)) {
    if (!BUILT_MEMBERS.has(key) && value !== undefined) {
      carried[key] = value
    }
  }

  if (!built && Object.keys(carried).length === 0) {
    return undefined
  }

  return { ...carried, ...(built ?? {}) }
}

/** The person's per-chat overrides in a push map the gateway holds. */
export const perBotOfPushMap = (gateway: unknown): Record<string, PushTypeOverrides> =>
  pushPerBotOf({ push: isObject(gateway) ? gateway : {} })

/** Whether a push map the gateway holds has a row some other installation wrote. */
export const othersRegisteredIn = (gateway: unknown, installationId: string): boolean =>
  Object.keys(foreignPushRows({ push: isObject(gateway) ? gateway : {} }, installationId)).length > 0

/** The row the gateway holds for this browser, or `undefined`. */
export function gatewayRowOf(gateway: unknown, installationId: string): unknown {
  const registrations = isObject(gateway) && isObject(gateway.registrations) ? gateway.registrations : {}

  return installationId ? registrations[installationId] : undefined
}
