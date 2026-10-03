import type { IncomingMessage, ServerResponse } from 'node:http'

import { originOf } from './base-url'
import { b64u, b64uDecode } from './encoding'
import { userHandle } from './challenge'
import { type PasskeyGateway, userKey, type Identity } from './gateway'
import {
  CodeInvalid,
  CommitRefused,
  CredentialExists,
  PendingInvalid,
  idOf,
  registrationOf,
  type CredentialRecord
} from './store'
import { ALG_ES256, verifyAssertion, verifyRegistration } from './webauthn'

/**
 * The six passkey routes, with the shapes, codes and reasons of the real gateway
 * (`hermes_cli/dashboard_auth/passkeys/routes.py`):
 *
 *     GET  /api/auth/passkeys                   the caller's passkey state and credentials
 *     POST /api/auth/passkeys/register/begin    open a registration (300 s)
 *     POST /api/auth/passkeys/register/finish   enrol a credential: attestation + a one-time enrolment code
 *     POST /api/auth/passkeys/stepup/begin      open a step-up for `invite` or `revoke` (120 s, single use)
 *     POST /api/auth/passkeys/invites           mint an enrolment code for oneself, with an `invite` step-up
 *     POST /api/auth/passkeys/revoke            revoke one of one's own credentials, with a `revoke` step-up
 *
 * Rules every route keeps:
 *
 * - While the level is switched off every route answers what an unknown `/api` path gets on a gateway
 *   without them: 404 `No such API endpoint` for GET, 405 for a POST.
 * - The identity is the gate's: the signed-in account of the cookie or bearer, never a body. Without one
 *   (session-token or ungated mode) the answer is 403 `no_identity`. A caller only ever sees, adds to or
 *   revokes their own credentials.
 * - A cookie-authenticated write must carry an `Origin` that is the origin of one of the level's own
 *   accepted base URLs. A bearer caller (the native app) is exempt: a browser never attaches one by itself.
 * - Bodies are JSON objects of at most 16 KiB.
 * - Every enrolment-code failure is one answer, 403 `code_invalid`.
 */

export const PREFIX = '/api/auth/passkeys'
export const BODY_CAP = 16 * 1024

const NAME_MAX = 100
const ID_MAX = 64

/** Who is calling and how the gate recognised them. */
export interface RouteCall {
  identity: Identity | null
  auth: 'bearer' | 'cookie'
  ip: string
}

class Fail extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly detail: string,
    readonly reason = '',
    readonly retryAfter = 0
  ) {
    super(error)
  }
}

interface Reply {
  status: number
  body: unknown
  headers?: Record<string, string>
}

const NO_STORE = { 'cache-control': 'no-store' }

function send(res: ServerResponse, reply: Reply): void {
  const text = JSON.stringify(reply.body)

  res.writeHead(reply.status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...reply.headers
  })
  res.end(text)
}

const failReply = (fail: Fail): Reply => ({
  status: fail.status,
  body: { error: fail.error, detail: fail.detail, ...(fail.reason ? { reason: fail.reason } : {}) },
  headers: { ...NO_STORE, ...(fail.retryAfter ? { 'retry-after': String(fail.retryAfter) } : {}) }
})

/** What a gateway without these routes answers for the same request. */
function notFound(method: string, path: string): Reply {
  if (method === 'GET') {
    return { status: 404, body: { detail: `No such API endpoint: ${path}` } }
  }

  return { status: 405, body: { detail: 'Method Not Allowed' }, headers: { allow: 'GET' } }
}

const ROUTES: Record<string, string> = {
  '': 'GET',
  '/register/begin': 'POST',
  '/register/finish': 'POST',
  '/stepup/begin': 'POST',
  '/invites': 'POST',
  '/revoke': 'POST'
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = req.headers['content-length']

  if (declared !== undefined) {
    const length = Number(declared)

    if (!Number.isFinite(length)) {
      throw new Fail(400, 'bad_request', 'Malformed Content-Length.')
    }

    if (length > BODY_CAP) {
      throw new Fail(413, 'body_too_large', `The body is larger than ${BODY_CAP} bytes.`)
    }
  }

  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    size += (chunk as Buffer).length

    if (size > BODY_CAP) {
      throw new Fail(413, 'body_too_large', `The body is larger than ${BODY_CAP} bytes.`)
    }

    chunks.push(chunk as Buffer)
  }

  let data: unknown

  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
  } catch {
    throw new Fail(400, 'bad_request', 'The body is not JSON.')
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Fail(400, 'bad_request', 'The body must be a JSON object.')
  }

  return data as Record<string, unknown>
}

const string = (body: Record<string, unknown>, key: string, low = 1, high = 512): string => {
  const value = body[key]

  if (typeof value !== 'string' || value.length < low || value.length > high) {
    throw new Fail(400, 'bad_request', `${key} must be a string of ${low} to ${high} characters.`)
  }

  return value
}

function credentialName(body: Record<string, unknown>): string {
  const name = string(body, 'name', 1, NAME_MAX * 4).trim()

  if (name.length < 1 || name.length > NAME_MAX || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new Fail(400, 'bad_request', `name must be 1 to ${NAME_MAX} printable characters.`)
  }

  return name
}

function aaguidText(aaguid: Buffer): string {
  const hex = aaguid.toString('hex')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const credentialView = (c: CredentialRecord): Record<string, unknown> => ({
  id: idOf(c),
  name: c.name,
  rp_id: c.rpId,
  aaguid: aaguidText(c.aaguid),
  created_at: c.createdAt,
  last_used_at: c.lastUsedAt,
  backup_eligible: c.backupEligible,
  backed_up: c.backedUp,
  created_via: c.createdVia,
  transports: [...c.transports]
})

const credentialsByRp = (records: CredentialRecord[]): { rp_id: string; ids: string[] }[] => {
  const byRp = new Map<string, string[]>()

  for (const c of records) {
    byRp.set(c.rpId, [...(byRp.get(c.rpId) ?? []), idOf(c)])
  }

  return [...byRp].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([rp_id, ids]) => ({ rp_id, ids }))
}

/** Steps rp_not_accepted, base_url_not_accepted, rp_host_mismatch for a ceremony being opened. */
function checkRpAndBaseUrl(gw: PasskeyGateway, rpId: string, baseUrl: string): void {
  const ctx = gw.context()
  const kind = ctx.nativeRpIds.has(rpId) ? 'native' : ctx.webRpIds.has(rpId) ? 'web' : null

  if (kind === null) {
    throw new Fail(400, 'bad_request', 'This RP is not accepted here.', 'rp_not_accepted')
  }

  if (!ctx.acceptedBaseUrls.includes(baseUrl)) {
    throw new Fail(
      400,
      'bad_request',
      "This base URL is not one of this gateway's passkey base URLs.",
      'base_url_not_accepted'
    )
  }

  if (kind === 'web' && new URL(baseUrl).hostname !== rpId) {
    throw new Fail(400, 'bad_request', 'A browser RP must be the host of the base URL.', 'rp_host_mismatch')
  }
}

interface Call extends RouteCall {
  identity: Identity
  user: string
}

// ── GET /api/auth/passkeys ─────────────────────────────────────────────────────────────────────

function status(gw: PasskeyGateway, call: Call): Reply {
  const ctx = gw.context()
  const reason = ctx.capabilityReason({ enabled: true, identity: true })

  return {
    status: 200,
    headers: NO_STORE,
    body: {
      v: 1,
      enabled: reason === '',
      reason,
      gateway_id: b64u(gw.store.gatewayId),
      user: { id: call.user, handle: b64u(userHandle(gw.store.handleKey, call.user)) },
      rp: { native: [...ctx.nativeRpIds].sort(), web: [...ctx.webRpIds].sort() },
      base_urls: [...ctx.acceptedBaseUrls],
      user_invites: gw.settings.userInvites,
      credentials: gw.store.credentials(call.user).map(credentialView)
    }
  }
}

// ── registration ───────────────────────────────────────────────────────────────────────────────

function registerBegin(gw: PasskeyGateway, call: Call, body: Record<string, unknown>): Reply {
  const rpId = string(body, 'rp_id', 1, 253)
  const baseUrl = string(body, 'base_url')
  const name = credentialName(body)

  checkRpAndBaseUrl(gw, rpId, baseUrl)

  const { limiters } = gw
  const allowed =
    !limiters.registerBeginPerUser.exhausted(call.user) &&
    !limiters.registerBeginPerIp.exhausted(call.ip) &&
    limiters.registerBeginPerUser.check(call.user) &&
    limiters.registerBeginPerIp.check(call.ip)

  if (!allowed) {
    gw.note({ surface: 'register', reason: 'rate_limited', userId: call.user, requestId: '' })

    throw new Fail(429, 'rate_limited', 'Too many registrations; try again later.', '', 600)
  }

  const pending = gw.store.openPending('register', { userId: call.user, rpId, baseUrl, subject: name })
  const exclude = gw.store
    .credentials(call.user)
    .filter(c => c.rpId === rpId)
    .map(c => ({ type: 'public-key', id: idOf(c), transports: [...c.transports] }))

  return {
    status: 200,
    headers: NO_STORE,
    body: {
      registration_id: pending.id,
      nonce: b64u(pending.nonce),
      expires_at: pending.expiresAt,
      gateway_id: b64u(gw.store.gatewayId),
      base_url: baseUrl,
      rp: { id: rpId, name: rpId },
      user: {
        id: call.user,
        handle: b64u(userHandle(gw.store.handleKey, call.user)),
        name,
        display_name: name
      },
      exclude_credentials: exclude,
      pub_key_cred_params: [{ type: 'public-key', alg: ALG_ES256 }],
      user_verification: 'required',
      attestation: 'none'
    }
  }
}

function refuseIfCodeFailuresExhausted(gw: PasskeyGateway, call: Call, registrationId: string): void {
  const { limiters } = gw
  let wait = 0

  if (limiters.codeFailuresGateway.exhausted('gateway')) {
    wait = limiters.codeFailuresGateway.windowSec
  } else if (limiters.codeFailuresPerUser.exhausted(call.user) || limiters.codeFailuresPerIp.exhausted(call.ip)) {
    wait = limiters.codeFailuresPerUser.windowSec
  } else {
    return
  }

  gw.note({ surface: 'register', reason: 'rate_limited', userId: call.user, requestId: registrationId })

  throw new Fail(429, 'rate_limited', 'Too many failed enrolment codes; try again later.', '', wait)
}

function recordCodeFailure(gw: PasskeyGateway, call: Call): void {
  gw.limiters.codeFailuresPerUser.check(call.user)
  gw.limiters.codeFailuresPerIp.check(call.ip)
  gw.limiters.codeFailuresGateway.check('gateway')
}

function registerFinish(gw: PasskeyGateway, call: Call, body: Record<string, unknown>): Reply {
  const registrationId = string(body, 'registration_id', 1, ID_MAX)

  if (typeof body.code !== 'string') {
    throw new Fail(400, 'bad_request', 'code must be a string (the enrolment code).')
  }

  refuseIfCodeFailuresExhausted(gw, call, registrationId)

  const pending = gw.store.pending(registrationId, 'register', call.user)

  if (!pending) {
    gw.note({ surface: 'register', reason: 'expired', userId: call.user, requestId: registrationId })

    throw new Fail(410, 'expired', 'The registration is unknown, used or expired; start again.')
  }

  const verdict = verifyRegistration(gw.context(), registrationOf(pending), body)

  if (!verdict.ok) {
    gw.note({ surface: 'register', reason: verdict.reason, userId: call.user, requestId: registrationId })

    throw new Fail(422, 'attestation_invalid', 'The new passkey could not be verified.', verdict.reason)
  }

  refuseIfCodeFailuresExhausted(gw, call, registrationId)

  let record: CredentialRecord

  try {
    record = gw.store.addCredential({ userId: call.user, code: body.code, registration: verdict, createdIp: call.ip })
  } catch (error) {
    if (error instanceof PendingInvalid) {
      gw.note({ surface: 'register', reason: 'expired', userId: call.user, requestId: registrationId })

      throw new Fail(410, 'expired', 'The registration is unknown, used or expired; start again.')
    }

    if (error instanceof CodeInvalid) {
      recordCodeFailure(gw, call)
      gw.note({ surface: 'register', reason: 'code_invalid', userId: call.user, requestId: registrationId })

      throw new Fail(403, 'code_invalid', 'The enrolment code is not valid.')
    }

    if (error instanceof CredentialExists) {
      // Counted like a wrong code: the store checks the code before the id, so a caller holding one valid
      // code could otherwise probe which credential ids exist for as long as the registration lives.
      recordCodeFailure(gw, call)
      gw.note({ surface: 'register', reason: 'credential_exists', userId: call.user, requestId: registrationId })

      throw new Fail(409, 'credential_exists', 'This passkey is already registered.')
    }

    throw error
  }

  gw.announce(call.user, 'added', record)

  return { status: 200, headers: NO_STORE, body: { ok: true, credential: credentialView(record) } }
}

// ── step-ups ───────────────────────────────────────────────────────────────────────────────────

function stepupBegin(gw: PasskeyGateway, call: Call, body: Record<string, unknown>): Reply {
  const purpose = body.purpose

  if (purpose !== 'invite' && purpose !== 'revoke') {
    throw new Fail(400, 'bad_request', 'purpose must be "invite" or "revoke".')
  }

  const active = gw.store.credentials(call.user)

  if (!active.length) {
    throw new Fail(400, 'bad_request', 'You have no passkey on this gateway.', 'not_enrolled')
  }

  let subject: string

  if (purpose === 'invite') {
    if (!gw.settings.userInvites) {
      gw.note({ surface: 'stepup', reason: 'user_invites_disabled', userId: call.user, requestId: '' })

      throw new Fail(403, 'invites_disabled', "This gateway's operator mints every enrolment code.")
    }

    if ((body.subject ?? 'invite') !== 'invite') {
      throw new Fail(400, 'bad_request', 'The subject of an invite step-up is "invite".')
    }

    subject = 'invite'
  } else {
    subject = string(body, 'subject', 1, 1400)

    // Only the caller's own active credentials; another user's id gets the same answer as an unknown one.
    if (!active.some(c => idOf(c) === subject)) {
      throw new Fail(400, 'bad_request', 'subject is not one of your passkeys.', 'unknown_credential')
    }
  }

  if (!gw.limiters.stepupBeginPerUser.check(call.user)) {
    gw.note({ surface: 'stepup', reason: 'rate_limited', userId: call.user, requestId: '' })

    throw new Fail(429, 'rate_limited', 'Too many step-ups; try again later.', '', 600)
  }

  const pending = gw.store.openPending(purpose, { userId: call.user, subject })

  return {
    status: 200,
    headers: NO_STORE,
    body: {
      stepup_id: pending.id,
      purpose,
      subject,
      nonce: b64u(pending.nonce),
      expires_at: pending.expiresAt,
      credentials: credentialsByRp(active)
    }
  }
}

/**
 * Verify and commit a step-up assertion (README §5 for `invite` / `revoke`). A step-up is single use: an
 * assertion refused by the verifier or at the store's commit spends it too. `subject`, when given, must be
 * what the step-up was opened for.
 */
function stepup(
  gw: PasskeyGateway,
  call: Call,
  body: Record<string, unknown>,
  purpose: 'invite' | 'revoke',
  subject?: string
): { credentialId: Buffer; rpId: string; baseUrl: string; requestId: string } {
  const stepupId = string(body, 'stepup_id', 1, ID_MAX)
  const assertion = body.assertion

  if (typeof assertion !== 'object' || assertion === null || Array.isArray(assertion)) {
    throw new Fail(400, 'bad_request', 'assertion must be an object.')
  }

  const claimed = assertion as Record<string, unknown>

  if ('base_url' in body && body.base_url !== claimed.base_url) {
    throw new Fail(400, 'bad_request', "base_url differs from the assertion's base_url.")
  }

  const refuse = (note: string): never => {
    gw.note({ surface: 'stepup', reason: note, userId: call.user, requestId: stepupId })

    throw new Fail(403, 'stepup_invalid', `No open ${purpose} step-up with this id for you; start again.`)
  }
  const pending = gw.store.pending(stepupId, purpose, call.user)

  if (!pending || (subject !== undefined && pending.subject !== subject)) {
    return refuse('stepup_invalid')
  }

  const snapshot = gw.store.snapshot(call.user)
  const verdict = verifyAssertion(
    gw.context(),
    {
      userId: call.user,
      requestId: pending.id,
      nonce: pending.nonce,
      title: '',
      summary: pending.subject,
      detail: '',
      sessionId: '',
      purpose
    },
    snapshot,
    { decision: 'confirmed', method: 'passkey', passkey: assertion }
  )

  const spend = (): void => {
    try {
      gw.store.takePending(pending.id, purpose, call.user)
    } catch {
      // already taken or expired
    }
  }

  if (!verdict.ok) {
    spend()
    gw.note({ surface: 'stepup', reason: verdict.reason, userId: call.user, requestId: stepupId })

    throw new Fail(422, 'assertion_invalid', 'The passkey assertion was refused.', verdict.reason)
  }

  const used = snapshot.find(c => c.credentialId.equals(verdict.credentialId))

  if (!used) {
    spend()

    return refuse('stepup_invalid')
  }

  try {
    gw.store.commitAssertion(verdict, { userId: call.user, snapshot: used, stepupId: pending.id })
  } catch (error) {
    if (!(error instanceof CommitRefused)) {
      throw error
    }

    spend() // the commit changed nothing, the step-up included
    gw.note({ surface: 'stepup', reason: error.reason, userId: call.user, requestId: stepupId })

    if (error.reason === 'stepup_invalid') {
      throw new Fail(403, 'stepup_invalid', `No open ${purpose} step-up with this id for you; start again.`)
    }

    throw new Fail(422, 'assertion_invalid', 'The passkey assertion was refused.', error.reason)
  }

  return {
    credentialId: verdict.credentialId,
    rpId: verdict.rpId,
    baseUrl: verdict.baseUrl,
    requestId: verdict.requestId
  }
}

function invites(gw: PasskeyGateway, call: Call, body: Record<string, unknown>): Reply {
  if (!gw.settings.userInvites) {
    gw.note({ surface: 'stepup', reason: 'user_invites_disabled', userId: call.user, requestId: '' })

    throw new Fail(403, 'invites_disabled', "This gateway's operator mints every enrolment code.")
  }

  stepup(gw, call, body, 'invite')

  const invite = gw.store.mintCode({ by: call.user })

  return { status: 200, headers: NO_STORE, body: { code: invite.code, expires_at: invite.expiresAt } }
}

function revoke(gw: PasskeyGateway, call: Call, body: Record<string, unknown>): Reply {
  const credentialId = string(body, 'credential_id', 1, 1400)
  let raw: Buffer

  try {
    raw = b64uDecode(credentialId, 1, 1023)
  } catch {
    throw new Fail(400, 'bad_request', 'credential_id is not a base64url credential id.')
  }

  stepup(gw, call, body, 'revoke', credentialId)

  const revoked = gw.store.revoke(raw, { by: call.user, userId: call.user })

  // Revoked meanwhile (the operator, or a parallel request): nothing more to announce.
  if (revoked) {
    gw.announce(call.user, 'revoked', revoked)
  }

  return { status: 200, headers: NO_STORE, body: { ok: true } }
}

/**
 * Serve one passkey route. `false` when `path` is not one of them (the caller carries on). The caller has
 * already run the gate: the request is authenticated, `call` says as whom.
 */
export async function handlePasskeyRoute(
  gw: PasskeyGateway,
  req: IncomingMessage,
  res: ServerResponse,
  call: RouteCall
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
    return false
  }

  const suffix = url.pathname.slice(PREFIX.length)
  const method = req.method ?? 'GET'

  if (!(suffix in ROUTES)) {
    return false
  }

  if (!gw.settings.enabled) {
    send(res, notFound(method, url.pathname))

    return true
  }

  const allowed = ROUTES[suffix] as string

  if (method !== allowed) {
    send(res, { status: 405, body: { detail: 'Method Not Allowed' }, headers: { allow: allowed } })

    return true
  }

  try {
    if (!call.identity) {
      throw new Fail(403, 'no_identity', 'Passkeys belong to a signed-in user; this connection has none.')
    }

    const write = method !== 'GET'
    const origin = String(req.headers.origin ?? '')
    const accepted = new Set(gw.context().acceptedBaseUrls.map(originOf))

    if (write && call.auth === 'cookie' && !accepted.has(origin)) {
      gw.note({
        surface: suffix.startsWith('/register') ? 'register' : 'stepup',
        reason: 'origin_not_listed',
        userId: userKey(call.identity),
        requestId: ''
      })

      throw new Fail(
        403,
        'origin_not_listed',
        "A browser write needs an Origin that is one of this gateway's passkey base URLs."
      )
    }

    const body = write ? await readBody(req) : {}
    const scoped: Call = { ...call, identity: call.identity, user: userKey(call.identity) }
    const handler: Record<string, (g: PasskeyGateway, c: Call, b: Record<string, unknown>) => Reply> = {
      '': status,
      '/register/begin': registerBegin,
      '/register/finish': registerFinish,
      '/stepup/begin': stepupBegin,
      '/invites': invites,
      '/revoke': revoke
    }

    send(res, (handler[suffix] as (g: PasskeyGateway, c: Call, b: Record<string, unknown>) => Reply)(gw, scoped, body))
  } catch (error) {
    if (error instanceof Fail) {
      send(res, failReply(error))
    } else {
      throw error
    }
  }

  return true
}
