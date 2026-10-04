/**
 * `contract/confirm-passkey/vectors.json`, byte for byte.
 *
 * The same vectors the gateway's own verifier and the native app run. Every vector goes through this
 * package's verifier (`node:crypto`, no WebAuthn library) and must pass or fail exactly as labelled:
 * the same refusal reason, in the order the README gives them.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { NotABaseUrl, isPrivate, originOf, serialiseBaseUrl } from './base-url'
import {
  challenge,
  challengePreimage,
  enrolmentCodeCanonical,
  enrolmentCodeHash,
  textDigest,
  userHandle
} from './challenge'
import { b64u, b64uDecode } from './encoding'
import { GRANT_FAILURES, PasskeyStore, reauthSecretHash } from './store'
import {
  ASSERTION_REASONS,
  GatewayContext,
  REGISTRATION_REASONS,
  type StoredCredential,
  verifyAssertion,
  verifyRegistration
} from './webauthn'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../contract/confirm-passkey/vectors.json', import.meta.url)), 'utf8')
) as Json

const contextOf = (name: string): { ctx: GatewayContext; user: Json } => {
  const raw = vectors.contexts[name] as Json
  const ctx = new GatewayContext(
    b64uDecode(raw.gateway_id, 16, 16),
    b64uDecode(raw.handle_key, 32, 32),
    (raw.base_urls as string[]).map(serialiseBaseUrl),
    raw.native_rps,
    raw.allow_private_base_urls
  )

  return { ctx, user: raw.user }
}

describe('contexts', () => {
  for (const name of Object.keys(vectors.contexts)) {
    it(`derives what ${name} says it derives`, () => {
      const { ctx } = contextOf(name)
      const derived = vectors.contexts[name].derived as Json

      expect(ctx.acceptedBaseUrls).toEqual(derived.accepted_base_urls)
      expect([...ctx.nativeRpIds].sort()).toEqual(derived.accepted_rps.native)
      expect([...ctx.webRpIds].sort()).toEqual(derived.accepted_rps.web)
      expect(ctx.capabilityReason()).toBe(derived.capability_reason)
    })
  }
})

describe('base URL serialisation (§3, §10)', () => {
  for (const vector of vectors.base_url_vectors as Json[]) {
    it(vector.name, () => {
      if (vector.error) {
        expect(() => serialiseBaseUrl(vector.input)).toThrow(NotABaseUrl)

        return
      }

      const baseUrl = serialiseBaseUrl(vector.input)

      expect(baseUrl).toBe(vector.base_url)
      expect(originOf(baseUrl)).toBe(vector.origin)
      expect(isPrivate(baseUrl)).toBe(vector.private)
    })
  }
})

describe('text digest, challenge, user handle, enrolment codes (§4 to §7)', () => {
  it('computes every text digest', () => {
    for (const vector of vectors.text_digest_vectors as Json[]) {
      expect(b64u(textDigest(vector.title, vector.summary, vector.detail)), vector.name).toBe(vector.text_digest)
    }
  })

  it('computes every challenge, down to the preimage', () => {
    for (const vector of vectors.challenge_vectors as Json[]) {
      const digest = textDigest(vector.title, vector.summary, vector.detail)
      const fields = {
        purpose: vector.purpose,
        baseUrl: vector.base_url,
        gatewayId: b64uDecode(vector.gateway_id),
        userId: vector.user_id,
        sessionId: vector.session_id,
        requestId: vector.request_id,
        nonce: b64uDecode(vector.nonce),
        digest
      }

      expect(b64u(digest), vector.name).toBe(vector.text_digest)
      expect(challengePreimage(fields).toString('hex'), vector.name).toBe(vector.preimage_hex)
      expect(b64u(challenge(fields)), vector.name).toBe(vector.challenge)
    }
  })

  it('computes every user handle', () => {
    for (const vector of vectors.user_handle_vectors as Json[]) {
      expect(b64u(userHandle(b64uDecode(vector.handle_key), vector.user_id))).toBe(vector.user_handle)
    }
  })

  it('canonicalises and hashes every enrolment code', () => {
    for (const vector of vectors.enrolment_code_vectors as Json[]) {
      expect(enrolmentCodeCanonical(vector.input), vector.name).toBe(vector.canonical)

      const hash = enrolmentCodeHash(vector.input)

      expect(hash === null ? null : b64u(hash), vector.name).toBe(vector.code_hash)
    }
  })
})

const storedOf = (rows: Json[]): StoredCredential[] =>
  rows.map(row => ({
    credentialId: b64uDecode(row.credential_id),
    userId: row.user_id,
    rpId: row.rp_id,
    publicX: b64uDecode(row.public_key.x),
    publicY: b64uDecode(row.public_key.y),
    signCount: row.sign_count,
    backupEligible: row.backup_eligible,
    active: row.active
  }))

const assertionRequestOf = (vector: Json) => ({
  userId: vector.request.user_id as string,
  requestId: vector.request.request_id as string,
  nonce: b64uDecode(vector.request.nonce),
  title: vector.request.title as string,
  summary: vector.request.summary as string,
  detail: (vector.request.detail ?? null) as string | null,
  sessionId: vector.request.session_id as string,
  purpose: 'confirm' as const
})

describe('assertion vectors (§9)', () => {
  it('lists the refusal reasons in the order the verifier checks them', () => {
    expect(vectors.assertion_refusal_order).toEqual([...ASSERTION_REASONS, 'too_many_attempts'])
    expect(vectors.registration_refusal_order).toEqual([...REGISTRATION_REASONS])
  })

  for (const vector of vectors.assertion_vectors as Json[]) {
    it(`${vector.context}: ${vector.name}`, () => {
      const { ctx } = contextOf(vector.context)
      const verdict = verifyAssertion(ctx, assertionRequestOf(vector), storedOf(vector.store), vector.answer)

      if (vector.expect.ok) {
        expect(verdict).toMatchObject({
          ok: true,
          signCount: vector.expect.sign_count,
          backupEligible: vector.expect.backup_eligible,
          backedUp: vector.expect.backed_up,
          counterWarning: vector.expect.counter_warning
        })
      } else {
        expect(vector.expect.code).toBe(4034)
        expect(verdict).toEqual({ ok: false, reason: vector.expect.reason })
      }
    })
  }
})

describe('registration vectors (§11)', () => {
  for (const vector of vectors.registration_vectors as Json[]) {
    it(`${vector.context}: ${vector.name}`, () => {
      const { ctx } = contextOf(vector.context)
      const begin = vector.begin as Json
      const verdict = verifyRegistration(
        ctx,
        {
          registrationId: begin.registration_id,
          userId: begin.user.id,
          rpId: begin.rp_id,
          baseUrl: begin.base_url,
          name: begin.name,
          nonce: b64uDecode(begin.nonce)
        },
        vector.finish
      )

      if (vector.expect.ok) {
        expect(verdict.ok).toBe(true)

        if (verdict.ok) {
          expect({
            ok: true,
            credential_id: b64u(verdict.credentialId),
            rp_id: verdict.rpId,
            alg: verdict.alg,
            public_key: { x: b64u(verdict.publicX), y: b64u(verdict.publicY) },
            sign_count: verdict.signCount,
            backup_eligible: verdict.backupEligible,
            backed_up: verdict.backedUp,
            aaguid: b64u(verdict.aaguid)
          }).toEqual(vector.expect)
        }
      } else {
        expect(vector.expect.status).toBe(422)
        expect(vector.expect.error).toBe('attestation_invalid')
        expect(verdict).toEqual({ ok: false, reason: vector.expect.reason })
      }
    })
  }
})

describe('fresh-authentication grants (§7.2)', () => {
  it('lists the failures in the order the store judges them', () => {
    expect(vectors.reauth_failure_order).toEqual(GRANT_FAILURES)
    expect(new Set((vectors.reauth_freshness_vectors as Json[]).map(v => v.expect.failure ?? null))).toEqual(
      new Set([null, ...GRANT_FAILURES])
    )
  })

  for (const client of ['web', 'native'] as const) {
    for (const vector of vectors.reauth_freshness_vectors as Json[]) {
      it(`${client}: ${vector.name}`, () => {
        const { grant, session } = vector
        const store = new PasskeyStore({ clock: () => grant.created_at * 1000 })
        const secret = 'cookie-secret'
        const opened = store.openGrant(
          grant.user_id,
          grant.provider,
          client,
          client === 'web' ? reauthSecretHash(secret) : null
        )

        expect(opened.createdAt).toBe(grant.created_at)
        expect(opened.expiresAt).toBe(grant.created_at + 600)

        const done = store.completeGrant(opened.id, {
          sessionUser: session.user_id,
          sessionProvider: session.provider,
          authTime: session.auth_time,
          client,
          secret: client === 'web' ? secret : null,
          useSecretHash: client === 'native' ? reauthSecretHash('use') : null,
          acceptMissing: vector.accept_missing_auth_time
        })

        expect(done.state).toBe(vector.expect.state)

        if (vector.expect.state === 'failed') {
          expect(done.failure).toBe(vector.expect.failure)
        } else {
          expect(done.authTimeAssumed).toBe(vector.expect.auth_time_assumed)
        }
      })
    }
  }
})
