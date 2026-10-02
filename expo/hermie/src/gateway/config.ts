import {
  type FrontDoor,
  frontDoorHeaders,
  type GatewayAuthMode,
  NO_FRONT_DOOR,
  originOf,
  type TokenSet
} from '@hermie/gateway-client'

import { dropShareDeliveryRecordFor } from '../features/share/delivery-credential'
import { keyValueStore } from '../platform/key-value-store'
import { secretStore } from '../platform/secret-store'
import { clearUrlCache } from '../platform/url-cache'
import type { GatewayNamespace } from './namespace'

/**
 * Where a configured gateway lives on disk.
 *
 * The split is deliberate and follows what each store is for: the secret store
 * is a keychain item, so only credentials go there, and the key-value store is
 * a plain preference file, so it holds the things you would happily print in a
 * support log — which address, which provider, which version.
 */

/**
 * Non-secret configuration, in the key-value store.
 *
 * The BASE key. What is actually written is `configKeyFor(namespace)` — one
 * gateway's configuration, under that gateway's id. The bare name survives as
 * the thing the one-time move reads from, and as what `migrate.ts` names.
 */
export const CONFIG_KEY = 'hermie.gateway.config'

/** Where one gateway's configuration lives. */
export const configKeyFor = (ns: GatewayNamespace): string => ns.key(CONFIG_KEY)

/**
 * Secret-store keys. Signing out deletes exactly these six.
 *
 * `frontDoor` is a secret and not configuration, even though half of it — a
 * Cloudflare Access client id — is not itself one. The pair is entered together,
 * is useless apart, and a record split across two stores is a record that goes
 * out of step; the keychain is also what the origin binding below is worth
 * having in front of.
 */
export const SECRET_KEYS = {
  accessToken: 'hermie.auth.access_token',
  refreshToken: 'hermie.auth.refresh_token',
  tokenMeta: 'hermie.auth.token_meta',
  sessionToken: 'hermie.auth.session_token',
  extraHeaders: 'hermie.auth.extra_headers',
  frontDoor: 'hermie.auth.front_door'
} as const

export type SecretKeys = Record<keyof typeof SECRET_KEYS, string>

/**
 * The same six, for one gateway.
 *
 * A keychain is the one store where a key collision is not a stale preference
 * but a credential handed to a stranger: two gateways under one
 * `hermie.auth.access_token` means the second sign-in overwrites the first, and
 * whichever gateway dials next presents a token minted for the other one. So
 * the suffix goes on here, at the one place the names are written down.
 */
export function secretKeysFor(ns: GatewayNamespace): SecretKeys {
  // `secretKey`, not `key`: the secret store rejects the `@` the key-value
  // store is suffixed with. See `SECRET_NAMESPACE_SEPARATOR`.
  return Object.fromEntries(Object.entries(SECRET_KEYS).map(([slot, key]) => [slot, ns.secretKey(key)])) as SecretKeys
}

export interface StoredGatewayConfig {
  baseUrl: string
  authMode: GatewayAuthMode
  /** Provider name as the gateway reports it, e.g. `self-hosted`. */
  provider?: string
  /** Provider label for the UI, e.g. `Self-Hosted OIDC`. */
  providerDisplayName?: string
  version?: string
  userDisplayName?: string
  /** The signed-in person's email, as `/api/auth/me` sent it. Empty or absent draws no email row. */
  userEmail?: string
  /**
   * Where their picture lives, relative to `baseUrl` — `/api/auth/me`'s own
   * `picture_url`, unchanged. Absent on a gateway that never sent one (an
   * upstream Hermes, or a fork account with no picture held), which draws the
   * initial exactly as before HERM-120.
   */
  userPictureUrl?: string
}

export interface GatewaySetup {
  config: StoredGatewayConfig
  /**
   * What actually goes on the wire: the headers typed under "Custom headers"
   * with the front door's own pair folded in on top.
   *
   * One map rather than two, because everything downstream — the REST client,
   * the dial plan, the probe — takes exactly one and has no business knowing
   * which preset produced it. Which preset DID produce it is `frontDoor`, and
   * that is only read by the surfaces that have to show it back.
   */
  extraHeaders: Record<string, string>
  /** The headers as typed, so the wizard can show them again after a sign-out. */
  customHeaders: Record<string, string>
  /** The preset, or `{ kind: 'none' }` — including when one was dropped for the wrong origin. */
  frontDoor: FrontDoor
  sessionToken: string | null
  /** False after a sign-out: the address is known, the credentials are not. */
  hasCredentials: boolean
  /**
   * Whether the stored credential can outlive its access token.
   *
   * Read off the secret store rather than remembered as a flag, because it is a
   * fact about what is actually there: a provider whose client has no
   * `offline_access` scope answers the exchange without a refresh token, and
   * the session then ends silently when the access token expires. Only
   * meaningful for `native_pkce` — the other two modes have nothing to rotate
   * and answer true so nothing warns about them.
   */
  canRefresh: boolean
  /**
   * Set when the secret store REFUSED rather than came back empty.
   *
   * The two are indistinguishable downstream — `expo-secure-store` resolves a
   * missing item and an item in an unreadable access group to the same `null` —
   * so the difference has to be captured at the one place where it still
   * exists, which is here. Without it, a launch that lands on the sign-in step
   * leaves nothing behind saying whether the credential was gone or merely out
   * of reach.
   */
  credentialError?: string
}

/**
 * The tag on a secret-store write failure, and why it is a field rather than a
 * class check.
 *
 * `instanceof` on a subclass of `Error` is only as reliable as the transform
 * that compiled it: a downlevelled `extends Error` loses the prototype link and
 * the check silently answers false, which for THIS error would mean the wizard
 * printing a raw keychain message instead of the sentence written for it. A tag
 * on the object survives every transform and every module boundary.
 */
const SECRET_STORE_WRITE_FAILED = 'hermie.secret_store.write_failed'

/**
 * The credentials could not be written to this device's secret store.
 *
 * Its own type because it is the one failure in setup that is neither the
 * reader's fault nor the gateway's: the address was right, the sign-in worked,
 * and the keychain refused. Everything else in the wizard's failure path is a
 * `GatewayError` with a host in it, and phrasing this one as "the settings
 * could not be saved: <OSStatus>" told nobody what had happened.
 *
 * `reason` is what the platform said, kept verbatim: an OSStatus is the only
 * thing that distinguishes a missing entitlement from a locked device, and a
 * sentence that swallows it leaves the reader nothing to search for.
 */
export class SecretStoreWriteError extends Error {
  readonly kind = SECRET_STORE_WRITE_FAILED
  readonly reason: string

  constructor(reason: string) {
    super(`the secret store refused the credentials: ${reason}`)
    this.name = 'SecretStoreWriteError'
    this.reason = reason
  }
}

/** True for a `SecretStoreWriteError`, across module boundaries and transforms. */
export function isSecretStoreWriteError(value: unknown): value is SecretStoreWriteError {
  return Boolean(value) && typeof value === 'object' && (value as { kind?: unknown }).kind === SECRET_STORE_WRITE_FAILED
}

/** What the platform said, in the one form every caller here can print. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  return message.trim() || 'no reason given'
}

export interface SaveGatewaySetupInput {
  config: StoredGatewayConfig
  /** The headers as typed under "Custom headers". The front door adds its own. */
  extraHeaders: Record<string, string>
  frontDoor?: FrontDoor
  /** Native PKCE only. */
  tokens?: TokenSet | null
  /** Session-token gateways only. */
  sessionToken?: string | null
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(entry => typeof entry === 'string')
  )
}

/**
 * Read a stored front door back, and refuse one that belongs to another gateway.
 *
 * A Cloudflare Access service token is issued for one Access application, which
 * is one hostname. A record that survived a change of gateway would be sent to
 * a host that never asked for it and cannot use it — a long-lived tenant
 * credential handed to a stranger, in exchange for nothing. So the origin it
 * was entered for rides along with it and a mismatch drops the whole record
 * rather than trying to repair it.
 *
 * "Change gateway" already clears the credentials when the address changes, so
 * this is the second line rather than the first. It is the line that holds when
 * the address changed some other way: an edited config, a restore onto another
 * device, a build that wrote the record before the origin was part of it — and
 * that last case is exactly why an absent `origin` reads as a mismatch rather
 * than as permission.
 */
function readFrontDoor(raw: string | null, baseUrl: string): FrontDoor {
  if (!raw) {
    return NO_FRONT_DOOR
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object') {
      return NO_FRONT_DOOR
    }

    const record = parsed as Record<string, unknown>

    if (
      record.kind !== 'cloudflare_access' ||
      typeof record.clientId !== 'string' ||
      typeof record.clientSecret !== 'string' ||
      typeof record.origin !== 'string'
    ) {
      return NO_FRONT_DOOR
    }

    if (record.origin.toLowerCase() !== originOf(baseUrl)) {
      return NO_FRONT_DOOR
    }

    return {
      kind: 'cloudflare_access',
      clientId: record.clientId,
      clientSecret: record.clientSecret,
      origin: record.origin.toLowerCase()
    }
  } catch {
    // A record written by an older build is not worth failing a launch over.
    // The connection goes out without it and the resulting 403 explains itself.
    return NO_FRONT_DOOR
  }
}

/** Read the configured gateway, or `null` when the app has never been set up. */
export async function loadGatewaySetup(ns: GatewayNamespace): Promise<GatewaySetup | null> {
  const keys = secretKeysFor(ns)
  const config = await keyValueStore.getJson<StoredGatewayConfig>(configKeyFor(ns))

  if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
    return null
  }

  let credentialError: string | undefined

  // A throwing keychain must not strand the launch. Before this, the rejection
  // escaped `reload()`'s un-awaited call and the app sat on the splash for ever
  // — the one outcome worse than asking for a sign-in.
  const [rawHeaders, rawFrontDoor, sessionToken, accessToken, refreshToken] = await Promise.all([
    secretStore.get(keys.extraHeaders),
    secretStore.get(keys.frontDoor),
    secretStore.get(keys.sessionToken),
    secretStore.get(keys.accessToken),
    secretStore.get(keys.refreshToken)
  ]).catch((error: unknown) => {
    credentialError = error instanceof Error ? error.message : String(error)

    return [null, null, null, null, null] as const
  })

  let customHeaders: Record<string, string> = {}

  if (rawHeaders) {
    try {
      const parsed: unknown = JSON.parse(rawHeaders)

      if (isRecordOfStrings(parsed)) {
        customHeaders = parsed
      }
    } catch {
      // A header blob written by an older build is not worth failing startup
      // over; the connection simply goes out without the extra headers, and
      // the resulting 403 explains itself.
    }
  }

  const frontDoor = readFrontDoor(rawFrontDoor, config.baseUrl)
  // The front door goes on LAST, so a hand-typed `CF-Access-Client-Secret`
  // under Custom headers cannot quietly shadow the one the preset holds.
  const extraHeaders = { ...customHeaders, ...frontDoorHeaders(frontDoor, config.baseUrl) }

  /**
   * Is there a credential to reconnect with?
   *
   * The cookie flow is the odd one out and deliberately answers TRUE without
   * looking: its credential is an `HttpOnly` cookie in the browser's own jar,
   * which this process cannot read by design. The only honest way to find out
   * whether it is still good is to use it — so the app dials, and a lapsed
   * session comes back as `needs_signin` from the gateway, which is the same
   * answer with a real reason attached. Answering false here instead would send
   * every reload of a perfectly signed-in tab back to the wizard.
   */
  const hasCredentials =
    config.authMode === 'cookie'
      ? true
      : config.authMode === 'session_token'
        ? Boolean(sessionToken)
        : Boolean(accessToken)

  // Only the PKCE flow has anything to rotate; the other two say yes so that
  // nothing downstream warns a session-token or cookie gateway about a refresh
  // token it was never going to have.
  const canRefresh = config.authMode === 'native_pkce' ? Boolean(refreshToken) : true

  return {
    config,
    extraHeaders,
    customHeaders,
    frontDoor,
    sessionToken,
    hasCredentials,
    canRefresh,
    ...(credentialError ? { credentialError } : {})
  }
}

/**
 * Write everything the app needs to reconnect on its next launch. This is the
 * only point in onboarding where a secret is persisted: up to here the tokens
 * exist only in memory, so abandoning a half-finished wizard leaves nothing
 * behind.
 *
 * **The credentials go first, and the configuration only if they landed.** The
 * other order was the shape of a real failure: the config was written, a secret
 * write then rejected, and what survived on disk was a gateway with an address
 * and no way in — under an id that, because the caller never got as far as
 * saving the registry, no entry claimed. Fifty of those accumulated on one
 * simulator, one per launch, while the app returned to the wizard saying
 * nothing. Written this way round the failing case leaves the disk exactly as
 * it found it: the secrets that did land are taken back out, no configuration
 * is written, and the caller is TOLD, with the platform's own reason attached.
 *
 * Rolling back is best-effort by necessity — the store that just refused a
 * write is not a store whose deletes can be relied on either — so it is
 * `allSettled` and the throw happens regardless. A secret left behind under an
 * id no configuration names is unreachable and is what the sweep in
 * `registry.ts` is for; a configuration with no secret is what sends somebody
 * back to the wizard, and that is the one this prevents.
 */
export async function saveGatewaySetup(ns: GatewayNamespace, input: SaveGatewaySetupInput): Promise<void> {
  const { config, extraHeaders, frontDoor = NO_FRONT_DOOR, tokens, sessionToken } = input
  const keys = secretKeysFor(ns)

  const writes: Promise<void>[] = [
    Object.keys(extraHeaders).length > 0
      ? secretStore.set(keys.extraHeaders, JSON.stringify(extraHeaders))
      : secretStore.delete(keys.extraHeaders),
    // Bound to the address being saved rather than to whatever the record said
    // when it was typed, so the two cannot disagree after a change of gateway.
    frontDoor.kind === 'cloudflare_access'
      ? secretStore.set(keys.frontDoor, JSON.stringify({ ...frontDoor, origin: originOf(config.baseUrl) }))
      : secretStore.delete(keys.frontDoor)
  ]

  if (tokens) {
    writes.push(
      secretStore.set(keys.accessToken, tokens.accessToken),
      secretStore.set(keys.refreshToken, tokens.refreshToken),
      secretStore.set(
        keys.tokenMeta,
        JSON.stringify({ expiresAt: tokens.expiresAt, provider: tokens.provider, userId: tokens.userId })
      )
    )
  }

  if (sessionToken) {
    writes.push(secretStore.set(keys.sessionToken, sessionToken))
  }

  try {
    await Promise.all(writes)
  } catch (error) {
    await Promise.allSettled(Object.values(keys).map(key => secretStore.delete(key)))

    throw new SecretStoreWriteError(reasonOf(error))
  }

  await keyValueStore.setJson(configKeyFor(ns), config)
}

/**
 * Sign out of ONE gateway: forget its credentials, keep its address.
 *
 * The seventh delete is the share extension's copy, and it is here rather than at
 * the callers because a sign-out that left it behind would leave the one part of
 * the install that can still reach the gateway outside the app: an access token
 * stays good at the identity provider for whatever it has left, so a share sheet
 * would keep sending on a session its owner has ended. Guarded by gateway id, so
 * signing out of a gateway nobody is using does not silently stop the active
 * one's sheet from sending.
 *
 * `dropShareDeliveryRecordFor` rather than the publisher in
 * `share-credential.ts`: this file is imported by that one, and the drop needs
 * nothing from it — only the record and the store.
 */
export async function clearCredentials(ns: GatewayNamespace): Promise<void> {
  await Promise.all(Object.values(secretKeysFor(ns)).map(key => secretStore.delete(key)))
  await dropShareDeliveryRecordFor(secretStore, ns.id)
}

/** Forget ONE gateway: its credentials and its address. */
export async function clearGateway(ns: GatewayNamespace): Promise<void> {
  await clearCredentials(ns)
  await keyValueStore.delete(configKeyFor(ns))
  /*
    And whatever the platform cached for it.

    `URLCache` is keyed by bundle identifier and survives the app being deleted,
    so a 301 stored when a gateway moved domains was still being served to a
    fresh install months later — the probe reached the old host and the failure
    named the address the owner had correctly typed. Forgetting a gateway is the
    one moment where nothing cached for it is wanted any more, and it is the
    only moment the app has any business emptying a cache at all.
  */
  clearUrlCache()
}
