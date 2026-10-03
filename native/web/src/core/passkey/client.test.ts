/**
 * What the passkey routes' refusals carry back: the route's `error` and `reason`, and a 429's
 * `Retry-After`. The routes themselves are `model.integration.test.ts`'s (against the fake gateway).
 */
import { describe, expect, it } from 'vitest'

import { createPasskeyClient, parseRetryAfter, type PasskeyRouteError } from './client'

const BASE = 'https://gw.example.test'

const answering = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  createPasskeyClient(BASE, async () => new Response(JSON.stringify(body), { status, headers }))

const refusal = async (call: Promise<unknown>): Promise<PasskeyRouteError> => {
  try {
    await call
  } catch (error) {
    return error as PasskeyRouteError
  }

  throw new Error('the call did not fail')
}

describe('reading Retry-After', () => {
  it('takes seconds, and a date against the clock it is given', () => {
    expect(parseRetryAfter('600')).toBe(600)
    expect(parseRetryAfter(' 30 ')).toBe(30)
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:30 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(30)
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:29:00 GMT'))).toBe(0)
  })

  it('says nothing for an absent or unreadable value', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('soon')).toBeNull()
  })
})

describe('a refused route call', () => {
  it('carries the wait the gateway asked for on a 429', async () => {
    const client = answering(
      429,
      { error: 'rate_limited', detail: 'Too many registrations; try again later.' },
      { 'retry-after': '600' }
    )
    const error = await refusal(client.registerBegin({ rp_id: 'gw.example.test', base_url: BASE, name: 'x' }))

    expect(error).toMatchObject({ kind: 'refused', status: 429, error: 'rate_limited', retryAfter: 600 })
  })

  it('has no wait when the 429 names none, and none on any other refusal', async () => {
    const plain = await refusal(
      answering(429, { error: 'rate_limited' }).stepupBegin({ purpose: 'invite', subject: '' })
    )
    const other = await refusal(
      answering(403, { error: 'code_invalid' }, { 'retry-after': '5' }).registerFinish({
        registration_id: 'r',
        base_url: BASE,
        code: 'c',
        credential: { id: 'i', client_data_json: 'a', attestation_object: 'b' }
      })
    )

    expect(plain.retryAfter).toBeNull()
    expect(other.retryAfter).toBeNull()
  })

  it('carries the error of a write the gateway does not take from this page’s address', async () => {
    const error = await refusal(
      answering(403, { error: 'origin_not_listed', detail: 'A browser write needs an Origin that is listed.' }).invite({
        stepup_id: 's',
        base_url: BASE,
        assertion: {} as never
      })
    )

    expect(error).toMatchObject({ kind: 'refused', status: 403, error: 'origin_not_listed', retryAfter: null })
  })
})
