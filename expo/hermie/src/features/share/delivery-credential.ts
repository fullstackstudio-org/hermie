/**
 * The one credential a share extension is allowed to hold, and its format.
 *
 * ADR-0026 lets the iOS share extension deliver what somebody shared without
 * opening the app. To reach a gateway it needs an address, the extra headers
 * that gateway insists on, and something to authenticate with — and every one of
 * those is a thing the app already has and the extension has no way to obtain.
 *
 * ## Why this is a keychain item and not a file in the container
 *
 * The App Group container is a directory. Every binary signed into the group can
 * read it, it is backed up, and nothing in it is encrypted beyond whatever the
 * device does to the whole file system. A bearer token that opens somebody's
 * gateway has no business living there — so this record goes into the keychain,
 * where the app's credentials already are, under the access group both binaries
 * declare (`keychain-access-groups` in `app.config.ts`, and the extension's own
 * entitlements). The container carries what a bot is called; the keychain
 * carries what lets you speak to one.
 *
 * ## Why it is ONE item rather than the six that already exist
 *
 * `gateway/config.ts` keeps six secret keys per gateway, suffixed with that
 * gateway's id. An extension reading those would have to learn which gateway is
 * active — which is in the key-value store, which is a JavaScript store the
 * extension cannot read — and then reassemble the front door's headers from a
 * record with its own origin check in it. That is three pieces of the app's
 * reasoning re-implemented in Swift, in a process with no way to report that it
 * got them wrong.
 *
 * So the app projects all of it into one unnamespaced item: whichever gateway is
 * active, ready to use, versioned. The same argument the widget snapshot makes
 * for the roster, made for the connection.
 *
 * ## What is deliberately NOT in it
 *
 * **The refresh token.** An extension that could refresh would be an extension
 * that can rotate the app's own credential out from under it: on a provider with
 * refresh-token rotation the app's stored token is dead the moment somebody else
 * spends it, and on a provider with reuse detection presenting the dead one
 * revokes the whole session. So an expired access token is the end of the road
 * for the extension — it leaves the entry and the app, which CAN refresh, sends
 * it. `expiresAt` is written so that the extension can tell before it tries.
 *
 * **Anything about a bot.** Those are in `targets.ts`, in the container, because
 * they are not secret and because a change of roster must not have to rewrite a
 * keychain item.
 */
import type { SecretStore } from '../../platform/secret-store'

/** Bumped when a field changes meaning or goes. Adding an OPTIONAL one is free. */
export const SHARE_DELIVERY_RECORD_VERSION = 1

/**
 * The keychain account, and the one key in this app that is NOT namespaced by
 * gateway.
 *
 * It describes whichever gateway is active, and the whole reason it exists is
 * that the reader of it cannot find out which one that is. A per-gateway copy
 * would be a set of records with no pointer — see `gateway/namespace.ts` for
 * the general rule and the four other exceptions to it.
 */
export const SHARE_DELIVERY_KEY = 'hermie.share.delivery'

/** Which header carries the credential. Both spellings are the gateway's, not ours. */
export type ShareDeliveryAuthHeader = 'authorization' | 'x-hermes-session-token'

export interface ShareDeliveryRecord {
  version: number
  /** The registry id, so the app can tell whether a record is the one it wrote. */
  gatewayId: string
  /** `gatewayKeyOf` the address — what `share-targets.json` is matched against. */
  gatewayKey: string
  baseUrl: string
  /** `session_token` or `native_pkce`. Nothing else can be delivered from here. */
  authMode: 'session_token' | 'native_pkce'
  authHeader: ShareDeliveryAuthHeader
  /** The bearer or the session token. Never a refresh token. */
  token: string
  /**
   * Unix SECONDS, or `0` for a credential that does not expire on its own.
   *
   * A session token is `0`: it is revoked or it is not, and there is nothing to
   * count down. An access token carries its own deadline, and the extension
   * refuses to try once it has passed rather than spending a round trip to be
   * told 401 — the outcome is the same and the fast one keeps the sheet short.
   */
  expiresAt: number
  /**
   * Every extra header the app sends, including the front door's pair.
   *
   * Copied rather than re-derived: `readFrontDoor` drops a record whose origin
   * does not match the address, and that check has already been made by the time
   * a `GatewaySetup` exists. An extension re-deriving it would be a second
   * implementation of "is this tenant credential for this host", which is not a
   * question worth answering twice.
   */
  headers: Record<string, string>
}

export interface ShareDeliveryRecordInput {
  gatewayId: string
  gatewayKey: string
  baseUrl: string
  authMode: string
  headers: Record<string, string>
  /** The session token, for a `session_token` gateway. */
  sessionToken?: string | null
  /** The access token and its deadline, for a `native_pkce` one. */
  accessToken?: string | null
  expiresAt?: number
}

/**
 * The record, or `null` when this gateway cannot be delivered to from outside
 * the app.
 *
 * Three ways to answer `null`, and each is a real gateway somebody runs:
 *
 * - **No credential.** Signed out, or a wizard that never finished. There is
 *   nothing to write and an item left behind from before would be a token the
 *   reader has revoked, so callers DELETE on `null` rather than leaving what is
 *   there.
 * - **The cookie flow.** Its credential is an `HttpOnly` cookie in a browser's
 *   own jar. That is not a thing that can be copied into a keychain, and the
 *   flow only exists on the web build, where there is no extension.
 * - **An address that is not one.** Nothing downstream should have to defend
 *   against `baseUrl` being empty.
 */
export function buildShareDeliveryRecord(input: ShareDeliveryRecordInput): ShareDeliveryRecord | null {
  if (!input.baseUrl || !input.gatewayId) {
    return null
  }

  if (input.authMode === 'session_token') {
    const token = input.sessionToken ?? ''

    return token
      ? {
          version: SHARE_DELIVERY_RECORD_VERSION,
          gatewayId: input.gatewayId,
          gatewayKey: input.gatewayKey,
          baseUrl: input.baseUrl,
          authMode: 'session_token',
          authHeader: 'x-hermes-session-token',
          token,
          expiresAt: 0,
          headers: { ...input.headers }
        }
      : null
  }

  if (input.authMode !== 'native_pkce') {
    return null
  }

  const token = input.accessToken ?? ''

  return token
    ? {
        version: SHARE_DELIVERY_RECORD_VERSION,
        gatewayId: input.gatewayId,
        gatewayKey: input.gatewayKey,
        baseUrl: input.baseUrl,
        authMode: 'native_pkce',
        authHeader: 'authorization',
        token,
        expiresAt: input.expiresAt ?? 0,
        headers: { ...input.headers }
      }
    : null
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Read a record back.
 *
 * Only the app and a test read this in TypeScript — the extension is the real
 * reader and it is Swift. It exists so that "what does the extension see" is a
 * table in a test rather than a thing established on a phone, and so that the
 * app can ask WHOSE record is currently published without re-deriving it.
 */
export function parseShareDeliveryRecord(json: string | null): ShareDeliveryRecord | null {
  if (!json) {
    return null
  }

  let raw: unknown

  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }

  if (!isObject(raw) || raw.version !== SHARE_DELIVERY_RECORD_VERSION) {
    return null
  }

  const mode =
    raw.authMode === 'session_token' ? 'session_token' : raw.authMode === 'native_pkce' ? 'native_pkce' : null

  if (!mode) {
    return null
  }

  const headers = isObject(raw.headers)
    ? Object.fromEntries(
        Object.entries(raw.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    : {}

  const string = (value: unknown): string => (typeof value === 'string' ? value : '')

  return {
    version: SHARE_DELIVERY_RECORD_VERSION,
    gatewayId: string(raw.gatewayId),
    gatewayKey: string(raw.gatewayKey),
    baseUrl: string(raw.baseUrl),
    authMode: mode,
    authHeader: raw.authHeader === 'x-hermes-session-token' ? 'x-hermes-session-token' : 'authorization',
    token: string(raw.token),
    expiresAt: typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? raw.expiresAt : 0,
    headers
  }
}

/**
 * Publish a record, or take the published one away.
 *
 * Never throws. A keychain that refuses this write is a keychain that has
 * already refused something that mattered more, and the consequence here is
 * only that the extension queues instead of sending — which is the behaviour
 * this whole feature had before ADR-0026 and is still the fallback.
 */
export async function writeShareDeliveryRecord(
  store: SecretStore,
  record: ShareDeliveryRecord | null
): Promise<boolean> {
  try {
    if (!record) {
      await store.delete(SHARE_DELIVERY_KEY)

      return true
    }

    await store.set(SHARE_DELIVERY_KEY, JSON.stringify(record))

    return true
  } catch {
    return false
  }
}

/**
 * Take the record away IF it belongs to this gateway.
 *
 * The guard is the point. Signing out of the gateway that is not active must not
 * silently stop the active one's sheet from sending, and a `delete` with no
 * question asked would do exactly that — the record names one gateway and every
 * sign-out looks alike from inside `clearCredentials`.
 */
export async function dropShareDeliveryRecordFor(store: SecretStore, gatewayId: string): Promise<boolean> {
  try {
    const published = parseShareDeliveryRecord(await store.get(SHARE_DELIVERY_KEY))

    if (!published || published.gatewayId !== gatewayId) {
      return false
    }

    await store.delete(SHARE_DELIVERY_KEY)

    return true
  } catch {
    return false
  }
}

/** Whose record is published right now, or `null`. Read by the two republish paths. */
export async function publishedShareDeliveryGateway(store: SecretStore): Promise<string | null> {
  try {
    return parseShareDeliveryRecord(await store.get(SHARE_DELIVERY_KEY))?.gatewayId ?? null
  } catch {
    return null
  }
}
