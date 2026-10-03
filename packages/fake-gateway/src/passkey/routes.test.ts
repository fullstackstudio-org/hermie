/**
 * The six passkey routes against the running fake, end to end, with the software authenticator.
 *
 * What is pinned is what the real gateway's routes pin
 * (`tests/hermes_cli/test_passkey_routes.py`): 404 for every route while the level is off; nothing is
 * public; identity only from the gate; enrolment needs a code every time; an invite needs a valid `invite`
 * step-up and a revoke a `revoke` step-up for that credential; one user never sees, adds to or revokes
 * another's credentials; a cookie write needs a listed `Origin`; the 16 KiB body cap; the rate limits; and
 * `passkey.changed` reaching only the user's own connections.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { b64u, b64uDecode } from './encoding'
import {
  ALICE,
  BOB,
  bearerFor,
  closeAll,
  connect,
  cookieFor,
  post,
  startPasskeyGateway,
  type Account,
  type Harness,
  type Json
} from './harness'
import { SoftAuthenticator } from '../testing/soft-authenticator'

afterEach(closeAll)

const PREFIX = '/api/auth/passkeys'

/** A signed-in caller: the headers its requests carry. */
interface Caller {
  who: Account
  headers: Record<string, string>
}

const cookieCaller = async (h: Harness, who: Account, origin: string | null = h.url): Promise<Caller> => ({
  who,
  headers: { cookie: await cookieFor(h, who), ...(origin === null ? {} : { origin }) }
})

const bearerCaller = async (h: Harness): Promise<Caller> => ({
  who: ALICE,
  headers: { authorization: await bearerFor(h) }
})

const get = async (h: Harness, c: Caller, path = ''): Promise<{ status: number; body: Json; headers: Headers }> => {
  const response = await fetch(`${h.url}${PREFIX}${path}`, { headers: c.headers })

  return { status: response.status, body: (await response.json()) as Json, headers: response.headers }
}

const send = async (
  h: Harness,
  c: Caller,
  path: string,
  body: unknown
): Promise<{ status: number; body: Json; headers: Headers }> => {
  const response = await post(`${h.url}${PREFIX}${path}`, body, c.headers)

  return { status: response.status, body: (await response.json()) as Json, headers: response.headers }
}

const operatorCode = async (h: Harness, user?: Account): Promise<string> =>
  ((await (await post(`${h.url}/__fake/passkey/code`, user ? { user: user.key } : {})).json()) as Json).code

const begin = async (h: Harness, c: Caller, auth: SoftAuthenticator, name = 'Phone — gw.example.invalid') => {
  const answer = await send(h, c, '/register/begin', { rp_id: auth.rpId, base_url: h.url, name })

  return answer
}

const finishBody = (h: Harness, auth: SoftAuthenticator, opened: Json, code: string) =>
  auth.register(
    {
      registrationId: opened.registration_id,
      baseUrl: opened.base_url,
      gatewayId: b64uDecode(opened.gateway_id),
      userId: opened.user.id,
      name: opened.user.name,
      nonce: b64uDecode(opened.nonce)
    },
    code
  )

/** Enrol `auth` for `c` with an operator code (or the given one); returns the credential the route answered. */
const enrol = async (h: Harness, c: Caller, auth: SoftAuthenticator, code?: string): Promise<Json> => {
  const opened = await begin(h, c, auth)

  expect(opened.status).toBe(200)

  const finished = await send(
    h,
    c,
    '/register/finish',
    finishBody(h, auth, opened.body, code ?? (await operatorCode(h, c.who)))
  )

  expect(finished.status, JSON.stringify(finished.body)).toBe(200)

  return finished.body.credential as Json
}

const stepup = async (h: Harness, c: Caller, purpose: 'invite' | 'revoke', subject?: string): Promise<Json> => {
  const answer = await send(h, c, '/stepup/begin', { purpose, ...(subject === undefined ? {} : { subject }) })

  expect(answer.status, JSON.stringify(answer.body)).toBe(200)

  return answer.body
}

/** What `auth` signs for a step-up the gateway opened. */
const signStepup = async (
  h: Harness,
  c: Caller,
  auth: SoftAuthenticator,
  opened: Json,
  options: { purpose?: 'invite' | 'revoke'; subject?: string } = {}
) => {
  const status = (await get(h, c)).body

  return auth.assert({
    baseUrl: h.url,
    gatewayId: b64uDecode(status.gateway_id),
    userId: c.who.key,
    requestId: opened.stepup_id,
    nonce: b64uDecode(opened.nonce),
    title: '',
    summary: options.subject ?? opened.subject,
    detail: '',
    purpose: options.purpose ?? opened.purpose,
    userHandle: status.user.handle
  }).passkey
}

describe('availability', () => {
  it('answers like an unknown path for every route while the level is off, and creates nothing', async () => {
    const h = await startPasskeyGateway({ passkey: { enabled: false } })
    const alice = await cookieCaller(h, ALICE)

    for (const [method, path] of [
      ['GET', ''],
      ['POST', '/register/begin'],
      ['POST', '/register/finish'],
      ['POST', '/stepup/begin'],
      ['POST', '/invites'],
      ['POST', '/revoke']
    ] as const) {
      const response = await fetch(`${h.url}${PREFIX}${path}`, {
        method,
        headers: { ...alice.headers, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {})
      })

      if (method === 'GET') {
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ detail: `No such API endpoint: ${PREFIX}${path}` })
      } else {
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('GET')
        expect(await response.json()).toEqual({ detail: 'Method Not Allowed' })
      }
    }

    expect(h.gateway.passkey()?.store.counts()).toMatchObject({ credentials: 0, openCodes: 0 })
  })

  it('serves nothing at all on a gateway that does not know the level', async () => {
    const h = await startPasskeyGateway({ passkey: false })
    const alice = await cookieCaller(h, ALICE)

    expect(h.gateway.passkey()).toBeNull()
    expect((await get(h, alice)).status).toBe(404)
  })

  it('is behind the gate: no cookie, no answer', async () => {
    const h = await startPasskeyGateway()

    for (const [method, path] of [
      ['GET', ''],
      ['POST', '/register/begin'],
      ['POST', '/register/finish'],
      ['POST', '/stepup/begin'],
      ['POST', '/invites'],
      ['POST', '/revoke']
    ] as const) {
      const response = await fetch(`${h.url}${PREFIX}${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) })

      expect(response.status, `${method} ${path}`).toBe(401)
    }
  })

  it('names nobody on a gateway with a session token, so there is nothing to bind a passkey to', async () => {
    const h = await startPasskeyGateway({ auth: 'token', token: 'secret' })
    const headers = { 'x-hermes-session-token': 'secret' }
    const read = await fetch(`${h.url}${PREFIX}`, { headers })

    expect(read.status).toBe(403)
    expect(await read.json()).toMatchObject({ error: 'no_identity' })

    const write = await post(
      `${h.url}${PREFIX}/register/begin`,
      { rp_id: 'confirm.hermie.dev', base_url: h.url, name: 'x' },
      headers
    )

    expect(write.status).toBe(403)
    expect(await write.json()).toMatchObject({ error: 'no_identity' })
  })
})

describe('status', () => {
  it('names the gateway, the user and the RPs, and is never cached', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const answer = await get(h, alice)

    expect(answer.status).toBe(200)
    expect(answer.headers.get('cache-control')).toBe('no-store')
    expect(answer.body).toMatchObject({
      v: 1,
      enabled: true,
      reason: '',
      gateway_id: b64u(h.gateway.passkey()!.store.gatewayId),
      user: { id: ALICE.key },
      rp: { native: ['confirm.hermie.dev'], web: [] },
      base_urls: [h.url],
      user_invites: true,
      credentials: []
    })
    expect(b64uDecode(answer.body.user.handle)).toHaveLength(32)
    expect((await get(h, await cookieCaller(h, BOB))).body.user.handle).not.toBe(answer.body.user.handle)
  })

  it('is not enabled while the level has no usable base URL, and says why', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)

    await post(`${h.url}/__fake/passkey/enable`, { base_urls: [] })
    expect((await get(h, alice)).body).toMatchObject({
      enabled: false,
      reason: 'no_base_url',
      rp: { native: [], web: [] }
    })

    await post(`${h.url}/__fake/passkey/enable`, { base_urls: ['http://192.168.1.10:9119'], allow_private: false })
    expect((await get(h, alice)).body).toMatchObject({ enabled: false, reason: 'private_origin', base_urls: [] })
  })
})

describe('enrolment', () => {
  it('enrols with an operator code, announces it to the user and nobody else', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const phone = await connect(h, alice.headers)
    const laptop = await connect(h, alice.headers)
    const bob = await connect(h, (await cookieCaller(h, BOB)).headers)
    const anonymous = await connect(h)
    const auth = SoftAuthenticator.native()
    const opened = await begin(h, alice, auth)

    expect(opened.body).toMatchObject({
      rp: { id: 'confirm.hermie.dev', name: 'confirm.hermie.dev' },
      user_verification: 'required',
      attestation: 'none',
      pub_key_cred_params: [{ type: 'public-key', alg: -7 }],
      exclude_credentials: [],
      base_url: h.url
    })
    expect(opened.body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 290)

    const finished = await send(h, alice, '/register/finish', finishBody(h, auth, opened.body, await operatorCode(h)))

    expect(finished.status).toBe(200)
    expect(finished.body.credential).toMatchObject({
      id: auth.id,
      rp_id: 'confirm.hermie.dev',
      name: 'Phone — gw.example.invalid',
      created_via: 'operator',
      backup_eligible: true,
      backed_up: true
    })
    expect((await get(h, alice)).body.credentials.map((c: Json) => c.id)).toEqual([auth.id])

    const expected = {
      change: 'added',
      credential: { id: auth.id, name: 'Phone — gw.example.invalid', rp_id: 'confirm.hermie.dev' },
      at: expect.any(Number)
    }

    await phone.next(frame => frame.params?.type === 'passkey.changed', 'the announcement')
    await laptop.next(frame => frame.params?.type === 'passkey.changed', 'the announcement')
    expect(phone.events('passkey.changed').map(frame => frame.params?.payload)).toEqual([expected])
    expect(laptop.events('passkey.changed').map(frame => frame.params?.payload)).toEqual([expected])
    expect(phone.events('passkey.changed')[0]?.params?.session_id).toBe('')
    expect(bob.events('passkey.changed')).toEqual([])
    expect(anonymous.events('passkey.changed')).toEqual([])

    // The next registration for the same RP excludes the enrolled credential.
    const again = await begin(h, alice, SoftAuthenticator.native())

    expect(again.body.exclude_credentials.map((c: Json) => c.id)).toEqual([auth.id])
  })

  it('needs a code of its own for every enrolment, and one answer for every way a code is wrong', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const first = await operatorCode(h, ALICE)

    await enrol(h, alice, SoftAuthenticator.native(), first)

    const second = SoftAuthenticator.native()
    const opened = await begin(h, alice, second)

    for (const code of ['', first, 'not-a-code', '00000-00000-00000-00000']) {
      const refused = await send(h, alice, '/register/finish', finishBody(h, second, opened.body, code))

      expect([refused.status, refused.body.error], code).toEqual([403, 'code_invalid'])
    }

    const { code: _code, ...withoutCode } = finishBody(h, second, opened.body, '')

    expect((await send(h, alice, '/register/finish', withoutCode)).status).toBe(400)
    expect((await get(h, alice)).body.credentials).toHaveLength(1)

    // The registration stayed open: the right code still works.
    const retried = await send(
      h,
      alice,
      '/register/finish',
      finishBody(h, second, opened.body, await operatorCode(h, ALICE))
    )

    expect(retried.status).toBe(200)
    expect((await get(h, alice)).body.credentials).toHaveLength(2)
  })

  it('refuses a registration for an RP or base URL the level does not accept, and never normalises one', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const open = (body: Json) => send(h, alice, '/register/begin', { name: 'x', ...body })

    expect((await open({ rp_id: 'evil.example', base_url: h.url })).body).toMatchObject({
      error: 'bad_request',
      reason: 'rp_not_accepted'
    })
    expect((await open({ rp_id: 'confirm.hermie.dev', base_url: 'https://other.example.invalid' })).body.reason).toBe(
      'base_url_not_accepted'
    )
    expect((await open({ rp_id: 'confirm.hermie.dev', base_url: `${h.url}/` })).body.reason).toBe(
      'base_url_not_accepted'
    )
    expect((await open({ rp_id: 'confirm.hermie.dev', base_url: h.url, name: 'a\nb' })).status).toBe(400)
    expect((await open({ rp_id: 'confirm.hermie.dev', base_url: h.url, name: '' })).status).toBe(400)
  })

  it('verifies the attestation, and lets a registration expire', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const auth = SoftAuthenticator.native()
    const opened = await begin(h, alice, auth)
    const code = await operatorCode(h, ALICE)

    const tampered = finishBody(h, auth, opened.body, code)

    tampered.credential.client_data_json = b64u(Buffer.from('{"type":"webauthn.create","challenge":"AA","origin":"x"}'))

    const refused = await send(h, alice, '/register/finish', tampered)

    expect([refused.status, refused.body.error, refused.body.reason]).toEqual([
      422,
      'attestation_invalid',
      'bad_client_data'
    ])

    const body = finishBody(h, auth, opened.body, code)

    await post(`${h.url}/__fake/passkey/expire`, { pending: true })

    const expired = await send(h, alice, '/register/finish', body)

    expect([expired.status, expired.body.error]).toEqual([410, 'expired'])
    expect((await send(h, alice, '/register/finish', { ...body, registration_id: 'nope' })).status).toBe(410)
  })

  it('refuses the same passkey twice (409), and counts that like a wrong code', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const auth = SoftAuthenticator.native()

    await enrol(h, alice, auth)

    const twin = auth.clone()
    const opened = await begin(h, alice, twin)
    const refused = await send(
      h,
      alice,
      '/register/finish',
      finishBody(h, twin, opened.body, await operatorCode(h, ALICE))
    )

    expect([refused.status, refused.body.error]).toEqual([409, 'credential_exists'])
  })

  it('lets a browser enrol for its own host with a cookie, when the base URL is https and listed', async () => {
    const base = 'https://gw.example.invalid'
    const h = await startPasskeyGateway({ passkey: { baseUrls: [base], allowPrivateBaseUrls: false } })
    const alice = await cookieCaller(h, ALICE, base)
    const browser = SoftAuthenticator.web(base)
    const opened = await send(h, alice, '/register/begin', { rp_id: browser.rpId, base_url: base, name: 'Laptop' })

    expect(opened.status).toBe(200)

    const code = await operatorCode(h, ALICE)
    const finished = await send(h, alice, '/register/finish', finishBody(h, browser, opened.body, code))

    expect(finished.body.credential).toMatchObject({ rp_id: 'gw.example.invalid', backup_eligible: false })
    expect((await get(h, alice)).body.rp).toEqual({ native: ['confirm.hermie.dev'], web: ['gw.example.invalid'] })
  })

  it('enrols over a bearer too, which sends no Origin', async () => {
    const h = await startPasskeyGateway({ auth: 'native' })
    const caller = await bearerCaller(h)
    const credential = await enrol(h, caller, SoftAuthenticator.native())

    expect(credential.rp_id).toBe('confirm.hermie.dev')
  })
})

describe('step-ups, invites and revocation', () => {
  it('needs a valid invite step-up to mint a code, once, and the code is bound to the caller', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const bob = await cookieCaller(h, BOB)
    const phone = SoftAuthenticator.native()
    const phoneCredential = await enrol(h, alice, phone)

    // No step-up at all, or one that is not open.
    const unopened = { stepup_id: 'made-up', nonce: b64u(Buffer.alloc(32)), subject: 'invite', purpose: 'invite' }
    const bogus = await send(h, alice, '/invites', {
      stepup_id: 'made-up',
      assertion: await signStepup(h, alice, phone, unopened)
    })

    expect([bogus.status, bogus.body.error]).toEqual([403, 'stepup_invalid'])

    // Signed by a key that is not enrolled: refused, and the step-up is spent.
    const first = await stepup(h, alice, 'invite')

    expect(first.credentials).toEqual([{ rp_id: 'confirm.hermie.dev', ids: [phoneCredential.id] }])

    const stranger = SoftAuthenticator.native()
    const strange = await send(h, alice, '/invites', {
      stepup_id: first.stepup_id,
      assertion: await signStepup(h, alice, stranger, first)
    })

    expect([strange.status, strange.body.error, strange.body.reason]).toEqual([
      422,
      'assertion_invalid',
      'unknown_credential'
    ])
    expect(
      (
        await send(h, alice, '/invites', {
          stepup_id: first.stepup_id,
          assertion: await signStepup(h, alice, phone, first)
        })
      ).body.error
    ).toBe('stepup_invalid')

    // Other text than "invite" is refused.
    const second = await stepup(h, alice, 'invite')
    const other = await send(h, alice, '/invites', {
      stepup_id: second.stepup_id,
      assertion: await signStepup(h, alice, phone, second, { subject: 'something else' })
    })

    expect(other.body.reason).toBe('challenge_mismatch')

    // A valid one mints a code that enrols a browser passkey for Alice and for nobody else.
    const third = await stepup(h, alice, 'invite')
    const minted = await send(h, alice, '/invites', {
      stepup_id: third.stepup_id,
      assertion: await signStepup(h, alice, phone, third)
    })

    expect(minted.status, JSON.stringify(minted.body)).toBe(200)
    expect(minted.body.code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/u)
    expect(minted.body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 880)

    // Single use: replaying the step-up is refused.
    expect(
      (
        await send(h, alice, '/invites', {
          stepup_id: third.stepup_id,
          assertion: await signStepup(h, alice, phone, third)
        })
      ).status
    ).toBe(403)

    // Bob cannot redeem Alice's code.
    const bobPhone = SoftAuthenticator.native()
    const bobOpened = await begin(h, bob, bobPhone)
    const bobTry = await send(h, bob, '/register/finish', finishBody(h, bobPhone, bobOpened.body, minted.body.code))

    expect(bobTry.body.error).toBe('code_invalid')

    const added = await enrol(h, alice, SoftAuthenticator.native(), minted.body.code)

    expect(added.created_via).toBe('passkey')
  })

  it('can have invites switched off by the operator', async () => {
    const h = await startPasskeyGateway({ passkey: { userInvites: false } })
    const alice = await cookieCaller(h, ALICE)

    await enrol(h, alice, SoftAuthenticator.native())

    expect((await get(h, alice)).body.user_invites).toBe(false)

    const refused = await send(h, alice, '/stepup/begin', { purpose: 'invite' })

    expect([refused.status, refused.body.error]).toEqual([403, 'invites_disabled'])
    expect((await send(h, alice, '/invites', {})).body.error).toBe('invites_disabled')
  })

  it('does not let a step-up for one purpose or subject do another', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const phone = SoftAuthenticator.native()
    const laptop = SoftAuthenticator.native()
    const phoneId = (await enrol(h, alice, phone)).id
    const laptopId = (await enrol(h, alice, laptop)).id

    // An invite step-up cannot revoke, signed as an invite or as if it were a revoke.
    const invite = await stepup(h, alice, 'invite')

    expect(
      (
        await send(h, alice, '/revoke', {
          credential_id: phoneId,
          stepup_id: invite.stepup_id,
          assertion: await signStepup(h, alice, phone, invite)
        })
      ).body.error
    ).toBe('stepup_invalid')
    expect(
      (
        await send(h, alice, '/revoke', {
          credential_id: phoneId,
          stepup_id: invite.stepup_id,
          assertion: await signStepup(h, alice, phone, invite, { purpose: 'revoke', subject: phoneId })
        })
      ).status
    ).toBe(403)

    // A revoke step-up for the laptop cannot revoke the phone.
    const forLaptop = await stepup(h, alice, 'revoke', laptopId)

    expect(
      (
        await send(h, alice, '/revoke', {
          credential_id: phoneId,
          stepup_id: forLaptop.stepup_id,
          assertion: await signStepup(h, alice, phone, forLaptop)
        })
      ).body.error
    ).toBe('stepup_invalid')

    // And a revoke step-up is no invite.
    const forPhone = await stepup(h, alice, 'revoke', phoneId)

    expect(
      (
        await send(h, alice, '/invites', {
          stepup_id: forPhone.stepup_id,
          assertion: await signStepup(h, alice, phone, forPhone)
        })
      ).body.error
    ).toBe('stepup_invalid')
    expect(new Set((await get(h, alice)).body.credentials.map((c: Json) => c.id))).toEqual(new Set([phoneId, laptopId]))
  })

  it('revokes the last credential, announces it, and leaves nothing to step up with', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const listening = await connect(h, alice.headers)
    const bob = await connect(h, (await cookieCaller(h, BOB)).headers)
    const phone = SoftAuthenticator.native()
    const phoneId = (await enrol(h, alice, phone)).id
    const opened = await stepup(h, alice, 'revoke', phoneId)

    expect(opened.subject).toBe(phoneId)

    const revoked = await send(h, alice, '/revoke', {
      credential_id: phoneId,
      stepup_id: opened.stepup_id,
      base_url: h.url,
      assertion: await signStepup(h, alice, phone, opened)
    })

    expect([revoked.status, revoked.body]).toEqual([200, { ok: true }])
    expect((await get(h, alice)).body.credentials).toEqual([])
    await listening.next(frame => frame.params?.payload?.change === 'revoked', 'the revocation')
    expect(listening.events('passkey.changed').map(frame => frame.params?.payload.change)).toEqual(['added', 'revoked'])
    expect(bob.events('passkey.changed')).toEqual([])
    expect((await send(h, alice, '/stepup/begin', { purpose: 'invite' })).body.reason).toBe('not_enrolled')
    expect(h.gateway.passkey()?.store.credentials(ALICE.key, true)[0]?.revokedBy).toBe(ALICE.key)
  })

  it('never lets one user see, add to or revoke another one’s credentials', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const bob = await cookieCaller(h, BOB)
    const alicePhone = SoftAuthenticator.native()
    const bobPhone = SoftAuthenticator.native()
    const aliceId = (await enrol(h, alice, alicePhone)).id

    expect((await get(h, bob)).body.credentials).toEqual([])
    expect((await send(h, bob, '/stepup/begin', { purpose: 'revoke', subject: aliceId })).body.reason).toBe(
      'not_enrolled'
    )

    const bobId = (await enrol(h, bob, bobPhone)).id

    expect((await get(h, bob)).body.credentials.map((c: Json) => c.id)).toEqual([bobId])
    expect((await get(h, alice)).body.credentials.map((c: Json) => c.id)).toEqual([aliceId])

    // Bob cannot open a revoke step-up for Alice's credential: the same answer as an unknown id.
    const refused = await send(h, bob, '/stepup/begin', { purpose: 'revoke', subject: aliceId })

    expect([refused.status, refused.body.reason]).toEqual([400, 'unknown_credential'])
    expect(
      (await send(h, bob, '/stepup/begin', { purpose: 'revoke', subject: b64u(Buffer.alloc(32, 7)) })).body
    ).toEqual(refused.body)

    // Bob cannot take Alice's step-up, nor Alice's registration.
    const alices = await stepup(h, alice, 'revoke', aliceId)
    const taken = await send(h, bob, '/revoke', {
      credential_id: aliceId,
      stepup_id: alices.stepup_id,
      assertion: await signStepup(h, alice, alicePhone, alices)
    })

    expect([taken.status, taken.body.error]).toEqual([403, 'stepup_invalid'])

    const alicesRegistration = await begin(h, alice, SoftAuthenticator.native())
    const stolen = await send(
      h,
      bob,
      '/register/finish',
      finishBody(h, SoftAuthenticator.native(), alicesRegistration.body, await operatorCode(h))
    )

    expect([stolen.status, stolen.body.error]).toEqual([410, 'expired'])

    // Alice's authenticator signing Bob's step-up is not one of Bob's credentials.
    const bobs = await stepup(h, bob, 'revoke', bobId)
    const wrongKey = await send(h, bob, '/revoke', {
      credential_id: bobId,
      stepup_id: bobs.stepup_id,
      assertion: await signStepup(h, bob, alicePhone, bobs)
    })

    expect(wrongKey.body.reason).toBe('unknown_credential')
    expect((await get(h, alice)).body.credentials.map((c: Json) => c.id)).toEqual([aliceId])
    expect((await get(h, bob)).body.credentials.map((c: Json) => c.id)).toEqual([bobId])
  })
})

describe('what guards a write', () => {
  it('needs an Origin on the level’s own list for a cookie write, and nothing for a read or a bearer', async () => {
    const h = await startPasskeyGateway()
    const body = { rp_id: 'confirm.hermie.dev', base_url: h.url, name: 'Phone' }

    for (const origin of [null, 'https://evil.example', 'http://127.0.0.1:1', 'null']) {
      const caller = await cookieCaller(h, ALICE, origin)
      const refused = await send(h, caller, '/register/begin', body)

      expect([refused.status, refused.body.error], String(origin)).toEqual([403, 'origin_not_listed'])
    }

    expect((await send(h, await cookieCaller(h, ALICE), '/register/begin', body)).status).toBe(200)
    expect((await get(h, await cookieCaller(h, ALICE, null))).status).toBe(200)

    const native = await startPasskeyGateway({ auth: 'native' })

    expect(
      (await send(native, await bearerCaller(native), '/register/begin', { ...body, base_url: native.url })).status
    ).toBe(200)
    expect(
      h.gateway
        .passkey()
        ?.refusals()
        .some(note => note.reason === 'origin_not_listed')
    ).toBe(true)
  })

  it('takes the Origin from the level’s own list, not from anything else', async () => {
    const h = await startPasskeyGateway({
      passkey: { baseUrls: ['https://other.example.invalid'], allowPrivateBaseUrls: false }
    })
    const body = { rp_id: 'confirm.hermie.dev', base_url: 'https://other.example.invalid', name: 'Phone' }

    expect((await send(h, await cookieCaller(h, ALICE, h.url), '/register/begin', body)).status).toBe(403)
    expect(
      (await send(h, await cookieCaller(h, ALICE, 'https://other.example.invalid'), '/register/begin', body)).status
    ).toBe(200)
  })

  it('caps a body at 16 KiB and wants a JSON object', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const big = await send(h, alice, '/register/begin', {
      rp_id: 'confirm.hermie.dev',
      base_url: h.url,
      name: 'x',
      pad: 'a'.repeat(16 * 1024)
    })

    expect([big.status, big.body.error]).toEqual([413, 'body_too_large'])

    for (const content of ['[1, 2]', '{not json']) {
      const response = await fetch(`${h.url}${PREFIX}/register/begin`, {
        method: 'POST',
        headers: { ...alice.headers, 'content-type': 'application/json' },
        body: content
      })

      expect(response.status, content).toBe(400)
      expect(((await response.json()) as Json).error).toBe('bad_request')
    }
  })
})

describe('rate limits', () => {
  it('limits register/begin per user, with a Retry-After', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const body = { rp_id: 'confirm.hermie.dev', base_url: h.url, name: 'Phone' }

    for (let i = 0; i < 5; i += 1) {
      expect((await send(h, alice, '/register/begin', body)).status).toBe(200)
    }

    const refused = await send(h, alice, '/register/begin', body)

    expect([refused.status, refused.body.error, refused.headers.get('retry-after')]).toEqual([
      429,
      'rate_limited',
      '600'
    ])
  })

  it('limits wrong enrolment codes per user, and then refuses even a right one for a while', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)
    const auth = SoftAuthenticator.native()
    const opened = await begin(h, alice, auth)

    for (let i = 0; i < 5; i += 1) {
      expect((await send(h, alice, '/register/finish', finishBody(h, auth, opened.body, 'wrong'))).status).toBe(403)
    }

    const refused = await send(
      h,
      alice,
      '/register/finish',
      finishBody(h, auth, opened.body, await operatorCode(h, ALICE))
    )

    expect([refused.status, refused.body.error, refused.headers.get('retry-after')]).toEqual([
      429,
      'rate_limited',
      '600'
    ])
  })

  it('limits step-ups per user', async () => {
    const h = await startPasskeyGateway()
    const alice = await cookieCaller(h, ALICE)

    await enrol(h, alice, SoftAuthenticator.native())

    for (let i = 0; i < 10; i += 1) {
      expect((await send(h, alice, '/stepup/begin', { purpose: 'invite' })).status).toBe(200)
    }

    const refused = await send(h, alice, '/stepup/begin', { purpose: 'invite' })

    expect([refused.status, refused.body.error]).toEqual([429, 'rate_limited'])
  })
})
