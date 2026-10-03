/**
 * The page's passkeys on its gateway (plan `confirm-passkey.md`, contract
 * `contract/confirm-passkey/`): `confirm` requests at level `passkey`, enrolment
 * with a one-time code, the step-ups that mint an invite or revoke a credential,
 * the credential list, and the `client.capabilities` advertisement.
 *
 * The native apps' `PasskeyModel` (`HermieCore/Passkey`), for a browser: the same
 * phases, the same refusal reasons and the same notices, with the web RP (the
 * page's own hostname) and the page's own origin as the base URL.
 *
 * How it answers, and what it never does:
 *
 *  - **Every answer goes through `request.answer`**, so a refusal comes back
 *    (4033, 4034 with `data.reason`, which leaves the request open for another
 *    try until the fifth). `ok` means "received and valid", never "confirmed"
 *    (phase `received`): the gateway commits it next and says `request.cancel
 *    {reason: "verification_failed"}` when that fails, which is the one reason
 *    that overrides an answer that went through. A client never sends `verified`.
 *  - **An answer that may have arrived is never called "not confirmed".** When a
 *    `request.answer` carrying an assertion gets no reply (the socket closed, the
 *    call timed out), the gateway may have taken it: the confirmation is marked
 *    `answerMayHaveArrived`, the retry state says the answer may have reached the
 *    gateway, and every later ending that is not the gateway's definitive verdict
 *    (a timeout, `resolved`, a withdrawal, a later answer it no longer takes) is
 *    `outcome_unknown`. `verification_failed`, too many attempts, 4033 and an `ok`
 *    keep their meaning.
 *  - **A decline is exactly `{decision: "declined", method: "tap"}`.**
 *  - **When the ceremony cannot run here** the frame is answered with error 4040
 *    and `data.reason`: `rp_not_configured` (no secure context or no WebAuthn),
 *    `bad_base_url` (the gateway's base URL has a path prefix, or is not one),
 *    `unsupported_version`, `bad_request`, `no_credential` (no passkey of this
 *    site listed), `gateway_id_mismatch`, `gateway_id_conflict`. The last five
 *    also leave a notice: never a silent failure.
 *  - **The challenge is computed from the confirmation the sheet renders**
 *    (`PasskeyConfirmation`: title, summary, detail as the frame carried them),
 *    and nothing else of its kind.
 *  - **Advertising.** After every arrival at `ready`, the two calls of contract
 *    §8: the first `client.capabilities` again (the channel's own call throws its
 *    result away), then, only when the first result's `confirm_passkey` is
 *    enabled, lists this page's hostname under `rp.web`, the page is a secure
 *    context with WebAuthn, the base URL has no path prefix and the gateway id
 *    breaks no pin, the second call with `confirm: ["passkey"]` and
 *    `confirm_passkey {v: 1, kind: "web", rp_id}`. `plain` is not advertised:
 *    this client has no sheet for it.
 *  - **Open requests again.** The gateway hides a gated request from a
 *    connection that has not advertised the level, and the replay of a resume
 *    runs before the second call, so once `passkey` is newly accepted on a socket
 *    the open requests of every session the page holds are read again
 *    (`session.events.since`); the channel hands them to this model like a live
 *    frame. A session the page starts holding only after that (a chat that
 *    resumed while the capability calls were still in flight, and whose answer
 *    the gateway had hidden) is read when it appears. A confirmation that was
 *    open before a read, belongs to a session just read and is not listed any
 *    more is over (the socket that told us so dropped): it ends as `timed_out`,
 *    quietly, like the gateway's own `timeout`.
 *  - **The page's clock ends a confirmation too.** A confirmation whose
 *    `expires_at` has passed is not actionable (`confirm` and `decline` end it as
 *    `timed_out` instead of running a ceremony for a dead request), and the sheet
 *    asks for it to end at the deadline (`expire`).
 *  - **Pins** (contract §10): the gateway id is pinned on the first successful
 *    enrolment; after that a frame, a capability or a status read with another id
 *    is refused and leaves a notice, and so is an id pinned for another gateway in
 *    this browser.
 *  - Nothing from a frame, an assertion or a code is logged.
 */
import { JsonRpcGatewayError, type ServerRequest } from '@hermes/shared/json-rpc-channel'
import type { StoreApi } from 'zustand/vanilla'

import type { PasskeyPinStore } from '../../platform/passkey-pins'
import { type CeremonyProblem, CeremonyError, type WebAuthnSeam } from '../../platform/webauthn'
import {
  type AdvertisingVerdict,
  type ConfirmEnd,
  type ConfirmPhase,
  isActionablePhase,
  isExpired,
  isOpenPhase,
  type PasskeyConfirmation,
  type PasskeyNoticeKind,
  type PasskeysState,
  passkeysStore
} from '../../state/passkeys'
import type { ChatGateway } from '../link'
import {
  b64uDecode,
  b64uEncode,
  canonicalEnrolmentCode,
  type ChallengeBinding,
  challenge,
  hasPathPrefix,
  serialiseBaseUrl,
  subjectText
} from './challenge'
import {
  type PasskeyAssertion,
  type PasskeyClient,
  type PasskeyCredentialInfo,
  PasskeyRouteError,
  type PasskeyStatus
} from './client'

/** The 4040 message (contract §8, `error_cannot_run_ceremony`). */
export const CANNOT_RUN_MESSAGE = 'passkey ceremony unavailable'
export const NOT_ALLOWED_CODE = 4033
export const REFUSED_CODE = 4034
export const CANNOT_RUN_CODE = 4040

/** The exact decline (contract §8). */
export const DECLINE = Object.freeze({ decision: 'declined', method: 'tap' })

/** At most this many finished confirmations are kept, for the sheet to show their end. */
const FINISHED_KEPT = 20

/** The slice of the connection the model uses. */
export type PasskeyGateway = Pick<ChatGateway, 'request' | 'onAny' | 'onRequest' | 'onStatus'>

/** Answer a server request with a JSON-RPC error that carries `data` (see `platform/socket.ts`). */
export type FailWithData = (
  request: ServerRequest,
  code: number,
  message: string,
  data: Record<string, unknown>
) => void

/** A session whose open requests can be read again, and how far the page has read it. */
export interface OpenSession {
  sessionId: string
  lastSeen: number
}

export interface PasskeyModelOptions {
  gateway: PasskeyGateway
  client: PasskeyClient
  webauthn: WebAuthnSeam
  /** The gateway's base URL (`ResolvedBasePath.baseUrl`). */
  baseUrl: string
  pins: PasskeyPinStore
  store?: StoreApi<PasskeysState>
  /** The sessions the page holds, for reading their open requests again. */
  openSessions?: () => readonly OpenSession[]
  /** Call `listener` whenever the sessions the page holds may have changed; returns the way to stop. */
  watchSessions?: (listener: () => void) => () => void
  /** How a 4040 with `data.reason` goes out; without one the error goes out without `data`. */
  failWithData?: FailWithData
  /** The first half of a new passkey's name: `<displayName> — <host>`. */
  displayName?: string
  /** Unix seconds. */
  now?: () => number
}

/** Why an enrolment, an invite or a revoke did not happen. */
export type PasskeyActionProblem =
  /** No secure context, no WebAuthn, or a base URL with a path prefix. */
  | { kind: 'not_supported' }
  /** The code is not 20 symbols of the contract's alphabet. */
  | { kind: 'invalid_code' }
  /** The gateway does not offer the level, or says why not. */
  | { kind: 'unavailable'; reason: string }
  /** The gateway does not accept this page's host as an RP. */
  | { kind: 'rp_not_accepted' }
  /** No passkey of this account for this site on the gateway. */
  | { kind: 'not_enrolled' }
  | { kind: 'gateway_id_mismatch' }
  | { kind: 'gateway_id_conflict' }
  /** The ceremony produced nothing. */
  | { kind: 'ceremony'; problem: CeremonyProblem }
  /** The route refused (`error` and `reason` as it gave them). */
  | {
      kind: 'refused'
      status: number
      error: string
      reason: string
      message: string
      /** Seconds the gateway asked the caller to wait (a 429's `Retry-After`). */
      retryAfter: number | null
    }
  /** The answer was not what the route promises. */
  | { kind: 'bad_answer' }
  /** The call did not get through. */
  | { kind: 'transport'; message: string }

export class PasskeyActionError extends Error {
  constructor(readonly problem: PasskeyActionProblem) {
    super(problem.kind)
    this.name = 'PasskeyActionError'
  }
}

/** A fresh enrolment code minted with a passkey. */
export interface PasskeyInvite {
  code: string
  /** Unix seconds. */
  expiresAt: number | null
}

interface ConfirmContext {
  /** The frame, to answer it with an error (4040) when the ceremony cannot run. */
  request: ServerRequest
  binding: ChallengeBinding
  allowCredentialIds: Uint8Array[]
}

interface Account {
  gatewayId: Uint8Array
  gatewayIdText: string
  userId: string
  handle: Uint8Array
  baseUrl: string
  rpId: string
}

/** A `gateway_id` that breaks a pin (contract §10). */
type PinProblem = { kind: 'gateway_id_mismatch' } | { kind: 'gateway_id_conflict' }

class FrameProblem extends Error {
  constructor(
    readonly reason: string,
    readonly notice?: PasskeyNoticeKind
  ) {
    super(reason)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export class PasskeyModel {
  readonly store: StoreApi<PasskeysState>
  /** The serialised base URL every challenge commits to; `null` where the browser path is not offered. */
  readonly baseUrl: string | null

  private readonly options: PasskeyModelOptions
  private readonly contexts = new Map<string, ConfirmContext>()
  /** Credential ids this page is adding or revoking: their `passkey.changed` is no news. */
  private readonly expectedAdditions = new Set<string>()
  private readonly expectedRevocations = new Set<string>()
  private unsubscribes: (() => void)[] = []
  private started = false
  private stopped = false
  private wasReady = false
  /** Bumped per socket generation (every arrival at `ready`), so a late capability answer is dropped. */
  private generation = 0
  private acceptedOnSocket = false
  /** The sessions whose open requests were read on this socket, once the level was accepted on it. */
  private readonly sessionsRead = new Set<string>()
  private nextNoticeId = 0
  private nextVersion = 0

  constructor(options: PasskeyModelOptions) {
    this.options = options
    this.store = options.store ?? passkeysStore

    const serialised = serialiseBaseUrl(options.baseUrl)

    this.baseUrl = serialised !== null && !hasPathPrefix(serialised) ? serialised : null
  }

  private get now(): number {
    return this.options.now?.() ?? Date.now() / 1000
  }

  /** This browser can run the level here at all. */
  get supported(): boolean {
    return this.options.webauthn.available && this.baseUrl !== null && this.options.webauthn.rpId !== ''
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────

  /** Listen to the connection: its server requests, its events and its arrivals at `ready`. */
  start(): void {
    if (this.started || this.stopped) {
      return
    }

    this.started = true
    this.store.getState().reset()
    this.store.setState({
      supported: this.supported,
      rpId: this.options.webauthn.rpId,
      pinned: this.options.pins.gatewayId() !== null
    })

    const { gateway } = this.options

    this.unsubscribes.push(
      gateway.onRequest(request => this.ingest(request)),
      gateway.onAny(event => {
        const payload: Record<string, unknown> = isRecord(event.payload) ? { ...event.payload } : {}

        if (event.type === ('request.cancel' as typeof event.type)) {
          this.withdrawn(text(payload.id) ?? '', text(payload.reason) ?? '')
        } else if (event.type === ('passkey.changed' as typeof event.type)) {
          void this.changed(payload)
        }
      }),
      ...(this.options.watchSessions
        ? [
            this.options.watchSessions(() => {
              if (this.acceptedOnSocket && !this.stopped) {
                void this.readOpenRequests()
              }
            })
          ]
        : []),
      gateway.onStatus(status => {
        if (status !== 'ready') {
          this.wasReady = false
          this.acceptedOnSocket = false
          this.sessionsRead.clear()

          return
        }

        if (!this.wasReady) {
          this.wasReady = true
          void this.advertise()
        }
      })
    )
  }

  /** Stop listening; every open confirmation is left to the gateway's deadline. */
  stop(): void {
    if (this.stopped) {
      return
    }

    this.stopped = true

    for (const unsubscribe of this.unsubscribes) {
      unsubscribe()
    }

    this.unsubscribes = []
    this.contexts.clear()
    this.options.webauthn.cancel()
    this.store.getState().reset()
  }

  // ── advertising (contract §8) ─────────────────────────────────────────────────────────────────

  /** Run the two `client.capabilities` calls for the current socket. Never throws. */
  async advertise(): Promise<void> {
    const generation = ++this.generation
    const { gateway, webauthn } = this.options
    let first: Record<string, unknown>

    try {
      first = (await gateway.request('client.capabilities', { server_requests: true })) as unknown as Record<
        string,
        unknown
      >
    } catch {
      if (generation === this.generation) {
        this.store.setState({ capability: { verdict: { kind: 'not_offered' }, accepted: [] } })
      }

      return
    }

    if (generation !== this.generation || this.stopped) {
      return
    }

    const offer = isRecord(first.confirm_passkey) ? first.confirm_passkey : null
    let verdict = this.verdict(offer)

    if (verdict.kind === 'gateway_id_mismatch' || verdict.kind === 'gateway_id_conflict') {
      this.notify({ kind: verdict.kind })
    }

    if (verdict.kind === 'advertised') {
      // The base URLs the level accepts are in the status read, not in the capability offer. A page whose
      // address is not one of them would have every answer refused (`base_url_not_accepted`), and five
      // refusals open the no-downgrade window for the conversation: do not advertise to begin with.
      const read = await this.readStatus()

      if (generation !== this.generation || this.stopped) {
        return
      }

      if (read.problem) {
        verdict = read.problem
      } else if (read.status && !this.baseUrlListed(read.status)) {
        verdict = { kind: 'base_url_not_listed' }
        this.notify({ kind: 'base_url_not_listed' })
      }
    }

    let accepted: string[] = []

    if (verdict.kind === 'advertised') {
      try {
        const second = (await gateway.request('client.capabilities', {
          server_requests: true,
          confirm: ['passkey'],
          confirm_passkey: { v: 1, kind: 'web', rp_id: webauthn.rpId }
        } as { server_requests: boolean })) as unknown as Record<string, unknown>

        accepted = Array.isArray(second.confirm)
          ? second.confirm.filter((level): level is string => typeof level === 'string')
          : []
      } catch {
        accepted = []
      }
    }

    if (generation !== this.generation || this.stopped) {
      return
    }

    this.store.setState({ capability: { verdict, accepted } })

    if (accepted.includes('passkey') && !this.acceptedOnSocket) {
      this.acceptedOnSocket = true
      await this.readOpenRequests()
    }

    // The level is on here: read the list once, for the settings page and the notices. (Where it is off the
    // routes answer 404, and the settings page reads them itself when it is opened.)
    if (offer?.enabled === true && this.store.getState().status === null && verdict.kind !== 'advertised') {
      await this.refresh()
    }
  }

  /** The gateway lists this page's address among its base URLs; true too when it does not say (an older gateway). */
  private baseUrlListed(status: PasskeyStatus): boolean {
    if (!Array.isArray(status.base_urls) || this.baseUrl === null) {
      return true
    }

    return status.base_urls.some(url => typeof url === 'string' && serialiseBaseUrl(url) === this.baseUrl)
  }

  private verdict(offer: Record<string, unknown> | null): AdvertisingVerdict {
    if (!offer || offer.v !== 1) {
      return { kind: 'not_offered' }
    }

    if (offer.enabled !== true) {
      return { kind: 'unavailable', reason: text(offer.reason) ?? '' }
    }

    if (!this.supported) {
      return { kind: 'not_supported' }
    }

    const web = isRecord(offer.rp) && Array.isArray(offer.rp.web) ? offer.rp.web : []

    if (!web.includes(this.options.webauthn.rpId)) {
      return { kind: 'rp_not_accepted' }
    }

    return this.pinProblem(text(offer.gateway_id) ?? '') ?? { kind: 'advertised' }
  }

  /**
   * Read the open requests of every session the page holds again; they arrive through the channel. A
   * confirmation that was open before the read, is in a session just read and is not among the open
   * requests the gateway lists now is over: the socket that said so was dropped (or the request never
   * reached it), and nothing will say it again.
   */
  private async readOpenRequests(): Promise<void> {
    const sessions = (this.options.openSessions?.() ?? []).filter(({ sessionId }) => !this.sessionsRead.has(sessionId))

    for (const { sessionId } of sessions) {
      this.sessionsRead.add(sessionId)
    }

    await Promise.all(
      sessions.map(async ({ sessionId, lastSeen }) => {
        // Only what was here before the read: a frame that arrives while it is in flight may be newer than
        // the gateway's list.
        const before = this.store
          .getState()
          .confirmations.filter(entry => entry.sessionId === sessionId && isOpenPhase(entry.phase))
          .map(entry => entry.id)
        let result: unknown

        try {
          result = await this.options.gateway.request('session.events.since', {
            session_id: sessionId,
            last_seen: lastSeen
          })
        } catch {
          // Not read: the next change of the sessions tries it again.
          this.sessionsRead.delete(sessionId)

          return
        }

        const open = isRecord(result) ? result.open_requests : undefined

        if (this.stopped || !Array.isArray(open)) {
          // A gateway that does not list them says nothing about them.
          return
        }

        const listed = new Set(open.map(entry => (isRecord(entry) ? text(entry.id) : null)))

        for (const id of before) {
          if (!listed.has(id)) {
            this.withdrawn(id, 'timeout')
          }
        }
      })
    )
  }

  /** A `gateway_id` checked against the pins (contract §10). */
  private pinProblem(gatewayId: string): PinProblem | null {
    const pinned = this.options.pins.gatewayId()

    if (pinned !== null && pinned !== gatewayId) {
      return { kind: 'gateway_id_mismatch' }
    }

    return this.options.pins.foreignGatewayIds().has(gatewayId) ? { kind: 'gateway_id_conflict' } : null
  }

  // ── arrival of a confirm ──────────────────────────────────────────────────────────────────────

  /** The connection's handler for server requests: `confirm` at level `passkey` is ours. */
  private ingest(request: ServerRequest): boolean {
    if (this.stopped || request.method !== 'confirm' || request.params.level !== 'passkey') {
      // `plain` is never advertised here; anything else is somebody else's.
      return false
    }

    const existing = this.find(request.id)

    // A copy of one already here: a reconnect or a second read re-delivered it. An error goes out on
    // the newest copy. The one exception is a request this connection was told (4033) it may not answer: that
    // was about the connection then (an answer in the window before the second capabilities call was
    // accepted), and a frame delivered again is the gateway offering it to this connection now.
    if (existing && !(existing.phase.kind === 'ended' && existing.phase.end.kind === 'not_allowed')) {
      const context = this.contexts.get(request.id)

      if (context) {
        context.request = request
      }

      return true
    }

    try {
      const { confirmation, context } = this.read(request)

      this.contexts.set(request.id, context)
      this.upsert(confirmation)
    } catch (error) {
      const problem = error instanceof FrameProblem ? error : new FrameProblem('bad_request')

      if (problem.notice) {
        this.notify(problem.notice)
      }

      this.cannotRun(request, problem.reason)
    }

    return true
  }

  /** Read a frame into what the sheet shows and what the challenge commits to, or say why not. */
  private read(request: ServerRequest): { confirmation: PasskeyConfirmation; context: ConfirmContext } {
    const { webauthn } = this.options

    if (!webauthn.available || webauthn.rpId === '') {
      throw new FrameProblem('rp_not_configured')
    }

    if (this.baseUrl === null) {
      throw new FrameProblem('bad_base_url')
    }

    const params = request.params
    const passkey = isRecord(params.passkey) ? params.passkey : null

    if (!passkey || passkey.v !== 1) {
      throw new FrameProblem('unsupported_version', { kind: 'unsupported_version' })
    }

    const title = text(params.title)
    const summary = text(params.summary)
    const sessionId = text(params.session_id)
    const detail = params.detail === undefined || params.detail === null ? null : text(params.detail)
    const user = isRecord(passkey.user) ? passkey.user : {}
    const userId = text(user.id)
    const gatewayIdText = text(passkey.gateway_id)
    const gatewayId = gatewayIdText === null ? null : b64uDecode(gatewayIdText, 16, 16)
    const nonce = typeof passkey.nonce === 'string' ? b64uDecode(passkey.nonce, 32, 32) : null

    if (
      title === null ||
      summary === null ||
      sessionId === null ||
      (params.detail !== undefined && params.detail !== null && detail === null) ||
      !userId ||
      gatewayIdText === null ||
      gatewayId === null ||
      nonce === null
    ) {
      throw new FrameProblem('bad_request', { kind: 'malformed_request' })
    }

    const allow = (Array.isArray(passkey.credentials) ? passkey.credentials : [])
      .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.rp_id === webauthn.rpId)
      .flatMap(entry => (Array.isArray(entry.ids) ? entry.ids : []))
      .map(id => (typeof id === 'string' ? b64uDecode(id, 1, 1023) : null))
      .filter((id): id is Uint8Array => id !== null)

    if (allow.length === 0) {
      throw new FrameProblem('no_credential', { kind: 'no_credential' })
    }

    const pin = this.pinProblem(gatewayIdText)

    if (pin) {
      throw new FrameProblem(pin.kind, pin)
    }

    const expires = typeof passkey.expires_at === 'number' ? passkey.expires_at : null

    return {
      confirmation: {
        id: request.id,
        sessionId,
        title,
        summary,
        detail,
        baseUrl: this.baseUrl,
        userName: text(user.name) ?? '',
        expiresAt: expires,
        phase: { kind: 'waiting' },
        answerMayHaveArrived: false,
        version: 0,
        dismissed: false
      },
      context: {
        request,
        binding: {
          purpose: 'confirm',
          baseUrl: this.baseUrl,
          gatewayId,
          userId,
          sessionId,
          requestId: request.id,
          nonce
        },
        allowCredentialIds: allow
      }
    }
  }

  private cannotRun(request: ServerRequest, reason: string): void {
    if (this.options.failWithData) {
      this.options.failWithData(request, CANNOT_RUN_CODE, CANNOT_RUN_MESSAGE, { reason })
    } else {
      request.fail(CANNOT_RUN_CODE, CANNOT_RUN_MESSAGE)
    }
  }

  // ── answering ─────────────────────────────────────────────────────────────────────────────────

  /**
   * The person pressed Confirm: run the ceremony over the challenge of what the
   * sheet shows, then answer through `request.answer`. Closing the browser's
   * sheet sends nothing and leaves the confirmation as it was.
   */
  async confirm(id: string): Promise<void> {
    const current = this.find(id)
    const context = this.contexts.get(id)

    if (!current || !context || !isActionablePhase(current.phase) || this.expire(id)) {
      return
    }

    const before = current.phase
    const { webauthn } = this.options

    this.setPhase(id, { kind: 'signing' })

    let response

    try {
      // The text is the confirmation's own: the object the sheet renders.
      const signed = await challenge(webauthn.sha256, context.binding, current)

      response = await webauthn.get({
        rpId: webauthn.rpId,
        challenge: signed,
        allowCredentialIds: context.allowCredentialIds
      })
    } catch (error) {
      this.ceremonyFailed(id, error, before)

      return
    }

    // The gateway may have withdrawn it while the browser's sheet was up.
    if (this.find(id)?.phase.kind !== 'signing') {
      return
    }

    const assertion: PasskeyAssertion = {
      v: 1,
      rp_id: webauthn.rpId,
      base_url: current.baseUrl,
      credential_id: b64uEncode(response.credentialId),
      authenticator_data: b64uEncode(response.authenticatorData),
      client_data_json: b64uEncode(response.clientDataJSON),
      signature: b64uEncode(response.signature),
      ...(response.userHandle && response.userHandle.length > 0 ? { user_handle: b64uEncode(response.userHandle) } : {})
    }

    await this.answer(id, { decision: 'confirmed', method: 'passkey', passkey: assertion }, { kind: 'received' })
  }

  /** The person pressed Decline: exactly `{decision: "declined", method: "tap"}`. */
  async decline(id: string): Promise<void> {
    const current = this.find(id)

    if (!current || !isActionablePhase(current.phase) || this.expire(id)) {
      return
    }

    await this.answer(id, { ...DECLINE }, { kind: 'declined' })
  }

  /**
   * End a confirmation whose deadline has passed on this page's clock, the way the gateway's own `timeout`
   * would (quietly; the layer says it). The gateway's `request.cancel` is the first word, but a socket that
   * dropped misses it, and a request nobody can answer must not stay on screen as if somebody could. An
   * answer already on its way is left to the gateway. Returns whether it ended.
   */
  expire(id: string): boolean {
    const current = this.find(id)

    if (!current || !isOpenPhase(current.phase) || !isExpired(current, this.now)) {
      return false
    }

    this.withdrawn(id, 'timeout')

    return this.find(id)?.phase.kind === 'ended'
  }

  /** The person closed the sheet of a finished confirmation. */
  dismiss(id: string): void {
    const current = this.find(id)

    if (current && !isOpenPhase(current.phase)) {
      this.patch(id, { dismissed: true })
    }
  }

  private ceremonyFailed(id: string, error: unknown, before: ConfirmPhase): void {
    if (this.find(id)?.phase.kind !== 'signing') {
      return
    }

    const problem: CeremonyProblem =
      error instanceof CeremonyError
        ? error.problem
        : { kind: 'failed', message: error instanceof Error ? error.message : String(error) }

    switch (problem.kind) {
      case 'cancelled':
      case 'busy':
        // Closed, timed out or already busy: nothing goes out, the sheet stays as it was.
        this.setPhase(id, before)

        return
      case 'unavailable': {
        // This browser cannot take part: the frame is answered 4040, which takes this connection out
        // of the running.
        const request = this.contexts.get(id)?.request

        this.setPhase(id, { kind: 'ended', end: { kind: 'unavailable', reason: problem.reason } })

        if (request) {
          this.cannotRun(request, problem.reason)
        }

        return
      }
      default:
        this.setPhase(id, { kind: 'not_sent', message: problem.kind === 'failed' ? problem.message : problem.kind })
    }
  }

  /**
   * Send `result` through `request.answer` and read what came back.
   *
   * A call that got no reply (the socket closed, it timed out) may still have delivered what it carried: when
   * that was an assertion, the confirmation is marked `answerMayHaveArrived`, and from then on no ending
   * says that nothing was confirmed unless the gateway said so (see `patch`). A gateway that answers a later
   * try with anything but `ok`, 4033 or 4034 (it no longer knows the request, it was settled) gives no
   * verdict either: such a confirmation ends `outcome_unknown`.
   */
  private async answer(id: string, result: Record<string, unknown>, done: ConfirmPhase): Promise<void> {
    this.setPhase(id, { kind: 'sending' })

    let outcome: ConfirmPhase

    try {
      const reply = (await this.options.gateway.request('request.answer', { id, result })) as { status?: unknown }
      const status = text(reply?.status) ?? ''

      outcome = status === 'ok' ? done : { kind: 'ended', end: { kind: 'withdrawn', reason: status } }
    } catch (error) {
      const unanswered = isTransportFailure(error)

      if (unanswered && result.decision === 'confirmed') {
        this.patch(id, { answerMayHaveArrived: true })
      }

      outcome = phaseAfter(error)

      if (!unanswered && outcome.kind === 'not_sent' && this.find(id)?.answerMayHaveArrived) {
        outcome = { kind: 'ended', end: { kind: 'outcome_unknown' } }
      }
    }

    // A `request.cancel` may have ended it meanwhile; only `verification_failed` overrides an answer
    // that went through, and it is already in.
    if (this.find(id)?.phase.kind !== 'sending') {
      return
    }

    this.setPhase(id, outcome)

    if (outcome.kind === 'declined') {
      this.patch(id, { dismissed: true })
    }
  }

  // ── withdrawals ───────────────────────────────────────────────────────────────────────────────

  /** `request.cancel` for one of ours: the reason is the outcome. */
  private withdrawn(id: string, reason: string): void {
    const current = this.find(id)

    if (!current) {
      return
    }

    const answered =
      current.phase.kind === 'received' || current.phase.kind === 'declined' || current.phase.kind === 'sending'
    let next: ConfirmPhase | null

    switch (reason) {
      case 'verification_failed':
        // The one reason that overrides an answer that went through: it is NOT confirmed.
        next = { kind: 'ended', end: { kind: 'verification_failed' } }
        break
      case 'too_many_attempts':
        next = { kind: 'ended', end: { kind: 'too_many_attempts' } }
        break
      case 'resolved':
        next = answered ? null : { kind: 'ended', end: { kind: 'answered_elsewhere' } }
        break
      case 'timeout':
        next = answered ? null : { kind: 'ended', end: { kind: 'timed_out' } }
        break
      default:
        next = answered ? null : { kind: 'ended', end: { kind: 'withdrawn', reason } }
    }

    if (!next) {
      return
    }

    if (current.phase.kind === 'signing') {
      this.options.webauthn.cancel()
    }

    this.setPhase(id, next)

    // What ended it without the person's doing is said by the layer as it goes; what the person
    // must read (it did not count, or it may have counted) stays on screen, even over a sheet they had
    // closed. Read back: an answer that may have arrived turns these endings into `outcome_unknown`.
    const ended = this.find(id)?.phase
    const quiet = ended?.kind === 'ended' && QUIET_ENDS.has(ended.end.kind)

    this.patch(id, { dismissed: quiet })
  }

  // ── events ────────────────────────────────────────────────────────────────────────────────────

  /** `passkey.changed`: a credential of this account was added or revoked somewhere. */
  private async changed(payload: Record<string, unknown>): Promise<void> {
    const credential = isRecord(payload.credential) ? payload.credential : {}
    const id = text(credential.id) ?? ''
    const name = text(credential.name) ?? ''
    const known = this.options.pins.seen().ids

    if (payload.change === 'added' && !this.expectedAdditions.has(id) && !known.includes(id)) {
      this.notify({ kind: 'credential_added', name })
    } else if (payload.change === 'revoked' && !this.expectedRevocations.has(id) && known.includes(id)) {
      this.notify({ kind: 'credential_revoked', name })
    }

    await this.refresh()
  }

  // ── the list ──────────────────────────────────────────────────────────────────────────────────

  /** Read `GET /api/auth/passkeys`. Never throws; `statusError` says why it failed. */
  async refresh(): Promise<void> {
    await this.readStatus()
  }

  /** `refresh`, with what it read: the status, or the pin it broke (already noticed), or neither when it failed. */
  private async readStatus(): Promise<{ status: PasskeyStatus | null; problem: PinProblem | null }> {
    if (this.stopped) {
      return { status: null, problem: null }
    }

    try {
      const next = await this.options.client.status()

      if (this.stopped) {
        return { status: null, problem: null }
      }

      this.store.setState({ statusError: null })

      const problem = this.adopt(next)

      return { status: problem ? null : next, problem }
    } catch (error) {
      const route = error instanceof PasskeyRouteError ? error : null

      this.store.setState({
        statusError: {
          kind: route?.kind ?? 'transport',
          message: error instanceof Error ? error.message : String(error)
        }
      })

      return { status: null, problem: null }
    }
  }

  /**
   * Take in a status read: notice a gateway id that breaks the pin and passkeys added without this page.
   * Returns the pin it breaks, in which case nothing of the read is kept: it is not this gateway's list as
   * this browser knows it, and the settings page must not show another gateway's passkeys under the notice.
   */
  private adopt(next: PasskeyStatus): PinProblem | null {
    const credentials = Array.isArray(next.credentials) ? next.credentials : []
    const problem = next.gateway_id ? this.pinProblem(next.gateway_id) : null

    if (problem) {
      this.store.setState({ status: null, credentials: [] })
      this.notify(problem)

      return problem
    }

    this.store.setState({ status: next, credentials })

    const seen = this.options.pins.seen()
    const added = credentials.filter(
      credential => !seen.ids.includes(credential.id) && !this.expectedAdditions.has(credential.id)
    )

    if (seen.seenAt > 0 && added[0]) {
      this.notify({ kind: 'credential_added', name: added[0].name })
    }

    this.options.pins.remember(credentials.map(credential => credential.id))

    return null
  }

  // ── enrolment and step-ups ────────────────────────────────────────────────────────────────────

  /**
   * Enrol a passkey of this browser for this gateway, with a one-time code from the operator (or
   * minted with one's own passkey elsewhere). Pins the gateway's id on the first success.
   */
  async enrol(code: string): Promise<PasskeyCredentialInfo> {
    const canonical = canonicalEnrolmentCode(code)

    if (!canonical) {
      throw new PasskeyActionError({ kind: 'invalid_code' })
    }

    const account = await this.account()
    const host = new URL(account.baseUrl).host
    const name = credentialName(this.options.displayName ?? 'Hermie', host)
    const begin = await this.route(client =>
      client.registerBegin({ rp_id: account.rpId, base_url: account.baseUrl, name })
    )
    const nonce = typeof begin?.nonce === 'string' ? b64uDecode(begin.nonce, 32, 32) : null

    if (typeof begin?.registration_id !== 'string' || !begin.registration_id || !nonce) {
      throw new PasskeyActionError({ kind: 'bad_answer' })
    }

    const { webauthn } = this.options
    const signed = await challenge(
      webauthn.sha256,
      {
        purpose: 'register',
        baseUrl: account.baseUrl,
        gatewayId: account.gatewayId,
        userId: account.userId,
        sessionId: '',
        requestId: begin.registration_id,
        nonce
      },
      subjectText(name)
    )
    const handle =
      (typeof begin.user?.handle === 'string' ? b64uDecode(begin.user.handle, 1, 64) : null) ?? account.handle
    const excluded = (Array.isArray(begin.exclude_credentials) ? begin.exclude_credentials : [])
      .map(entry => (typeof entry?.id === 'string' ? b64uDecode(entry.id, 1, 1023) : null))
      .filter((id): id is Uint8Array => id !== null)

    let registration

    try {
      registration = await webauthn.create({
        rpId: account.rpId,
        challenge: signed,
        userHandle: handle,
        name,
        excludeCredentialIds: excluded
      })
    } catch (error) {
      throw ceremonyActionError(error)
    }

    const id = b64uEncode(registration.credentialId)

    this.expectedAdditions.add(id)

    try {
      const finish = await this.route(client =>
        client.registerFinish({
          registration_id: begin.registration_id,
          base_url: account.baseUrl,
          code: canonical,
          credential: {
            id,
            client_data_json: b64uEncode(registration.clientDataJSON),
            attestation_object: b64uEncode(registration.attestationObject),
            transports: registration.transports
          }
        })
      )

      // The first successful enrolment pins the id; a later one keeps the pin there is.
      if (this.options.pins.gatewayId() === null) {
        this.options.pins.pin(account.gatewayIdText)
      }

      this.store.setState({ pinned: true })

      this.options.pins.remember([...this.options.pins.seen().ids, id])
      await this.refresh()

      return finish?.credential ?? { id, name, rp_id: account.rpId }
    } finally {
      this.expectedAdditions.delete(id)
    }
  }

  /** Mint an enrolment code with a passkey of this browser (`invite` step-up), for another device. */
  async mintInvite(): Promise<PasskeyInvite> {
    const { stepupId, assertion, account } = await this.stepUp('invite', 'invite')
    const result = await this.route(client =>
      client.invite({ stepup_id: stepupId, base_url: account.baseUrl, assertion })
    )

    if (typeof result?.code !== 'string' || !result.code) {
      throw new PasskeyActionError({ kind: 'bad_answer' })
    }

    return { code: result.code, expiresAt: typeof result.expires_at === 'number' ? result.expires_at : null }
  }

  /** Remove one of this account's passkeys, with a passkey of this browser (`revoke` step-up). */
  async revoke(credentialId: string): Promise<void> {
    this.expectedRevocations.add(credentialId)

    try {
      const { stepupId, assertion, account } = await this.stepUp('revoke', credentialId)

      await this.route(client =>
        client.revoke({ credential_id: credentialId, stepup_id: stepupId, base_url: account.baseUrl, assertion })
      )

      this.options.pins.remember(this.options.pins.seen().ids.filter(id => id !== credentialId))
      await this.refresh()
    } finally {
      this.expectedRevocations.delete(credentialId)
    }
  }

  /** Open a step-up and sign it: `subject` is `"invite"` or the credential id (contract §5). */
  private async stepUp(
    purpose: 'invite' | 'revoke',
    subject: string
  ): Promise<{ stepupId: string; assertion: PasskeyAssertion; account: Account }> {
    const account = await this.account()
    const begin = await this.route(client => client.stepupBegin({ purpose, subject }))
    const nonce = typeof begin?.nonce === 'string' ? b64uDecode(begin.nonce, 32, 32) : null

    if (typeof begin?.stepup_id !== 'string' || !begin.stepup_id || !nonce || (begin.subject ?? subject) !== subject) {
      throw new PasskeyActionError({ kind: 'bad_answer' })
    }

    const allow = (Array.isArray(begin.credentials) ? begin.credentials : [])
      .filter(entry => entry?.rp_id === account.rpId)
      .flatMap(entry => (Array.isArray(entry.ids) ? entry.ids : []))
      .map(id => (typeof id === 'string' ? b64uDecode(id, 1, 1023) : null))
      .filter((id): id is Uint8Array => id !== null)

    if (allow.length === 0) {
      throw new PasskeyActionError({ kind: 'not_enrolled' })
    }

    const { webauthn } = this.options
    const signed = await challenge(
      webauthn.sha256,
      {
        purpose,
        baseUrl: account.baseUrl,
        gatewayId: account.gatewayId,
        userId: account.userId,
        sessionId: '',
        requestId: begin.stepup_id,
        nonce
      },
      subjectText(subject)
    )

    let response

    try {
      response = await webauthn.get({ rpId: account.rpId, challenge: signed, allowCredentialIds: allow })
    } catch (error) {
      throw ceremonyActionError(error)
    }

    return {
      stepupId: begin.stepup_id,
      account,
      assertion: {
        v: 1,
        rp_id: account.rpId,
        base_url: account.baseUrl,
        credential_id: b64uEncode(response.credentialId),
        authenticator_data: b64uEncode(response.authenticatorData),
        client_data_json: b64uEncode(response.clientDataJSON),
        signature: b64uEncode(response.signature),
        ...(response.userHandle && response.userHandle.length > 0
          ? { user_handle: b64uEncode(response.userHandle) }
          : {})
      }
    }
  }

  /** A fresh status read, decoded and checked against the pins and this page's RP. */
  private async account(): Promise<Account> {
    if (!this.supported || this.baseUrl === null) {
      throw new PasskeyActionError({ kind: 'not_supported' })
    }

    const fresh = await this.route(client => client.status())
    const broken = typeof fresh?.gateway_id === 'string' ? this.pinProblem(fresh.gateway_id) : null

    if (broken) {
      // Another gateway's list: not shown, not kept.
      this.store.setState({ status: null, credentials: [] })
      this.notify(broken)

      throw new PasskeyActionError(broken)
    }

    this.store.setState({
      status: fresh,
      credentials: Array.isArray(fresh?.credentials) ? fresh.credentials : [],
      statusError: null
    })

    if (fresh?.enabled !== true) {
      throw new PasskeyActionError({ kind: 'unavailable', reason: text(fresh?.reason) ?? '' })
    }

    const rpId = this.options.webauthn.rpId

    if (!Array.isArray(fresh.rp?.web) || !fresh.rp.web.includes(rpId)) {
      throw new PasskeyActionError({ kind: 'rp_not_accepted' })
    }

    const gatewayId = typeof fresh.gateway_id === 'string' ? b64uDecode(fresh.gateway_id, 16, 16) : null
    const handle = typeof fresh.user?.handle === 'string' ? b64uDecode(fresh.user.handle, 1, 64) : null

    if (!gatewayId || !handle || typeof fresh.user?.id !== 'string' || !fresh.user.id) {
      throw new PasskeyActionError({ kind: 'bad_answer' })
    }

    return {
      gatewayId,
      gatewayIdText: fresh.gateway_id,
      userId: fresh.user.id,
      handle,
      baseUrl: this.baseUrl,
      rpId
    }
  }

  /** One route call, its failures as `PasskeyActionError`. */
  private async route<T>(call: (client: PasskeyClient) => Promise<T>): Promise<T> {
    try {
      return await call(this.options.client)
    } catch (error) {
      if (error instanceof PasskeyRouteError) {
        if (error.kind === 'not_offered') {
          throw new PasskeyActionError({ kind: 'unavailable', reason: 'disabled' })
        }

        if (error.kind === 'transport') {
          throw new PasskeyActionError({ kind: 'transport', message: error.message })
        }

        throw new PasskeyActionError({
          kind: 'refused',
          status: error.status,
          error: error.error,
          reason: error.reason,
          message: error.message,
          retryAfter: error.retryAfter
        })
      }

      throw new PasskeyActionError({
        kind: 'transport',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // ── the pin ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Forget the gateway id pinned for this gateway, and only that: the way a gateway whose passkey store
   * was reset on purpose is accepted again (the pin is otherwise cleared only with the site's data). The
   * next enrolment pins the id it presents. What the model decided under the old pin is decided again:
   * the mismatch notice goes and the capability calls run once more.
   */
  forgetPin(): void {
    this.options.pins.forget()
    this.store.setState(state => ({
      pinned: false,
      notices: state.notices.filter(notice => notice.notice.kind !== 'gateway_id_mismatch')
    }))

    if (this.wasReady && !this.stopped) {
      void this.advertise()
    }
  }

  // ── notices ───────────────────────────────────────────────────────────────────────────────────

  /** The person closed a notice. */
  dismissNotice(id: number): void {
    this.store.setState(state => ({ notices: state.notices.filter(notice => notice.id !== id) }))
  }

  private notify(notice: PasskeyNoticeKind): void {
    const same = JSON.stringify(notice)

    if (this.store.getState().notices.some(existing => JSON.stringify(existing.notice) === same)) {
      return
    }

    this.nextNoticeId += 1
    this.store.setState(state => ({
      notices: [...state.notices, { id: this.nextNoticeId, notice, at: this.now }]
    }))
  }

  // ── the list of confirmations ─────────────────────────────────────────────────────────────────

  /** A confirmation by id. */
  find(id: string): PasskeyConfirmation | undefined {
    return this.store.getState().confirmations.find(confirmation => confirmation.id === id)
  }

  private upsert(confirmation: PasskeyConfirmation): void {
    this.nextVersion += 1

    const entry = { ...confirmation, version: this.nextVersion }

    this.store.setState(state => {
      const others = state.confirmations.filter(existing => existing.id !== entry.id)
      const next = [...others, entry]
      const finished = next.filter(existing => !isOpenPhase(existing.phase))
      const drop = new Set(finished.slice(0, Math.max(0, finished.length - FINISHED_KEPT)).map(e => e.id))

      return { confirmations: next.filter(existing => !drop.has(existing.id)) }
    })
  }

  /**
   * Change one confirmation. The one choke point for its phase, so the rule holds whoever ends it: once an
   * assertion may have reached the gateway, an ending that is not the gateway's definitive verdict
   * (`UNSETTLED_ENDS`) becomes `outcome_unknown`.
   */
  private patch(
    id: string,
    change: Partial<Pick<PasskeyConfirmation, 'phase' | 'dismissed' | 'answerMayHaveArrived'>>
  ): void {
    const current = this.find(id)

    if (!current) {
      return
    }

    this.nextVersion += 1

    const next = { ...current, ...change, version: this.nextVersion }

    if (next.answerMayHaveArrived && next.phase.kind === 'ended' && UNSETTLED_ENDS.has(next.phase.end.kind)) {
      next.phase = { kind: 'ended', end: { kind: 'outcome_unknown' } }
    }

    this.store.setState(state => ({
      confirmations: state.confirmations.map(existing => (existing.id === id ? next : existing))
    }))

    if (change.phase && !isOpenPhase(change.phase)) {
      this.contexts.delete(id)
    }
  }

  private setPhase(id: string, phase: ConfirmPhase): void {
    this.patch(id, { phase })
  }
}

/** Endings the layer announces as the sheet closes (nothing the person must read on the sheet). */
const QUIET_ENDS: ReadonlySet<ConfirmEnd['kind']> = new Set(['timed_out', 'answered_elsewhere', 'withdrawn'])

/**
 * Endings that are not the gateway's verdict on an answer: after an assertion may have arrived, each of
 * them is `outcome_unknown` (the request may have been settled by that very assertion). The definitive
 * ones (`verification_failed`, `too_many_attempts`, `not_allowed`) keep their meaning.
 */
const UNSETTLED_ENDS: ReadonlySet<ConfirmEnd['kind']> = new Set([
  'timed_out',
  'answered_elsewhere',
  'withdrawn',
  'unavailable'
])

/**
 * A `request.answer` that failed without the gateway's reply (no socket, a timeout, a send that threw): what
 * it carried may have been delivered. A JSON-RPC error with a code is the gateway's word, so it is not.
 */
export function isTransportFailure(error: unknown): boolean {
  return !(error instanceof JsonRpcGatewayError) || typeof error.code !== 'number'
}

/** The gateway's limit on a passkey's name, in characters. */
export const CREDENTIAL_NAME_LIMIT = 100

/**
 * `<displayName> — <host>`, cut to the gateway's limit by shortening the host with an ellipsis in the middle
 * (both ends of a host say something: the first label and the domain).
 */
export function credentialName(displayName: string, host: string): string {
  const prefix = `${displayName} — `
  const room = CREDENTIAL_NAME_LIMIT - Array.from(prefix).length
  const letters = Array.from(host)

  if (letters.length <= room) {
    return prefix + host
  }

  const keep = Math.max(room - 1, 2)
  const head = Math.ceil(keep / 2)
  const tail = keep - head

  return `${prefix}${letters.slice(0, head).join('')}…${letters.slice(letters.length - tail).join('')}`
}

/** What a refused `request.answer` means for the confirmation. */
export function phaseAfter(error: unknown): ConfirmPhase {
  // No reply from the gateway (`isTransportFailure`): try again.
  if (!(error instanceof JsonRpcGatewayError) || typeof error.code !== 'number') {
    return { kind: 'not_sent', message: error instanceof Error ? error.message : String(error) }
  }

  const data = isRecord(error.data) ? error.data : {}
  const reason = text(data.reason) ?? ''

  if (error.code === NOT_ALLOWED_CODE) {
    return { kind: 'ended', end: { kind: 'not_allowed' } }
  }

  if (error.code !== REFUSED_CODE) {
    return { kind: 'not_sent', message: error.message }
  }

  return reason === 'too_many_attempts'
    ? { kind: 'ended', end: { kind: 'too_many_attempts' } }
    : { kind: 'refused', reason }
}

function ceremonyActionError(error: unknown): PasskeyActionError {
  return new PasskeyActionError({
    kind: 'ceremony',
    problem:
      error instanceof CeremonyError
        ? error.problem
        : { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  })
}
