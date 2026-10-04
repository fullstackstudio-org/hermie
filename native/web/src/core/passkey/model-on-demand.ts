/**
 * What the passkey model does only when the Passkeys settings page asks: enrol a passkey of this browser with a code,
 * add one by signing in again (contract §7.2), and the step-ups that mint an invite or revoke a credential.
 *
 * None of it runs before the reader opens that page, so it is not part of the first load: `PasskeyModel` keeps a
 * method of the same name for each public function here, which hands the call to this module once it has loaded
 * (`onDemandPart` in `core/on-demand.ts`; at once, in the same tick, when it is already there). The Settings pages'
 * chunk imports this module, so it is there before the page can ask. What the first load needs of the model (`confirm`
 * requests, the advertisement, the list, the notices, the pin) stays in `model.ts`.
 *
 * Each function takes the model as `c` and works on its state as its methods do: the members it reads are the model's
 * own (`model.ts`), not part of what a screen is given (`PasskeyActions`). Moved from the class unchanged, apart from
 * `this` being `c`.
 */
import { CeremonyError } from '../../platform/webauthn'
import { b64uDecode, b64uEncode, canonicalEnrolmentCode, challenge, subjectText } from './challenge'
import {
  type PasskeyAssertion,
  type PasskeyClient,
  type PasskeyCredentialInfo,
  PasskeyRouteError,
  type SelfEnrolStatus
} from './client'
import {
  credentialName,
  endsGrant,
  PasskeyActionError,
  type PasskeyActionProblem,
  type PasskeyInvite,
  type PasskeyModel,
  providePasskeyModelOnDemand
} from './model'

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

// ── enrolment and step-ups ────────────────────────────────────────────────────────────────────

/**
 * Enrol a passkey of this browser for this gateway, with a one-time code from the operator (or
 * minted with one's own passkey elsewhere). Pins the gateway's id on the first success.
 */
export async function enrol(c: PasskeyModel, code: string): Promise<PasskeyCredentialInfo> {
  const canonical = canonicalEnrolmentCode(code)

  if (!canonical) {
    throw new PasskeyActionError({ kind: 'invalid_code' })
  }

  return register(c, { code: canonical })
}

/**
 * First half: open a grant, keep its id and deadline across the trip, and send the window to the gateway's sign-in
 * page (top level: an identity provider cannot be framed). Resolves only when the navigation was started; the page
 * is gone a moment later. Throws before leaving when it cannot come back (`self_enrol_stash`) or the gateway says no.
 */
export async function startSelfEnrolment(c: PasskeyModel): Promise<void> {
  const seam = c.options.selfEnrolment

  if (!seam) {
    throw new PasskeyActionError({ kind: 'self_enrol_unavailable', reason: 'not_supported' })
  }

  const account = await readAccount(c)

  if (account.selfEnrol?.available !== true) {
    const reason = account.selfEnrol?.reason

    throw new PasskeyActionError({
      kind: 'self_enrol_unavailable',
      reason: reason === 'disabled' || reason === 'provider_no_reauth' ? reason : 'not_offered'
    })
  }

  const grant = await route(c, client => client.reauthBegin(), {
    kind: 'self_enrol_unavailable',
    reason: 'not_offered'
  })

  if (
    typeof grant?.grant_id !== 'string' ||
    !grant.grant_id ||
    typeof grant.expires_at !== 'number' ||
    !Number.isFinite(grant.expires_at) ||
    typeof grant.login_path !== 'string'
  ) {
    throw new PasskeyActionError({ kind: 'bad_answer' })
  }

  if (!seam.stash.write({ grantId: grant.grant_id, expiresAt: grant.expires_at })) {
    seam.stash.clear()

    throw new PasskeyActionError({ kind: 'self_enrol_stash' })
  }

  if (!seam.bounce(grant.login_path)) {
    seam.stash.clear()

    throw new PasskeyActionError({ kind: 'bad_answer' })
  }
}

/**
 * Second half, run from a click: the passkey ceremony for the grant the sign-in completed. See the header for what
 * keeps the stash and what removes it.
 */
export async function finishSelfEnrolment(c: PasskeyModel): Promise<PasskeyCredentialInfo> {
  const seam = c.options.selfEnrolment
  const entry = seam?.stash.read() ?? null

  // The local deadline is not asked: the gateway says whether the grant still lives (`reauth_invalid`, which ends it).
  if (!seam || entry === null) {
    c.forgetSelfEnrolment()

    throw new PasskeyActionError({ kind: 'self_enrol_expired' })
  }

  try {
    const credential = await register(c, { grantId: entry.grantId })

    c.forgetSelfEnrolment()

    return credential
  } catch (error) {
    if (endsGrant(error)) {
      c.forgetSelfEnrolment()
    }

    throw error
  }
}

/** Mint an enrolment code with a passkey of this browser (`invite` step-up), for another device. */
export async function mintInvite(c: PasskeyModel): Promise<PasskeyInvite> {
  const { stepupId, assertion, account } = await stepUp(c, 'invite', 'invite')
  const result = await route(c, client => client.invite({ stepup_id: stepupId, base_url: account.baseUrl, assertion }))

  if (typeof result?.code !== 'string' || !result.code) {
    throw new PasskeyActionError({ kind: 'bad_answer' })
  }

  return { code: result.code, expiresAt: typeof result.expires_at === 'number' ? result.expires_at : null }
}

/** Remove one of this account's passkeys, with a passkey of this browser (`revoke` step-up). */
export async function revoke(c: PasskeyModel, credentialId: string): Promise<void> {
  c.expectedRevocations.add(credentialId)

  try {
    const { stepupId, assertion, account } = await stepUp(c, 'revoke', credentialId)

    await route(c, client =>
      client.revoke({ credential_id: credentialId, stepup_id: stepupId, base_url: account.baseUrl, assertion })
    )

    c.options.pins.remember(c.options.pins.seen().ids.filter(id => id !== credentialId))
    await c.refresh()
  } finally {
    c.expectedRevocations.delete(credentialId)
  }
}

/**
 * The registration ceremony, authorised by exactly one of a code or a fresh-authentication grant (contract §7):
 * `register/begin`, the browser's `create()`, `register/finish`; then the pin and the list.
 */
async function register(
  c: PasskeyModel,
  authority: { code: string } | { grantId: string }
): Promise<PasskeyCredentialInfo> {
  const account = await readAccount(c)
  const host = new URL(account.baseUrl).host
  const name = credentialName(c.options.displayName ?? 'Hermie', host)
  const begin = await route(c, client =>
    client.registerBegin({
      rp_id: account.rpId,
      base_url: account.baseUrl,
      name,
      ...('grantId' in authority ? { grant_id: authority.grantId } : {})
    })
  )
  const nonce = typeof begin?.nonce === 'string' ? b64uDecode(begin.nonce, 32, 32) : null

  if (typeof begin?.registration_id !== 'string' || !begin.registration_id || !nonce) {
    throw new PasskeyActionError({ kind: 'bad_answer' })
  }

  const { webauthn } = c.options
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

  c.expectedAdditions.add(id)

  try {
    const finish = await route(c, client =>
      client.registerFinish({
        registration_id: begin.registration_id,
        base_url: account.baseUrl,
        ...('code' in authority ? { code: authority.code } : { grant_id: authority.grantId }),
        credential: {
          id,
          client_data_json: b64uEncode(registration.clientDataJSON),
          attestation_object: b64uEncode(registration.attestationObject),
          transports: registration.transports
        }
      })
    )

    // The first successful enrolment pins the id; a later one keeps the pin there is.
    if (c.options.pins.gatewayId() === null) {
      c.options.pins.pin(account.gatewayIdText)
    }

    c.store.setState({ pinned: true })

    c.options.pins.remember([...c.options.pins.seen().ids, id])
    await c.refresh()

    return finish?.credential ?? { id, name, rp_id: account.rpId }
  } finally {
    c.expectedAdditions.delete(id)
  }
}

/** Open a step-up and sign it: `subject` is `"invite"` or the credential id (contract §5). */
async function stepUp(
  c: PasskeyModel,
  purpose: 'invite' | 'revoke',
  subject: string
): Promise<{ stepupId: string; assertion: PasskeyAssertion; account: Account }> {
  const account = await readAccount(c)
  const begin = await route(c, client => client.stepupBegin({ purpose, subject }))
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

  const { webauthn } = c.options
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
      ...(response.userHandle && response.userHandle.length > 0 ? { user_handle: b64uEncode(response.userHandle) } : {})
    }
  }
}

/** A fresh status read, decoded and checked against the pins and this page's RP. */
async function readAccount(c: PasskeyModel): Promise<Account> {
  if (!c.supported || c.baseUrl === null) {
    throw new PasskeyActionError({ kind: 'not_supported' })
  }

  const fresh = await route(c, client => client.status())
  const broken = typeof fresh?.gateway_id === 'string' ? c.pinProblem(fresh.gateway_id) : null

  if (broken) {
    // Another gateway's list: not shown, not kept.
    c.store.setState({ status: null, credentials: [] })
    c.notify(broken)

    throw new PasskeyActionError(broken)
  }

  c.store.setState({
    status: fresh,
    credentials: Array.isArray(fresh?.credentials) ? fresh.credentials : [],
    statusError: null
  })

  if (fresh?.enabled !== true) {
    throw new PasskeyActionError({ kind: 'unavailable', reason: text(fresh?.reason) ?? '' })
  }

  const rpId = c.options.webauthn.rpId

  if (!Array.isArray(fresh.rp?.web) || !fresh.rp.web.includes(rpId)) {
    throw new PasskeyActionError({ kind: 'rp_not_accepted' })
  }

  const gatewayId = typeof fresh.gateway_id === 'string' ? b64uDecode(fresh.gateway_id, 16, 16) : null
  const handle = typeof fresh.user?.handle === 'string' ? b64uDecode(fresh.user.handle, 1, 64) : null

  if (!gatewayId || !handle || typeof fresh.user?.id !== 'string' || !fresh.user.id) {
    throw new PasskeyActionError({ kind: 'bad_answer' })
  }

  return {
    selfEnrol: fresh.self_enrol,
    gatewayId,
    gatewayIdText: fresh.gateway_id,
    userId: fresh.user.id,
    handle,
    baseUrl: c.baseUrl,
    rpId
  }
}

/** One route call, its failures as `PasskeyActionError`. */
async function route<T>(
  c: PasskeyModel,
  call: (client: PasskeyClient) => Promise<T>,
  notOffered: PasskeyActionProblem = { kind: 'unavailable', reason: 'disabled' }
): Promise<T> {
  try {
    return await call(c.options.client)
  } catch (error) {
    if (error instanceof PasskeyRouteError) {
      if (error.kind === 'not_offered') {
        throw new PasskeyActionError(notOffered)
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
        retryAfter: error.retryAfter,
        failure: error.failure
      })
    }

    throw new PasskeyActionError({
      kind: 'transport',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

interface Account {
  /** What the status read this account came from says about self-enrolment. */
  selfEnrol: SelfEnrolStatus | undefined
  gatewayId: Uint8Array
  gatewayIdText: string
  userId: string
  handle: Uint8Array
  baseUrl: string
  rpId: string
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

/** What `PasskeyModel` hands its calls to (`onDemandPart`). */
const part = {
  enrol,
  startSelfEnrolment,
  finishSelfEnrolment,
  mintInvite,
  revoke
}

export type PasskeyModelOnDemand = typeof part

providePasskeyModelOnDemand(part)
