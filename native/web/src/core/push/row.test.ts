/**
 * This browser's row, the key it names, the rule for keeping or replacing a
 * subscription, and the push map a write carries.
 */
import { pushAddressOf, PUSH_TYPES } from '@hermie/gateway-client/push'
import { describe, expect, it } from 'vitest'

import {
  addressOfSubscription,
  APPLICATION_SERVER_KEY,
  applicationServerKeyBytes,
  base64UrlOf,
  bytesOfBase64Url,
  canonicalKey,
  pushMapOf,
  registrationRowOf,
  sameKey,
  subscriptionStep,
  type WebRegistrationInput
} from './row'

/** The fake gateway's advert key: an uncompressed P-256 point, 87 base64url characters. */
const ADVERT_KEY = 'BB4V0uA3Mhr24OQdSBvpiQbXxekA10YihCyW0_L4zE616vb3_kTg5WvgJ_rP5L6QUdFKymkHRs2SDtj8M9czWIw'

/** Another valid key: the same point with one byte changed. */
const OTHER_KEY = base64UrlOf(
  (() => {
    const bytes = applicationServerKeyBytes(ADVERT_KEY) as Uint8Array

    bytes[10] = (bytes[10] as number) ^ 0xff

    return bytes
  })()
)

const allTypes = Object.fromEntries(PUSH_TYPES.map(type => [type, true])) as WebRegistrationInput['types']

const own = (overrides: Partial<WebRegistrationInput> = {}): WebRegistrationInput => ({
  installationId: 'iaaaaaaaaaaaaaaaa',
  gatewayKey: 'bf796761db84e312',
  address: {
    transport: 'webpush',
    endpoint: 'https://push.example.test/send/abc',
    keys: { p256dh: 'p256', auth: 'auth' },
    applicationServerKey: ADVERT_KEY
  },
  types: allTypes,
  preview: false,
  updatedAt: 1_790_000_000,
  ...overrides
})

describe('the key', () => {
  it('reads the advert’s key as the 65 bytes of an uncompressed P-256 point', () => {
    const bytes = applicationServerKeyBytes(ADVERT_KEY)

    expect(ADVERT_KEY).toHaveLength(87)
    expect(bytes).toHaveLength(65)
    expect(bytes?.[0]).toBe(0x04)
    expect(bytes?.buffer).toBeInstanceOf(ArrayBuffer)
  })

  it('refuses what is not one', () => {
    expect(applicationServerKeyBytes('')).toBeNull()
    expect(applicationServerKeyBytes('not base64!')).toBeNull()
    expect(applicationServerKeyBytes(base64UrlOf(new Uint8Array(65)))).toBeNull()
    expect(applicationServerKeyBytes(base64UrlOf(new Uint8Array(33).fill(4)))).toBeNull()
    expect(bytesOfBase64Url('A')).toBeNull()
  })

  it('writes it as base64url without padding, the shape the plugin accepts', () => {
    expect(canonicalKey(ADVERT_KEY)).toBe(ADVERT_KEY)
    expect(APPLICATION_SERVER_KEY.test(canonicalKey(ADVERT_KEY))).toBe(true)

    // The same key spelled as padded standard base64 is the same key.
    const padded = `${ADVERT_KEY.replace(/-/gu, '+').replace(/_/gu, '/')}=`

    expect(canonicalKey(padded)).toBe(ADVERT_KEY)
    expect(sameKey(padded, ADVERT_KEY)).toBe(true)
    expect(sameKey(OTHER_KEY, ADVERT_KEY)).toBe(false)
    expect(sameKey('', '')).toBe(false)
  })
})

describe('the subscription', () => {
  it('is made when there is none', () => {
    expect(subscriptionStep(null, ADVERT_KEY)).toBe('subscribe')
  })

  it('is kept when it was made with the advert’s key', () => {
    expect(subscriptionStep(ADVERT_KEY, ADVERT_KEY)).toBe('keep')
  })

  it('is made again when it was made with another key, or with one that cannot be told', () => {
    expect(subscriptionStep(OTHER_KEY, ADVERT_KEY)).toBe('resubscribe')
    expect(subscriptionStep('', ADVERT_KEY)).toBe('resubscribe')
  })

  it('becomes an address only with an endpoint, both keys and a key it was made with', () => {
    const json = { endpoint: 'https://push.example.test/send/abc', keys: { p256dh: 'p', auth: 'a' } }

    expect(addressOfSubscription(json, ADVERT_KEY)).toEqual({
      transport: 'webpush',
      endpoint: json.endpoint,
      keys: { p256dh: 'p', auth: 'a' },
      applicationServerKey: ADVERT_KEY
    })
    expect(addressOfSubscription({ ...json, keys: { p256dh: 'p' } }, ADVERT_KEY)).toBeNull()
    expect(addressOfSubscription({ keys: json.keys }, ADVERT_KEY)).toBeNull()
    expect(addressOfSubscription(json, 'nope')).toBeNull()
    expect(addressOfSubscription(null, ADVERT_KEY)).toBeNull()
  })
})

describe('the row', () => {
  it('is the shared row plus the key, and the two fields that say what this worker can show', () => {
    expect(registrationRowOf(own())).toEqual({
      v: 1,
      transport: 'webpush',
      endpoint: 'https://push.example.test/send/abc',
      keys: { p256dh: 'p256', auth: 'auth' },
      applicationServerKey: ADVERT_KEY,
      platform: 'web',
      types: allTypes,
      preview: false,
      gatewayKey: 'bf796761db84e312',
      updatedAt: 1_790_000_000,
      clears: true,
      requestMethods: true
    })
  })

  it('is a row every reader accepts as a Web Push address', () => {
    expect(pushAddressOf(registrationRowOf(own()))).toEqual({
      transport: 'webpush',
      endpoint: 'https://push.example.test/send/abc',
      keys: { p256dh: 'p256', auth: 'auth' }
    })
  })

  it('names no gateway key when it has none', () => {
    expect(registrationRowOf(own({ gatewayKey: '' }))).not.toHaveProperty('gatewayKey')
  })
})

describe('the push map', () => {
  const ID = 'iaaaaaaaaaaaaaaaa'
  const phone = { v: 1, transport: 'expo', token: 'ExponentPushToken[x]', platform: 'ios', updatedAt: 1 }
  const gateway = {
    registrations: { iphone: phone, [ID]: { v: 1, transport: 'webpush', endpoint: 'old', keys: {} } },
    seen: { iphone: { bot: 'scout', at: 1_790_000_000 } },
    perBot: { scout: { cron: false } },
    future: { kept: true }
  }
  const base = {
    gateway,
    installationId: ID,
    own: null,
    carryOwn: false,
    seen: null,
    perBot: { scout: { cron: false } },
    now: 1_790_000_100,
    perChat: true
  }

  it('carries every other device’s row and heartbeat, and members it does not know', () => {
    const map = pushMapOf(base)

    expect(map?.registrations).toEqual({ iphone: phone })
    expect(map?.seen).toEqual({ iphone: { bot: 'scout', at: 1_790_000_000 } })
    expect(map?.future).toEqual({ kept: true })
    expect(map?.perBot).toEqual({ scout: { cron: false } })
  })

  it('writes this browser’s row in place of the one the gateway holds', () => {
    const map = pushMapOf({ ...base, own: own() })

    expect((map?.registrations as Record<string, unknown>)[ID]).toEqual(registrationRowOf(own()))
    expect((map?.registrations as Record<string, unknown>).iphone).toEqual(phone)
  })

  it('carries the gateway’s row for this browser until the launch check has run', () => {
    const map = pushMapOf({ ...base, carryOwn: true })

    expect((map?.registrations as Record<string, unknown>)[ID]).toEqual(gateway.registrations[ID])
  })

  it('writes no row for a browser that asked about nothing', () => {
    const none = Object.fromEntries(PUSH_TYPES.map(type => [type, false])) as WebRegistrationInput['types']
    const map = pushMapOf({ ...base, own: own({ types: none }) })

    expect(map?.registrations).toEqual({ iphone: phone })
  })

  it('writes this browser’s heartbeat, the newer of the two, in the shape the plugin reads', () => {
    expect(
      (pushMapOf({ ...base, seen: { bot: 'writer', at: 1_790_000_050 } })?.seen as Record<string, unknown>)[ID]
    ).toEqual({
      bot: 'writer',
      at: 1_790_000_050
    })
    expect(
      (
        pushMapOf({ ...base, perChat: false, seen: { bot: 'writer', at: 1_790_000_050 } })?.seen as Record<
          string,
          unknown
        >
      )[ID]
    ).toBe(1_790_000_050)
  })

  it('takes the person’s per-chat overrides from the store', () => {
    expect(pushMapOf({ ...base, perBot: {} })).not.toHaveProperty('perBot')
    expect(pushMapOf({ ...base, perBot: { writer: { message: false } } })?.perBot).toEqual({
      writer: { message: false }
    })
  })

  it('is nothing at all when there is nothing to say', () => {
    expect(pushMapOf({ ...base, gateway: undefined, perBot: {} })).toBeUndefined()
  })
})
