/**
 * A native sign-out ends the grant at the gateway, then forgets it here.
 *
 * It used to do only the second half: the tokens left the device and the grant
 * stayed alive at the identity provider until it expired by itself. A gateway
 * that has `POST /auth/native/revoke` advertises `native_revoke` on
 * `/api/status`, and on one of those the refresh token is now handed back
 * before it is wiped — best effort, and never in the way of the wipe.
 */
import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterEach, describe, expect, it } from 'vitest'

import { NativePkceCredentials } from './credentials'
import { exchangeCode, refreshTokens, TokenCoordinator, type TokenSet, type TokenStore } from './native-auth'
import { buildAuthorizeUrl, createPkce, parseLoopbackRedirect, REDIRECT_URI } from './pkce'

const live: FakeGateway[] = []

afterEach(async () => {
  await Promise.all(live.splice(0).map(gateway => gateway.close()))
})

function memoryStore(initial: TokenSet | null): TokenStore & { value: () => TokenSet | null } {
  let stored = initial

  return {
    value: () => stored,
    async load() {
      return stored
    },
    async save(tokens) {
      stored = tokens
    },
    async clear() {
      stored = null
    }
  }
}

async function gateway(options: { nativeRevoke?: boolean } = {}): Promise<FakeGateway> {
  const started = await startFakeGateway({ port: 0, auth: 'native', ...options })
  live.push(started)

  return started
}

/** The real native PKCE round trip against the fake gateway. */
async function signIn(on: FakeGateway): Promise<TokenSet> {
  const pkce = createPkce()
  const authorize = new URL(
    buildAuthorizeUrl(on.url, {
      provider: 'self-hosted',
      challenge: pkce.challenge,
      state: pkce.state,
      redirectUri: REDIRECT_URI
    })
  )
  authorize.searchParams.set('auto', '1')

  const location = (await fetch(authorize, { redirect: 'manual' })).headers.get('location') ?? ''
  const redirect = parseLoopbackRedirect(location)

  if ('error' in redirect) {
    throw new Error(`Sign-in failed: ${redirect.error}`)
  }

  return exchangeCode(on.url, { code: redirect.code, verifier: pkce.verifier })
}

function credentialsFor(
  baseUrl: string,
  tokens: TokenSet,
  extra: { fetchImpl?: typeof fetch; extraHeaders?: Record<string, string>; revokeTimeoutMs?: number } = {}
) {
  const store = memoryStore(tokens)
  const coordinator = new TokenCoordinator({ store, refresh: current => refreshTokens(baseUrl, current) })
  const credentials = new NativePkceCredentials({ baseUrl, coordinator, ...extra })

  return { credentials, store }
}

/** A `fetch` that records what it was asked and passes it on to the real one. */
function recording(): { fetchImpl: typeof fetch; calls: { path: string; init: RequestInit }[] } {
  const calls: { path: string; init: RequestInit }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, init: init ?? {} })

    return fetch(input, init)
  }) as typeof fetch

  return { fetchImpl, calls }
}

describe('a native sign-out on a gateway that advertises native_revoke', () => {
  it('hands the refresh token and provider back, without a bearer, then wipes', async () => {
    const on = await gateway()
    const tokens = await signIn(on)
    const { credentials, store } = credentialsFor(on.url, tokens)

    await credentials.signOut()

    expect(on.state.revokeCalls).toEqual([
      { refreshToken: tokens.refreshToken, provider: 'self-hosted', authorization: false }
    ])
    expect(store.value()).toBeNull()
    // The grant is over at the gateway: the same refresh token no longer rotates.
    await expect(refreshTokens(on.url, tokens)).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })

  it('carries the front door with it, and refuses to follow a redirect with the token in the body', async () => {
    const on = await gateway()
    const tokens = await signIn(on)
    const { fetchImpl, calls } = recording()
    const { credentials } = credentialsFor(on.url, tokens, {
      fetchImpl,
      extraHeaders: { 'CF-Access-Client-Id': 'abc.access', 'CF-Access-Client-Secret': 'shh' }
    })

    await credentials.signOut()

    const revoke = calls.find(call => call.path === '/auth/native/revoke')
    const sent = new Headers(revoke?.init.headers)

    expect(revoke?.init.method).toBe('POST')
    expect(revoke?.init.redirect).toBe('manual')
    expect(sent.get('CF-Access-Client-Secret')).toBe('shh')
    expect(sent.has('authorization')).toBe(false)
    expect(JSON.parse(String(revoke?.init.body))).toEqual({
      refresh_token: tokens.refreshToken,
      provider: 'self-hosted'
    })
  })
})

describe('a native sign-out the gateway cannot help with', () => {
  it('sends no revoke when the flow is not advertised, and still wipes', async () => {
    const on = await gateway({ nativeRevoke: false })
    const tokens = await signIn(on)
    const { fetchImpl, calls } = recording()
    const { credentials, store } = credentialsFor(on.url, tokens, { fetchImpl })

    await credentials.signOut()

    expect(calls.map(call => call.path)).toEqual(['/api/status'])
    expect(on.state.revokeCalls).toEqual([])
    expect(store.value()).toBeNull()
  })

  it('wipes even when the revoke fails', async () => {
    const on = await gateway()
    const tokens = await signIn(on)
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/auth/native/revoke') {
        throw new Error('connect ECONNRESET')
      }

      return fetch(input, init)
    }) as typeof fetch
    const { credentials, store } = credentialsFor(on.url, tokens, { fetchImpl: failing })

    await expect(credentials.signOut()).resolves.toBeUndefined()
    expect(store.value()).toBeNull()
  })

  it('does not wait on a revoke that hangs for longer than its budget', async () => {
    const on = await gateway()
    const tokens = await signIn(on)
    // Hangs, and ignores the abort as well: the wipe must not depend on the
    // platform's fetch honouring it.
    const hanging = (async (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input)).pathname === '/auth/native/revoke'
        ? new Promise<Response>(() => {})
        : fetch(input, init)) as typeof fetch
    const { credentials, store } = credentialsFor(on.url, tokens, { fetchImpl: hanging, revokeTimeoutMs: 200 })

    const started = Date.now()
    await credentials.signOut()

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(store.value()).toBeNull()
  })

  it('wipes when the gateway is not there at all', async () => {
    const on = await gateway()
    const tokens = await signIn(on)
    const address = on.url
    await on.close()
    live.splice(live.indexOf(on), 1)

    const { credentials, store } = credentialsFor(address, tokens)

    await credentials.signOut()

    expect(store.value()).toBeNull()
  })

  it('sends nothing when there is no refresh token to hand back', async () => {
    const on = await gateway()
    const tokens = await signIn(on)
    const { fetchImpl, calls } = recording()
    const { credentials, store } = credentialsFor(on.url, { ...tokens, refreshToken: '' }, { fetchImpl })

    await credentials.signOut()

    expect(calls).toEqual([])
    expect(store.value()).toBeNull()
  })
})
