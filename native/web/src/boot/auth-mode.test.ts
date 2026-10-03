import { CookieSessionCredentials, GatewayError } from '@hermie/gateway-client'
import { describe, expect, it } from 'vitest'

import { fakeFetch, gatedRoutes, json, meRoute, ungatedRoutes } from '../test-support/fake-fetch'
import { createCookieSession, detectAuthMode, readIdentity, SameOriginCookieCredentials } from './auth-mode'

const baseUrl = 'https://gateway.example.com/hermes'

describe('the auth mode', () => {
  it('is the cookie session on a gated gateway', async () => {
    const { fetch, calls } = fakeFetch(gatedRoutes, '/hermes')
    const mode = await detectAuthMode(baseUrl, fetch)

    expect(mode.kind).toBe('cookie')
    expect(mode.probe.authRequired).toBe(true)
    expect(calls[0]?.url).toBe('https://gateway.example.com/hermes/api/status')
  })

  it('is the session token on an ungated one', async () => {
    const { fetch } = fakeFetch(ungatedRoutes, '/hermes')

    expect((await detectAuthMode(baseUrl, fetch)).kind).toBe('token')
  })

  it('throws what the probe found when there is no gateway to ask', async () => {
    const { fetch } = fakeFetch({}, '/hermes')

    await expect(detectAuthMode(baseUrl, fetch)).rejects.toMatchObject({ kind: 'not_hermes', status: 404 })
  })
})

describe('the same-origin cookie session', () => {
  it('is the package’s cookie flow with the cookie narrowed to this origin', () => {
    const credentials = new SameOriginCookieCredentials({ baseUrl })

    expect(credentials).toBeInstanceOf(CookieSessionCredentials)
    expect(credentials.mode).toBe('cookie')
    expect(credentials.fetchCredentials).toBe('same-origin')
    // The package default is untouched for everybody else.
    expect(new CookieSessionCredentials({ baseUrl }).fetchCredentials).toBe('include')
  })

  it('sends REST, the ticket mint and the sign-out as same-origin, with no auth header and no redirect followed', async () => {
    const { fetch, calls } = fakeFetch(
      {
        'GET /api/auth/me': meRoute,
        'POST /api/auth/ws-ticket': () => json(200, { ticket: 't1', ttl_seconds: 30 }),
        'POST /auth/logout': () => new Response(null, { status: 302, headers: { location: '/login' } })
      },
      '/hermes'
    )
    const session = createCookieSession(baseUrl, fetch)

    await session.http.authMe()
    const plan = await session.credentials.dialPlan('wss://gateway.example.com/hermes/api/ws', {})
    await session.credentials.signOut()

    expect(plan).toEqual({
      url: 'wss://gateway.example.com/hermes/api/ws',
      protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.t1']
    })
    expect(calls.map(call => [call.method, new URL(call.url).pathname, call.credentials, call.redirect])).toEqual([
      ['GET', '/hermes/api/auth/me', 'same-origin', 'manual'],
      ['POST', '/hermes/api/auth/ws-ticket', 'same-origin', 'manual'],
      ['POST', '/hermes/auth/logout', 'same-origin', 'manual']
    ])

    for (const call of calls) {
      expect(Object.keys(call.headers).filter(name => /authorization|token|cookie/iu.test(name))).toEqual([])
    }
  })
})

describe('the identity', () => {
  it('is who /api/auth/me names, with the author stamp the gateway writes', async () => {
    const { fetch } = fakeFetch({ 'GET /api/auth/me': meRoute }, '/hermes')
    const result = await readIdentity(createCookieSession(baseUrl, fetch).http)

    expect(result).toMatchObject({
      kind: 'signed_in',
      signedIn: {
        identity: { userId: 'tester', provider: 'basic', displayName: 'Tester' },
        author: { id: 'basic:tester', name: 'Tester' }
      }
    })
  })

  it('has no author when the gateway names no identity', async () => {
    const { fetch } = fakeFetch({ 'GET /api/auth/me': () => json(200, { user_id: '', provider: '' }) }, '/hermes')
    const result = await readIdentity(createCookieSession(baseUrl, fetch).http)

    expect(result).toMatchObject({ kind: 'signed_in', signedIn: { author: undefined } })
  })

  it('needs a sign-in when the session is refused (HTTP 401)', async () => {
    const { fetch } = fakeFetch(
      {
        'GET /api/auth/me': () => json(401, { error: 'session_expired', login_url: '/login' })
      },
      '/hermes'
    )

    expect(await readIdentity(createCookieSession(baseUrl, fetch).http)).toEqual({ kind: 'needs_signin' })
  })

  // The gateway answers a missing or lapsed session with 401. A 403 is a proxy, a firewall or an origin check
  // in front of it: signing in again would reload into the same 403, so it is a failure to show, not a sign-in.
  it('does not take an HTTP 403 for a lapsed session, and throws it with its status', async () => {
    const { fetch } = fakeFetch({ 'GET /api/auth/me': () => json(403, { detail: 'Forbidden' }) }, '/hermes')

    const failure = readIdentity(createCookieSession(baseUrl, fetch).http)

    await expect(failure).rejects.toBeInstanceOf(GatewayError)
    await expect(failure).rejects.toMatchObject({ kind: 'auth', status: 403 })
  })

  it('throws any other failure for the caller to show', async () => {
    const { fetch } = fakeFetch({ 'GET /api/auth/me': () => json(502, { detail: 'Bad Gateway' }) }, '/hermes')

    const failure = readIdentity(createCookieSession(baseUrl, fetch).http)

    await expect(failure).rejects.toBeInstanceOf(GatewayError)
    await expect(failure).rejects.toMatchObject({ kind: 'server', status: 502 })
  })
})
