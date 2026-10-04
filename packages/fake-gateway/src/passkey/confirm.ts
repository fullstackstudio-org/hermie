import { randomBytes } from 'node:crypto'

import { codePointLength, verbatimProblem } from '../verbatim'
import { b64u } from './encoding'
import { NONCE_BYTES, type ConfirmField } from './challenge'
import type { ReviewRegister } from '../review-register'
import { type PasskeyGateway, type Identity, userKey } from './gateway'
import { CommitRefused, StoreError } from './store'
import {
  memoisedAssertionValidator,
  type AssertionOk,
  type GatewayContext,
  type Refusal,
  type StoredCredential
} from './webauthn'

/**
 * The `confirm` server request, with the gating rules of the real gateway
 * (`tui_gateway/confirm.py`, `confirm_passkey.py`, `server_requests.py`): the level `plain` and the level
 * `passkey`, whose verification is the gateway's own.
 *
 * Used only by a gateway that knows the level (`startFakeGateway({ passkey })`); one that does not keeps the
 * permissive `confirm` the fake always had.
 *
 * What it reproduces, in one place:
 *
 * - the frame goes only to connections that offered the level; at `passkey` also only to connections
 *   signed in as the bound user that advertised an RP the user has a credential for. The same predicate
 *   decides who may answer and who gets the request back from `session.resume`;
 * - `request.answer` refuses with 4033 (not allowed) and 4034 (not valid, `data.reason` at `passkey`); a
 *   refused `passkey` answer leaves the request open, the fifth settles it `unavailable
 *   (verification_failed)` and withdraws it (`request.cancel too_many_attempts`);
 * - a valid answer settles the request and `request.answer` says `ok`, meaning "received and valid". Only
 *   the store commit that follows makes it `confirmed` with `verified: true`; a refused commit (revoked
 *   meanwhile, replay, counter regression) is `unavailable (verification_failed)` and the session gets
 *   `request.cancel {reason: "verification_failed"}`;
 * - per-level method sets: `plain` accepts `tap` only (a `plain` answer with `method: "passkey"` is
 *   refused), `passkey` accepts `passkey` or exactly `{decision: "declined", method: "tap"}`;
 * - one open confirmation and at most 6 per 600 s per conversation;
 * - no downgrade: after a `passkey` request ends in a failure a third party can cause once a frame was
 *   sent (declined, timeout, verification_failed, an error response, withdrawn, no capable client), `plain`
 *   requests in that conversation are `unavailable (downgrade_refused)` for 600 s;
 * - structured `fields` (contract §4.1): checked verbatim (refused, never rewritten); a request with fields
 *   goes only to connections that advertised `confirm_fields: true` (at `passkey` also `confirm_passkey {v: 2}`)
 *   and is `unavailable (no_capable_client)` with nothing sent when none is attached. At `passkey` such a
 *   request is version 2: `passkey.v` is 2 and the challenge commits to `text_digest_v2`;
 * - `draft_id`: the detail is the text the person approved in `review.draft`, taken verbatim from the review
 *   register (whatever detail the caller passed is ignored); an unknown or expired id is refused before
 *   anything is sent.
 */

export const TIMEOUT_SECONDS = 120
export const MAX_PENDING = 1
export const MAX_PER_WINDOW = 6
export const WINDOW_SECONDS = 600
export const DOWNGRADE_WINDOW_SECONDS = 600
export const MAX_REFUSALS = 5
export const TITLE_MAX = 80
export const SUMMARY_MAX = 500
export const DETAIL_MAX = 2000
export const DEFAULT_TITLE = 'Confirm an action'

/** The levels a client may advertise. */
export const CONFIRM_LEVELS = ['plain', 'passkey'] as const

export type ConfirmLevel = (typeof CONFIRM_LEVELS)[number]

/** What the agent learns. */
export interface ConfirmOutcome {
  outcome: 'confirmed' | 'declined' | 'unavailable' | 'timeout'
  method: string | null
  verified: boolean
  reason: string
}

/** The agent's text cannot be shown as given. */
export class ConfirmParamsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfirmParamsError'
  }
}

/** A refused `request.answer`: the JSON-RPC error the caller gets. */
export class AnswerRefused extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'AnswerRefused'
  }
}

// ── text ──────────────────────────────────────────────────────────────────────────────────────

const INVISIBLE_LETTERS = new Set(['ᅟ', 'ᅠ', 'ㅤ', 'ﾠ', '⠀'])
const MAX_COMBINING_MARKS = 4

/**
 * Plain text safe to show verbatim: line and paragraph separators become newlines, every other control,
 * format (bidi overrides, zero-width), surrogate and private-use code point is dropped, as are invisible
 * letters and combining marks beyond four per base character. A single-line field collapses whitespace.
 */
export function cleanText(text: unknown, multiline: boolean): string {
  const raw = String(text ?? '').replace(/\r\n?/gu, '\n')
  const out: string[] = []
  let marks = 0

  for (const ch of raw) {
    if (/[\p{Mn}\p{Me}]/u.test(ch)) {
      marks += 1

      if (marks <= MAX_COMBINING_MARKS) {
        out.push(ch)
      }

      continue
    }

    marks = 0

    if (ch === '\n' || ch === '\u2028' || ch === '\u2029') {
      out.push(multiline ? '\n' : ' ')
    } else if (ch === '\t') {
      out.push(' ')
    } else if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u.test(ch) || INVISIBLE_LETTERS.has(ch)) {
      continue
    } else {
      out.push(ch)
    }
  }

  const cleaned = out.join('')

  if (!multiline) {
    return cleaned.split(/\s+/u).filter(Boolean).join(' ')
  }

  const kept: string[] = []

  for (const line of cleaned.split('\n').map(l => l.split(/\s+/u).filter(Boolean).join(' '))) {
    if (line || (kept.length && kept[kept.length - 1])) {
      kept.push(line)
    }
  }

  while (kept.length && !kept[kept.length - 1]) {
    kept.pop()
  }

  return kept.join('\n')
}

export interface ConfirmText {
  title: string
  summary: string
  detail: string | null
  level: ConfirmLevel
  /** The structured fields, in display order; absent for a version-1 request. */
  fields?: ConfirmField[]
}

// ── structured fields ─────────────────────────────────────────────────────────────────────────

export const FIELDS_MAX = 8
export const FIELD_LABEL_MAX = 40
export const FIELD_VALUE_MAX = 200
export const FIELD_CURRENCY_MAX = 16
export const FIELD_KINDS = ['amount', 'text', 'recipient', 'domain', 'model', 'count', 'date'] as const
const FIELD_KEYS = new Set(['id', 'kind', 'label', 'value', 'currency'])
const FIELD_ID = /^[a-z][a-z0-9_]{0,31}$/

/**
 * One string of a structured field: ONE line, shown exactly as given. Spaces at either end are the only thing
 * removed; a value that is not a string (no number is converted: the agent writes it as it should be shown),
 * anything `verbatimProblem` refuses (an invisible, bidi or control character, padding) and a line break
 * throw, never rewritten.
 */
function fieldText(index: number, key: string, raw: unknown, limit: number): string {
  if (typeof raw !== 'string') {
    throw new ConfirmParamsError(`fields[${index}].${key} must be a string, written exactly as it should be shown`)
  }

  const text = raw.replace(/^ +| +$/g, '')

  if (!text) {
    throw new ConfirmParamsError(`fields[${index}].${key} is empty`)
  }

  if (codePointLength(text) > limit) {
    throw new ConfirmParamsError(
      `fields[${index}].${key} is ${codePointLength(text)} characters; the limit is ${limit}.`
    )
  }

  if (text.includes('\n')) {
    throw new ConfirmParamsError(`fields[${index}].${key} must be one line`)
  }

  const problem = verbatimProblem(text)

  if (problem) {
    throw new ConfirmParamsError(`fields[${index}].${key} cannot be shown as it is: ${problem}`)
  }

  return text
}

/**
 * The `fields` of a `confirm` (README §4.1), or `undefined` for none. Throws `ConfirmParamsError` for anything
 * the person could not be shown exactly: more than 8, an unknown key or kind, an id that is not
 * `[a-z][a-z0-9_]{0,31}` or not unique (a missing id becomes `field_<n>`), `currency` on anything but an
 * `amount`, and every string `fieldText` refuses.
 */
export function buildFields(fields: unknown): ConfirmField[] | undefined {
  if (fields === undefined || fields === null || (Array.isArray(fields) && fields.length === 0)) {
    return undefined
  }

  if (!Array.isArray(fields)) {
    throw new ConfirmParamsError('fields must be a list of {kind, label, value, currency?, id?} objects')
  }

  if (fields.length > FIELDS_MAX) {
    throw new ConfirmParamsError(`${fields.length} fields; the limit is ${FIELDS_MAX}.`)
  }

  const built: ConfirmField[] = []

  for (const [index, raw] of fields.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConfirmParamsError(`fields[${index}] must be an object with kind, label and value`)
    }

    const entry = raw as Record<string, unknown>
    const unknown = Object.keys(entry)
      .filter(key => !FIELD_KEYS.has(key))
      .sort()

    if (unknown.length) {
      throw new ConfirmParamsError(`fields[${index}] has unknown keys: ${unknown.join(', ')}`)
    }

    const kind = entry.kind

    if (typeof kind !== 'string' || !(FIELD_KINDS as readonly string[]).includes(kind)) {
      throw new ConfirmParamsError(`fields[${index}].kind must be one of: ${FIELD_KINDS.join(', ')}`)
    }

    const id = entry.id === undefined || entry.id === null ? `field_${index + 1}` : entry.id

    if (typeof id !== 'string' || !FIELD_ID.test(id)) {
      throw new ConfirmParamsError(
        `fields[${index}].id must be a lower-case identifier ([a-z][a-z0-9_]*, at most 32 characters)`
      )
    }

    if (built.some(field => field.id === id)) {
      throw new ConfirmParamsError(`fields[${index}].id '${id}' is used twice`)
    }

    const field: ConfirmField = {
      id,
      kind,
      label: fieldText(index, 'label', entry.label, FIELD_LABEL_MAX),
      value: fieldText(index, 'value', entry.value, FIELD_VALUE_MAX)
    }

    if (entry.currency !== undefined && entry.currency !== null) {
      if (kind !== 'amount') {
        throw new ConfirmParamsError(`fields[${index}].currency is only for kind amount`)
      }

      field.currency = fieldText(index, 'currency', entry.currency, FIELD_CURRENCY_MAX)
    }

    built.push(field)
  }

  return built
}

/** A reviewed draft's text is shown (and signed) as the person approved it: at most this long. */
export const DRAFT_DETAIL_MAX = DETAIL_MAX

/**
 * The text the person approved as draft `draftId` in conversation `conversation` (the review register), or
 * `ConfirmParamsError` when this conversation has no such live draft (unknown, expired, or another
 * conversation's): nothing is sent then.
 */
export function draftDetail(register: ReviewRegister, conversation: string, draftId: unknown, now: number): string {
  if (typeof draftId !== 'string' || !draftId) {
    throw new ConfirmParamsError('draft_id must be the draft_id a review_draft approval returned')
  }

  const draft = register.get(conversation, draftId, now)

  if (!draft) {
    throw new ConfirmParamsError(
      `draft ${draftId} is unknown or expired in this conversation (drafts are kept 60 minutes): ask for a review_draft approval again; nothing was sent`
    )
  }

  if (draft.text.length > DRAFT_DETAIL_MAX) {
    throw new ConfirmParamsError(
      `draft ${draftId} is ${draft.text.length} characters; a confirmation shows at most ${DRAFT_DETAIL_MAX}, so it cannot be confirmed with draft_id; nothing was sent`
    )
  }

  return draft.text
}

/** The `confirm` params (without `session_id`), cleaned and bounded. Throws `ConfirmParamsError`. */
export function buildText(input: {
  title?: unknown
  summary?: unknown
  detail?: unknown
  level?: unknown
  /** Structured facts shown apart from the text (see `buildFields`). */
  fields?: unknown
  /** The detail is a reviewed draft's approved text (`draftDetail`): shown verbatim, never cleaned. */
  verbatimDetail?: boolean
}): ConfirmText {
  const level = typeof input.level === 'string' && input.level.trim() ? input.level.trim() : 'plain'

  if (!(CONFIRM_LEVELS as readonly string[]).includes(level)) {
    throw new ConfirmParamsError(`level must be one of: ${[...CONFIRM_LEVELS].sort().join(', ')}`)
  }

  const summary = cleanText(input.summary, true)

  if (!summary) {
    throw new ConfirmParamsError('summary is required: one or two plain sentences saying exactly what will happen')
  }

  if (summary.length > SUMMARY_MAX) {
    throw new ConfirmParamsError(`summary is ${summary.length} characters; the limit is ${SUMMARY_MAX}.`)
  }

  let detail: string

  if (input.verbatimDetail && input.detail !== undefined && input.detail !== null) {
    detail = String(input.detail)

    const problem = verbatimProblem(detail)

    if (problem) {
      throw new ConfirmParamsError(`detail cannot be shown verbatim: ${problem}`)
    }
  } else {
    detail = input.detail === undefined || input.detail === null ? '' : cleanText(input.detail, true)
  }

  if (detail.length > DETAIL_MAX) {
    throw new ConfirmParamsError(`detail is ${detail.length} characters; the limit is ${DETAIL_MAX}.`)
  }

  const title = input.title === undefined || input.title === null ? '' : cleanText(input.title, false)

  if (title.length > TITLE_MAX) {
    throw new ConfirmParamsError(`title is ${title.length} characters; the limit is ${TITLE_MAX}.`)
  }

  const fields = buildFields(input.fields)

  return {
    title: title || DEFAULT_TITLE,
    summary,
    detail: detail || null,
    level: level as ConfirmLevel,
    ...(fields ? { fields } : {})
  }
}

// ── host ──────────────────────────────────────────────────────────────────────────────────────

/** What the gate needs from the server it lives in. `P` is a live connection. */
export interface ConfirmHost<P extends object> {
  /** Every live connection. */
  peers(): P[]
  /** Who a connection is signed in as (the identity its WebSocket was minted for), or `null`. */
  identityOf(peer: P): Identity | null
  /** The user a request is bound to when the control call names none: the gateway's only account, or `null`. */
  defaultUser(): Identity | null
  /** The name of an account, for the frame's `user.name`. */
  displayNameOf(user: string): string
  send(peer: P, frame: unknown): void
  /** An event to every connection of a session (`request.cancel`), also kept in the session's replay ring. */
  publish(type: string, sessionId: string, payload: unknown): void
  /** Run `fn` after `ms`; returns the cancel. */
  later(fn: () => void, ms: number): () => void
  nextRequestId(): string
  /** Milliseconds since the epoch. */
  now(): number
  /** Put the request on the list `session.resume` reports. `viewer` says who it may be shown to. */
  register(
    id: string,
    entry: { sessionId: string; params: Record<string, unknown>; viewer: (peer: P) => boolean }
  ): void
  forget(id: string): void
  /** Record an answer or an error response in the fake's answer log. */
  recordAnswer(entry: { id: string; result?: unknown; error?: unknown }): void
}

interface Advertisement {
  levels: Set<string>
  passkey: { kind: 'native' | 'web'; rp_id: string; v: 1 | 2 } | null
  /** `confirm_fields: true` was accepted (exactly `true`, and only with an accepted level). */
  fields: boolean
}

interface Verification {
  userId: string
  userName: string
  nonce: Buffer
  expiresAt: number
  ctx: GatewayContext
  snapshot: StoredCredential[]
  enrolledRps: Set<string>
  validate: (answer: unknown) => AssertionOk | Refusal
  /** 2 for a request with structured fields (`text_digest_v2`), else 1. */
  version: 1 | 2
}

interface OpenRequest<P extends object> {
  id: string
  sessionId: string
  conversation: string
  level: ConfirmLevel
  params: Record<string, unknown>
  verification: Verification | null
  targets: Set<P>
  refusals: number
  expiresAt: number
  cancelTimer: () => void
  resolve: (outcome: ConfirmOutcome) => void
  forced: boolean
}

export interface OutcomeNote extends ConfirmOutcome {
  request_id: string
  level: ConfirmLevel
  user_id: string | null
  /** The credential that signed it (base64url), for a verified confirmation. */
  credential_id: string | null
}

const DECLINE = { decision: 'declined', method: 'tap' }

const isDecline = (result: unknown): boolean => {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return false
  }

  const keys = Object.keys(result)

  return (
    keys.length === 2 &&
    keys.every(k => k in DECLINE) &&
    Object.entries(DECLINE).every(([k, v]) => (result as Record<string, unknown>)[k] === v)
  )
}

/** The outcomes after which a `passkey` request opens the no-downgrade window. */
export function opensDowngradeWindow(outcome: ConfirmOutcome): boolean {
  return (
    outcome.outcome === 'declined' ||
    outcome.outcome === 'timeout' ||
    (outcome.outcome === 'unavailable' &&
      (['verification_failed', 'error_response', 'no_capable_client'].includes(outcome.reason) ||
        outcome.reason.startsWith('cancelled:')))
  )
}

export type RaiseResult =
  { kind: 'unavailable'; reason: string } | { kind: 'open'; id: string; done: Promise<ConfirmOutcome> }

export interface RaiseInput {
  /** The runtime id of the session the frame names. */
  sessionId: string
  /** What the person's conversation is called for the limits and the window: the stored session id. */
  conversation: string
  text: ConfirmText
  /** The person the request is for; `undefined` is the gateway's default account, `null` is nobody. */
  user?: string | null
  /** Stage `turn_isolation`: the agent runs where it cannot see which client advertised what. */
  turnIsolation?: boolean
  /** Seconds before the request times out. */
  timeoutSeconds?: number
  /** A confirmation the gateway forces for an operator rule: counts under its own limit key. */
  forced?: boolean
}

export class ConfirmGate<P extends object> {
  private readonly adverts = new Map<P, Advertisement>()
  private readonly open = new Map<string, OpenRequest<P>>()
  private readonly pending = new Map<string, number>()
  private readonly sent = new Map<string, number[]>()
  private readonly failedAt = new Map<string, number>()
  private readonly outcomeLog: OutcomeNote[] = []

  constructor(
    readonly passkey: PasskeyGateway,
    private readonly host: ConfirmHost<P>
  ) {}

  // ── capabilities ─────────────────────────────────────────────────────────────────────────────

  /**
   * Record what a connection says it can perform (`client.capabilities`). Levels count only together with
   * `server_requests`; unknown or malformed entries are dropped; `passkey` counts only with a
   * `confirm_passkey` this gateway accepts from a signed-in connection. Every call replaces the previous
   * advertisement. Returns the levels accepted, sorted.
   */
  advertise(peer: P, params: Record<string, unknown>): string[] {
    const identity = this.host.identityOf(peer) !== null
    const listed = Array.isArray(params.confirm) ? params.confirm : []
    const levels = new Set<string>()
    let passkey: Advertisement['passkey'] = null

    if (params.server_requests === true) {
      for (const level of listed) {
        if (level === 'plain') {
          levels.add('plain')
        } else if (level === 'passkey') {
          passkey = this.passkey.acceptAdvertisement(identity, params.confirm_passkey)

          if (passkey) {
            levels.add('passkey')
          }
        }
      }
    }

    if (levels.size) {
      this.adverts.set(peer, {
        levels,
        passkey: levels.has('passkey') ? passkey : null,
        // A client that would drop the fields must not be asked to confirm less than the agent asked.
        fields: params.confirm_fields === true
      })
    } else {
      this.adverts.delete(peer)
    }

    return [...levels].sort()
  }

  forgetPeer(peer: P): void {
    this.adverts.delete(peer)
  }

  /** The levels a connection offered. */
  levelsOf(peer: P): string[] {
    return [...(this.adverts.get(peer)?.levels ?? [])]
  }

  /** Whether the connection advertised `confirm_fields: true` and it was accepted (what `client.capabilities` echoes). */
  showsFields(peer: P): boolean {
    return this.adverts.get(peer)?.fields === true
  }

  // ── who may see and answer ───────────────────────────────────────────────────────────────────

  private qualifies(req: OpenRequest<P>, peer: P): boolean {
    const advert = this.adverts.get(peer)

    if (!advert?.levels.has(req.level)) {
      return false
    }

    // A request with fields goes only to (and is answered only by) a connection that shows them.
    if (Array.isArray(req.params.fields) && !advert.fields) {
      return false
    }

    const v = req.verification

    if (!v) {
      return true
    }

    const identity = this.host.identityOf(peer)

    if (!identity || userKey(identity) !== v.userId || !advert.passkey) {
      return false
    }

    // A version-2 request (fields, `text_digest_v2`) goes only to a client that computes it.
    if (v.version >= 2 && advert.passkey.v !== 2) {
      return false
    }

    const accepted = advert.passkey.kind === 'native' ? v.ctx.nativeRpIds : v.ctx.webRpIds

    return accepted.has(advert.passkey.rp_id) && v.enrolledRps.has(advert.passkey.rp_id)
  }

  // ── raising a request ────────────────────────────────────────────────────────────────────────

  /** Open one confirmation. Unavailable before anything is sent, or open with a promise for the outcome. */
  raise(input: RaiseInput): RaiseResult {
    const { text, conversation, sessionId } = input
    const level = text.level
    const now = this.host.now()
    const id = this.host.nextRequestId()
    const finishEarly = (reason: string, extra: { user?: string | null } = {}): RaiseResult => {
      this.record(id, level, extra.user ?? null, {
        outcome: 'unavailable',
        method: null,
        verified: false,
        reason
      })

      return { kind: 'unavailable', reason }
    }

    if (input.turnIsolation) {
      return finishEarly('turn_isolation')
    }

    if (level === 'plain' && this.downgradeRefused(conversation, now)) {
      return finishEarly('downgrade_refused')
    }

    let verification: Verification | null = null
    let user: string | null = null

    if (level === 'passkey') {
      const opened = this.openPasskey(input, id, now)

      if ('reason' in opened) {
        return finishEarly(opened.reason, { user: opened.user })
      }

      verification = opened
      user = opened.userId
    }

    const key = input.forced ? `forced:${conversation}` : conversation
    const refused = this.reserve(key, now)

    if (refused) {
      return finishEarly(refused, { user })
    }

    const timeout = input.timeoutSeconds ?? TIMEOUT_SECONDS
    const outgoing: Record<string, unknown> = {
      title: text.title,
      summary: text.summary,
      ...(text.detail ? { detail: text.detail } : {}),
      level,
      ...(text.fields?.length ? { fields: text.fields } : {}),
      ...(verification ? this.passkeyParams(verification) : {})
    }
    const req: OpenRequest<P> = {
      id,
      sessionId,
      conversation,
      level,
      params: outgoing,
      verification,
      targets: new Set(),
      refusals: 0,
      expiresAt: verification ? verification.expiresAt : Math.floor(now / 1000) + Math.ceil(timeout),
      cancelTimer: () => undefined,
      resolve: () => undefined,
      forced: input.forced === true
    }

    for (const peer of this.host.peers()) {
      if (this.qualifies(req, peer)) {
        req.targets.add(peer)
      }
    }

    if (!req.targets.size) {
      this.release(key, null)

      const outcome: ConfirmOutcome = {
        outcome: 'unavailable',
        method: null,
        verified: false,
        reason: 'no_capable_client'
      }

      this.record(id, level, user, outcome)

      if (level === 'passkey') {
        this.failedAt.set(conversation, now)
      }

      return { kind: 'unavailable', reason: 'no_capable_client' }
    }

    const done = new Promise<ConfirmOutcome>(resolve => {
      req.resolve = outcome => {
        this.release(key, now)
        resolve(outcome)
      }
    })

    this.open.set(id, req)
    this.host.register(id, {
      sessionId,
      params: outgoing,
      viewer: peer => this.qualifies(req, peer)
    })
    req.cancelTimer = this.host.later(() => this.timeOut(id), timeout * 1000)

    for (const peer of req.targets) {
      this.host.send(peer, { jsonrpc: '2.0', id, method: 'confirm', params: { session_id: sessionId, ...outgoing } })
    }

    return { kind: 'open', id, done }
  }

  private openPasskey(
    input: RaiseInput,
    id: string,
    now: number
  ): Verification | { reason: string; user: string | null } {
    const { passkey } = this

    if (!passkey.settings.enabled) {
      return { reason: 'disabled', user: null }
    }

    const ctx = passkey.context()
    const reason = ctx.capabilityReason({ enabled: true, identity: true })

    if (reason) {
      return { reason, user: null }
    }

    // The bound user: the account the turn acts for, resolved by the gateway, never from tool arguments.
    let userId: string

    if (input.user === null) {
      const anyone = this.host.peers().some(peer => this.host.identityOf(peer) !== null)

      return { reason: anyone ? 'no_acting_user' : 'no_identity', user: null }
    }

    if (typeof input.user === 'string') {
      userId = input.user
    } else {
      const fallback = this.host.defaultUser()

      if (!fallback) {
        return { reason: 'no_identity', user: null }
      }

      userId = userKey(fallback)
    }

    const accepted = new Set([...ctx.nativeRpIds, ...ctx.webRpIds])
    const snapshot = passkey.store.snapshot(userId).filter(c => accepted.has(c.rpId))

    if (!snapshot.length) {
      return { reason: 'not_enrolled', user: userId }
    }

    const nonce = randomBytes(NONCE_BYTES)
    const text = input.text
    const fields = text.fields ?? []

    return {
      version: fields.length ? 2 : 1,
      userId,
      userName: this.host.displayNameOf(userId),
      nonce,
      expiresAt: Math.floor(now / 1000) + Math.ceil(input.timeoutSeconds ?? TIMEOUT_SECONDS),
      ctx,
      snapshot,
      enrolledRps: new Set(snapshot.map(c => c.rpId)),
      validate: memoisedAssertionValidator(
        ctx,
        {
          userId,
          requestId: id,
          nonce,
          title: text.title,
          summary: text.summary,
          detail: text.detail,
          sessionId: input.sessionId,
          purpose: 'confirm',
          ...(fields.length ? { fields } : {})
        },
        snapshot
      )
    }
  }

  private passkeyParams(v: Verification): Record<string, unknown> {
    const byRp = new Map<string, string[]>()

    for (const c of v.snapshot) {
      byRp.set(c.rpId, [...(byRp.get(c.rpId) ?? []), b64u(c.credentialId)])
    }

    return {
      passkey: {
        v: v.version,
        nonce: b64u(v.nonce),
        gateway_id: b64u(v.ctx.gatewayId),
        base_url: v.ctx.acceptedBaseUrls[0] ?? '',
        expires_at: v.expiresAt,
        user: { id: v.userId, name: v.userName },
        credentials: [...byRp].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([rp_id, ids]) => ({ rp_id, ids }))
      }
    }
  }

  // ── limits and the window ────────────────────────────────────────────────────────────────────

  private reserve(key: string, now: number): string {
    const history = (this.sent.get(key) ?? []).filter(at => now - at < WINDOW_SECONDS * 1000)

    this.sent.set(key, history)

    if ((this.pending.get(key) ?? 0) >= MAX_PENDING) {
      return 'already_pending'
    }

    if (history.length >= MAX_PER_WINDOW) {
      return 'rate_limited'
    }

    this.pending.set(key, (this.pending.get(key) ?? 0) + 1)

    return ''
  }

  private release(key: string, sentAt: number | null): void {
    const left = (this.pending.get(key) ?? 0) - 1

    if (left > 0) {
      this.pending.set(key, left)
    } else {
      this.pending.delete(key)
    }

    if (sentAt !== null) {
      this.sent.set(key, [...(this.sent.get(key) ?? []), sentAt])
    }
  }

  private downgradeRefused(conversation: string, now: number): boolean {
    const failed = this.failedAt.get(conversation)

    if (failed !== undefined && now - failed >= DOWNGRADE_WINDOW_SECONDS * 1000) {
      this.failedAt.delete(conversation)

      return false
    }

    return failed !== undefined
  }

  /** End the no-downgrade window and the per-conversation limits (what ten minutes passing does). */
  resetWindows(): void {
    this.failedAt.clear()
    this.sent.clear()
  }

  windows(): { conversation: string; until: number }[] {
    const now = this.host.now()

    return [...this.failedAt]
      .filter(([, at]) => now - at < DOWNGRADE_WINDOW_SECONDS * 1000)
      .map(([conversation, at]) => ({ conversation, until: Math.floor((at + DOWNGRADE_WINDOW_SECONDS * 1000) / 1000) }))
  }

  // ── answering ────────────────────────────────────────────────────────────────────────────────

  /** The refusal reason for an answer that may not settle the request, or `null`. Pure. */
  private problem(req: OpenRequest<P>, result: unknown): string | null {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      return 'result must be an object'
    }

    const r = result as Record<string, unknown>

    if (!req.verification) {
      if (r.decision !== 'confirmed' && r.decision !== 'declined') {
        return "decision must be one of ['confirmed', 'declined']"
      }

      return r.method === 'tap' ? null : "bad_shape: method must be one of ['tap'] at level plain"
    }

    if (isDecline(result)) {
      return null
    }

    const verdict = req.verification.validate(result)

    return verdict.ok ? null : verdict.reason
  }

  /**
   * `request.answer {id, result}` from `peer`. `null` when the request is not a gated one the gate knows
   * (the caller's own path decides); otherwise `{status: 'ok'}`, or throws `AnswerRefused`.
   */
  answer(peer: P, id: string, result: unknown): { status: 'ok' } | null {
    const req = this.open.get(id)

    if (!req) {
      return null
    }

    if (!this.qualifies(req, peer)) {
      throw new AnswerRefused(4033, `this connection is not attached or may not answer confirm level "${req.level}"`)
    }

    const problem = this.problem(req, result)

    if (!problem) {
      this.settleAnswered(req, peer, result as Record<string, unknown>)

      return { status: 'ok' }
    }

    if (!req.verification) {
      throw new AnswerRefused(4034, problem)
    }

    const exhausted = this.countRefusal(req, peer, problem)

    throw new AnswerRefused(4034, 'answer refused', { reason: exhausted ? 'too_many_attempts' : problem })
  }

  /**
   * A bare response frame (`{id, result}` or `{id, error}`) from `peer`: accepted the same way, but a
   * refusal gets no reply. `true` when the frame was for a gated request here.
   */
  respond(peer: P, frame: { id?: unknown; result?: unknown; error?: unknown }): boolean {
    const req = typeof frame.id === 'string' ? this.open.get(frame.id) : undefined

    if (!req) {
      return false
    }

    if (frame.error) {
      this.host.recordAnswer({ id: req.id, error: frame.error })

      if (!req.targets.has(peer)) {
        return true
      }

      req.targets.delete(peer)

      if (!req.targets.size) {
        this.settle(req, { outcome: 'unavailable', method: null, verified: false, reason: 'error_response' })
      }

      return true
    }

    if (!this.qualifies(req, peer)) {
      return true
    }

    const problem = this.problem(req, frame.result)

    if (!problem) {
      this.settleAnswered(req, peer, frame.result as Record<string, unknown>)
    } else if (req.verification) {
      this.countRefusal(req, peer, problem)
    }

    return true
  }

  private countRefusal(req: OpenRequest<P>, peer: P, reason: string): boolean {
    req.refusals += 1

    const exhausted = req.refusals >= MAX_REFUSALS
    const user = req.verification?.userId ?? ''
    const identity = this.host.identityOf(peer)

    this.passkey.note({
      surface: 'confirm',
      reason: exhausted ? 'too_many_attempts' : reason,
      userId: identity ? userKey(identity) : user,
      requestId: req.id
    })

    if (exhausted) {
      this.host.publish('request.cancel', req.sessionId, { id: req.id, method: 'confirm', reason: 'too_many_attempts' })
      this.settle(req, { outcome: 'unavailable', method: null, verified: false, reason: 'verification_failed' })
    }

    return exhausted
  }

  /** The request settled with a valid answer: tell the others, commit once, decide `verified`. */
  private settleAnswered(req: OpenRequest<P>, peer: P, result: Record<string, unknown>): void {
    this.detach(req)
    this.host.recordAnswer({ id: req.id, result })
    this.host.publish('request.cancel', req.sessionId, { id: req.id, method: 'confirm', reason: 'resolved' })

    const v = req.verification

    if (!v) {
      this.finish(req, {
        outcome: result.decision as 'confirmed' | 'declined',
        method: 'tap',
        verified: false,
        reason: ''
      })

      return
    }

    if (isDecline(result)) {
      this.finish(req, { outcome: 'declined', method: 'tap', verified: false, reason: '' })

      return
    }

    // Commit: once, here. Revoked meanwhile, a replay, a regressed counter or a store error is never consent.
    const verdict = v.validate(result)
    const used = verdict.ok ? v.snapshot.find(c => c.credentialId.equals(verdict.credentialId)) : undefined
    const identity = this.host.identityOf(peer)

    if (!verdict.ok || !used) {
      this.passkey.note({ surface: 'confirm', reason: 'refused', userId: v.userId, requestId: req.id })
      this.withdrawSettled(req)

      return
    }

    try {
      this.passkey.store.commitAssertion(verdict, { userId: v.userId, snapshot: used })
    } catch (error) {
      if (!(error instanceof CommitRefused) && !(error instanceof StoreError)) {
        throw error
      }

      this.passkey.note({
        surface: 'confirm',
        reason: error instanceof CommitRefused ? error.reason : 'store_error',
        userId: identity ? userKey(identity) : v.userId,
        requestId: req.id
      })
      this.withdrawSettled(req)

      return
    }

    this.finish(
      req,
      { outcome: 'confirmed', method: 'passkey', verified: true, reason: '' },
      b64u(verdict.credentialId)
    )
  }

  /** The answer was valid (`request.answer` said `ok`) but did not commit: tell the clients it did not count. */
  private withdrawSettled(req: OpenRequest<P>): void {
    this.host.publish('request.cancel', req.sessionId, { id: req.id, method: 'confirm', reason: 'verification_failed' })
    this.finish(req, { outcome: 'unavailable', method: null, verified: false, reason: 'verification_failed' })
  }

  // ── ending a request ─────────────────────────────────────────────────────────────────────────

  private detach(req: OpenRequest<P>): void {
    this.open.delete(req.id)
    req.cancelTimer()
    this.host.forget(req.id)
  }

  private settle(req: OpenRequest<P>, outcome: ConfirmOutcome): void {
    this.detach(req)
    this.finish(req, outcome)
  }

  private finish(req: OpenRequest<P>, outcome: ConfirmOutcome, credentialId: string | null = null): void {
    this.record(req.id, req.level, req.verification?.userId ?? null, outcome, credentialId)

    if (req.level === 'passkey' && opensDowngradeWindow(outcome)) {
      this.failedAt.set(req.conversation, this.host.now())
    }

    req.resolve(outcome)
  }

  private timeOut(id: string): void {
    const req = this.open.get(id)

    if (!req) {
      return
    }

    this.host.publish('request.cancel', req.sessionId, { id, method: 'confirm', reason: 'timeout' })
    this.settle(req, { outcome: 'timeout', method: null, verified: false, reason: 'timeout' })
  }

  /** Time out one request now, or every open one (`POST /__fake/passkey/expire`). Returns how many. */
  expire(id?: string): number {
    const ids = id === undefined ? [...this.open.keys()] : this.open.has(id) ? [id] : []

    for (const each of ids) {
      this.timeOut(each)
    }

    return ids.length
  }

  /** The request was withdrawn from outside (`/__fake/withdraw-requests`, which already sent the `request.cancel`). */
  withdrawn(id: string, reason: string): void {
    const req = this.open.get(id)

    if (req) {
      this.settle(req, { outcome: 'unavailable', method: null, verified: false, reason: `cancelled:${reason}` })
    }
  }

  isOpen(id: string): boolean {
    return this.open.has(id)
  }

  private record(
    id: string,
    level: ConfirmLevel,
    user: string | null,
    outcome: ConfirmOutcome,
    credentialId: string | null = null
  ): void {
    this.outcomeLog.push({ request_id: id, level, user_id: user, credential_id: credentialId, ...outcome })

    if (this.outcomeLog.length > 200) {
      this.outcomeLog.shift()
    }
  }

  // ── the public view ──────────────────────────────────────────────────────────────────────────

  view(): {
    open: Record<string, unknown>[]
    outcomes: OutcomeNote[]
    windows: { conversation: string; until: number }[]
  } {
    return {
      open: [...this.open.values()].map(req => ({
        id: req.id,
        level: req.level,
        user_id: req.verification?.userId ?? null,
        refusals: req.refusals,
        expires_at: req.expiresAt,
        targets: req.targets.size
      })),
      outcomes: this.outcomeLog.map(note => ({ ...note })),
      windows: this.windows()
    }
  }
}
