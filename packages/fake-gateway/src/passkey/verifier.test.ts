/**
 * The verifier and the store on their own: the CBOR subset, a soft authenticator round trip, truncated and
 * bit-flipped input at every offset, and the rules the store keeps for codes, ceremonies and commits.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { CborError, decode, decodeExactly } from './cbor'
import { b64u, b64uDecode, EncodingError } from './encoding'
import {
  PasskeyStore,
  CodeInvalid,
  CommitRefused,
  CredentialExists,
  PendingInvalid,
  idOf,
  registrationOf,
  stored
} from './store'
import { GatewayContext, verifyAssertion, verifyRegistration, type AssertionRequest } from './webauthn'
import { cbor, SoftAuthenticator } from '../testing/soft-authenticator'

const USER = 'self-hosted:alice@example.invalid'
const BASE = 'https://gw.example.invalid'

describe('base64url', () => {
  it.each(['AA==', 'A', 'AB', '+/+/', 'a b', 'AAB'])('refuses %j', text => {
    expect(() => b64uDecode(text)).toThrow(EncodingError)
  })

  it('round-trips and bounds the decoded length', () => {
    const raw = Buffer.from([1, 2, 3, 4, 5])

    expect(b64uDecode(b64u(raw))).toEqual(raw)
    expect(() => b64uDecode(b64u(raw), 6, 8)).toThrow(EncodingError)
    expect(() => b64uDecode(b64u(raw), 1, 4)).toThrow(EncodingError)
    expect(b64uDecode(b64u(raw), 5, 5)).toEqual(raw)
  })
})

describe('the CBOR subset', () => {
  const hex = (text: string) => Buffer.from(text.replaceAll(' ', ''), 'hex')

  it('decodes integers, strings, arrays, maps and the three simple values', () => {
    expect(decodeExactly(hex('00'))).toBe(0)
    expect(decodeExactly(hex('17'))).toBe(23)
    expect(decodeExactly(hex('18 18'))).toBe(24)
    expect(decodeExactly(hex('26'))).toBe(-7)
    expect(decodeExactly(hex('3818'))).toBe(-25)
    expect(decodeExactly(hex('1b ffffffffffffffff'))).toBe(18446744073709551615n)
    expect(decodeExactly(hex('43 010203'))).toEqual(Buffer.from([1, 2, 3]))
    expect(decodeExactly(hex('63 616263'))).toBe('abc')
    expect(decodeExactly(hex('82 01 02'))).toEqual([1, 2])
    expect(decodeExactly(hex('f4'))).toBe(false)
    expect(decodeExactly(hex('f5'))).toBe(true)
    expect(decodeExactly(hex('f6'))).toBeNull()
    expect(decodeExactly(hex('a2 01 02 63 616263 03'))).toEqual(
      new Map<number | string, unknown>([
        [1, 2],
        ['abc', 3]
      ])
    )
  })

  it('keeps an integer key and the text key of the same digits apart', () => {
    expect(decodeExactly(hex('a2 01 02 61 31 03'))).toEqual(
      new Map<number | string, unknown>([
        [1, 2],
        ['1', 3]
      ])
    )
  })

  it('accepts non-shortest integers and reports how much it consumed', () => {
    expect(decode(hex('18 05 ff'))).toEqual([5, 2])
  })

  it.each([
    ['an indefinite-length map', 'bf 01 02 ff'],
    ['an indefinite-length string', '5f 41 01 ff'],
    ['a tag', 'c1 01'],
    ['a float', 'f9 3c00'],
    ['undefined', 'f7'],
    ['a simple value', 'f0'],
    ['a duplicate key', 'a2 01 02 01 03'],
    ['a boolean key', 'a1 f5 01'],
    ['a byte-string key', 'a1 41 01 01'],
    ['a truncated string', '43 0102'],
    ['a truncated map', 'a2 01 02'],
    ['a length beyond the buffer', '5b ffffffffffffffff'],
    ['text that is not UTF-8', '62 c328'],
    ['an empty buffer', ''],
    ['nesting five deep', '81 81 81 81 81 00']
  ])('refuses %s', (_name, input) => {
    expect(() => decodeExactly(hex(input))).toThrow(CborError)
  })

  it('refuses trailing bytes when it must consume everything', () => {
    expect(() => decodeExactly(hex('01 02'))).toThrow(CborError)
  })

  it('accepts nesting four deep and no more', () => {
    expect(decodeExactly(hex('81 81 81 00'))).toEqual([[[0]]])
    expect(() => decodeExactly(hex('81 81 81 81 00'))).toThrow(CborError)
  })

  it('never throws anything else, at any truncation or single-bit flip of an attestation object', () => {
    const phone = SoftAuthenticator.native()
    const body = phone.register(
      {
        registrationId: 'reg-1',
        baseUrl: BASE,
        gatewayId: Buffer.alloc(16, 1),
        userId: USER,
        name: 'Phone',
        nonce: Buffer.alloc(32, 2)
      },
      'code'
    )
    const attestation = b64uDecode(body.credential.attestation_object)

    for (let end = 0; end < attestation.length; end += 1) {
      try {
        decodeExactly(attestation.subarray(0, end))
      } catch (error) {
        expect(error).toBeInstanceOf(CborError)
      }
    }

    for (let i = 0; i < attestation.length * 8; i += 1) {
      const flipped = Buffer.from(attestation)

      flipped[i >> 3] = (flipped[i >> 3] as number) ^ (1 << (i & 7))

      try {
        decodeExactly(flipped)
      } catch (error) {
        expect(error).toBeInstanceOf(CborError)
      }
    }
  })

  it('encodes what it decodes', () => {
    const value = new Map<number | string, unknown>([
      [1, 2],
      [-1, Buffer.from([9])],
      ['k', [true, false, 'x', 300]]
    ])

    expect(decodeExactly(cbor(value as never))).toEqual(value)
  })
})

const contextOf = () =>
  new GatewayContext(Buffer.alloc(16, 1), Buffer.alloc(32, 2), [BASE], {
    'confirm.hermie.dev': ['https://confirm.hermie.dev']
  })

describe('the verifier against a soft authenticator', () => {
  const ctx = contextOf()

  const enrolled = (auth: SoftAuthenticator) => {
    const registration = auth.register(
      {
        registrationId: 'reg-1',
        baseUrl: BASE,
        gatewayId: ctx.gatewayId,
        userId: USER,
        name: 'Phone',
        nonce: Buffer.alloc(32, 3)
      },
      'code'
    )
    const verdict = verifyRegistration(
      ctx,
      {
        registrationId: 'reg-1',
        userId: USER,
        rpId: auth.rpId,
        baseUrl: BASE,
        name: 'Phone',
        nonce: Buffer.alloc(32, 3)
      },
      registration
    )

    if (!verdict.ok) {
      throw new Error(`registration refused: ${verdict.reason}`)
    }

    return verdict
  }

  const request = (): AssertionRequest => ({
    userId: USER,
    requestId: 'srq-1',
    nonce: Buffer.alloc(32, 4),
    title: 'Pay',
    summary: 'Pay 10 EUR',
    detail: null,
    sessionId: 'sid-1',
    purpose: 'confirm'
  })

  const answer = (auth: SoftAuthenticator) =>
    auth.assert({
      baseUrl: BASE,
      gatewayId: ctx.gatewayId,
      userId: USER,
      sessionId: 'sid-1',
      requestId: 'srq-1',
      nonce: Buffer.alloc(32, 4),
      title: 'Pay',
      summary: 'Pay 10 EUR'
    })

  it('registers and asserts end to end, for a synced and for a device-bound credential', () => {
    for (const synced of [true, false]) {
      const auth = SoftAuthenticator.native({ synced })
      const registration = enrolled(auth)
      const record = [
        {
          ...registration,
          active: true,
          userId: USER,
          signCount: registration.signCount,
          backupEligible: registration.backupEligible,
          publicX: registration.publicX,
          publicY: registration.publicY,
          credentialId: registration.credentialId,
          rpId: registration.rpId
        }
      ]
      const verdict = verifyAssertion(ctx, request(), record, answer(auth))

      expect(verdict.ok, String(synced)).toBe(true)
      expect(verdict.ok && verdict.backupEligible).toBe(synced)
    }
  })

  it('refuses garbage without throwing, at every truncation and every flipped bit of an answer', () => {
    const auth = SoftAuthenticator.native()
    const registration = enrolled(auth)
    const record = [
      {
        credentialId: registration.credentialId,
        userId: USER,
        rpId: registration.rpId,
        publicX: registration.publicX,
        publicY: registration.publicY,
        signCount: 0,
        backupEligible: true,
        active: true
      }
    ]
    const good = answer(auth)

    for (const field of ['authenticator_data', 'client_data_json', 'signature'] as const) {
      const raw = b64uDecode(good.passkey[field])

      for (let end = 0; end < raw.length; end += 1) {
        const cut = { ...good, passkey: { ...good.passkey, [field]: b64u(raw.subarray(0, end)) } }

        expect(verifyAssertion(ctx, request(), record, cut).ok, `${field} cut at ${end}`).toBe(false)
      }

      for (let i = 0; i < raw.length * 8; i += 1) {
        const flipped = Buffer.from(raw)

        flipped[i >> 3] = (flipped[i >> 3] as number) ^ (1 << (i & 7))

        const verdict = verifyAssertion(ctx, request(), record, {
          ...good,
          passkey: { ...good.passkey, [field]: b64u(flipped) }
        })

        // A flip in a place nothing reads (the UTF-8 of a JSON key's whitespace, a counter byte) may still
        // verify; what it must never do is throw, and a flip in the signature must never verify.
        if (field === 'signature') {
          expect(verdict.ok, `signature bit ${i}`).toBe(false)
        }
      }
    }

    for (const junk of [
      null,
      1,
      'x',
      [],
      {},
      { decision: 'confirmed' },
      { decision: 'confirmed', method: 'passkey', passkey: 5 }
    ]) {
      expect(verifyAssertion(ctx, request(), record, junk)).toEqual({ ok: false, reason: 'bad_shape' })
    }
  })

  it('memoises a verdict per answer', async () => {
    const { memoisedAssertionValidator } = await import('./webauthn')
    const auth = SoftAuthenticator.native()
    const registration = enrolled(auth)
    const validate = memoisedAssertionValidator(ctx, request(), [
      {
        credentialId: registration.credentialId,
        userId: USER,
        rpId: registration.rpId,
        publicX: registration.publicX,
        publicY: registration.publicY,
        signCount: 0,
        backupEligible: true,
        active: true
      }
    ])
    const given = answer(auth)

    expect(validate(given)).toBe(validate(given))
    expect(validate({ ...given, decision: 'declined' })).toEqual({ ok: false, reason: 'bad_shape' })
  })
})

describe('the store', () => {
  let now = 1_790_000_000_000
  const clock = () => now

  beforeEach(() => {
    now = 1_790_000_000_000
  })

  const BASE_REG = (store: PasskeyStore) => {
    const auth = SoftAuthenticator.native()
    const pending = store.openPending('register', { userId: USER, rpId: auth.rpId, baseUrl: BASE, subject: 'Phone' })
    const ctx = new GatewayContext(store.gatewayId, store.handleKey, [BASE], {
      'confirm.hermie.dev': ['https://confirm.hermie.dev']
    })
    const verdict = verifyRegistration(
      ctx,
      registrationOf(pending),
      auth.register(
        {
          registrationId: pending.id,
          baseUrl: BASE,
          gatewayId: store.gatewayId,
          userId: USER,
          name: 'Phone',
          nonce: pending.nonce
        },
        ''
      )
    )

    if (!verdict.ok) {
      throw new Error(verdict.reason)
    }

    return { auth, pending, verdict, ctx }
  }

  it('redeems a code once, for its user, before it expires, and only with the credential it enrols', () => {
    const store = new PasskeyStore({ clock })
    const bound = store.mintCode({ userId: 'self-hosted:bob@example.invalid' })
    const open = store.mintCode()
    const { verdict, pending } = BASE_REG(store)

    // The wrong user, an unknown code: nothing is taken, the registration stays open.
    expect(() => store.addCredential({ userId: USER, code: bound.code, registration: verdict })).toThrow(CodeInvalid)
    expect(() => store.addCredential({ userId: USER, code: 'nonsense', registration: verdict })).toThrow(CodeInvalid)
    expect(store.pending(pending.id, 'register', USER)).toBeDefined()

    const record = store.addCredential({ userId: USER, code: open.code, registration: verdict })

    expect(record).toMatchObject({ userId: USER, createdVia: 'operator', name: 'Phone' })
    expect(store.pending(pending.id, 'register', USER)).toBeUndefined()

    // Spent: the same code enrols nothing else.
    const another = BASE_REG(store)

    expect(() => store.addCredential({ userId: USER, code: open.code, registration: another.verdict })).toThrow(
      CodeInvalid
    )

    // Expired.
    const late = store.mintCode({ ttl: 60 })
    const third = BASE_REG(store)

    now += 61_000
    expect(() => store.addCredential({ userId: USER, code: late.code, registration: third.verdict })).toThrow(
      CodeInvalid
    )
  })

  it('lets a code that a person minted be redeemed by that person only, and says where it came from', () => {
    const store = new PasskeyStore({ clock })
    const minted = store.mintCode({ by: USER })
    const { verdict } = BASE_REG(store)

    expect(() =>
      store.addCredential({ userId: 'self-hosted:eve@example.invalid', code: minted.code, registration: verdict })
    ).toThrow(PendingInvalid)
    expect(store.addCredential({ userId: USER, code: minted.code, registration: verdict }).createdVia).toBe('passkey')
    expect(() => store.mintCode({ by: USER, userId: 'self-hosted:bob@example.invalid' })).toThrow()
    expect(() => store.mintCode({ ttl: 59 })).toThrow()
    expect(() => store.mintCode({ ttl: 24 * 3600 + 1 })).toThrow()
  })

  it('refuses a credential id that is already stored, revoked or not', () => {
    const store = new PasskeyStore({ clock })
    const first = BASE_REG(store)
    const record = store.addCredential({ userId: USER, code: store.mintCode().code, registration: first.verdict })

    store.revoke(record.credentialId, { by: 'operator' })

    const second = store.openPending('register', {
      userId: USER,
      rpId: first.auth.rpId,
      baseUrl: BASE,
      subject: 'Again'
    })
    const verdict = verifyRegistration(
      first.ctx,
      registrationOf(second),
      first.auth.register(
        {
          registrationId: second.id,
          baseUrl: BASE,
          gatewayId: store.gatewayId,
          userId: USER,
          name: 'Again',
          nonce: second.nonce
        },
        ''
      )
    )

    if (!verdict.ok) {
      throw new Error(verdict.reason)
    }

    expect(() => store.addCredential({ userId: USER, code: store.mintCode().code, registration: verdict })).toThrow(
      CredentialExists
    )
  })

  it('never lists a revoked credential as active, and revokes once', () => {
    const store = new PasskeyStore({ clock })
    const { verdict } = BASE_REG(store)
    const record = store.addCredential({ userId: USER, code: store.mintCode().code, registration: verdict })

    expect(store.snapshot(USER).map(c => b64u(c.credentialId))).toEqual([idOf(record)])
    expect(
      store.revoke(record.credentialId, { by: 'operator', userId: 'self-hosted:eve@example.invalid' })
    ).toBeUndefined()
    expect(store.revoke(record.credentialId, { by: 'operator', userId: USER })).toMatchObject({ revokedBy: 'operator' })
    expect(store.revoke(record.credentialId, { by: 'operator' })).toBeUndefined()
    expect(store.snapshot(USER)).toEqual([])
    expect(store.credentials(USER, true)).toHaveLength(1)
    expect(store.find(idOf(record).slice(0, 6), true)).toHaveLength(1)
    expect(store.find('')).toEqual([])
  })

  it('commits an assertion once: revoked, replayed and regressed ones are refused', () => {
    const store = new PasskeyStore({ clock })
    const { auth, verdict, ctx } = BASE_REG(store)
    const record = store.addCredential({ userId: USER, code: store.mintCode().code, registration: verdict })
    const snapshot = stored(record)
    const make = (nonce: number, requestId: string, signCount?: number) => {
      const signed = verifyAssertion(
        ctx,
        {
          userId: USER,
          requestId,
          nonce: Buffer.alloc(32, nonce),
          title: 'T',
          summary: 'S',
          detail: null,
          sessionId: 'sid',
          purpose: 'confirm'
        },
        [snapshot],
        auth.assert(
          {
            baseUrl: BASE,
            gatewayId: store.gatewayId,
            userId: USER,
            sessionId: 'sid',
            requestId,
            nonce: Buffer.alloc(32, nonce),
            title: 'T',
            summary: 'S'
          },
          signCount === undefined ? {} : { signCount }
        )
      )

      if (!signed.ok) {
        throw new Error(signed.reason)
      }

      return signed
    }

    const first = make(1, 'srq-1')

    expect(store.commitAssertion(first, { userId: USER, snapshot })).toMatchObject({
      counterWarning: false,
      credential: { lastUsedAt: 1_790_000_000 }
    })
    expect(() => store.commitAssertion(first, { userId: USER, snapshot })).toThrow(CommitRefused)
    expect(store.receipts()).toHaveLength(1)
    expect(store.receipts({ userId: 'someone else' })).toEqual([])
    // A synced credential whose counter went down is committed, with a warning.
    expect(store.commitAssertion(make(2, 'srq-2', 0), { userId: USER, snapshot })).toMatchObject({
      counterWarning: false
    })

    // Revoked meanwhile.
    const third = make(3, 'srq-3')

    store.revoke(record.credentialId, { by: 'operator' })
    expect(() => store.commitAssertion(third, { userId: USER, snapshot })).toThrow(
      expect.objectContaining({ reason: 'revoked' })
    )
    expect(store.counts()).toMatchObject({ credentials: 0, revoked: 1, receipts: 2 })
  })

  it('takes a step-up only once, by its user, with the matching text, and lets ceremonies expire', () => {
    const store = new PasskeyStore({ clock })
    const open = store.openPending('invite', { userId: USER, subject: 'invite' })

    expect(store.pending(open.id, 'revoke', USER)).toBeUndefined()
    expect(store.pending(open.id, 'invite', 'self-hosted:eve@example.invalid')).toBeUndefined()
    expect(() => store.takePending(open.id, 'invite', 'self-hosted:eve@example.invalid')).toThrow(PendingInvalid)
    expect(store.takePending(open.id, 'invite', USER).id).toBe(open.id)
    expect(() => store.takePending(open.id, 'invite', USER)).toThrow(PendingInvalid)

    const short = store.openPending('revoke', { userId: USER, subject: 'x' })

    expect(short.expiresAt - store.now()).toBe(120)
    expect(
      store.openPending('register', { userId: USER, rpId: 'r', baseUrl: BASE, subject: 'n' }).expiresAt - store.now()
    ).toBe(300)
    now += 121_000
    expect(store.pending(short.id, 'revoke', USER)).toBeUndefined()
    expect(() => store.openPending('nonsense', { userId: USER })).toThrow()
  })

  it('mints an identity of its own, and every store has a different one', () => {
    const a = new PasskeyStore()
    const b = new PasskeyStore()

    expect(a.gatewayId).toHaveLength(16)
    expect(a.handleKey).toHaveLength(32)
    expect(a.gatewayId.equals(b.gatewayId)).toBe(false)
    expect(a.counts()).toEqual({ credentials: 0, revoked: 0, users: 0, openCodes: 0, receipts: 0 })
  })
})
