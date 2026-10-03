import { NotABaseUrl, hasPathPrefix, serialiseBaseUrl } from './base-url'
import { b64u } from './encoding'
import { PasskeyStore, idOf, type CredentialRecord, type PasskeyStoreOptions } from './store'
import { GatewayContext } from './webauthn'

/**
 * The passkey level of the fake gateway: the operator's settings, the store, the rate limits and the
 * capability block. The routes (`routes.ts`) and the `confirm` request (`confirm.ts`) are built on it.
 *
 * It follows the real gateway's `confirm.passkey` section (`settings.py`): the level keeps its OWN list of
 * base URLs, never anything a dashboard session could change; native RPs are a map from RP id to the
 * `clientDataJSON.origin` values allowed for it.
 */

/** The documented default native RP: the official build's associated domain. */
export const DEFAULT_NATIVE_RPS: Readonly<Record<string, readonly string[]>> = {
  'confirm.hermie.dev': ['https://confirm.hermie.dev']
}

/** Who a request or a connection is signed in as, the way the gateway's auth layer names them. */
export interface Identity {
  provider: string
  /** The provider's user id. */
  userId: string
  displayName: string
}

/** `<provider>:<user id>`: the key every credential is stored under. */
export const userKey = (identity: Pick<Identity, 'provider' | 'userId'>): string =>
  `${identity.provider}:${identity.userId}`

export interface PasskeySettings {
  enabled: boolean
  /** Serialised (contract §3); the only base URLs a challenge may name. */
  baseUrls: string[]
  nativeRps: Record<string, string[]>
  userInvites: boolean
  allowPrivateBaseUrls: boolean
}

/** What a caller (`startFakeGateway`, `POST /__fake/passkey/enable`, the CLI) may set. All optional. */
export interface PasskeyOptions {
  /** `false` stages a gateway that knows the level and has it switched off (`reason: "disabled"`). Default true. */
  enabled?: boolean
  /** The gateway's own base URLs for this level, in any spelling the contract serialises. Default: the fake's own address. */
  baseUrls?: string[]
  /** Native RPs: RP id to the `clientDataJSON.origin` values allowed for it. Default `DEFAULT_NATIVE_RPS`. */
  nativeRps?: Record<string, string[]>
  /** The operator's opt-in for private base URLs (`http`, loopback, LAN). Default: true when no base URL was given, since the fake's own address is one. */
  allowPrivateBaseUrls?: boolean
  /** May a person mint their own enrolment code with a passkey (`user_invites`). Default true. */
  userInvites?: boolean
}

/** A body that is not a usable `enable` request; `message` says which field. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsError'
  }
}

/** Apply `options` over `current` (or over the defaults), serialising and validating what it names. */
export function applySettings(
  current: PasskeySettings | null,
  options: PasskeyOptions,
  ownUrl: () => string
): PasskeySettings {
  const next: PasskeySettings = current
    ? { ...current, baseUrls: [...current.baseUrls], nativeRps: { ...current.nativeRps } }
    : {
        enabled: true,
        baseUrls: [],
        nativeRps: Object.fromEntries(Object.entries(DEFAULT_NATIVE_RPS).map(([rp, origins]) => [rp, [...origins]])),
        userInvites: true,
        allowPrivateBaseUrls: false
      }

  if (options.enabled !== undefined) {
    next.enabled = options.enabled
  }

  if (options.baseUrls !== undefined) {
    if (!Array.isArray(options.baseUrls) || !options.baseUrls.every(url => typeof url === 'string')) {
      throw new SettingsError('base_urls must be a list of URLs')
    }

    const urls: string[] = []

    for (const url of options.baseUrls) {
      try {
        const serialised = serialiseBaseUrl(url)

        if (!urls.includes(serialised)) {
          urls.push(serialised)
        }
      } catch (error) {
        if (error instanceof NotABaseUrl) {
          throw new SettingsError(`base_urls: ${JSON.stringify(url)} is not an http(s) base URL`)
        }

        throw error
      }
    }

    next.baseUrls = urls
  } else if (!current) {
    next.baseUrls = [serialiseBaseUrl(ownUrl())]
  }

  if (options.nativeRps !== undefined) {
    const rps: Record<string, string[]> = {}

    for (const [rpId, origins] of Object.entries(options.nativeRps)) {
      if (!rpId || rpId !== rpId.trim().toLowerCase() || rpId.includes('/') || rpId.includes(':')) {
        throw new SettingsError(`rps: ${JSON.stringify(rpId)} is not a lower-case host name`)
      }

      if (Array.isArray(origins) && origins.length === 0) {
        continue
      }

      const accepted: string[] = []

      for (const origin of Array.isArray(origins) ? origins : []) {
        let serialised = ''

        try {
          serialised = serialiseBaseUrl(origin)
        } catch {
          serialised = ''
        }

        if (!serialised.startsWith('https://') || hasPathPrefix(serialised) || serialised !== origin) {
          throw new SettingsError(`rps.${rpId}: ${JSON.stringify(origin)} is not a serialised https origin`)
        }

        accepted.push(serialised)
      }

      if (!accepted.length) {
        throw new SettingsError(`rps.${rpId}: no usable origin`)
      }

      rps[rpId] = accepted
    }

    next.nativeRps = rps
  }

  if (options.userInvites !== undefined) {
    next.userInvites = options.userInvites === true
  }

  if (options.allowPrivateBaseUrls !== undefined) {
    next.allowPrivateBaseUrls = options.allowPrivateBaseUrls === true
  } else if (!current && options.baseUrls === undefined) {
    // The fake's own address is `http://127.0.0.1:<port>`: private by the contract's definition.
    next.allowPrivateBaseUrls = true
  }

  return next
}

// ── rate limits (plan, Security Considerations) ───────────────────────────────────────────────

/** A per-key sliding-window throttle: `check` records an event when within budget. */
export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, number[]>()

  constructor(
    readonly maxEvents: number,
    readonly windowSec: number,
    private readonly clock: () => number
  ) {}

  private live(key: string): number[] {
    const cutoff = this.clock() - this.windowSec * 1000
    const events = (this.buckets.get(key || '_unknown_') ?? []).filter(at => at >= cutoff)

    this.buckets.set(key || '_unknown_', events)

    return events
  }

  /** Record an event for `key` when it is within budget; `false` when it is not. */
  check(key: string): boolean {
    const events = this.live(key)

    if (events.length >= this.maxEvents) {
      return false
    }

    events.push(this.clock())

    return true
  }

  /** True when `key` has no budget left. Records nothing. */
  exhausted(key: string): boolean {
    return this.live(key).length >= this.maxEvents
  }

  reset(): void {
    this.buckets.clear()
  }
}

/** One refusal, as the public view lists it: never a code, a signature or the confirmed text. */
export interface RefusalNote {
  at: number
  surface: 'register' | 'stepup' | 'confirm'
  reason: string
  userId: string
  requestId: string
}

const REFUSALS_KEPT = 200

export class PasskeyGateway {
  settings: PasskeySettings
  readonly store: PasskeyStore
  readonly clock: () => number

  readonly limiters: {
    registerBeginPerUser: SlidingWindowLimiter
    registerBeginPerIp: SlidingWindowLimiter
    codeFailuresPerUser: SlidingWindowLimiter
    codeFailuresPerIp: SlidingWindowLimiter
    codeFailuresGateway: SlidingWindowLimiter
    stepupBeginPerUser: SlidingWindowLimiter
  }

  private readonly refusalNotes: RefusalNote[] = []

  constructor(
    settings: PasskeySettings,
    readonly ownUrl: () => string,
    options: PasskeyStoreOptions & {
      /** `passkey.changed` to every live connection signed in as `userId`. */
      announce?: (userId: string, payload: Record<string, unknown>) => number
    } = {}
  ) {
    this.settings = settings
    this.clock = options.clock ?? Date.now
    this.store = new PasskeyStore(options)
    this.announceTo = options.announce ?? (() => 0)
    this.limiters = {
      registerBeginPerUser: new SlidingWindowLimiter(5, 600, this.clock),
      registerBeginPerIp: new SlidingWindowLimiter(5, 600, this.clock),
      codeFailuresPerUser: new SlidingWindowLimiter(5, 600, this.clock),
      codeFailuresPerIp: new SlidingWindowLimiter(5, 600, this.clock),
      codeFailuresGateway: new SlidingWindowLimiter(20, 3600, this.clock),
      stepupBeginPerUser: new SlidingWindowLimiter(10, 600, this.clock)
    }
  }

  private readonly announceTo: (userId: string, payload: Record<string, unknown>) => number

  /** The verifier's view of this gateway: store identity, the level's own base URLs, native RPs. */
  context(): GatewayContext {
    return new GatewayContext(
      this.store.gatewayId,
      this.store.handleKey,
      this.settings.baseUrls,
      this.settings.nativeRps,
      this.settings.allowPrivateBaseUrls
    )
  }

  /** `passkey.changed` to the user's live connections (the real gateway also fires a plugin hook). */
  announce(userId: string, change: 'added' | 'revoked', credential: CredentialRecord): number {
    return this.announceTo(userId, {
      change,
      credential: { id: idOf(credential), name: credential.name, rp_id: credential.rpId },
      at: this.store.now()
    })
  }

  /** A raw `passkey.changed`, for a test that wants the event without the change. */
  announceRaw(userId: string, payload: Record<string, unknown>): number {
    return this.announceTo(userId, payload)
  }

  resetLimits(): void {
    for (const limiter of Object.values(this.limiters)) {
      limiter.reset()
    }
  }

  note(note: Omit<RefusalNote, 'at'>): void {
    this.refusalNotes.push({ at: this.store.now(), ...note })

    if (this.refusalNotes.length > REFUSALS_KEPT) {
      this.refusalNotes.shift()
    }
  }

  refusals(): RefusalNote[] {
    return this.refusalNotes.map(note => ({ ...note }))
  }

  /**
   * The `confirm_passkey` object of a `client.capabilities` result for a connection (contract §8).
   * `identity`: whether the connection has a signed-in user.
   */
  capability(identity: boolean): Record<string, unknown> {
    const off = { v: 1, enabled: false, gateway_id: '', rp: { native: [] as string[], web: [] as string[] } }

    if (!this.settings.enabled) {
      return { ...off, reason: 'disabled' }
    }

    const ctx = this.context()
    const reason = ctx.capabilityReason({ enabled: true, identity })

    return {
      v: 1,
      enabled: reason === '',
      reason,
      gateway_id: b64u(ctx.gatewayId),
      rp: { native: [...ctx.nativeRpIds].sort(), web: [...ctx.webRpIds].sort() }
    }
  }

  /**
   * The detail recorded with `passkey` for a connection, or `null` when the level must not be accepted from
   * it: the level is not enabled here, the connection has no signed-in user, or `{v: 1, kind, rp_id}`
   * names an RP this gateway does not accept for that kind. Whether the user has a credential is decided
   * per request.
   */
  acceptAdvertisement(identity: boolean, advertisement: unknown): { kind: 'native' | 'web'; rp_id: string } | null {
    if (typeof advertisement !== 'object' || advertisement === null || Array.isArray(advertisement)) {
      return null
    }

    const { v, kind, rp_id: rpId } = advertisement as Record<string, unknown>

    if (v !== 1 || (kind !== 'native' && kind !== 'web') || typeof rpId !== 'string' || !identity) {
      return null
    }

    if (!this.settings.enabled) {
      return null
    }

    const ctx = this.context()

    if (ctx.capabilityReason({ enabled: true, identity: true })) {
      return null
    }

    return (kind === 'native' ? ctx.nativeRpIds : ctx.webRpIds).has(rpId) ? { kind, rp_id: rpId } : null
  }
}
