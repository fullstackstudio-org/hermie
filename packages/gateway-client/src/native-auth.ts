import { type AuthEventRecorder, type AuthTimelineSink, NULL_AUTH_TIMELINE } from './auth-timeline'
import { type FetchLike, parseJsonObject, requestText } from './fetch-json'
import { NATIVE_REVOKE_FLOW } from './probe'
import { apiUrl, normalizeHeaders } from './url'
import { GatewayError, type GatewayErrorKind, isGatewayError } from './types'

/** Refresh this long before the access token actually expires. */
export const REFRESH_SKEW_SECONDS = 60

export interface TokenSet {
  accessToken: string
  refreshToken: string
  /** Unix seconds, as the gateway reports it. */
  expiresAt: number
  provider: string
  userId: string
}

/** Where the app keeps the token set. On device this is the platform secret store. */
export interface TokenStore {
  load(): Promise<TokenSet | null>
  save(tokens: TokenSet): Promise<void>
  clear(): Promise<void>
}

export interface NativeAuthOptions {
  extraHeaders?: Record<string, string>
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** Where a sign-in that cannot be refreshed is recorded. */
  timeline?: AuthEventRecorder
}

function toTokenSet(body: Record<string, unknown>, url: string): TokenSet {
  const accessToken = body.access_token
  const refreshToken = body.refresh_token

  if (typeof accessToken !== 'string' || !accessToken) {
    throw new GatewayError('protocol', `${url} answered without an access_token.`)
  }

  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
    expiresAt: typeof body.expires_at === 'number' ? body.expires_at : 0,
    provider: typeof body.provider === 'string' ? body.provider : '',
    userId: typeof body.user_id === 'string' ? body.user_id : ''
  }
}

/**
 * Redeem the one-time loopback code for bearer tokens. The gateway consumes the
 * code on every path, so a failure here is final: start a new sign-in rather
 * than retrying the exchange.
 */
export async function exchangeCode(
  baseUrl: string,
  params: { code: string; verifier: string },
  options: NativeAuthOptions = {}
): Promise<TokenSet> {
  const url = apiUrl(baseUrl, '/auth/native/token')
  const response = await requestText(url, {
    method: 'POST',
    headers: normalizeHeaders(options.extraHeaders),
    body: { code: params.code, code_verifier: params.verifier },
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs
  })

  if (response.status === 400) {
    throw new GatewayError('auth', 'That sign-in code was already used or has expired. Sign in again.', {
      status: 400
    })
  }

  if (response.status >= 500) {
    throw new GatewayError('server', `The gateway answered HTTP ${response.status} while exchanging the code.`, {
      status: response.status
    })
  }

  if (!response.ok) {
    throw new GatewayError('auth', `The code exchange failed with HTTP ${response.status}.`, {
      status: response.status
    })
  }

  const tokens = toTokenSet(parseJsonObject(response.text, url, 'protocol'), url)

  if (!tokens.refreshToken) {
    // The gateway answered with an access token and nothing to rotate it with.
    // That is not an error — the sign-in worked and the session is live — but
    // it has an expiry date the owner has not been told about, and the reason
    // is a scope on the provider's client registration rather than anything
    // here. See `AuthEventName['signin.no_refresh']`.
    ;(options.timeline ?? NULL_AUTH_TIMELINE).record({ event: 'signin.no_refresh', kind: 'auth' })
  }

  return tokens
}

/**
 * The only statuses that mean "this grant is finished, sign in again".
 *
 * Everything else a refresh can answer with is a statement about the moment, not
 * about the grant, and the difference decides whether the user keeps their
 * session: a definitive rejection reaches `TokenCoordinator.clear()` and deletes
 * the refresh token, which cannot be undone by retrying.
 *
 * This set used to be "401, or anything else that is not ok and not 5xx", which
 * swept up 408 and 429 — a request timeout and a rate limiter, neither of which
 * has an opinion about the refresh token. A gateway behind a proxy that
 * throttled a burst of refreshes signed the user out and threw away a token that
 * was still good.
 */
const DEFINITIVE_REFRESH_STATUSES = new Set([400, 401, 403])

/**
 * Rotate a refresh token. A 400/401/403 means the grant is finished and the user
 * has to sign in again; a 503 means the identity provider is unreachable and the
 * same refresh token is still worth retrying later.
 */
export async function refreshTokens(
  baseUrl: string,
  tokens: Pick<TokenSet, 'refreshToken' | 'provider'>,
  options: NativeAuthOptions = {}
): Promise<TokenSet> {
  const url = apiUrl(baseUrl, '/auth/native/refresh')

  if (!tokens.refreshToken) {
    throw new GatewayError('auth', 'There is no refresh token to rotate. Sign in again.', { status: 401 })
  }

  const response = await requestText(url, {
    method: 'POST',
    headers: normalizeHeaders(options.extraHeaders),
    body: { refresh_token: tokens.refreshToken, provider: tokens.provider },
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs
  })

  if (DEFINITIVE_REFRESH_STATUSES.has(response.status)) {
    throw new GatewayError('auth', 'Your session has expired. Sign in again.', { status: response.status })
  }

  if (response.status === 503) {
    throw new GatewayError('server', 'The identity provider is unreachable; Hermie will keep retrying.', {
      status: 503
    })
  }

  // A gateway too old to have the endpoint is a configuration story, not an
  // expired session: saying `auth` here would sign the user out of a gateway
  // that never had a refresh route to begin with.
  if (response.status === 404) {
    throw new GatewayError('protocol', 'This gateway has no /auth/native/refresh endpoint (HTTP 404).', { status: 404 })
  }

  if (!response.ok) {
    throw new GatewayError('server', `The gateway answered HTTP ${response.status} while refreshing.`, {
      status: response.status
    })
  }

  return toTokenSet(parseJsonObject(response.text, url, 'protocol'), url)
}

/**
 * How long a sign-out waits for the gateway to hear about it, in total.
 *
 * Short, because the wipe that follows is the part the reader asked for and it
 * must not sit behind a gateway that is down, or a network that swallows
 * packets. Both requests below share this one budget.
 */
export const NATIVE_REVOKE_TIMEOUT_MS = 3_000

/**
 * Ask the gateway to end this grant at the identity provider. Best effort, and
 * it never throws.
 *
 * Without this a sign-out only deleted the tokens on this device: the refresh
 * token stayed valid at the provider until it expired by itself, so a copy of
 * it taken from a backup or a lost device kept working.
 *
 * **Only where the route exists.** A gateway that has `POST /auth/native/revoke`
 * says so with `native_revoke` in the `auth_flows` of `/api/status`. That list
 * is read here, at sign-out, rather than carried from the probe: it is one
 * request on an action somebody takes rarely, it costs nothing on every start,
 * and it answers for the gateway as it is now rather than as it was when the
 * address was set up. Without the flow nothing is sent.
 *
 * **What goes out.** `{refresh_token, provider}` and the extra headers a front
 * door needs to pass the edge — no `Authorization`: the route is public, and
 * the refresh token in the body is the whole of the proof. Both requests refuse
 * to follow a redirect (`requestText`'s default), because the body is a
 * credential and a 30x must not hand it to the host it names.
 *
 * **How long.** Both requests share `timeoutMs` (default
 * `NATIVE_REVOKE_TIMEOUT_MS`), and this resolves when the budget is spent even
 * if the platform's `fetch` ignores the abort.
 */
export async function revokeNativeGrant(
  baseUrl: string,
  tokens: Pick<TokenSet, 'refreshToken' | 'provider'>,
  options: NativeAuthOptions = {}
): Promise<void> {
  // The gateway answers 400 to either one missing; there is nothing to send.
  if (!tokens.refreshToken || !tokens.provider) {
    return
  }

  const budget = options.timeoutMs ?? NATIVE_REVOKE_TIMEOUT_MS
  const controller = new AbortController()
  const request = {
    headers: normalizeHeaders(options.extraHeaders),
    fetchImpl: options.fetchImpl,
    timeoutMs: budget,
    signal: controller.signal
  }

  const attempt = (async () => {
    const statusUrl = apiUrl(baseUrl, '/api/status')
    const status = await requestText(statusUrl, request)

    if (!status.ok) {
      return
    }

    const flows = parseJsonObject(status.text, statusUrl, 'protocol').auth_flows

    if (!Array.isArray(flows) || !flows.includes(NATIVE_REVOKE_FLOW)) {
      return
    }

    await requestText(apiUrl(baseUrl, '/auth/native/revoke'), {
      ...request,
      method: 'POST',
      body: { refresh_token: tokens.refreshToken, provider: tokens.provider }
    })
  })().catch(() => {
    // Best effort: whatever the gateway said, the device still signs out.
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve()
    }, budget)
  })

  try {
    await Promise.race([attempt, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** True once the access token is inside the proactive-refresh window. */
export function tokenNeedsRefresh(tokens: TokenSet, nowSeconds: number, skew = REFRESH_SKEW_SECONDS): boolean {
  if (!tokens.expiresAt) {
    return false
  }

  return tokens.expiresAt - nowSeconds < skew
}

/**
 * The classification of a failure, and nothing else from it.
 *
 * A timeline entry must be safe to paste into an issue, so the message never
 * travels — only the `kind` and the HTTP status a `GatewayError` already carries.
 * Something thrown by the platform's secret store has neither, and stays
 * anonymous rather than being guessed at.
 */
function kindOf(error: unknown): { kind?: GatewayErrorKind; status?: number } {
  if (!isGatewayError(error)) {
    return {}
  }

  return { kind: error.kind, ...(error.status === undefined ? {} : { status: error.status }) }
}

/** Thrown when a sign-in or sign-out landed while a refresh was in flight. */
export class AuthChangedError extends Error {
  constructor() {
    super('Authentication changed while the request was in progress. Try again.')
    this.name = 'AuthChangedError'
  }
}

export interface TokenCoordinatorOptions {
  store: TokenStore
  refresh: (tokens: TokenSet) => Promise<TokenSet>
  nowSeconds?: () => number
  skewSeconds?: number
  /** A refresh failure that means "sign in again" rather than "try later". */
  isAuthRejection?: (error: unknown) => boolean
  /** Where the rotation record goes, so a later sign-out can be read back. */
  timeline?: AuthTimelineSink
}

export interface AccessTokenOptions {
  forceRefresh?: boolean
  /**
   * The access token that just got a 401. A late 401 must join a rotation that
   * is already running rather than rotate its winner a second time.
   */
  rejectedAccessToken?: string
}

/**
 * Ported from the Hermes Desktop native access-token coordinator: one owner for
 * refresh flights, with an auth epoch so a sign-in or sign-out that lands
 * mid-flight cannot be overwritten by the rotation it raced.
 *
 * Hermie talks to exactly one gateway, so the desktop's per-host maps collapse
 * into single fields.
 */
export class TokenCoordinator {
  // `timeline` is excluded: it has its own field, defaulted to the no-op ring.
  private readonly options: Required<Omit<TokenCoordinatorOptions, 'store' | 'refresh' | 'timeline'>> &
    Pick<TokenCoordinatorOptions, 'store' | 'refresh'>
  private refreshFlight: Promise<string | null> | null = null
  private authEpoch = 0
  /** Memo of the stored set; the secret store is slow and asked on every request. */
  private cached: TokenSet | null | undefined
  private loadFlight: Promise<TokenSet | null> | null = null
  private readonly timeline: AuthTimelineSink

  constructor(options: TokenCoordinatorOptions) {
    this.timeline = options.timeline ?? NULL_AUTH_TIMELINE
    this.options = {
      store: options.store,
      refresh: options.refresh,
      nowSeconds: options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
      skewSeconds: options.skewSeconds ?? REFRESH_SKEW_SECONDS,
      isAuthRejection:
        options.isAuthRejection ?? ((error: unknown) => error instanceof GatewayError && error.kind === 'auth')
    }
  }

  /** The token set as stored, without refreshing anything. */
  async current(): Promise<TokenSet | null> {
    if (this.cached !== undefined) {
      return this.cached
    }

    if (!this.loadFlight) {
      // The read is async, so a sign-in or sign-out can land while it is out.
      // `beginAuthChange` drops the flight, but the flight's own continuation
      // still runs — and without this fence it would write the pre-change
      // contents of the store back over the token that just replaced them.
      const flightEpoch = this.authEpoch

      const flight = this.options.store.load().then(
        loaded => {
          if (this.authEpoch !== flightEpoch) {
            return this.cached ?? null
          }

          this.cached = loaded

          if (this.loadFlight === flight) {
            this.loadFlight = null
          }

          return loaded
        },
        (error: unknown) => {
          // A keychain read can fail transiently — an item that is
          // `WhenUnlocked` and a process that asked a moment too early. Leaving
          // the rejected promise memoised here made one unlucky read permanent:
          // every later caller got the SAME rejection, so the coordinator could
          // never produce a token again and the dial loop reconnected forever
          // against a store that had been readable all along.
          if (this.loadFlight === flight) {
            this.loadFlight = null
          }

          this.timeline.record({ event: 'token.read_failed', ...kindOf(error) })

          throw error
        }
      )

      this.loadFlight = flight
    }

    return this.loadFlight
  }

  /**
   * An access token that is good to use right now: the stored one when it is
   * still comfortably valid, otherwise the result of a single shared rotation.
   * `null` means the user has to sign in again.
   */
  async accessToken(options: AccessTokenOptions = {}): Promise<string | null> {
    const existingFlight = this.refreshFlight

    if (existingFlight) {
      return existingFlight
    }

    const tokens = await this.current()

    if (!tokens) {
      return null
    }

    // A 401 for a token that is no longer the stored one was already handled by
    // whoever rotated it; hand back the current token instead of rotating again.
    const rejectedCurrent = !options.rejectedAccessToken || options.rejectedAccessToken === tokens.accessToken

    if (
      !(options.forceRefresh && rejectedCurrent) &&
      !tokenNeedsRefresh(tokens, this.options.nowSeconds(), this.options.skewSeconds)
    ) {
      // The remaining lifetime as THIS device's clock reads it. A reading far
      // from the lifetime the gateway issues is the only visible fingerprint of
      // clock drift, which is otherwise indistinguishable from an expired token.
      this.timeline.record({
        event: 'token.served',
        ...(tokens.expiresAt ? { expiresIn: tokens.expiresAt - this.options.nowSeconds() } : {})
      })

      return tokens.accessToken
    }

    if (!tokens.refreshToken) {
      this.timeline.record({ event: 'token.cleared', reason: 'no_refresh_token' })
      await this.clear()

      return null
    }

    // Reading the secret store is async, so a second caller can arrive between
    // the load and the decision. Re-check before opening a second rotation:
    // both callers awaited the same load, so their continuations run in order
    // and the loser finds the winner's flight here.
    const raced = this.refreshFlight

    if (raced) {
      return raced
    }

    return this.startRefresh(tokens)
  }

  /** Persist a freshly minted token set and fence any refresh in flight. */
  async save(tokens: TokenSet): Promise<void> {
    this.beginAuthChange()
    this.cached = tokens
    await this.options.store.save(tokens)
  }

  /** Forget the tokens and fence any refresh in flight. */
  async clear(): Promise<void> {
    this.beginAuthChange()
    this.cached = null
    await this.options.store.clear()
  }

  private beginAuthChange(): void {
    this.authEpoch += 1
    this.refreshFlight = null
    this.loadFlight = null
  }

  private startRefresh(tokens: TokenSet): Promise<string | null> {
    const flightEpoch = this.authEpoch

    const assertCurrent = () => {
      if (this.authEpoch !== flightEpoch) {
        throw new AuthChangedError()
      }
    }

    const flight = (async (): Promise<string | null> => {
      let rotated: TokenSet

      this.timeline.record({ event: 'refresh.start' })

      try {
        rotated = await this.options.refresh(tokens)
      } catch (error) {
        assertCurrent()
        this.timeline.record({ event: 'refresh.failed', ...kindOf(error) })

        if (this.options.isAuthRejection(error)) {
          this.timeline.record({ event: 'token.cleared', reason: 'refresh_rejected' })
          await this.clear()

          return null
        }

        throw error
      }

      assertCurrent()
      this.timeline.record({
        event: 'refresh.ok',
        ...(rotated.expiresAt ? { expiresIn: rotated.expiresAt - this.options.nowSeconds() } : {})
      })
      this.cached = rotated

      try {
        await this.options.store.save(rotated)
        this.timeline.record({ event: 'token.write_ok' })
      } catch (error) {
        // Rotation is destructive at the server: the refresh token just spent is
        // dead the moment the gateway answers. Rejecting here would throw away a
        // token set that works — breaking the session NOW on top of the next
        // launch being signed out anyway, because the store still holds the dead
        // pair. So the rotated set is served from memory and the failed write is
        // recorded, which is the only way the next sign-out can be traced back
        // to this moment.
        this.timeline.record({ event: 'token.write_failed', ...kindOf(error) })
      }

      return rotated.accessToken
    })()

    this.refreshFlight = flight

    return flight.finally(() => {
      if (this.refreshFlight === flight) {
        this.refreshFlight = null
      }
    })
  }
}
