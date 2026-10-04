/**
 * Structured `confirm` (`contract/requests` is for the interactive methods; this is `contract/confirm-passkey`
 * §4.1, §8 and §9 and the gateway's `tests/tui_gateway/test_confirm_fields.py`): `fields`, the version-2 text
 * digest, the `confirm_fields` advertisement and `draft_id`.
 *
 * Pinned here: field values are refused, never rewritten, when they hold anything a renderer shows as nothing or
 * more than one line, and the contract's limits hold; a `confirm` with fields goes only to connections that
 * advertised `confirm_fields: true` (at `passkey` also `confirm_passkey {v: 2}`) and is `unavailable
 * (no_capable_client)` with nothing sent when none is attached; a version-1 passkey client never gets a
 * version-2 frame; a version-2 answer is verified against `text_digest_v2`, a signature over the text without the
 * fields (or with them in another order) is refused, and `passkey.v` must repeat the request's own version;
 * `draft_id` takes the approved text from the review register verbatim and an unknown, expired or foreign id
 * sends nothing.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { startFakeGateway } from '../server'
import { ReviewRegister, TTL_MS } from '../review-register'
import type { ConfirmField } from './challenge'
import { SoftAuthenticator, type ConfirmFrameParams } from '../testing/soft-authenticator'
import { b64uDecode } from './encoding'
import { buildFields, buildText, ConfirmParamsError, draftDetail, FIELD_KINDS } from './confirm'
import {
  ALICE,
  closeAll,
  connect,
  cookieFor,
  post,
  startPasskeyGateway,
  stateOf,
  until,
  type Connection,
  type Harness,
  type Json
} from './harness'

const closing: Harness[] = []

afterEach(async () => {
  await closeAll()

  while (closing.length) {
    await closing.pop()?.close()
  }
})

const BUDGET = [
  { kind: 'amount', label: 'Estimated cost', value: '4.20', currency: '€' },
  { kind: 'count', label: 'tokens', value: '1,200,000' },
  { kind: 'model', label: 'Model', value: 'claude-opus-5-5' }
]

// ── building the fields ──────────────────────────────────────────────────────────────────────

describe('building the fields', () => {
  it('numbers a field without an id and keeps the order', () => {
    expect(buildFields(BUDGET)).toEqual([
      { id: 'field_1', kind: 'amount', label: 'Estimated cost', value: '4.20', currency: '€' },
      { id: 'field_2', kind: 'count', label: 'tokens', value: '1,200,000' },
      { id: 'field_3', kind: 'model', label: 'Model', value: 'claude-opus-5-5' }
    ])
    // No fields, or an empty list: the key is absent and the frame is the version-1 one.
    expect(buildFields(undefined)).toBeUndefined()
    expect(buildFields([])).toBeUndefined()
    expect(buildText({ summary: 'x', fields: [] })).not.toHaveProperty('fields')
    expect(buildText({ summary: 'x' })).not.toHaveProperty('fields')
  })

  it('removes the spaces at either end and nothing else', () => {
    expect(
      buildFields([
        { id: 'to', kind: 'recipient', label: '  To ', value: ' alex@example.com' },
        { kind: 'count', label: 'Files', value: '3' }
      ])
    ).toEqual([
      { id: 'to', kind: 'recipient', label: 'To', value: 'alex@example.com' },
      { id: 'field_2', kind: 'count', label: 'Files', value: '3' }
    ])
  })

  it.each([
    [Array.from({ length: 9 }, () => ({ kind: 'text', label: 'L', value: 'v' })), /the limit is 8/],
    ['amount 4', /must be a list/],
    [['amount'], /must be an object/],
    [[{ kind: 'amount', label: 'L', value: '1', unit: 'EUR' }], /unknown keys: unit/],
    [[{ kind: 'iban', label: 'L', value: '1' }], /kind must be one of/],
    [[{ kind: 'text', label: 'L', value: '1', currency: 'EUR' }], /only for kind amount/],
    [[{ kind: 'text', label: 'L' }], /value must be a string/],
    [[{ kind: 'text', label: 'L', value: true }], /value must be a string/],
    [[{ kind: 'text', label: 'L', value: 1.5 }], /value must be a string/],
    [[{ kind: 'count', label: 'L', value: 3 }], /value must be a string/],
    [[{ kind: 'text', label: 7, value: 'v' }], /label must be a string/],
    [[{ kind: 'amount', label: 'L', value: '1', currency: 978 }], /currency must be a string/],
    [[{ kind: 'text', label: '', value: '1' }], /label is empty/],
    [[{ kind: 'text', label: 'L', value: '   ' }], /value is empty/],
    [[{ kind: 'text', label: 'L'.repeat(41), value: '1' }], /the limit is 40/],
    [[{ kind: 'text', label: 'L', value: 'v'.repeat(201) }], /the limit is 200/],
    [[{ kind: 'amount', label: 'L', value: '1', currency: 'C'.repeat(17) }], /the limit is 16/],
    [[{ kind: 'text', label: 'L', value: 'one\ntwo' }], /must be one line/],
    [[{ kind: 'text', label: 'L', value: 'one\u2028two' }], /cannot be shown as it is/],
    [[{ kind: 'recipient', label: 'To', value: 'alice\u202e@evil.example' }], /cannot be shown as it is/],
    [[{ kind: 'amount', label: 'L', value: '1\u200b00' }], /cannot be shown as it is/],
    [[{ kind: 'amount', label: 'L', value: '100', currency: 'EUR\ufe0f' }], /cannot be shown as it is/],
    [[{ kind: 'text', label: 'Lㅤ', value: '1' }], /cannot be shown as it is/],
    [[{ kind: 'text', label: 'L', value: 'a\tb' }], /cannot be shown as it is/],
    [[{ kind: 'text', label: 'L', value: `a${' '.repeat(17)}b` }], /spaces in a row/],
    [[{ kind: 'text', label: 'L', value: `e${'\u0301'.repeat(5)}` }], /combining marks/],
    [[{ id: 'Amount', kind: 'text', label: 'L', value: '1' }], /lower-case identifier/],
    [
      [
        { id: 'a', kind: 'text', label: 'L', value: '1' },
        { id: 'a', kind: 'text', label: 'M', value: '2' }
      ],
      /used twice/
    ]
  ])('refuses fields the person could not see exactly: %#', (fields, problem) => {
    expect(() => buildFields(fields)).toThrow(ConfirmParamsError)
    expect(() => buildFields(fields)).toThrow(problem)
  })

  it('has the contract’s kinds', () => {
    expect([...FIELD_KINDS]).toEqual(['amount', 'text', 'recipient', 'domain', 'model', 'count', 'date'])
  })
})

describe('the review register', () => {
  it('keeps a draft an hour for its own conversation only, twenty at most', () => {
    const register = new ReviewRegister()
    const draft = register.put('chat-1', 'Hi Sam,\n\n  the invoice is attached.', { edited: true, now: 1_000 })

    expect(draft.draftId).toMatch(/^drf-[0-9a-f]{12}$/)
    expect(draft.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(register.get('chat-1', draft.draftId, 2_000)?.text).toBe('Hi Sam,\n\n  the invoice is attached.')
    expect(register.get('chat-2', draft.draftId, 2_000)).toBeUndefined()
    expect(register.get('chat-1', draft.draftId, 1_000 + TTL_MS)).toBeUndefined()
    expect(register.count('chat-1', 1_000 + TTL_MS)).toBe(0)

    for (let n = 0; n < 25; n += 1) {
      register.put('chat-3', `draft ${n}`, { now: 5_000 })
    }

    expect(register.count('chat-3', 5_000)).toBe(20)
    register.clear('chat-3')
    expect(register.count('chat-3', 5_000)).toBe(0)
  })

  it('refuses a draft_id the conversation does not have, before anything is sent', () => {
    const register = new ReviewRegister()
    const draft = register.put('chat-1', 'word '.repeat(500) + 'end', { now: 0 })
    const stale = register.put('chat-1', 'old', { now: 0 })

    expect(() => draftDetail(register, 'chat-1', 'drf-000000000000', 1)).toThrow(/unknown or expired/)
    expect(() => draftDetail(register, 'chat-2', stale.draftId, 1)).toThrow(/unknown or expired/)
    expect(() => draftDetail(register, 'chat-1', draft.draftId, 1)).toThrow(/at most 2000/)
    expect(() => draftDetail(register, 'chat-1', 12, 1)).toThrow(/must be the draft_id/)
    expect(() => draftDetail(register, 'chat-1', '', 1)).toThrow(/must be the draft_id/)
    expect(draftDetail(register, 'chat-1', stale.draftId, 1)).toBe('old')
    expect(() => draftDetail(register, 'chat-1', stale.draftId, TTL_MS + 1)).toThrow(/unknown or expired/)
  })

  it('shows the draft verbatim as the detail, and refuses a draft that cannot be', () => {
    const text = 'Hi Sam,\n\n  the invoice is attached.\n\nAlex'

    expect(buildText({ summary: 'Send it.', detail: text, verbatimDetail: true }).detail).toBe(text)
    // Cleaned (not verbatim), the indentation would be gone.
    expect(buildText({ summary: 'Send it.', detail: text }).detail).toBe('Hi Sam,\n\nthe invoice is attached.\n\nAlex')
    expect(() => buildText({ summary: 'Send it.', detail: 'a\tb', verbatimDetail: true })).toThrow(/verbatim/)
  })
})

// ── a gateway that does not know the passkey level ───────────────────────────────────────────

const startPlain = async (): Promise<Harness> => {
  const gateway = await startFakeGateway({ port: 0 })
  const harness: Harness = { gateway, url: gateway.url, close: () => gateway.close() }

  closing.push(harness)

  return harness
}

const advertisePlain = (conn: Connection, extra: Json = {}): Promise<Json> =>
  conn
    .call('client.capabilities', { server_requests: true, confirm: ['plain'], ...extra })
    .then(frame => frame.result as Json)

const raiseConfirm = (h: Harness, params: Json, body: Json = {}): Promise<Response> =>
  post(`${h.url}/__fake/request`, { profile: 'researcher', method: 'confirm', ...body, params })

describe('the confirm_fields advertisement', () => {
  it('is always in the result, true only once accepted: exactly `true`, with a level, from a client that answers', async () => {
    const h = await startPlain()
    const app = await connect(h)

    expect((await advertisePlain(app)).confirm_fields).toBe(false) // a gateway that knows the key always sends it
    expect((await advertisePlain(app, { confirm_fields: true })).confirm_fields).toBe(true)

    // Without a level, without server_requests, or not exactly true: not accepted, and the call never fails.
    expect((await advertisePlain(app, { confirm: [], confirm_fields: true })).confirm_fields).toBe(false)
    expect((await advertisePlain(app, { confirm_fields: 1 })).confirm_fields).toBe(false)

    for (const odd of ['maybe', 'true', { v: 1 }, [true], null]) {
      const answer = await advertisePlain(app, { confirm_fields: odd })

      expect(answer, JSON.stringify(odd)).toMatchObject({ confirm: ['plain'], confirm_fields: false })
    }

    const off = (
      await app.call('client.capabilities', { server_requests: false, confirm: ['plain'], confirm_fields: true })
    ).result as Json

    expect(off.confirm_fields).toBe(false)
    // Every call replaces the last one.
    expect((await advertisePlain(app, { confirm_fields: true })).confirm_fields).toBe(true)
    expect((await advertisePlain(app)).confirm_fields).toBe(false)
  })

  it('is recorded as the client sent it', async () => {
    const h = await startPlain()
    const app = await connect(h)

    await advertisePlain(app, { confirm_fields: true })

    expect((await stateOf(h)).clientCapabilities.at(-1)).toEqual({
      server_requests: true,
      confirm: ['plain'],
      confirm_fields: true
    })
  })
})

describe('plain with fields', () => {
  it('reaches only connections that show them, and is unavailable with nothing sent when none does', async () => {
    const h = await startPlain()
    const old = await connect(h)
    const fresh = await connect(h)

    await advertisePlain(old)

    const none = await raiseConfirm(h, { summary: 'Run the long analysis.', fields: BUDGET })

    expect(none.status).toBe(409)
    expect(await none.json()).toMatchObject({ outcome: 'unavailable', reason: 'no_capable_client' })
    expect(old.confirms()).toHaveLength(0)

    await advertisePlain(fresh, { confirm_fields: true })

    const sent = await raiseConfirm(h, { summary: 'Run the long analysis.', fields: BUDGET })

    expect(sent.status).toBe(200)

    const frame = await fresh.next(f => f.method === 'confirm', 'the confirm with fields')

    expect(frame.params?.fields).toEqual(buildFields(BUDGET))
    expect(frame.params).not.toHaveProperty('passkey')
    expect(old.confirms()).toHaveLength(0)

    // The same request without fields reaches the old client too, and carries no `fields`.
    await raiseConfirm(h, { summary: 'Run it.' })

    const plain = await old.next(f => f.method === 'confirm', 'the confirm without fields')

    expect(plain.params).not.toHaveProperty('fields')
  })

  it('refuses fields the person could not see exactly with a 400, and sends nothing', async () => {
    const h = await startPlain()
    const fresh = await connect(h)

    await advertisePlain(fresh, { confirm_fields: true })

    const refused = await raiseConfirm(h, {
      summary: 'Pay.',
      fields: [{ kind: 'recipient', label: 'To', value: 'alice\u202e@evil.example' }]
    })

    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
      detail: expect.stringMatching(/fields\[0\]\.value cannot be shown as it is/)
    })
    expect(fresh.confirms()).toHaveLength(0)
  })

  it('lists a fields request on resume only to a connection that shows them', async () => {
    const h = await startPlain()
    const fresh = await connect(h)

    await advertisePlain(fresh, { confirm_fields: true })
    await raiseConfirm(h, { summary: 'Run it.', fields: BUDGET })

    const frame = await fresh.next(f => f.method === 'confirm', 'the confirm')
    const sessionId = String(frame.params?.session_id)
    const late = await connect(h)
    const stranger = await connect(h)

    await advertisePlain(late, { confirm_fields: true })
    await advertisePlain(stranger)

    const listed = async (conn: Connection) =>
      ((await conn.call('session.resume', { session_id: sessionId })).result?.open_requests ?? []) as Json[]

    expect((await listed(late)).map(entry => entry.id)).toEqual([frame.id])
    expect(await listed(stranger)).toEqual([])
  })
})

// ── draft_id ─────────────────────────────────────────────────────────────────────────────────

const DRAFT = 'Hi Sam,\n\n  the invoice is attached.\n\nAlex'

describe('draft_id', () => {
  const approveDraft = async (h: Harness, profile = 'researcher', text = DRAFT): Promise<string> => {
    const client = await connect(h)

    await client.call('client.capabilities', { server_requests: true, requests: ['review.draft'] })

    const { id } = (await (
      await post(`${h.url}/__fake/request`, { profile, method: 'review.draft', params: { text, editable: true } })
    ).json()) as { id: string }

    await client.call('request.answer', { id, result: { decision: 'approved', text: `${text}  ` } })

    const view = (await (await fetch(`${h.url}/__fake/request/${id}`)).json()) as Json

    return view.answer.draft_id as string
  }

  it('takes the approved text verbatim as the detail, and ignores the agent’s own', async () => {
    const h = await startPlain()
    const draftId = await approveDraft(h)
    const app = await connect(h)

    await advertisePlain(app)
    expect(draftId).toMatch(/^drf-[0-9a-f]{12}$/)

    const sent = await raiseConfirm(h, {
      summary: 'Send the approved mail to Sam.',
      detail: 'something else entirely',
      draft_id: draftId
    })

    expect(sent.status).toBe(200)

    const frame = await app.next(f => f.method === 'confirm', 'the confirm')

    expect(frame.params?.detail).toBe(DRAFT) // indentation and blank lines kept
  })

  it.each([
    ['an unknown id', async () => 'drf-000000000000', 'researcher'],
    ['a number', async () => 12 as unknown as string, 'researcher'],
    [
      'a draft too long to show',
      (h: Harness) => approveDraft(h, 'researcher', `${'word '.repeat(500)}end`),
      'researcher'
    ],
    ['another conversation’s draft', (h: Harness) => approveDraft(h, 'writer'), 'researcher']
  ])('sends nothing for %s', async (_name, make, profile) => {
    const h = await startPlain()
    const draftId = await make(h)
    const app = await connect(h)

    await advertisePlain(app)

    const refused = await raiseConfirm(h, { summary: 'Send it.', draft_id: draftId }, { profile })

    expect(refused.status).toBe(400)
    expect(app.confirms()).toHaveLength(0)
  })
})

// ── a gateway that knows the level passkey ───────────────────────────────────────────────────

const PREFIX = '/api/auth/passkeys'

interface Person {
  headers: Record<string, string>
  handle: string
}

const signIn = async (h: Harness): Promise<Person> => {
  const headers = { cookie: await cookieFor(h, ALICE), origin: h.url }
  const status = (await (await fetch(`${h.url}${PREFIX}`, { headers })).json()) as Json

  return { headers, handle: status.user.handle }
}

const enrol = async (h: Harness, person: Person, auth: SoftAuthenticator): Promise<void> => {
  const opened = (await (
    await post(`${h.url}${PREFIX}/register/begin`, { rp_id: auth.rpId, base_url: h.url, name: 'Phone' }, person.headers)
  ).json()) as Json
  const code = ((await (await post(`${h.url}/__fake/passkey/code`, { user: ALICE.key })).json()) as Json).code
  const body = auth.register(
    {
      registrationId: opened.registration_id,
      baseUrl: h.url,
      gatewayId: b64uDecode(opened.gateway_id),
      userId: opened.user.id,
      name: opened.user.name,
      nonce: b64uDecode(opened.nonce)
    },
    code
  )

  expect((await post(`${h.url}${PREFIX}/register/finish`, body, person.headers)).status).toBe(200)
}

/** The two calls of the contract (§8): what a client of version `v` sends, and what the gateway said. */
const advertise = async (
  conn: Connection,
  options: { v?: number; fields?: unknown; levels?: string[] } = {}
): Promise<{ first: Json; second: Json }> => {
  const first = (await conn.call('client.capabilities', { server_requests: true })).result as Json
  const second = (
    await conn.call('client.capabilities', {
      server_requests: true,
      confirm: options.levels ?? ['plain', 'passkey'],
      ...(options.fields === undefined ? {} : { confirm_fields: options.fields }),
      confirm_passkey: { v: options.v ?? 1, kind: 'native', rp_id: 'confirm.hermie.dev' }
    })
  ).result as Json

  return { first, second }
}

interface Scene {
  h: Harness
  person: Person
  phone: SoftAuthenticator
  app: Connection
}

const scene = async (options: { v?: number; fields?: unknown } = {}): Promise<Scene> => {
  const h = await startPasskeyGateway()
  const person = await signIn(h)
  const phone = SoftAuthenticator.native()

  await enrol(h, person, phone)

  const app = await connect(h, person.headers)

  await advertise(app, options)

  return { h, person, phone, app }
}

const raisePasskey = (h: Harness, params: Json = {}): Promise<Response> =>
  raiseConfirm(h, {
    level: 'passkey',
    title: 'Run with a large model',
    summary: 'Run the quarterly analysis with a large model.',
    ...params
  })

/** A confirm frame's params as these tests read them: `fields` is there when the test says it should be. */
type FrameParams = Omit<ConfirmFrameParams, 'fields'> & { fields: ConfirmField[] }

const frameOf = async (conn: Connection): Promise<{ id: string; params: FrameParams }> => {
  const frame = await conn.next(f => f.method === 'confirm', 'the confirm frame')

  return { id: String(frame.id), params: frame.params as unknown as FrameParams }
}

const submit = (conn: Connection, id: string, result: unknown) =>
  conn.call('request.answer', { id, result: result as Record<string, unknown> })

const outcomes = async (h: Harness): Promise<Json[]> => (await stateOf(h)).passkey.outcomes

describe('the capability handshake with structured fields', () => {
  it('lists the versions it accepts, and says whether it accepted the fields', async () => {
    const h = await startPasskeyGateway()
    const person = await signIn(h)
    const app = await connect(h, person.headers)
    const { first, second } = await advertise(app, { v: 2, fields: true })

    expect(first.confirm_passkey).toMatchObject({ v: 1, enabled: true, versions: [1, 2] })
    expect(first.confirm_fields).toBe(false)
    expect(second).toMatchObject({ confirm: ['passkey', 'plain'], confirm_fields: true })
    expect(second.confirm_passkey).toMatchObject({ versions: [1, 2] })
    expect((await stateOf(h)).clientCapabilities.at(-1)).toEqual({
      server_requests: true,
      confirm: ['plain', 'passkey'],
      confirm_fields: true,
      confirm_passkey: { v: 2, kind: 'native', rp_id: 'confirm.hermie.dev' }
    })
  })

  it('counts `confirm_fields` only exactly true and only with an accepted level', async () => {
    const h = await startPasskeyGateway()
    const person = await signIn(h)
    const app = await connect(h, person.headers)

    expect((await advertise(app, { v: 2, fields: 1 })).second).toMatchObject({
      confirm: ['passkey', 'plain'],
      confirm_fields: false
    })
    expect((await advertise(app, { v: 2, fields: 'true' })).second.confirm_fields).toBe(false)
    expect((await advertise(app, { v: 2, fields: true, levels: [] })).second).toMatchObject({
      confirm: [],
      confirm_fields: false
    })
    expect((await advertise(app, { v: 3, fields: true })).second).toMatchObject({
      confirm: ['plain'],
      confirm_fields: true
    })
  })
})

describe('a version-2 passkey confirmation', () => {
  it('never sends a version-2 frame to a version-1 client, nor to one that does not show the fields', async () => {
    const s = await scene() // confirm_passkey {v: 1}, no confirm_fields

    const none = await raisePasskey(s.h, { fields: BUDGET })

    expect(none.status).toBe(409)
    expect(await none.json()).toMatchObject({ outcome: 'unavailable', reason: 'no_capable_client' })
    expect(s.app.confirms()).toHaveLength(0)

    // v 1 with confirm_fields: still not a target (it would hash the text without the fields).
    await advertise(s.app, { v: 1, fields: true })
    expect((await raisePasskey(s.h, { fields: BUDGET })).status).toBe(409)
    // v 2 without confirm_fields: not a target either (it would not show them).
    await advertise(s.app, { v: 2, fields: false })
    expect((await raisePasskey(s.h, { fields: BUDGET })).status).toBe(409)
    expect(s.app.confirms()).toHaveLength(0)
  })

  it('sends it to a client that does both, as version 2 with the fields in order, and confirms a right answer', async () => {
    const s = await scene({ v: 2, fields: true })
    const old = await connect(s.h, s.person.headers)

    await advertise(old, { v: 1, fields: true }) // the same person's version-1 client

    expect((await raisePasskey(s.h, { fields: BUDGET })).status).toBe(200)

    const frame = await frameOf(s.app)

    expect(frame.params.passkey.v).toBe(2)
    expect(frame.params.fields).toEqual(buildFields(BUDGET))
    expect(frame.params.fields[0]).toMatchObject({ id: 'field_1', currency: '€' })
    expect(old.confirms()).toHaveLength(0) // the v1 client of the same person: never

    const answer = s.phone.answer(frame, { baseUrl: s.h.url, userHandle: s.person.handle })

    expect(answer.passkey.v).toBe(2)
    expect((await submit(s.app, frame.id, answer)).result).toEqual({ status: 'ok' })
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)
    expect((await outcomes(s.h))[0]).toMatchObject({ outcome: 'confirmed', method: 'passkey', verified: true })
  })

  it('refuses a signature over the version-1 text, over the fields in another order, or over another value', async () => {
    const s = await scene({ v: 2, fields: true })

    await raisePasskey(s.h, { fields: BUDGET })

    const frame = await frameOf(s.app)
    const reversed = { ...frame, params: { ...frame.params, fields: [...frame.params.fields].reverse() } }
    const changed = {
      ...frame,
      params: { ...frame.params, fields: frame.params.fields.map((f, i) => (i === 0 ? { ...f, value: '4.21' } : f)) }
    }
    const attempts = [
      s.phone.answer(frame, { baseUrl: s.h.url }, { signWithoutFields: true }),
      s.phone.answer(reversed, { baseUrl: s.h.url }),
      s.phone.answer(changed, { baseUrl: s.h.url })
    ]

    for (const attempt of attempts) {
      const refused = await submit(s.app, frame.id, attempt)

      expect(refused.error).toEqual({ code: 4034, message: 'answer refused', data: { reason: 'challenge_mismatch' } })
    }

    // Still open; the right answer settles it.
    const good = s.phone.answer(frame, { baseUrl: s.h.url })

    expect((await submit(s.app, frame.id, good)).result).toEqual({ status: 'ok' })
  })

  it('reads `v` as the request’s own version: version 1 for a request without fields, 2 for one with', async () => {
    const s = await scene({ v: 2, fields: true })

    await raisePasskey(s.h, { fields: BUDGET })

    const withFields = await frameOf(s.app)
    // The right signature with `v: 1`: the shape of a version-1 answer.
    const asV1 = s.phone.answer(withFields, { baseUrl: s.h.url }, { v: 1 })

    expect((await submit(s.app, withFields.id, asV1)).error?.data).toEqual({ reason: 'bad_shape' })
    expect((await submit(s.app, withFields.id, s.phone.answer(withFields, { baseUrl: s.h.url }))).result).toEqual({
      status: 'ok'
    })
    await until('the first outcome', async () => (await outcomes(s.h)).length === 1)

    // A version-1 request answered with `v: 2` is refused the same way.
    await raisePasskey(s.h)

    const plain = await s.app.next(f => f.method === 'confirm' && s.app.confirms().indexOf(f) === 1, 'the second frame')
    const plainFrame = { id: String(plain.id), params: plain.params as unknown as FrameParams }

    expect(plainFrame.params.passkey.v).toBe(1)
    expect(plainFrame.params).not.toHaveProperty('fields')
    expect(
      (await submit(s.app, plainFrame.id, s.phone.answer(plainFrame, { baseUrl: s.h.url }, { v: 2 }))).error?.data
    ).toEqual({
      reason: 'bad_shape'
    })
    expect((await submit(s.app, plainFrame.id, s.phone.answer(plainFrame, { baseUrl: s.h.url }))).result).toEqual({
      status: 'ok'
    })
  })

  it('takes version-1 frames from a version-2 client', async () => {
    const s = await scene({ v: 2, fields: true })

    await raisePasskey(s.h)

    const frame = await frameOf(s.app)

    expect(frame.params.passkey.v).toBe(1)
    expect(frame.params).not.toHaveProperty('fields')
    expect((await submit(s.app, frame.id, s.phone.answer(frame, { baseUrl: s.h.url }))).result).toEqual({
      status: 'ok'
    })
  })

  it('does not let a connection that drops v 2 or the fields while the request is open answer it', async () => {
    const s = await scene({ v: 2, fields: true })

    await raisePasskey(s.h, { fields: BUDGET })

    const frame = await frameOf(s.app)
    const good = s.phone.answer(frame, { baseUrl: s.h.url })

    for (const drop of [
      { v: 1, fields: true },
      { v: 2, fields: false }
    ]) {
      expect((await advertise(s.app, drop)).second.confirm).toEqual(['passkey', 'plain'])
      expect((await submit(s.app, frame.id, good)).error?.code, JSON.stringify(drop)).toBe(4033)
    }

    await advertise(s.app, { v: 2, fields: true })
    expect((await submit(s.app, frame.id, good)).result).toEqual({ status: 'ok' })
  })

  it('refuses fields the person could not see exactly with a 400 at either level, and sends nothing', async () => {
    const s = await scene({ v: 2, fields: true })
    const bad = { fields: [{ kind: 'amount', label: 'L', value: `1${' '.repeat(17)}0` }] }

    expect((await raisePasskey(s.h, bad)).status).toBe(400)
    expect((await raiseConfirm(s.h, { level: 'plain', summary: 'Pay.', ...bad })).status).toBe(400)
    expect(s.app.confirms()).toHaveLength(0)
  })

  it('takes a decline with no assertion, as for a version-1 request', async () => {
    const s = await scene({ v: 2, fields: true })

    await raisePasskey(s.h, { fields: BUDGET })

    const frame = await frameOf(s.app)

    expect((await submit(s.app, frame.id, { decision: 'declined', method: 'tap' })).result).toEqual({ status: 'ok' })
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)
    expect((await outcomes(s.h))[0]).toMatchObject({ outcome: 'declined', verified: false })
  })
})

describe('plain with fields beside the passkey level', () => {
  it('reaches only the connection that shows them, which alone may answer', async () => {
    const s = await scene({ v: 1 }) // offers both levels, no fields
    const shows = await connect(s.h, s.person.headers)

    await advertise(shows, { v: 1, fields: true, levels: ['plain'] })
    await raiseConfirm(s.h, { level: 'plain', summary: 'Run the long analysis.', fields: BUDGET })

    const frame = await frameOf(shows)

    expect(frame.params.fields).toEqual(buildFields(BUDGET))
    expect(frame.params).not.toHaveProperty('passkey')
    expect(s.app.confirms()).toHaveLength(0)
    expect((await submit(s.app, frame.id, { decision: 'confirmed', method: 'tap' })).error?.code).toBe(4033)
    expect((await submit(shows, frame.id, { decision: 'confirmed', method: 'tap' })).result).toEqual({ status: 'ok' })
  })

  it('is unavailable (no_capable_client) when nobody shows the fields', async () => {
    const s = await scene({ v: 1 })
    const refused = await raiseConfirm(s.h, { level: 'plain', summary: 'Run it.', fields: BUDGET })

    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ outcome: 'unavailable', reason: 'no_capable_client' })
  })
})

describe('draft_id on a gateway that knows the level passkey', () => {
  it('shows the approved text as the detail of a passkey confirmation, which the answer then commits to', async () => {
    const s = await scene({ v: 1 })

    await s.app.call('client.capabilities', {
      server_requests: true,
      confirm: ['plain', 'passkey'],
      confirm_passkey: { v: 1, kind: 'native', rp_id: 'confirm.hermie.dev' },
      requests: ['review.draft']
    })

    const { id } = (await (
      await post(`${s.h.url}/__fake/request`, {
        profile: 'researcher',
        method: 'review.draft',
        params: { text: DRAFT, editable: true }
      })
    ).json()) as { id: string }

    await submit(s.app, id, { decision: 'approved', text: DRAFT })

    const draftId = ((await (await fetch(`${s.h.url}/__fake/request/${id}`)).json()) as Json).answer.draft_id as string

    expect((await raisePasskey(s.h, { draft_id: draftId, detail: 'not this' })).status).toBe(200)

    const frame = await frameOf(s.app)

    expect(frame.params.detail).toBe(DRAFT)
    expect((await submit(s.app, frame.id, s.phone.answer(frame, { baseUrl: s.h.url }))).result).toEqual({
      status: 'ok'
    })
    await until('the outcome', async () => (await outcomes(s.h)).length === 1)
    expect((await outcomes(s.h))[0]).toMatchObject({ outcome: 'confirmed', verified: true })
  })
})
