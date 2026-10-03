/**
 * `confirm` at level `passkey` (and `plain` beside it) through the running fake, the way the real
 * gateway gates it (`tests/tui_gateway/test_confirm_passkey.py`): the two-call capability handshake, who
 * gets the frame and who may answer it, the refusals (4033, 4034 with a reason), five refusals settling
 * the request, `verified` set only after a commit, the per-level method sets, the limits and the
 * no-downgrade window.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { b64u, b64uDecode } from './encoding'
import {
  ALICE,
  BOB,
  closeAll,
  connect,
  cookieFor,
  post,
  startPasskeyGateway,
  stateOf,
  until,
  type Account,
  type Connection,
  type Frame,
  type Harness,
  type Json
} from './harness'
import { type ConfirmFrameParams, DECLINE, SoftAuthenticator, type Tampering } from '../testing/soft-authenticator'

afterEach(closeAll)

const PREFIX = '/api/auth/passkeys'
const TEXT = {
  title: 'Pay invoice',
  summary: 'Pay 120.00 EUR to Example Plumbing B.V. for invoice 2026-114.',
  detail: 'IBAN NL00 TEST 0123 4567 89\nReference 2026-114'
}

interface Person {
  who: Account
  headers: Record<string, string>
  handle: string
}

const signIn = async (h: Harness, who: Account, origin: string = h.url): Promise<Person> => {
  const headers = { cookie: await cookieFor(h, who), origin }
  const status = (await (await fetch(`${h.url}${PREFIX}`, { headers })).json()) as Json

  return { who, headers, handle: status.user.handle }
}

const enrol = async (h: Harness, person: Person, auth: SoftAuthenticator, base = h.url): Promise<void> => {
  const opened = (await (
    await post(`${h.url}${PREFIX}/register/begin`, { rp_id: auth.rpId, base_url: base, name: 'Phone' }, person.headers)
  ).json()) as Json
  const code = ((await (await post(`${h.url}/__fake/passkey/code`, { user: person.who.key })).json()) as Json).code
  const body = auth.register(
    {
      registrationId: opened.registration_id,
      baseUrl: base,
      gatewayId: b64uDecode(opened.gateway_id),
      userId: opened.user.id,
      name: opened.user.name,
      nonce: b64uDecode(opened.nonce)
    },
    code
  )
  const finished = await post(`${h.url}${PREFIX}/register/finish`, body, person.headers)

  expect(finished.status).toBe(200)
}

/** The two `client.capabilities` calls of the contract, for a client running `auth`'s ceremony. */
const advertise = async (
  conn: Connection,
  options: { kind?: 'native' | 'web'; rpId?: string; levels?: string[]; v?: number } = {}
): Promise<{ first: Json; second: Json }> => {
  const first = (await conn.call('client.capabilities', { server_requests: true })).result as Json
  const second = (
    await conn.call('client.capabilities', {
      server_requests: true,
      confirm: options.levels ?? ['plain', 'passkey'],
      confirm_passkey: {
        v: options.v ?? 1,
        kind: options.kind ?? 'native',
        rp_id: options.rpId ?? 'confirm.hermie.dev'
      }
    })
  ).result as Json

  return { first, second }
}

const raise = (h: Harness, body: Json = {}): Promise<Response> =>
  post(`${h.url}/__fake/request`, {
    profile: 'researcher',
    method: 'confirm',
    ...body,
    params: { level: 'passkey', ...TEXT, ...(body.params ?? {}) }
  })

const confirmFrame = async (conn: Connection, index = 0): Promise<{ id: string; params: ConfirmFrameParams }> => {
  const frame = await conn.next(f => f.method === 'confirm' && conn.confirms().indexOf(f) >= index, 'the confirm frame')

  return { id: String(frame.id), params: frame.params as unknown as ConfirmFrameParams }
}

const answerWith = (
  frame: { id: string; params: ConfirmFrameParams },
  auth: SoftAuthenticator,
  person: Person,
  h: Harness,
  tamper: Tampering = {},
  base = h.url
) => auth.answer(frame, { baseUrl: base, userHandle: person.handle }, tamper)

const submit = async (conn: Connection, id: string, result: unknown): Promise<Frame> =>
  conn.call('request.answer', { id, result: result as Record<string, unknown> })

const outcomes = async (h: Harness): Promise<Json[]> => (await stateOf(h)).passkey.outcomes

interface Scene {
  h: Harness
  alice: Person
  phone: SoftAuthenticator
  app: Connection
}

/** Alice enrolled with a native passkey, and an app of hers that advertised `passkey`. */
const scene = async (options: { harness?: Harness } = {}): Promise<Scene> => {
  const h = options.harness ?? (await startPasskeyGateway())
  const alice = await signIn(h, ALICE)
  const phone = SoftAuthenticator.native()

  await enrol(h, alice, phone)

  const app = await connect(h, alice.headers)

  await advertise(app)

  return { h, alice, phone, app }
}

describe('the capability handshake', () => {
  it('tells a signed-in connection how the level looks from there, in the first result', async () => {
    const h = await startPasskeyGateway()
    const app = await connect(h, (await signIn(h, ALICE)).headers)
    const { first } = await advertise(app)

    expect(first.server_requests).toContain('confirm')
    expect(first.confirm).toEqual([])
    expect(first.confirm_passkey).toEqual({
      v: 1,
      enabled: true,
      reason: '',
      gateway_id: expect.any(String),
      rp: { native: ['confirm.hermie.dev'], web: [] }
    })
    expect(b64uDecode(first.confirm_passkey.gateway_id)).toHaveLength(16)
  })

  it('accepts `passkey` from a signed-in connection with an RP it accepts, and echoes the levels sorted', async () => {
    const h = await startPasskeyGateway()
    const app = await connect(h, (await signIn(h, ALICE)).headers)
    const { second } = await advertise(app)

    expect(second.confirm).toEqual(['passkey', 'plain'])
    expect((await stateOf(h)).clientCapabilities.at(-1)).toEqual({
      server_requests: true,
      confirm: ['plain', 'passkey'],
      confirm_passkey: { v: 1, kind: 'native', rp_id: 'confirm.hermie.dev' }
    })
  })

  it('drops `passkey` for an RP, a kind, a version or a level it does not accept, and keeps `plain`', async () => {
    const h = await startPasskeyGateway()
    const app = await connect(h, (await signIn(h, ALICE)).headers)

    for (const options of [{ rpId: 'evil.example' }, { kind: 'web' as const }, { v: 2 }]) {
      expect((await advertise(app, options)).second.confirm, JSON.stringify(options)).toEqual(['plain'])
    }

    expect((await advertise(app, { levels: ['plain', 'device_auth', 7 as unknown as string] })).second.confirm).toEqual(
      ['plain']
    )
    // `passkey` listed without the object that says how: never accepted.
    const bare = await app.call('client.capabilities', { server_requests: true, confirm: ['passkey'] })

    expect(bare.result?.confirm).toEqual([])
  })

  it('counts levels only together with `server_requests`', async () => {
    const h = await startPasskeyGateway()
    const app = await connect(h, (await signIn(h, ALICE)).headers)
    const answer = await app.call('client.capabilities', {
      confirm: ['plain', 'passkey'],
      confirm_passkey: { v: 1, kind: 'native', rp_id: 'confirm.hermie.dev' }
    })

    expect(answer.result?.confirm).toEqual([])
  })

  it('names nobody on a connection with no signed-in user: `no_identity`, and `passkey` is never accepted', async () => {
    const h = await startPasskeyGateway({ auth: 'token', token: 'secret' })
    const app = await connect(h, null, '?token=secret')
    const { first, second } = await advertise(app)

    expect(first.confirm_passkey).toMatchObject({ enabled: false, reason: 'no_identity' })
    expect(second.confirm).toEqual(['plain'])
  })

  it.each([
    ['disabled', { enabled: false }, 'disabled'],
    ['no base URL', { base_urls: [] }, 'no_base_url'],
    ['only private base URLs', { base_urls: ['http://192.168.1.10:9119'], allow_private: false }, 'private_origin']
  ])('follows the operator’s settings: %s', async (_name, settings, reason) => {
    const h = await startPasskeyGateway()
    const app = await connect(h, (await signIn(h, ALICE)).headers)

    await post(`${h.url}/__fake/passkey/enable`, settings)

    const { first, second } = await advertise(app)

    expect(first.confirm_passkey).toMatchObject({ v: 1, enabled: false, reason })
    expect(second.confirm).toEqual(['plain'])
  })

  it('leaves a gateway that does not know the level exactly as it was', async () => {
    const h = await startPasskeyGateway({ passkey: false })
    const app = await connect(h, { cookie: await cookieFor(h, ALICE) })
    const first = await app.call('client.capabilities', { server_requests: true })

    expect(first.result).not.toHaveProperty('confirm_passkey')
    expect(first.result).not.toHaveProperty('confirm')
    expect(first.result?.server_requests).not.toContain('confirm')
  })
})

describe('a passkey confirmation', () => {
  it('confirms verified after the commit, and nothing before: ok means received and valid', async () => {
    const { h, alice, phone, app } = await scene()
    const other = await connect(h, alice.headers)

    await advertise(other)

    const raised = await raise(h)

    expect(raised.status).toBe(200)
    expect(await raised.json()).toMatchObject({ raised: 'confirm', level: 'passkey' })

    const frame = await confirmFrame(app)

    expect(frame.params).toMatchObject({
      ...TEXT,
      level: 'passkey',
      passkey: {
        v: 1,
        base_url: h.url,
        user: { id: ALICE.key, name: ALICE.displayName },
        credentials: [{ rp_id: 'confirm.hermie.dev', ids: [phone.id] }]
      }
    })
    expect(b64uDecode(frame.params.passkey.nonce)).toHaveLength(32)
    expect(frame.params.passkey.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 100)
    expect((await stateOf(h)).passkey.open).toHaveLength(1)

    const answered = await submit(app, frame.id, answerWith(frame, phone, alice, h))

    expect(answered.result).toEqual({ status: 'ok' })
    await until('the outcome', async () => (await outcomes(h)).length === 1)

    const state = (await stateOf(h)).passkey

    expect(state.outcomes).toEqual([
      {
        request_id: frame.id,
        level: 'passkey',
        user_id: ALICE.key,
        credential_id: phone.id,
        outcome: 'confirmed',
        method: 'passkey',
        verified: true,
        reason: ''
      }
    ])
    expect(state.open).toEqual([])
    expect(state.receipts).toHaveLength(1)
    expect(state.receipts[0]).toMatchObject({
      purpose: 'confirm',
      user_id: ALICE.key,
      credential_id: phone.id,
      rp_id: 'confirm.hermie.dev',
      base_url: h.url,
      request_id: frame.id,
      session_id: frame.params.session_id
    })
    expect(JSON.stringify(state)).not.toContain(TEXT.summary)
    expect((await stateOf(h)).serverRequestAnswers.at(-1)).toMatchObject({ id: frame.id, method: 'confirm' })

    // The other client of Alice's is told it was settled, and the answer is not replayable.
    await other.next(f => f.method === 'event' && f.params?.payload?.reason === 'resolved', 'the cancel')
    expect(other.cancels()).toEqual([{ id: frame.id, method: 'confirm', reason: 'resolved' }])
    expect((await submit(app, frame.id, answerWith(frame, phone, alice, h))).result).toEqual({ status: 'expired' })
  })

  it('accepts the answer on a bare response frame too, and a refusal of one gets no reply', async () => {
    const { h, alice, phone, app } = await scene()

    await raise(h)

    const frame = await confirmFrame(app)

    app.socket.send(
      `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: answerWith(frame, phone, alice, h, { flags: 0 }) })}\n`
    )
    await until('the refusal to be counted', async () => (await stateOf(h)).passkey.refusals.length === 1)
    expect((await stateOf(h)).passkey.open[0].refusals).toBe(1)

    app.socket.send(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: answerWith(frame, phone, alice, h) })}\n`)
    await until('the confirmation', async () => (await outcomes(h)).length === 1)
    expect((await outcomes(h))[0]).toMatchObject({ outcome: 'confirmed', verified: true })
  })

  it('confirms from a browser: a web RP, a device-bound credential whose counter must rise', async () => {
    const base = 'https://gw.example.invalid'
    const h = await startPasskeyGateway({ passkey: { baseUrls: [base], allowPrivateBaseUrls: false } })
    const alice = await signIn(h, ALICE, base)
    const browser = SoftAuthenticator.web(base)

    await enrol(h, alice, browser, base)

    const page = await connect(h, alice.headers)

    await advertise(page, { kind: 'web', rpId: 'gw.example.invalid' })

    for (let n = 1; n <= 2; n += 1) {
      expect((await raise(h)).status).toBe(200)

      const frame = await confirmFrame(page, n - 1)

      expect((await submit(page, frame.id, answerWith(frame, browser, alice, h, {}, base))).result).toEqual({
        status: 'ok'
      })
      await until('the outcome', async () => (await outcomes(h)).length === n)
      expect((await outcomes(h))[n - 1]).toMatchObject({ outcome: 'confirmed', verified: true })
    }

    expect(h.gateway.passkey()?.store.credentials(ALICE.key)[0]?.signCount).toBe(2)

    // A counter that does not rise is refused for a device-bound credential.
    await raise(h)

    const stale = await confirmFrame(page, 2)
    const refused = await submit(page, stale.id, answerWith(stale, browser, alice, h, { signCount: 2 }, base))

    expect(refused.error).toEqual({ code: 4034, message: 'answer refused', data: { reason: 'counter_regression' } })
  })

  it('accepts a synced credential whose counter went down, and writes the lower one', async () => {
    const h = await startPasskeyGateway()
    const alice = await signIn(h, ALICE)
    const phone = SoftAuthenticator.native({ signCount: 10 })

    await enrol(h, alice, phone)

    const app = await connect(h, alice.headers)

    await advertise(app)
    await raise(h)

    const frame = await confirmFrame(app)

    expect((await submit(app, frame.id, answerWith(frame, phone, alice, h, { signCount: 3 }))).result).toEqual({
      status: 'ok'
    })
    await until('the outcome', async () => (await outcomes(h)).length === 1)
    expect((await outcomes(h))[0]).toMatchObject({ outcome: 'confirmed', verified: true })
    expect(h.gateway.passkey()?.store.credentials(ALICE.key)[0]?.signCount).toBe(3)
  })

  it('takes a decline with no assertion, as `declined` and not verified', async () => {
    const { h, app } = await scene()

    await raise(h)

    const frame = await confirmFrame(app)

    expect((await submit(app, frame.id, DECLINE)).result).toEqual({ status: 'ok' })
    await until('the outcome', async () => (await outcomes(h)).length === 1)
    expect((await outcomes(h))[0]).toMatchObject({
      outcome: 'declined',
      method: 'tap',
      verified: false,
      credential_id: null
    })
    expect((await stateOf(h)).passkey.receipts).toEqual([])
    // Anything but the exact decline is not one.
    await post(`${h.url}/__fake/passkey/expire`, { window: true })
    await raise(h)

    const second = await confirmFrame(app, 1)
    const refused = await submit(app, second.id, { ...DECLINE, verified: false })

    expect(refused.error).toMatchObject({ code: 4034, data: { reason: 'bad_shape' } })
  })

  it('is `unavailable` when a client answers an error, and the credential is not asked again', async () => {
    const { h, app } = await scene()

    await raise(h)

    const frame = await confirmFrame(app)

    app.socket.send(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: 4040, message: 'passkey ceremony unavailable', data: { reason: 'no_credential' } }
      })}\n`
    )
    await until('the outcome', async () => (await outcomes(h)).length === 1)
    expect((await outcomes(h))[0]).toMatchObject({ outcome: 'unavailable', reason: 'error_response', verified: false })
    expect((await stateOf(h)).serverRequestAnswers.at(-1)).toMatchObject({ id: frame.id, error: { code: 4040 } })
  })
})

describe('refused answers', () => {
  const refusals: [string, string, (frame: { id: string; params: ConfirmFrameParams }, s: Scene) => Json][] = [
    [
      'the text shown is not the text sent',
      'challenge_mismatch',
      (frame, s) =>
        answerWith({ ...frame, params: { ...frame.params, title: 'Something else' } }, s.phone, s.alice, s.h)
    ],
    [
      'another request',
      'challenge_mismatch',
      (frame, s) => answerWith({ ...frame, id: `${frame.id}-other` }, s.phone, s.alice, s.h)
    ],
    [
      'another session',
      'challenge_mismatch',
      (frame, s) =>
        answerWith({ ...frame, params: { ...frame.params, session_id: 'sid-other' } }, s.phone, s.alice, s.h)
    ],
    [
      'another nonce',
      'challenge_mismatch',
      (frame, s) =>
        answerWith(
          { ...frame, params: { ...frame.params, passkey: { ...frame.params.passkey, nonce: 'A'.repeat(43) } } },
          s.phone,
          s.alice,
          s.h
        )
    ],
    [
      'another gateway id',
      'challenge_mismatch',
      (frame, s) =>
        answerWith(
          { ...frame, params: { ...frame.params, passkey: { ...frame.params.passkey, gateway_id: 'B'.repeat(22) } } },
          s.phone,
          s.alice,
          s.h
        )
    ],
    [
      'a base URL this gateway does not list',
      'base_url_not_accepted',
      (frame, s) => answerWith(frame, s.phone, s.alice, s.h, { claimBaseUrl: 'https://other.example.invalid' })
    ],
    [
      'a client origin not allowed for the RP',
      'bad_client_data',
      (frame, s) => answerWith(frame, s.phone, s.alice, s.h, { clientOrigin: 'https://evil.example' })
    ],
    [
      'an assertion type',
      'bad_client_data',
      (frame, s) => answerWith(frame, s.phone, s.alice, s.h, { clientType: 'webauthn.create' })
    ],
    [
      'the hash of another RP',
      'bad_authenticator_data',
      (frame, s) => answerWith(frame, s.phone, s.alice, s.h, { rpIdHashOf: 'other.example' })
    ],
    [
      'no user verification',
      'uv_required',
      (frame, s) => answerWith(frame, s.phone, s.alice, s.h, { flags: 0x01 | 0x08 | 0x10 })
    ],
    [
      'no user presence',
      'uv_required',
      (frame, s) => answerWith(frame, s.phone, s.alice, s.h, { flags: 0x04 | 0x08 | 0x10 })
    ],
    [
      'a changed backup eligibility',
      'backup_state_mismatch',
      (frame, s) => answerWith(frame, s.phone, s.alice, s.h, { flags: 0x01 | 0x04 })
    ],
    [
      'a signature by another key',
      'signature_invalid',
      (frame, s) => answerWith(frame, s.phone, s.alice, s.h, { signWith: SoftAuthenticator.native() })
    ],
    [
      'a key that is not enrolled',
      'unknown_credential',
      (frame, s) => answerWith(frame, SoftAuthenticator.native(), s.alice, s.h)
    ],
    [
      'the user handle of someone else',
      'unknown_credential',
      (frame, s) => answerWith(frame, s.phone, { ...s.alice, handle: b64u(Buffer.alloc(32, 9)) }, s.h)
    ],
    ['an extra key', 'bad_shape', (frame, s) => ({ ...answerWith(frame, s.phone, s.alice, s.h), verified: true })],
    ['method tap with decision confirmed', 'bad_shape', () => ({ decision: 'confirmed', method: 'tap' })],
    [
      'a missing signature',
      'bad_shape',
      (frame, s) => {
        const answer = answerWith(frame, s.phone, s.alice, s.h) as unknown as { passkey: Json }

        delete answer.passkey.signature

        return answer as unknown as Json
      }
    ]
  ]

  it.each(refusals)(
    'refuses %s with 4034 and the reason %s, and leaves the request open',
    async (_name, reason, build) => {
      const s = await scene()

      await raise(s.h)

      const frame = await confirmFrame(s.app)
      const refused = await submit(s.app, frame.id, build(frame, s))

      expect(refused.error).toEqual({ code: 4034, message: 'answer refused', data: { reason } })
      expect((await stateOf(s.h)).passkey.open).toMatchObject([{ id: frame.id, refusals: 1 }])
      expect(await outcomes(s.h)).toEqual([])

      // Still open for the right answer.
      expect((await submit(s.app, frame.id, answerWith(frame, s.phone, s.alice, s.h))).result).toEqual({ status: 'ok' })
    }
  )

  it('lets four refusals through and still confirms on a valid answer', async () => {
    const s = await scene()

    await raise(s.h)

    const frame = await confirmFrame(s.app)

    for (let i = 0; i < 4; i += 1) {
      expect(
        (await submit(s.app, frame.id, answerWith(frame, s.phone, s.alice, s.h, { flags: 0 }))).error?.data?.reason
      ).toBe('uv_required')
    }

    expect((await submit(s.app, frame.id, answerWith(frame, s.phone, s.alice, s.h))).result).toEqual({ status: 'ok' })
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)
    expect((await outcomes(s.h))[0]).toMatchObject({ outcome: 'confirmed', verified: true })
  })

  it('settles the request on the fifth refusal: unavailable, withdrawn everywhere, the window open', async () => {
    const s = await scene()
    const second = await connect(s.h, s.alice.headers)

    await advertise(second)
    await raise(s.h)

    const frame = await confirmFrame(s.app)
    const reasons: unknown[] = []

    for (let i = 0; i < 5; i += 1) {
      reasons.push(
        (await submit(s.app, frame.id, answerWith(frame, s.phone, s.alice, s.h, { flags: 0 }))).error?.data?.reason
      )
    }

    expect(reasons).toEqual(['uv_required', 'uv_required', 'uv_required', 'uv_required', 'too_many_attempts'])
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)
    expect((await outcomes(s.h))[0]).toMatchObject({
      outcome: 'unavailable',
      reason: 'verification_failed',
      verified: false
    })
    expect(s.app.cancels()).toEqual([{ id: frame.id, method: 'confirm', reason: 'too_many_attempts' }])
    expect((await stateOf(s.h)).passkey.windows).toHaveLength(1)
    expect((await submit(s.app, frame.id, answerWith(frame, s.phone, s.alice, s.h))).result).toEqual({
      status: 'expired'
    })
  })

  it('counts only refusals from connections that may answer: 4033s, errors and declines do not count', async () => {
    const s = await scene()
    const bob = await signIn(s.h, BOB)
    const intruder = await connect(s.h, bob.headers)

    await advertise(intruder)
    await raise(s.h)

    const frame = await confirmFrame(s.app)

    for (let i = 0; i < 6; i += 1) {
      expect((await submit(intruder, frame.id, answerWith(frame, s.phone, s.alice, s.h))).error?.code).toBe(4033)
    }

    expect((await stateOf(s.h)).passkey.open).toMatchObject([{ id: frame.id, refusals: 0 }])
  })

  it('follows the five-refusal sequence vector of the contract', async () => {
    const vectors = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../../contract/confirm-passkey/vectors.json', import.meta.url)), 'utf8')
    ) as Json
    const sequence = vectors.sequence_vectors[0] as Json
    const s = await scene()

    await raise(s.h)

    const frame = await confirmFrame(s.app)
    const build: Record<string, () => Json> = {
      'challenge for other text': () =>
        answerWith({ ...frame, params: { ...frame.params, summary: 'Other text' } }, s.phone, s.alice, s.h),
      'challenge for another request': () => answerWith({ ...frame, id: `${frame.id}-other` }, s.phone, s.alice, s.h),
      'signature by another key': () =>
        answerWith(frame, s.phone, s.alice, s.h, { signWith: SoftAuthenticator.native() }),
      'rpIdHash of another RP': () => answerWith(frame, s.phone, s.alice, s.h, { rpIdHashOf: 'other.example' }),
      'user verification flag clear': () => answerWith(frame, s.phone, s.alice, s.h, { flags: 0x01 | 0x08 | 0x10 })
    }
    const seen: string[] = []

    for (const step of sequence.steps as string[]) {
      const answer = await submit(s.app, frame.id, (build[step] as () => Json)())

      seen.push(
        answer.error
          ? answer.error.data?.reason === sequence.settled_outcome.refusal_reason
            ? 'settled'
            : 'refused'
          : 'ok'
      )
    }

    expect(seen).toEqual(sequence.expect)
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)
    expect((await outcomes(s.h))[0]).toMatchObject({
      outcome: sequence.settled_outcome.outcome,
      reason: sequence.settled_outcome.reason
    })
  })
})

describe('who sees and answers it', () => {
  it('never sends it to a connection signed in as someone else, which gets 4033 and an empty resume', async () => {
    const s = await scene()
    const bob = await signIn(s.h, BOB)
    const stranger = await connect(s.h, bob.headers)
    const phoneOfBob = SoftAuthenticator.native()

    await enrol(s.h, bob, phoneOfBob)
    await advertise(stranger)
    await raise(s.h)

    const frame = await confirmFrame(s.app)

    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stranger.confirms()).toEqual([])

    const refused = await submit(stranger, frame.id, answerWith(frame, phoneOfBob, bob, s.h))

    expect(refused.error?.code).toBe(4033)
    expect(
      (await stranger.call('session.resume', { session_id: frame.params.session_id })).result?.open_requests
    ).toEqual([])
    expect(
      (await s.app.call('session.resume', { session_id: frame.params.session_id })).result?.open_requests
    ).toMatchObject([{ id: frame.id, method: 'confirm' }])
  })

  it('does not target a connection that offered only `plain`, nor one whose RP has no credential for the user', async () => {
    const h = await startPasskeyGateway({
      passkey: { baseUrls: ['https://gw.example.invalid'], allowPrivateBaseUrls: false }
    })
    const alice = await signIn(h, ALICE, 'https://gw.example.invalid')
    const phone = SoftAuthenticator.native()

    await enrol(h, alice, phone, 'https://gw.example.invalid')

    const plainOnly = await connect(h, alice.headers)
    const browser = await connect(h, alice.headers)
    const app = await connect(h, alice.headers)

    await advertise(plainOnly, { levels: ['plain'] })
    // A browser of Alice's whose RP has no credential of hers.
    await advertise(browser, { kind: 'web', rpId: 'gw.example.invalid' })
    await advertise(app)

    await raise(h)

    const frame = await confirmFrame(app)

    await new Promise(resolve => setTimeout(resolve, 30))
    expect(plainOnly.confirms()).toEqual([])
    expect(browser.confirms()).toEqual([])
    expect(
      (await submit(browser, frame.id, answerWith(frame, phone, alice, h, {}, 'https://gw.example.invalid'))).error
        ?.code
    ).toBe(4033)
  })

  it('gives a reconnecting client the request back, and lets it answer on its new socket', async () => {
    const s = await scene()

    await raise(s.h)

    const frame = await confirmFrame(s.app)

    s.app.socket.terminate()

    const again = await connect(s.h, s.alice.headers)

    // Before it advertises the level it cannot see the request or answer it.
    expect((await again.call('session.resume', { session_id: frame.params.session_id })).result?.open_requests).toEqual(
      []
    )
    expect((await submit(again, frame.id, answerWith(frame, s.phone, s.alice, s.h))).error?.code).toBe(4033)

    await advertise(again)

    const resumed = (await again.call('session.resume', { session_id: frame.params.session_id })).result as Json

    expect(resumed.open_requests).toMatchObject([{ id: frame.id, method: 'confirm', params: { level: 'passkey' } }])
    expect(resumed.open_requests[0].params.passkey.nonce).toBe(frame.params.passkey.nonce)
    expect((await submit(again, frame.id, answerWith(frame, s.phone, s.alice, s.h))).result).toEqual({ status: 'ok' })
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)
    expect((await outcomes(s.h))[0]).toMatchObject({ outcome: 'confirmed', verified: true })
  })

  it('commits two valid answers at once only once', async () => {
    const s = await scene()
    const second = await connect(s.h, s.alice.headers)

    await advertise(second)
    await raise(s.h)

    const frame = await confirmFrame(s.app)
    const [a, b] = await Promise.all([
      submit(s.app, frame.id, answerWith(frame, s.phone, s.alice, s.h)),
      submit(second, frame.id, answerWith(frame, s.phone, s.alice, s.h))
    ])

    expect([a.result?.status, b.result?.status].sort()).toEqual(['expired', 'ok'])
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)
    expect((await stateOf(s.h)).passkey.receipts).toHaveLength(1)
  })
})

describe('the commit', () => {
  it('refuses a credential revoked while the request was open: ok was only "valid", the outcome is not consent', async () => {
    const s = await scene()
    const second = await connect(s.h, s.alice.headers)

    await advertise(second)
    await raise(s.h)

    const frame = await confirmFrame(s.app)

    await post(`${s.h.url}/__fake/passkey/revoke`, { credential_id: s.phone.id })

    expect((await submit(s.app, frame.id, answerWith(frame, s.phone, s.alice, s.h))).result).toEqual({ status: 'ok' })
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)

    const state = (await stateOf(s.h)).passkey

    expect(state.outcomes[0]).toMatchObject({ outcome: 'unavailable', reason: 'verification_failed', verified: false })
    expect(state.receipts).toEqual([])
    // The clients that were told "resolved" are told it did not count.
    await second.next(f => f.params?.payload?.reason === 'verification_failed', 'the withdrawal')
    expect(second.cancels()).toEqual([
      { id: frame.id, method: 'confirm', reason: 'resolved' },
      { id: frame.id, method: 'confirm', reason: 'verification_failed' }
    ])
    expect(state.windows).toHaveLength(1)
  })

  it('refuses an answer replayed from an earlier request', async () => {
    const s = await scene()

    await raise(s.h)

    const first = await confirmFrame(s.app)
    const answer = answerWith(first, s.phone, s.alice, s.h)

    expect((await submit(s.app, first.id, answer)).result).toEqual({ status: 'ok' })
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)
    await post(`${s.h.url}/__fake/passkey/expire`, { window: true })
    await raise(s.h)

    const second = await confirmFrame(s.app, 1)

    expect((await submit(s.app, second.id, answer)).error?.data?.reason).toBe('challenge_mismatch')
  })
})

describe('unavailable before anything is sent', () => {
  const raiseAndRead = async (h: Harness, body: Json = {}): Promise<{ status: number; body: Json }> => {
    const response = await raise(h, body)

    return { status: response.status, body: (await response.json()) as Json }
  }

  it.each([
    ['the level is switched off', { enabled: false }, {}, 'disabled'],
    ['there is no base URL', { base_urls: [] }, {}, 'no_base_url'],
    [
      'every base URL is private',
      { base_urls: ['http://192.168.1.10:9119'], allow_private: false },
      {},
      'private_origin'
    ]
  ])('says %s', async (_name, settings, body, reason) => {
    const s = await scene()

    await post(`${s.h.url}/__fake/passkey/enable`, settings)

    const answer = await raiseAndRead(s.h, body)

    expect(answer.status).toBe(409)
    expect(answer.body).toMatchObject({ outcome: 'unavailable', reason })
    expect(s.app.confirms()).toEqual([])
    expect((await stateOf(s.h)).passkey.windows).toEqual([])
    expect((await outcomes(s.h)).at(-1)).toMatchObject({ outcome: 'unavailable', reason })
  })

  it('says `no_identity` on a gateway that names nobody', async () => {
    const h = await startPasskeyGateway({ auth: 'token', token: 'secret' })

    await connect(h, null, '?token=secret')

    expect((await raiseAndRead(h)).body.reason).toBe('no_identity')
  })

  it('says `no_acting_user` for a turn nobody signed in submitted, while people are signed in', async () => {
    const s = await scene()

    expect((await raiseAndRead(s.h, { user: null })).body.reason).toBe('no_acting_user')
    expect(s.app.confirms()).toEqual([])
  })

  it('says `not_enrolled` for a person with no passkey, and sends nothing', async () => {
    const s = await scene()
    const bob = await connect(s.h, (await signIn(s.h, BOB)).headers)

    await advertise(bob)

    expect((await raiseAndRead(s.h, { user: BOB.username })).body.reason).toBe('not_enrolled')
    expect(bob.confirms()).toEqual([])
    expect(s.app.confirms()).toEqual([])
  })

  it('says `turn_isolation` when the agent cannot see who advertised what', async () => {
    const s = await scene()

    expect((await raiseAndRead(s.h, { turn_isolation: true })).body.reason).toBe('turn_isolation')
  })

  it('says `no_capable_client` when nobody of the user advertised the level, which does open the window', async () => {
    const s = await scene()

    await advertise(s.app, { levels: ['plain'] })

    const answer = await raiseAndRead(s.h)

    expect(answer.status).toBe(409)
    expect(answer.body).toMatchObject({
      reason: 'no_capable_client',
      detail: 'No connected client offered the "passkey" confirm level in client.capabilities; nothing was sent'
    })
    expect((await stateOf(s.h)).passkey.windows).toHaveLength(1)
  })

  it('allows one open confirmation per conversation and six per ten minutes', async () => {
    const s = await scene()

    expect((await raiseAndRead(s.h)).status).toBe(200)
    expect((await raiseAndRead(s.h)).body.reason).toBe('already_pending')

    // Six is the budget: the seventh within the window is refused.
    for (let i = 0; i < 6; i += 1) {
      await post(`${s.h.url}/__fake/passkey/expire`, {})
      expect((await raiseAndRead(s.h)).status, `request ${i + 2}`).toBe(i < 5 ? 200 : 409)
    }

    expect((await raiseAndRead(s.h)).body.reason).toBe('rate_limited')
  })

  it('rejects text the contract cannot carry, with a 400 that says which field', async () => {
    const s = await scene()

    expect((await raiseAndRead(s.h, { params: { summary: '   ' } })).status).toBe(400)
    expect((await raiseAndRead(s.h, { params: { title: 'x'.repeat(81) } })).body.detail).toContain('title is 81')
    expect((await raiseAndRead(s.h, { params: { summary: 'x'.repeat(501) } })).status).toBe(400)
    expect((await raiseAndRead(s.h, { params: { detail: 'x'.repeat(2001) } })).status).toBe(400)
    expect((await raiseAndRead(s.h, { params: { level: 'device_auth' } })).status).toBe(400)
  })

  it('strips control and format characters from the text, so the digest is over what the person sees', async () => {
    const s = await scene()

    await raise(s.h, { params: { title: 'Pay‮ now', summary: 'Pay​ 10 EUR', detail: 'a\r\nb' } })

    const frame = await confirmFrame(s.app)

    expect(frame.params).toMatchObject({ title: 'Pay now', summary: 'Pay 10 EUR', detail: 'a\nb' })
    expect((await submit(s.app, frame.id, answerWith(frame, s.phone, s.alice, s.h))).result).toEqual({ status: 'ok' })
  })
})

describe('plain beside it', () => {
  it('takes `tap` only: an answer with `method: "passkey"` is refused, and a tap is never verified', async () => {
    const { h, app } = await scene()

    expect((await raise(h, { params: { level: 'plain' } })).status).toBe(200)

    const frame = await confirmFrame(app)

    expect(frame.params.passkey).toBeUndefined()

    const refused = await submit(app, frame.id, { decision: 'confirmed', method: 'passkey' })

    expect(refused.error?.code).toBe(4034)
    expect(refused.error?.message).toContain('bad_shape')
    expect(refused.error).not.toHaveProperty('data')
    expect((await submit(app, frame.id, { decision: 'maybe', method: 'tap' })).error?.code).toBe(4034)
    expect((await submit(app, frame.id, { decision: 'confirmed', method: 'tap', verified: true })).result).toEqual({
      status: 'ok'
    })
    await until('the outcome', async () => (await outcomes(h)).length === 1)
    expect((await outcomes(h))[0]).toMatchObject({
      level: 'plain',
      outcome: 'confirmed',
      method: 'tap',
      verified: false
    })
  })

  it('reaches any connection that offered it, and is answered with a 4033 by one that did not', async () => {
    const { h, alice, app } = await scene()
    const none = await connect(h, alice.headers)

    await none.call('client.capabilities', { server_requests: true })
    await raise(h, { params: { level: 'plain' } })

    const frame = await confirmFrame(app)

    expect((await submit(none, frame.id, { decision: 'confirmed', method: 'tap' })).error?.code).toBe(4033)
  })
})

describe('no downgrade', () => {
  const failPasskey = async (s: Scene): Promise<void> => {
    const before = s.app.confirms().length

    await raise(s.h)

    const frame = await confirmFrame(s.app, before)

    expect((await submit(s.app, frame.id, DECLINE)).result).toEqual({ status: 'ok' })
    await until('the outcome', async () => (await outcomes(s.h)).length > 0)
  }

  it('refuses `plain` for ten minutes after a passkey request was declined, with nothing sent', async () => {
    const s = await scene()

    await failPasskey(s)

    const refused = await raise(s.h, { params: { level: 'plain' } })

    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ reason: 'downgrade_refused' })
    expect(s.app.confirms()).toHaveLength(1)

    // Ten minutes pass: plain is allowed again.
    await post(`${s.h.url}/__fake/passkey/expire`, { window: true })
    expect((await raise(s.h, { params: { level: 'plain' } })).status).toBe(200)
  })

  it('does not block `plain` after a confirmed passkey request', async () => {
    const s = await scene()

    await raise(s.h)

    const frame = await confirmFrame(s.app)

    await submit(s.app, frame.id, answerWith(frame, s.phone, s.alice, s.h))
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)
    expect((await raise(s.h, { params: { level: 'plain' } })).status).toBe(200)
  })

  it('is per conversation', async () => {
    const s = await scene()

    await failPasskey(s)

    const elsewhere = await post(`${s.h.url}/__fake/request`, {
      profile: 'writer',
      method: 'confirm',
      params: { level: 'plain', ...TEXT }
    })

    expect(elsewhere.status).toBe(200)
  })

  it.each([
    ['timing out', async (s: Scene) => post(`${s.h.url}/__fake/passkey/expire`, {}), 'timeout', 'timeout'],
    [
      'being withdrawn',
      async (s: Scene) => post(`${s.h.url}/__fake/withdraw-requests`, {}),
      'unavailable',
      'cancelled:withdrawn'
    ]
  ])('opens the window when the passkey request ends by %s', async (_name, end, outcome, reason) => {
    const s = await scene()

    await raise(s.h)
    await confirmFrame(s.app)
    await end(s)
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)
    expect((await outcomes(s.h))[0]).toMatchObject({ outcome, reason })
    expect((await raise(s.h, { params: { level: 'plain' } })).status).toBe(409)
  })
})

describe('timing out', () => {
  it('withdraws it with `request.cancel timeout` when it is timed out by hand, and drops it from resume', async () => {
    const s = await scene()

    await raise(s.h)

    const frame = await confirmFrame(s.app)
    const expired = (await (await post(`${s.h.url}/__fake/passkey/expire`, { request_id: frame.id })).json()) as Json

    expect(expired).toEqual({ requests: 1 })
    await s.app.next(f => f.params?.payload?.reason === 'timeout', 'the cancel')
    expect(s.app.cancels()).toEqual([{ id: frame.id, method: 'confirm', reason: 'timeout' }])
    expect((await outcomes(s.h))[0]).toMatchObject({ outcome: 'timeout', reason: 'timeout', verified: false })
    expect((await s.app.call('session.resume', { session_id: frame.params.session_id })).result?.open_requests).toEqual(
      []
    )
    expect((await submit(s.app, frame.id, DECLINE)).result).toEqual({ status: 'expired' })
  })

  it('times out by itself after `timeout_seconds`', async () => {
    const s = await scene()

    await raise(s.h, { timeout_seconds: 0.05 })
    await until('the timeout', async () => (await outcomes(s.h)).length === 1)
    expect((await outcomes(s.h))[0]).toMatchObject({ outcome: 'timeout' })
  })
})
