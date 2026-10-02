/**
 * This package's copy of the row reader agrees with `@hermie/gateway-client`'s.
 *
 * The reader exists twice for the reason `gateway-key.ts` gives (this package
 * ships with no workspace dependency), so the thing worth testing is that the
 * two copies accept and refuse the same rows. The vectors are the corpus
 * `npm run golden` records from the gateway-client copy; every `pushAddressOf`
 * and `pushRelayOriginOf` entry in it is replayed here against this copy.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { type PushRegistration, pushRegistrationOf, relayOriginOf } from './registrations'

interface Vector {
  fn: string
  args: unknown[]
  result?: unknown
}

const vectors = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contract/gateway/vectors/push.json'), 'utf8')
) as Vector[]

/** The address half of a registration, in the shape `pushAddressOf` answers with. */
function addressOf(registration: PushRegistration | null): unknown {
  if (!registration) {
    return null
  }

  switch (registration.transport) {
    case 'expo':
      return { transport: 'expo', token: registration.token }

    case 'webpush':
      return { transport: 'webpush', endpoint: registration.endpoint, keys: registration.keys }

    case 'relay':
      return {
        transport: 'relay',
        relay: registration.relay,
        handle: registration.handle,
        secret: registration.secret,
        ...(registration.enc !== undefined ? { enc: registration.enc } : {})
      }
  }
}

describe('the daemon’s copy of the row reader', () => {
  const rows = vectors.filter(vector => vector.fn === 'pushAddressOf')
  const origins = vectors.filter(vector => vector.fn === 'pushRelayOriginOf')

  it('has vectors to replay', () => {
    expect(rows.length).toBeGreaterThan(20)
    expect(origins.length).toBeGreaterThan(10)
  })

  it.each(rows.map((vector, index) => [index, vector]))('agrees on row vector %i', (_index, vector) => {
    const { args, result } = vector as Vector

    expect(addressOf(pushRegistrationOf('install-aaaa', args[0]))).toEqual(result)
  })

  it.each(origins.map((vector, index) => [index, vector]))('agrees on origin vector %i', (_index, vector) => {
    const { args, result } = vector as Vector

    expect(relayOriginOf(args[0])).toBe(result)
  })
})
