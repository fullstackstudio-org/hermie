/**
 * The one credential a share extension may hold: what is written, and when it is
 * taken away again.
 *
 * The auth matrix is the whole subject. A session-token gateway can be delivered
 * to from outside the app indefinitely, because a session token is revoked or it
 * is not; an OIDC one can only be delivered to while its access token is still
 * good, because an extension that could refresh would be an extension that can
 * rotate the app's own credential out from under it. Those two sentences are the
 * feature's honest limits and this is where they are pinned.
 */
import type { SecretStore } from '../src/platform/platform-contracts'
import {
  buildShareDeliveryRecord,
  dropShareDeliveryRecordFor,
  parseShareDeliveryRecord,
  publishedShareDeliveryGateway,
  writeShareDeliveryRecord,
  SHARE_DELIVERY_KEY,
  SHARE_DELIVERY_RECORD_VERSION
} from '../src/features/share/delivery-credential'

const base = {
  gatewayId: 'g1',
  gatewayKey: 'abc123',
  baseUrl: 'https://gateway.example',
  headers: { 'cf-access-client-id': 'id' }
}

function store(initial: Record<string, string> = {}): SecretStore & { items: Record<string, string> } {
  const items = { ...initial }

  return {
    items,
    async get(key) {
      return items[key] ?? null
    },
    async set(key, value) {
      items[key] = value
    },
    async delete(key) {
      delete items[key]
    }
  }
}

describe('the auth matrix', () => {
  it('writes a session token with no deadline', () => {
    const record = buildShareDeliveryRecord({ ...base, authMode: 'session_token', sessionToken: 'tok' })

    expect(record).toMatchObject({
      authMode: 'session_token',
      authHeader: 'x-hermes-session-token',
      token: 'tok',
      expiresAt: 0
    })
  })

  it('writes an access token with the deadline the app stored', () => {
    const record = buildShareDeliveryRecord({
      ...base,
      authMode: 'native_pkce',
      accessToken: 'bearer-value',
      expiresAt: 1_700_000_000
    })

    expect(record).toMatchObject({
      authMode: 'native_pkce',
      authHeader: 'authorization',
      token: 'bearer-value',
      expiresAt: 1_700_000_000
    })
  })

  /**
   * The refresh token is the one thing that must never reach an extension. On a
   * provider with rotation the app's stored token dies the moment somebody else
   * spends it, and on one with reuse detection presenting the dead one revokes the
   * session — so a share sheet could sign the app out.
   */
  it('never carries anything but the credential in use', () => {
    const record = buildShareDeliveryRecord({
      ...base,
      authMode: 'native_pkce',
      accessToken: 'bearer-value',
      expiresAt: 1
    })

    expect(JSON.stringify(record)).not.toContain('refresh')
    expect(Object.keys(record ?? {}).sort()).toEqual([
      'authHeader',
      'authMode',
      'baseUrl',
      'expiresAt',
      'gatewayId',
      'gatewayKey',
      'headers',
      'token',
      'version'
    ])
  })

  it('carries the extra headers the gateway insists on, front door and all', () => {
    const record = buildShareDeliveryRecord({ ...base, authMode: 'session_token', sessionToken: 'tok' })

    expect(record?.headers).toEqual({ 'cf-access-client-id': 'id' })
  })

  /**
   * The cookie flow's credential is an `HttpOnly` cookie in a browser's jar. It
   * cannot be copied into a keychain, and it only exists on the web build, where
   * there is no extension to copy it for.
   */
  it('answers nothing for a flow that cannot be delivered from outside the app', () => {
    expect(buildShareDeliveryRecord({ ...base, authMode: 'cookie' })).toBeNull()
    expect(buildShareDeliveryRecord({ ...base, authMode: 'session_token', sessionToken: '' })).toBeNull()
    expect(buildShareDeliveryRecord({ ...base, authMode: 'native_pkce', accessToken: null })).toBeNull()
    expect(buildShareDeliveryRecord({ ...base, baseUrl: '', authMode: 'session_token', sessionToken: 't' })).toBeNull()
  })
})

describe('publishing and taking away', () => {
  it('writes the record under the one unnamespaced key', async () => {
    const secrets = store()
    const record = buildShareDeliveryRecord({ ...base, authMode: 'session_token', sessionToken: 'tok' })

    await writeShareDeliveryRecord(secrets, record)

    expect(parseShareDeliveryRecord(secrets.items[SHARE_DELIVERY_KEY] ?? null)).toEqual(record)
    expect(await publishedShareDeliveryGateway(secrets)).toBe('g1')
  })

  it('deletes rather than leaving a stale token behind when there is nothing to write', async () => {
    const secrets = store({ [SHARE_DELIVERY_KEY]: 'anything' })

    await writeShareDeliveryRecord(secrets, null)

    expect(secrets.items[SHARE_DELIVERY_KEY]).toBeUndefined()
  })

  /**
   * The guard that keeps a sign-out from the gateway nobody is using out of the
   * active one's business. Without it, every `clearCredentials` would stop the
   * sheet from sending — from inside that function one gateway looks like another.
   */
  it('takes the record away only for the gateway that owns it', async () => {
    const secrets = store()

    await writeShareDeliveryRecord(
      secrets,
      buildShareDeliveryRecord({ ...base, authMode: 'session_token', sessionToken: 'tok' })
    )

    expect(await dropShareDeliveryRecordFor(secrets, 'g2')).toBe(false)
    expect(secrets.items[SHARE_DELIVERY_KEY]).toBeDefined()

    expect(await dropShareDeliveryRecordFor(secrets, 'g1')).toBe(true)
    expect(secrets.items[SHARE_DELIVERY_KEY]).toBeUndefined()
  })

  /**
   * A keychain that refuses is a share that queues, never an exception in a store
   * subscription: these are called from the end of a registry write and from the
   * end of a token rotation, and both have already done the thing that mattered.
   */
  it('never throws when the store does', async () => {
    const broken: SecretStore = {
      async get() {
        throw new Error('locked')
      },
      async set() {
        throw new Error('locked')
      },
      async delete() {
        throw new Error('locked')
      }
    }

    expect(await writeShareDeliveryRecord(broken, null)).toBe(false)
    expect(await dropShareDeliveryRecordFor(broken, 'g1')).toBe(false)
    expect(await publishedShareDeliveryGateway(broken)).toBeNull()
  })
})

describe('reading a record back', () => {
  it('refuses a version this build does not understand', () => {
    expect(
      parseShareDeliveryRecord(JSON.stringify({ version: SHARE_DELIVERY_RECORD_VERSION + 1, token: 't' }))
    ).toBeNull()
    expect(parseShareDeliveryRecord('not json')).toBeNull()
    expect(parseShareDeliveryRecord(null)).toBeNull()
  })

  it('refuses an auth mode nothing can be sent with', () => {
    expect(
      parseShareDeliveryRecord(JSON.stringify({ version: SHARE_DELIVERY_RECORD_VERSION, authMode: 'cookie' }))
    ).toBeNull()
  })
})
