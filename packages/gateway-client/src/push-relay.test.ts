/**
 * The `relay` transport: a row a native Apple build writes so a notifier can
 * deliver through the project's push relay instead of through Expo.
 *
 * Three promises are pinned here, and the last one is the reason the transport
 * could be added without bumping `v`:
 *
 *  - the ROW: what a relay registration looks like, with `enc` carried as-is.
 *  - the READER: `pushAddressOf` accepts exactly the rows a sender may use and
 *    refuses every confusion (two transports at once, a relay that is not an
 *    https origin, an empty handle or secret, a platform the relay cannot reach).
 *  - the OLD READERS: a notifier or app built before the transport existed
 *    drops a relay row as unreadable and every writer still carries it. That is
 *    proven against a frozen copy of the reader those builds shipped, not
 *    against this module's own types.
 */
import { describe, expect, it } from 'vitest'

import {
  foreignPushRows,
  noPushTypes,
  PUSH_RELAY_ORIGIN,
  pushAddressOf,
  pushRelayAllowed,
  pushRelayOriginOf,
  pushRowFor,
  pushSectionFor,
  type PushRegistrationInput
} from './push'
import { PLUGIN_CAPABILITIES } from './plugin'

const NOW = 1_789_957_143

const RELAY = {
  transport: 'relay' as const,
  relay: PUSH_RELAY_ORIGIN,
  handle: 'h_test-handle-0001',
  secret: 'test-send-secret-0001'
}

const relayRegistration = (patch: Partial<PushRegistrationInput> = {}): PushRegistrationInput => ({
  installationId: 'i-phone',
  gatewayKey: 'bf796761db84e312',
  address: RELAY,
  platform: 'ios',
  types: { ...noPushTypes(), message: true, request: true },
  preview: false,
  updatedAt: NOW,
  ...patch
})

const relayRow = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  transport: 'relay',
  relay: PUSH_RELAY_ORIGIN,
  handle: 'h_test-handle-0001',
  secret: 'test-send-secret-0001',
  platform: 'ios',
  types: { message: true },
  preview: false,
  updatedAt: NOW,
  ...patch
})

/**
 * The reader every notifier and app shipped before the relay transport, frozen.
 *
 * This is `pushRegistrationOf`'s transport rule from `hermie-web` 0.1.9
 * (the old Hermie Web's `src/push/registrations.ts`, removed from the
 * repository), restated without its bookkeeping: `v` must be 1, `expo` needs a token and no endpoint, `webpush`
 * needs an endpoint and both keys and no token, and ANY other transport is
 * dropped. It must not be edited to follow the current reader; it is the
 * baseline the new rows are checked against.
 */
function readableBefore(row: unknown): boolean {
  if (!row || typeof row !== 'object') {
    return false
  }

  const value = row as Record<string, unknown>
  const str = (field: unknown): string => (typeof field === 'string' ? field : '')

  if (value.v !== 1) {
    return false
  }

  const keys = (value.keys ?? {}) as Record<string, unknown>

  if (value.transport === 'expo') {
    return Boolean(str(value.token)) && !str(value.endpoint)
  }

  if (value.transport === 'webpush') {
    return Boolean(str(value.endpoint)) && Boolean(str(keys.p256dh)) && Boolean(str(keys.auth)) && !str(value.token)
  }

  return false
}

describe('a relay row', () => {
  it('writes the relay, the handle and the secret, and nothing of the other transports', () => {
    expect(pushRowFor(relayRegistration())).toEqual({
      v: 1,
      transport: 'relay',
      relay: 'https://push.hermie.dev',
      handle: 'h_test-handle-0001',
      secret: 'test-send-secret-0001',
      platform: 'ios',
      types: { ...noPushTypes(), message: true, request: true },
      preview: false,
      gatewayKey: 'bf796761db84e312',
      updatedAt: NOW
    })
  })

  it('carries `enc` exactly as it was handed over, unknown fields included', () => {
    const enc = { alg: 'chacha20-poly1305', key: 'k', kid: 1, future: { nested: [1, 2] } }
    const row = pushRowFor(relayRegistration({ address: { ...RELAY, enc } }))

    expect(row.enc).toEqual(enc)
  })

  it('omits `enc` when there is none, rather than writing an empty one', () => {
    expect(pushRowFor(relayRegistration())).not.toHaveProperty('enc')
  })

  it('round-trips through the reader', () => {
    const row = pushRowFor(relayRegistration({ platform: 'macos', address: { ...RELAY, enc: { kid: 2 } } }))

    expect(pushAddressOf(row)).toEqual({ ...RELAY, enc: { kid: 2 } })
  })
})

describe('reading a row', () => {
  it('accepts a well-formed relay row', () => {
    expect(pushAddressOf(relayRow())).toEqual(RELAY)
    expect(pushAddressOf(relayRow({ platform: 'macos' }))).toEqual(RELAY)
  })

  it('refuses a row from another version', () => {
    expect(pushAddressOf(relayRow({ v: 2 }))).toBeNull()
    expect(pushAddressOf(relayRow({ v: '1' }))).toBeNull()
    expect(pushAddressOf(relayRow({ v: undefined }))).toBeNull()
  })

  it('refuses a relay that is not an https origin', () => {
    for (const relay of [
      'http://push.hermie.dev',
      'https://push.hermie.dev/v1/send',
      'https://push.hermie.dev/?x=1',
      'https://push.hermie.dev#x',
      'https://user:pass@push.hermie.dev',
      'https://push.hermie.dev:443',
      'https://push.hermie.dev//',
      'push.hermie.dev',
      ' https://push.hermie.dev',
      '',
      42,
      null
    ]) {
      expect({ relay, address: pushAddressOf(relayRow({ relay })) }).toEqual({ relay, address: null })
    }
  })

  it('accepts a handle and a secret of 1 to 200 base64url characters, and nothing else', () => {
    expect(pushAddressOf(relayRow({ handle: 'h', secret: 'A-_z09' }))).not.toBeNull()
    expect(pushAddressOf(relayRow({ handle: 'h'.repeat(200), secret: 's'.repeat(200) }))).not.toBeNull()

    for (const bad of ['h'.repeat(201), 'h_with space', 'h_slash/', 'h_plus+', 'h_eq=', 'h_\u00e9', 'h_new\nline']) {
      expect({ bad, handle: pushAddressOf(relayRow({ handle: bad })) }).toEqual({ bad, handle: null })
      expect({ bad, secret: pushAddressOf(relayRow({ secret: bad })) }).toEqual({ bad, secret: null })
    }
  })

  it('refuses an empty or missing handle or secret', () => {
    expect(pushAddressOf(relayRow({ handle: '' }))).toBeNull()
    expect(pushAddressOf(relayRow({ handle: undefined }))).toBeNull()
    expect(pushAddressOf(relayRow({ handle: 7 }))).toBeNull()
    expect(pushAddressOf(relayRow({ secret: '' }))).toBeNull()
    expect(pushAddressOf(relayRow({ secret: undefined }))).toBeNull()
    expect(pushAddressOf(relayRow({ secret: { value: 'x' } }))).toBeNull()
  })

  it('refuses a platform the relay cannot reach', () => {
    for (const platform of ['android', 'web', '', undefined, 'iOS']) {
      expect(pushAddressOf(relayRow({ platform }))).toBeNull()
    }
  })

  it('never reads a row carrying both a token and a handle', () => {
    expect(pushAddressOf(relayRow({ token: 'ExponentPushToken[abc]' }))).toBeNull()
    expect(pushAddressOf(relayRow({ endpoint: 'https://push.example.com/x' }))).toBeNull()
    expect(
      pushAddressOf({ v: 1, transport: 'expo', token: 'ExponentPushToken[abc]', handle: 'h_x', secret: 's' })
    ).toBeNull()
    expect(
      pushAddressOf({
        v: 1,
        transport: 'webpush',
        endpoint: 'https://push.example.com/x',
        keys: { p256dh: 'p', auth: 'a' },
        handle: 'h_x'
      })
    ).toBeNull()
  })

  it('still reads the two older transports as before', () => {
    expect(pushAddressOf({ v: 1, transport: 'expo', token: 'ExponentPushToken[abc]' })).toEqual({
      transport: 'expo',
      token: 'ExponentPushToken[abc]'
    })
    expect(
      pushAddressOf({
        v: 1,
        transport: 'webpush',
        endpoint: 'https://push.example.com/x',
        keys: { p256dh: 'p', auth: 'a' }
      })
    ).toEqual({ transport: 'webpush', endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } })
  })

  it('refuses a transport it does not know', () => {
    expect(pushAddressOf({ ...relayRow(), transport: 'fcm' })).toBeNull()
    expect(pushAddressOf(null)).toBeNull()
    expect(pushAddressOf([relayRow()])).toBeNull()
  })
})

describe('the allow-list', () => {
  it('normalises an origin and refuses anything that is more than one', () => {
    expect(pushRelayOriginOf('https://push.hermie.dev')).toBe('https://push.hermie.dev')
    expect(pushRelayOriginOf('https://push.hermie.dev/')).toBe('https://push.hermie.dev')
    expect(pushRelayOriginOf('https://PUSH.Hermie.dev')).toBe('https://push.hermie.dev')
    expect(pushRelayOriginOf('https://relay.example.org:8443')).toBe('https://relay.example.org:8443')
    expect(pushRelayOriginOf('https://push.hermie.dev/v1')).toBe('')
    expect(pushRelayOriginOf('http://localhost:8080')).toBe('')
  })

  it('allows only an origin on the list', () => {
    expect(pushRelayAllowed('https://push.hermie.dev', [PUSH_RELAY_ORIGIN])).toBe(true)
    expect(pushRelayAllowed('https://push.hermie.dev/', [PUSH_RELAY_ORIGIN])).toBe(true)
    expect(pushRelayAllowed('https://evil.example', [PUSH_RELAY_ORIGIN])).toBe(false)
    expect(pushRelayAllowed('https://push.hermie.dev.evil.example', [PUSH_RELAY_ORIGIN])).toBe(false)
    expect(pushRelayAllowed('https://push.hermie.dev', [])).toBe(false)
    expect(pushRelayAllowed('https://relay.example.org', [PUSH_RELAY_ORIGIN, 'https://relay.example.org/'])).toBe(true)
  })

  it('names the capability next to the Expo one', () => {
    expect(PLUGIN_CAPABILITIES.pushRelay).toBe('push.relay')
    expect(PLUGIN_CAPABILITIES.pushExpo).toBe('push.expo')
  })
})

describe('older readers and writers', () => {
  it('a reader from before the transport drops a relay row instead of misreading it', () => {
    expect(readableBefore(relayRow())).toBe(false)
    expect(readableBefore(pushRowFor(relayRegistration()))).toBe(false)
    // The baseline really is the old reader: it still reads the rows it knew.
    expect(readableBefore({ v: 1, transport: 'expo', token: 'ExponentPushToken[abc]' })).toBe(true)
  })

  it('an old reader that meets a row with both a token and a handle reads it as Expo, which is why no writer emits one', () => {
    // The old reader only checks `token` and `endpoint`, so a confused row would
    // reach Expo there. `pushRowFor` cannot produce one (the address is a
    // union), and the current reader refuses it outright.
    const confused = { ...relayRow(), transport: 'expo', token: 'ExponentPushToken[abc]' }

    expect(readableBefore(confused)).toBe(true)
    expect(pushAddressOf(confused)).toBeNull()
  })

  it('a writer carries a relay row it did not write, unknown fields and `enc` included', () => {
    const foreign = relayRow({ enc: { kid: 1, key: 'k' }, futureField: { a: 1 } })
    const section = { push: { registrations: { 'i-mac': foreign } } }
    const carried = foreignPushRows(section, 'i-phone')

    expect(carried).toEqual({ 'i-mac': foreign })

    const written = pushSectionFor({
      others: carried,
      own: { ...relayRegistration(), address: { transport: 'expo', token: 'ExponentPushToken[abc]' } },
      seen: {},
      now: NOW
    })

    expect(written?.registrations['i-mac']).toEqual(foreign)
  })

  it('replaces this device’s own Expo row with its relay row under the same installation id', () => {
    const section = {
      push: { registrations: { 'i-phone': { v: 1, transport: 'expo', token: 'ExponentPushToken[abc]' } } }
    }
    const written = pushSectionFor({
      others: foreignPushRows(section, 'i-phone'),
      own: relayRegistration(),
      seen: {},
      now: NOW
    })

    expect(Object.keys(written?.registrations ?? {})).toEqual(['i-phone'])
    expect(written?.registrations['i-phone']).toMatchObject({ transport: 'relay', handle: 'h_test-handle-0001' })
    expect(written?.registrations['i-phone']).not.toHaveProperty('token')
  })
})
