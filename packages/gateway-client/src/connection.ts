import type { GatewayReadyPayload, RpcMethods, SessionLiveInfo } from '@hermes/shared/gateway-contract'
import type { GatewayEvent, GatewayEventName } from '@hermes/shared/gateway-events'
import type { ServerRequestHandler } from '@hermes/shared/json-rpc-channel'
import { JsonRpcGatewayClient } from '@hermes/shared/json-rpc-gateway'
import { reconnectBackoffDelayMs } from '@hermes/shared/reconnect-backoff'

import { type AuthTimelineSink, NULL_AUTH_TIMELINE } from './auth-timeline'
import type { CredentialProvider } from './credentials'
import type { FetchLike } from './fetch-json'
import { GatewayHttp } from './http'
import type { DialPlanSocketFactory } from './socket-factory'
import { asGatewayError, type ConnectionStatus, GatewayError, type GatewayConfig } from './types'
import { normalizeBaseUrl, normalizeHeaders, wsUrlFor } from './url'

/** How long after the socket opens we wait for the first `gateway.ready` frame. */
export const READY_TIMEOUT_MS = 10_000
/** Default window for one JSON-RPC call. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000
/** A turn can legitimately run for half an hour. */
export const PROMPT_SUBMIT_TIMEOUT_MS = 1_800_000
/** The first `session.resume` / `session.create` after a connect rebuilds an agent; give it room. */
export const FIRST_SESSION_TIMEOUT_MS = 60_000
/** Ceiling on the reconnect ladder. */
export const RECONNECT_CAP_MS = 15_000

/**
 * The lowest share of the exponential ceiling a wait is allowed to be.
 *
 * `@hermes/shared/reconnect-backoff` defaults to FULL jitter — a uniform draw
 * from `[0, ceiling)` — which is the right shape for a fleet of servers all
 * waking after one restart, and the wrong shape for one phone. Half its draws
 * land in the bottom half of the range and a good share land near zero, so a
 * ladder that had reached 2.4 s still dialled again 40 ms later.
 *
 * Bounded jitter keeps the spread that stops a thundering herd and drops the
 * floor no further than halfway. The vendored module is upstream code and is
 * not edited for this; the override lives in the connection's own default.
 */
const JITTER_FLOOR = 0.5

/**
 * Where the ladder starts when the address answered as something else.
 *
 * Attempt 3 is a 2.4 s ceiling on the 300 ms base. A `protocol` failure is a
 * well-formed HTTP answer from something that is not a gateway — a proxy
 * refusing a POST it does not route, a landing page — and none of that changes
 * in 300 ms. Measured on a real device before this existed: 18 dials in 24 s,
 * because each foreground calls `resume()`, which resets the ladder to the
 * bottom, and the bottom is a third of a second.
 *
 * A `network` failure deliberately keeps the fast first rungs. Those are the
 * flaps that really do heal in a second, and making them wait would be paying
 * for this fix with the case that already worked.
 */
export const PROTOCOL_LADDER_FLOOR = 3

/**
 * The ladder this connection climbs when the app does not supply one.
 *
 * Exported so the floor can be asserted rather than described: a jitter that is
 * allowed to return zero is exactly the defect this replaces.
 */
export function defaultBackoffDelayMs(attempt: number): number {
  const ceiling = reconnectBackoffDelayMs(attempt, { capMs: RECONNECT_CAP_MS, jitter: false })

  return ceiling * (JITTER_FLOOR + (1 - JITTER_FLOOR) * Math.random())
}

/**
 * How long a NetInfo "offline" has to hold before the socket comes down.
 *
 * On a phone, connectivity reports flap: a Wi-Fi/cellular handover, a VPN
 * coming up, walking past a lift. Each flap used to tear the connection down
 * and redial with `attempt = 0`, which mints a fresh ticket and rebuilds every
 * session — for a gap the socket would have ridden out untouched.
 *
 * What the grace does NOT do any more is decide whether to dial. See
 * `setOnline`: connectivity is a hint about timing, never a gate.
 */
export const OFFLINE_GRACE_MS = 2_500

/**
 * A dial that failed this recently means the ladder is still climbing, so a
 * network flap must not reset it back to the bottom.
 */
export const DIAL_FAILURE_RECENT_MS = 30_000
/** The oldest `SessionLiveInfo.desktop_contract` this client speaks. */
export const MIN_DESKTOP_CONTRACT = 7

/** Close codes the gateway uses to say "this is a configuration problem, not a blip". */
const CONFIG_CLOSE_CODES: Record<number, string> = {
  4403: 'The gateway rejected the connection because the address you used is not one it trusts. Set the gateway’s `dashboard.public_url` to this address and restart it.',
  4408: 'Another client took this connection over. Reopen Hermie to reclaim it.',
  4404: 'Chat is switched off on this gateway.'
}

const FIRST_SESSION_METHODS = new Set<string>(['session.resume', 'session.create'])

/**
 * How long one call gets. A prompt may legitimately run for half an hour; the
 * first `session.resume` / `session.create` after a connect rebuilds an agent
 * process and is far slower than the ones after it.
 */
export function rpcTimeoutMs(method: string, firstSessionCallDone: boolean): number {
  if (method === 'prompt.submit') {
    return PROMPT_SUBMIT_TIMEOUT_MS
  }

  if (!firstSessionCallDone && FIRST_SESSION_METHODS.has(method)) {
    return FIRST_SESSION_TIMEOUT_MS
  }

  return DEFAULT_RPC_TIMEOUT_MS
}

export type StatusHandler = (status: ConnectionStatus, error: GatewayError | null) => void

export interface GatewayConnectionOptions {
  config: GatewayConfig
  credentials: CredentialProvider
  socketFactory: DialPlanSocketFactory
  fetchImpl?: FetchLike
  /** Override the reconnect ladder (tests pass a deterministic one). */
  backoffDelayMs?: (attempt: number) => number
  readyTimeoutMs?: number
  /** Heartbeat interval; 0 disables it (the gateway still drives `gateway.ready.heartbeat`). */
  heartbeatIntervalMs?: number
  heartbeatDeadlineMs?: number
  connectTimeoutMs?: number
  /** How long an offline report must hold before the socket comes down. */
  offlineGraceMs?: number
  /** Injectable clock, so the backoff-preserving rules are testable. */
  now?: () => number
  /** Where the dial and sign-out record goes; the app persists it. */
  timeline?: AuthTimelineSink
}

/**
 * The connection state machine: one long-lived `JsonRpcGatewayClient` over a
 * socket this class dials, drops and redials.
 *
 * The client instance is deliberately never replaced. Its per-session
 * `lastSeenSeq` watermarks are what make `session.events.since` replay work
 * across a reconnect, and a fresh instance would start from an empty map and
 * silently lose every event that happened while the socket was down.
 */
export class GatewayConnection {
  readonly http: GatewayHttp

  private readonly client: JsonRpcGatewayClient
  private readonly credentials: CredentialProvider
  private readonly factory: DialPlanSocketFactory
  private readonly wsUrl: string
  private readonly extraHeaders: Record<string, string>
  private readonly backoff: (attempt: number) => number
  private readonly readyTimeoutMs: number
  private readonly offlineGraceMs: number
  private readonly now: () => number
  private readonly timeline: AuthTimelineSink

  private currentStatus: ConnectionStatus = 'disconnected'
  private currentError: GatewayError | null = null
  private readonly statusHandlers = new Set<StatusHandler>()

  private running = false
  private paused = false
  private online = true
  private attempt = 0
  private consecutiveAuthFailures = 0
  /**
   * WebSocket 4401 closes since the last healthy dial.
   *
   * Counted apart from `consecutiveAuthFailures` because upstream means something
   * different by it: no access token is verified on the upgrade path, so a 4401
   * is always a ticket that was expired, spent or unknown — and the first one
   * deserves a fresh ticket rather than a refresh-token rotation.
   */
  private consecutiveTicketRejections = 0
  private dialToken = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private offlineTimer: ReturnType<typeof setTimeout> | undefined
  private lastDialFailureAt: number | null = null
  private lastCloseCode: number | null = null
  private readyWaiter: {
    resolve: () => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  private currentReplayEpoch: string | null = null
  private currentLastReadyAt: number | null = null
  private firstSessionCallDone = false

  constructor(options: GatewayConnectionOptions) {
    const baseUrl = normalizeBaseUrl(options.config.baseUrl)
    this.credentials = options.credentials
    this.factory = options.socketFactory
    this.extraHeaders = normalizeHeaders(options.config.extraHeaders)
    this.wsUrl = wsUrlFor(baseUrl)
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.offlineGraceMs = options.offlineGraceMs ?? OFFLINE_GRACE_MS
    this.now = options.now ?? (() => Date.now())
    this.timeline = options.timeline ?? NULL_AUTH_TIMELINE
    this.backoff = options.backoffDelayMs ?? defaultBackoffDelayMs

    this.http = new GatewayHttp({
      baseUrl,
      credentials: options.credentials,
      extraHeaders: options.config.extraHeaders ?? {},
      timeline: this.timeline,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    })

    this.client = new JsonRpcGatewayClient({
      socketFactory: this.factory.create,
      requestTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.heartbeatDeadlineMs === undefined ? {} : { heartbeatDeadlineMs: options.heartbeatDeadlineMs }),
      ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs })
    })

    this.factory.setOnClose(info => {
      this.lastCloseCode = info.code
    })

    this.client.on('gateway.ready', event => this.onGatewayReady(event))
    this.client.onState(state => {
      if (state === 'closed' || state === 'error') {
        this.onTransportClosed()
      }
    })
  }

  get status(): ConnectionStatus {
    return this.currentStatus
  }

  get lastError(): GatewayError | null {
    return this.currentError
  }

  /** `replay_epoch` from the most recent `gateway.ready`; a change means the backend restarted. */
  get replayEpoch(): string | null {
    return this.currentReplayEpoch
  }

  /** `Date.now()` of the most recent `gateway.ready`. */
  get lastReadyAt(): number | null {
    return this.currentLastReadyAt
  }

  /** Begin dialling and keep the connection up until `stop()`. */
  start(): void {
    if (this.running) {
      return
    }

    this.running = true
    this.paused = false
    this.attempt = 0
    this.consecutiveAuthFailures = 0
    this.consecutiveTicketRejections = 0

    // Dialled even when NetInfo says there is no network: its answer is a hint,
    // and a cold start that believed a wrong one would never dial at all.
    void this.runDial()
  }

  /** Tear the connection down for good (sign-out, gateway change, app shutdown). */
  stop(): void {
    this.running = false
    this.paused = false
    this.teardown()
    this.setStatus('disconnected', null)
  }

  /**
   * Close the socket cleanly and stop every timer — the app went to the
   * background.
   *
   * A connection that is not running has already stopped for a reason it can
   * explain: `needs_signin`, a rejected certificate, a gateway that refused the
   * address. Overwriting that with `paused` loses the only account of why there
   * is no connection, and the user comes back to a blank screen.
   */
  pause(): void {
    if (this.paused || !this.running) {
      return
    }

    this.paused = true
    this.teardown()
    this.setStatus('paused', null)
  }

  /** Come back from the background: dial straight away, no backoff. */
  resume(): void {
    if (!this.paused && this.running) {
      return
    }

    this.paused = false
    this.running = true
    this.attempt = 0
    // A resume follows a fresh sign-in as often as it follows a foreground.
    // Keeping the old tally would send the next single rejection straight to
    // `needs_signin` with the new credential barely tried.
    this.consecutiveAuthFailures = 0
    this.consecutiveTicketRejections = 0
    this.clearOfflineTimer()

    void this.runDial()
  }

  /**
   * Dial now, skipping whatever backoff is pending — the "Try now" button, and
   * the one thing NetInfo is allowed to do to the loop.
   *
   * It is deliberately harmless to call at any time: a connection that has
   * stopped for a reason it can explain (`needs_signin`, a refused certificate,
   * a gateway that rejects this address) is not restarted by it, because
   * redialling those fails the same way and erases the explanation.
   *
   * Nor is one that is live or already dialling. A second dial beside a live
   * socket found the socket open, waited for a `gateway.ready` that had already
   * come, and tore the good socket down when that wait timed out; a connectivity
   * report during the first dial did the same to the socket it was opening.
   * Only a pending backoff, or a ladder labelled as climbing, is cut short.
   */
  retryNow(): void {
    if (!this.running || this.paused) {
      return
    }

    if (this.retryTimer === undefined && this.currentStatus !== 'reconnecting' && this.currentStatus !== 'offline') {
      return
    }

    this.attempt = 0
    this.consecutiveAuthFailures = 0
    this.consecutiveTicketRejections = 0
    void this.runDial()
  }

  /**
   * NetInfo says the device has (no) connectivity.
   *
   * **This is advice about timing, not permission to dial.** It used to be the
   * latter, and that is what made a connection unrecoverable without a relaunch:
   * a report of "no network" stopped the loop, and nothing but another report
   * started it again. Two ways that ends badly, both reproduced against the fake
   * gateway in `connection.test.ts`:
   *
   * - **A report that never comes back.** A tailnet interface going away and
   *   returning is exactly the transition a connectivity API is worst at, and
   *   the gateway on the other end of it was reachable the whole time.
   * - **A flap around a real drop.** Offline while the socket is up starts the
   *   grace; the socket then dies for real; online arrives inside the grace and
   *   the flap rule says "nothing to redial". The close was swallowed because
   *   the radio was believed to be down, so the connection stayed `ready` with
   *   a dead socket under it, for ever.
   *
   * So the ladder now runs regardless. What a connectivity report still does is
   * worth keeping, and it is only ever a speed-up: offline labels the status,
   * so a reader gets "Offline" rather than "Reconnecting…", and delays the
   * teardown of a live socket by `offlineGraceMs` so a handover does not rebuild
   * every session. Online collapses the pending backoff when the last dial did
   * not fail — a socket that was healthy a moment ago should come straight back.
   *
   * The grace belongs to the socket that was live when the report came: any
   * failure ends it (`handleFailure`, `scheduleReconnect`), so a grace timer
   * never outlives its socket to tear down the one the ladder dialled next.
   * That is also why a pending grace needs no check of its own here: it only
   * exists while the connection is `ready`.
   */
  setOnline(online: boolean): void {
    if (online) {
      this.clearOfflineTimer()
    }

    if (this.online === online) {
      return
    }

    this.online = online

    if (!online) {
      if (this.currentStatus !== 'ready') {
        // No live socket to protect. The ladder keeps its timer; all that
        // changes is the word the header shows while it climbs.
        if (this.running && !this.paused) {
          this.setStatus('offline')
        }

        return
      }

      this.offlineTimer = setTimeout(() => {
        this.offlineTimer = undefined
        // The status first: tearing the socket down while it still says `ready`
        // would have the close handled as a drop too, scheduling the reconnect
        // twice and climbing two rungs for one gap.
        const error = new GatewayError('network', 'This device reports no network connection.')
        this.setStatus('offline', error)
        this.scheduleReconnect(error)
      }, this.offlineGraceMs)

      return
    }

    if (!this.running || this.paused || this.currentStatus === 'ready') {
      // The flap ended before the socket came down; there is nothing to redial.
      return
    }

    // A dial that failed moments ago means the gateway, not the radio, is what
    // is unreachable. Collapsing the backoff there would hammer it once per
    // flap, so the ladder it had earned is left to climb — and it is capped, so
    // recovery is at most one interval away either way.
    if (this.lastDialFailureAt !== null && this.now() - this.lastDialFailureAt <= DIAL_FAILURE_RECENT_MS) {
      this.setStatus('reconnecting')

      return
    }

    this.retryNow()
  }

  /**
   * One JSON-RPC call, typed from the generated contract. Timeouts follow the
   * method: a prompt may run for half an hour, the first session call after a
   * connect rebuilds an agent, everything else gets 30 seconds.
   */
  request<M extends keyof RpcMethods>(
    method: M,
    params?: RpcMethods[M]['params'],
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<RpcMethods[M]['result']> {
    const timeoutMs = options.timeoutMs ?? rpcTimeoutMs(method as string, this.firstSessionCallDone)

    if (FIRST_SESSION_METHODS.has(method as string)) {
      this.firstSessionCallDone = true
    }

    return this.client.request<RpcMethods[M]['result']>(
      method as string,
      (params ?? {}) as Record<string, unknown>,
      timeoutMs,
      options.signal
    )
  }

  /** Subscribe to one gateway event type. */
  on<K extends GatewayEventName>(type: K, handler: (event: GatewayEvent<K>) => void): () => void {
    return this.client.on(type, handler)
  }

  /** Subscribe to every gateway event. */
  onAny(handler: (event: GatewayEvent) => void): () => void {
    return this.client.onAny(handler)
  }

  /** Server→client requests (approval, clarify, …). Unhandled ones are answered -32601 for us. */
  onRequest(handler: ServerRequestHandler): () => void {
    return this.client.onRequest(handler)
  }

  /** Subscribe to status transitions; the handler is called once with the current status. */
  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    handler(this.currentStatus, this.currentError)

    return () => this.statusHandlers.delete(handler)
  }

  private async runDial(): Promise<void> {
    const token = ++this.dialToken
    // Deliberately without `online`: a connectivity report is not allowed to
    // abandon a dial in flight, because the dial is the better evidence.
    const alive = () => token === this.dialToken && this.running && !this.paused

    this.clearRetryTimer()
    this.lastCloseCode = null
    this.timeline.record({ event: 'dial.start' })

    try {
      this.setStatus('authenticating')
      const plan = await this.credentials.dialPlan(this.wsUrl, this.extraHeaders)

      if (!alive()) {
        return
      }

      this.factory.arm(plan)
      // Register the waiter before connecting: `gateway.ready` can land in the
      // same tick the socket opens, and a gateway that refuses the credential
      // closes the socket instead of ever sending it.
      const ready = this.waitForReady()
      // The dial loop below awaits this; the no-op keeps a rejection that lands
      // while `connect()` is still pending from being reported as unhandled.
      ready.catch(() => undefined)
      this.setStatus('connecting')

      try {
        await this.client.connect(plan.url)
        await ready
      } finally {
        this.factory.disarm()
      }

      if (!alive()) {
        return
      }

      this.attempt = 0
      this.consecutiveAuthFailures = 0
      this.consecutiveTicketRejections = 0
      this.firstSessionCallDone = false
      this.lastDialFailureAt = null
      this.currentLastReadyAt = Date.now()
      this.timeline.record({ event: 'dial.ready' })
      this.setStatus('ready', null)
    } catch (error) {
      this.factory.disarm()

      if (!alive()) {
        return
      }

      await this.handleFailure(error)
    }
  }

  private waitForReady(): Promise<void> {
    this.rejectReadyWaiter(new GatewayError('network', 'A newer dial replaced this one.'))

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null
        reject(
          new GatewayError(
            'timeout',
            `The gateway accepted the socket but sent no gateway.ready within ${this.readyTimeoutMs / 1000} seconds.`
          )
        )
      }, this.readyTimeoutMs)

      this.readyWaiter = { resolve, reject, timer }
    })
  }

  private rejectReadyWaiter(error: Error): void {
    const waiter = this.readyWaiter

    if (!waiter) {
      return
    }

    this.readyWaiter = null
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }

  private onGatewayReady(event: GatewayEvent<'gateway.ready'>): void {
    const payload = event.payload as GatewayReadyPayload | undefined
    const epoch = payload?.replay_epoch

    if (typeof epoch === 'string' && epoch) {
      this.currentReplayEpoch = epoch
    }

    this.currentLastReadyAt = Date.now()

    const waiter = this.readyWaiter

    if (waiter) {
      this.readyWaiter = null
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  private onTransportClosed(): void {
    if (!this.running || this.paused) {
      return
    }

    // A gated gateway accepts the upgrade and *then* closes with 4401/4403, so
    // the socket opens and no `gateway.ready` ever arrives. Fail the waiting
    // dial straight away instead of sitting out the ready timeout.
    if (this.readyWaiter) {
      this.rejectReadyWaiter(
        new GatewayError('network', 'The gateway closed the connection during the handshake.', {
          ...(this.lastCloseCode === null ? {} : { closeCode: this.lastCloseCode })
        })
      )

      return
    }

    // A drop mid-dial is already the dial loop's problem; only a live connection
    // losing its socket has to re-enter the loop from here.
    if (this.currentStatus !== 'ready') {
      return
    }

    void this.handleFailure(
      new GatewayError('network', 'The gateway connection dropped.', {
        ...(this.lastCloseCode === null ? {} : { closeCode: this.lastCloseCode })
      })
    )
  }

  private async handleFailure(raw: unknown): Promise<void> {
    const error = asGatewayError(raw, 'network', 'The gateway connection failed.')
    const closeCode = error.closeCode ?? this.lastCloseCode
    this.lastDialFailureAt = this.now()
    // Whatever happens next, the socket an offline grace was protecting is gone.
    this.clearOfflineTimer()

    if (closeCode !== null && closeCode !== undefined && CONFIG_CLOSE_CODES[closeCode]) {
      this.running = false
      this.teardown()
      this.setStatus(
        'disconnected',
        new GatewayError('config', CONFIG_CLOSE_CODES[closeCode] as string, { closeCode, cause: error })
      )

      return
    }

    if (error.kind === 'tls') {
      // Retrying a rejected certificate just fails the same way; stop and explain.
      this.running = false
      this.teardown()
      this.setStatus('disconnected', error)

      return
    }

    if (error.kind === 'config') {
      this.running = false
      this.teardown()
      this.setStatus('disconnected', error)

      return
    }

    // Two different verdicts that used to share one branch. A 4401 is the gateway
    // refusing the TICKET — `_ws_auth_reason` inspects no access token, because
    // the HTTP auth middleware does not run for WebSocket routes — while an
    // `auth` error means the ticket MINT was refused, which is the one place an
    // expired bearer token actually shows up.
    if (closeCode === 4401) {
      await this.handleTicketRejection(error)

      return
    }

    if (error.kind === 'auth') {
      await this.handleAuthFailure(error)

      return
    }

    this.scheduleReconnect(error)
  }

  /**
   * A 4401 close: the ticket was expired (30 s TTL), already consumed, or unknown
   * because the gateway's process-local ticket store was reset. On `/api/ws` the
   * close carries no reason, so the three are indistinguishable — and a fresh
   * ticket is the answer to all three.
   *
   * Forcing a refresh-token rotation here, as this used to, diagnosed the only
   * thing a 4401 cannot mean. It also spent a rotation per refusal, and on a
   * provider with reuse detection a rotation is not free to spend.
   */
  private async handleTicketRejection(error: GatewayError): Promise<void> {
    this.consecutiveTicketRejections += 1
    this.timeline.record({ event: 'ws.closed', closeCode: 4401 })

    if (this.consecutiveTicketRejections === 1) {
      this.teardownSocket()

      if (!this.running || this.paused) {
        return
      }

      this.currentError = error
      void this.runDial()

      return
    }

    // A ticket minted seconds ago and refused as well is no longer a ticket
    // story: now the credential the mint authenticated with is the suspect.
    await this.handleAuthFailure(error)
  }

  private async handleAuthFailure(error: GatewayError): Promise<void> {
    this.consecutiveAuthFailures += 1
    this.teardownSocket()

    if (this.consecutiveAuthFailures > 1) {
      this.running = false
      this.teardown()
      this.timeline.signOut('rejected_after_refresh')
      this.setStatus(
        'needs_signin',
        new GatewayError('auth', 'The gateway rejected the credentials twice in a row. Sign in again.', {
          ...(error.closeCode === undefined ? {} : { closeCode: error.closeCode }),
          cause: error
        })
      )

      return
    }

    let verdict: 'retry' | 'reauth'

    try {
      verdict = await this.credentials.onRejected()
    } catch (refreshError) {
      this.scheduleReconnect(asGatewayError(refreshError, 'network', 'Refreshing the credentials failed.'))

      return
    }

    if (!this.running || this.paused) {
      return
    }

    if (verdict === 'reauth') {
      this.running = false
      this.teardown()
      // The verdict only says the credential provider has nothing left to offer.
      // Why it has nothing left was recorded by the coordinator a moment ago, so
      // the timeline attributes the sign-out by reading back to it.
      this.timeline.signOut('refresh_rejected')
      this.setStatus(
        'needs_signin',
        new GatewayError('auth', 'Your session has expired. Sign in again.', {
          cause: error
        })
      )

      return
    }

    this.currentError = error
    void this.runDial()
  }

  private scheduleReconnect(error: GatewayError): void {
    this.clearOfflineTimer()
    this.teardownSocket()

    // "Consecutive" has to mean it. Both tallies used to be reset only by a dial
    // that reached `ready`, so two auth failures with an ordinary outage between
    // them — a laptop roaming between networks, a gateway restarting behind a
    // proxy — counted as "twice in a row" however long the gap was, and signed
    // the user out with a claim that was not true. An outcome that is not an auth
    // failure breaks the streak.
    this.consecutiveAuthFailures = 0
    this.consecutiveTicketRejections = 0

    if (!this.running || this.paused) {
      return
    }

    // An answer that is not a gateway starts part-way up: see
    // `PROTOCOL_LADDER_FLOOR`. Everything else climbs from wherever it was.
    const rung = error.kind === 'protocol' ? Math.max(this.attempt, PROTOCOL_LADDER_FLOOR) : this.attempt
    const delay = this.backoff(rung)
    this.attempt = rung + 1
    // The ladder climbs either way; `offline` is only the word for it while the
    // device says there is no network to climb over. See `setOnline`.
    this.setStatus(this.online ? 'reconnecting' : 'offline', error)
    this.clearRetryTimer()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.runDial()
    }, delay)
  }

  private teardown(): void {
    this.dialToken += 1
    this.clearRetryTimer()
    this.clearOfflineTimer()
    this.teardownSocket()
    this.factory.disarm()
  }

  private teardownSocket(): void {
    this.rejectReadyWaiter(new GatewayError('network', 'The gateway connection was closed.'))
    this.client.close()
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  private clearOfflineTimer(): void {
    if (this.offlineTimer !== undefined) {
      clearTimeout(this.offlineTimer)
      this.offlineTimer = undefined
    }
  }

  private setStatus(status: ConnectionStatus, error: GatewayError | null | undefined = undefined): void {
    if (error !== undefined) {
      this.currentError = error
    }

    if (this.currentStatus === status) {
      return
    }

    this.currentStatus = status

    for (const handler of this.statusHandlers) {
      handler(status, this.currentError)
    }
  }
}

/**
 * Version gate. `SessionLiveInfo.desktop_contract` is the gateway's promise about
 * the shape of the session surface; below 7 the events this client reduces are
 * not all there, so refusing up front beats half-rendering a transcript.
 *
 * One resume shape leaves the field out on a gateway that otherwise speaks it:
 * a bot that has never said a word has a live session with no stored row yet,
 * and Hermes up to 0.21.3 answers `session.resume` for that session with
 * `{model, lazy: true, profile_name}` and nothing else. Every other path —
 * `session.create`, a resume of a spoken chat, `session.info` — carries the
 * number. So a `lazy` resume without it is not "old gateway"; it is "new bot".
 * The caller passes the contract it last saw from this gateway (`known`) and
 * that stands in. With nothing seen yet the resume is let through, because
 * the first chat someone opens on a fresh install is very often exactly such
 * a bot, and the next `session.info` brings the number for real.
 *
 * Returns the contract that was checked, or null when a lazy resume was let
 * through on trust.
 */
export function assertDesktopContract(
  info: SessionLiveInfo | null | undefined,
  known: number | null | undefined = null
): number | null {
  const raw = info?.desktop_contract
  let contract = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw

  if (typeof contract !== 'number' || Number.isNaN(contract)) {
    if (info?.lazy !== true) {
      throw new GatewayError(
        'incompatible',
        'This gateway does not report a desktop contract version, so it predates the session surface Hermie needs. Update Hermes on the gateway.'
      )
    }

    if (typeof known !== 'number' || Number.isNaN(known)) {
      return null
    }

    contract = known
  }

  if (contract < MIN_DESKTOP_CONTRACT) {
    throw new GatewayError(
      'incompatible',
      `This gateway speaks desktop contract ${contract}; Hermie needs at least ${MIN_DESKTOP_CONTRACT}. Update Hermes on the gateway.`
    )
  }

  return contract
}
