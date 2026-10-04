import { GatewayError } from '@hermie/gateway-client'
import { afterEach, describe, expect, it } from 'vitest'

import { resetLocale, setLanguageChoice } from '../i18n/locale'
import { fakeFetch, gatedRoutes, json, meRoute, type RecordedCall, ungatedRoutes } from '../test-support/fake-fetch'
import { deriveBasePath, type ResolvedBasePath } from './base-path'
import { boot, bootWithToken, describeBootFailure } from './boot'

const basePath = deriveBasePath({
  origin: 'https://gateway.example.com',
  pathname: '/dashboard-plugins/hermie/app/index.html'
}) as ResolvedBasePath

afterEach(() => {
  resetLocale()
})

describe('the boot state machine', () => {
  it('ends signed in on a gated gateway with a live session', async () => {
    const { fetch, calls } = fakeFetch({ ...gatedRoutes, 'GET /api/auth/me': meRoute })
    const state = await boot(basePath, { fetchImpl: fetch })

    expect(state).toMatchObject({
      kind: 'signed_in',
      basePath,
      probe: { authRequired: true },
      identity: { userId: 'tester', provider: 'basic' },
      author: { id: 'basic:tester', name: 'Tester' }
    })
    expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /api/status',
      'GET /api/auth/providers',
      'GET /api/auth/me'
    ])
  })

  it('needs a sign-in when the session lapsed between the document load and now', async () => {
    const { fetch } = fakeFetch({
      ...gatedRoutes,
      'GET /api/auth/me': () => json(401, { error: 'session_expired', login_url: '/login' })
    })

    expect(await boot(basePath, { fetchImpl: fetch })).toMatchObject({ kind: 'needs_signin', basePath })
  })

  it('is unreachable, not a sign-in, when something in front of the gateway answers 403 for the identity', async () => {
    const { fetch } = fakeFetch({ ...gatedRoutes, 'GET /api/auth/me': () => json(403, { detail: 'Forbidden' }) })
    const state = await boot(basePath, { fetchImpl: fetch })

    expect(state).toMatchObject({ kind: 'unreachable', error: { kind: 'auth', status: 403 } })

    if (state.kind !== 'unreachable') {
      throw new Error(`expected unreachable, got ${state.kind}`)
    }

    // The words name the status and do not send the reader round the sign-in loop or to a screen this client lacks.
    const said = describeBootFailure(state.error, basePath.baseUrl)

    expect(said).toContain('HTTP 403')
    expect(said).not.toMatch(/Advanced/u)
  })

  describe('on a gateway without sign-in', () => {
    const TOKEN = 'tok-Abc_123'
    const dashboard = (token: string | null) => () =>
      new Response(
        `<!doctype html><html><head><script>${token === null ? '' : `window.__HERMES_SESSION_TOKEN__="${token}";`}` +
          'window.__HERMES_AUTH_REQUIRED__=false;</script></head><body></body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
      )
    /** `/api/profiles` as an ungated gateway answers it: only with the right token. */
    const profiles = (accepted: string) => (call: RecordedCall) =>
      call.headers['x-hermes-session-token'] === accepted
        ? json(200, { profiles: [] })
        : json(401, { detail: 'Unauthorized' })

    it('reads the token from the dashboard’s bootstrap, checks it, and never asks who is signed in', async () => {
      const { fetch, calls } = fakeFetch({
        ...ungatedRoutes,
        'GET /': dashboard(TOKEN),
        'GET /api/profiles': profiles(TOKEN)
      })
      const state = await boot(basePath, { fetchImpl: fetch })

      expect(state).toMatchObject({ kind: 'token_ready', basePath, probe: { authRequired: false } })
      expect(calls.map(call => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
        'GET /api/status',
        'GET /',
        'GET /api/profiles'
      ])
      // The token rides as the header, and in no address.
      expect(calls[2]?.headers['x-hermes-session-token']).toBe(TOKEN)
      expect(calls.some(call => call.url.includes(TOKEN))).toBe(false)

      if (state.kind !== 'token_ready') {
        throw new Error(`expected token_ready, got ${state.kind}`)
      }

      // The socket gets it as `?token=`, the one address it may appear in.
      const plan = await state.session.credentials.dialPlan('wss://gateway.example.com/api/ws', {})

      expect(new URL(plan.url).searchParams.get('token')).toBe(TOKEN)
    })

    it('needs the token typed when the bootstrap carries none', async () => {
      const { fetch, calls } = fakeFetch({ ...ungatedRoutes, 'GET /': dashboard(null) })

      expect(await boot(basePath, { fetchImpl: fetch })).toMatchObject({ kind: 'needs_token', reason: 'absent' })
      expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/api/status', '/'])
    })

    it('needs the token typed when the gateway refuses the one its bootstrap gave', async () => {
      const { fetch } = fakeFetch({
        ...ungatedRoutes,
        'GET /': dashboard('stale-token'),
        'GET /api/profiles': profiles(TOKEN)
      })

      expect(await boot(basePath, { fetchImpl: fetch })).toMatchObject({ kind: 'needs_token', reason: 'rejected' })
    })

    it('is unreachable, not a token prompt, when the check fails for another reason', async () => {
      const { fetch } = fakeFetch({
        ...ungatedRoutes,
        'GET /': dashboard(TOKEN),
        'GET /api/profiles': () => json(403, { detail: 'Forbidden' })
      })

      expect(await boot(basePath, { fetchImpl: fetch })).toMatchObject({
        kind: 'unreachable',
        error: { kind: 'auth', status: 403 }
      })
    })

    it('checks a typed token the same way', async () => {
      const { fetch, calls } = fakeFetch({ ...ungatedRoutes, 'GET /api/profiles': profiles(TOKEN) })
      const probe = { authRequired: false } as Parameters<typeof bootWithToken>[1]

      expect(await bootWithToken(basePath, probe, 'wrong', { fetchImpl: fetch })).toMatchObject({
        kind: 'needs_token',
        reason: 'rejected'
      })
      expect(await bootWithToken(basePath, probe, TOKEN, { fetchImpl: fetch })).toMatchObject({ kind: 'token_ready' })
      expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/api/profiles', '/api/profiles'])
    })
  })

  it('is unreachable when the probe fails, and when the identity read fails for another reason', async () => {
    const offline = await boot(basePath, { fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) })
    expect(offline).toMatchObject({ kind: 'unreachable', error: { kind: 'network' } })

    const { fetch } = fakeFetch({ ...gatedRoutes, 'GET /api/auth/me': () => json(503, {}) })
    expect(await boot(basePath, { fetchImpl: fetch })).toMatchObject({
      kind: 'unreachable',
      error: { kind: 'server', status: 503 }
    })
  })
})

describe('a failed boot, in words', () => {
  const host = 'gateway.example.com'
  const say = (error: GatewayError) => describeBootFailure(error, basePath.baseUrl)

  it('names the host and uses the catalogue’s copy', () => {
    expect(say(new GatewayError('network', 'x'))).toContain(host)
    expect(say(new GatewayError('timeout', 'x'))).toContain(host)
    expect(say(new GatewayError('tls', 'x'))).toContain(host)
    expect(say(new GatewayError('not_hermes', 'x'))).toContain(host)
    expect(say(new GatewayError('server', 'x', { status: 502 }))).toContain('502')
    expect(say(new GatewayError('auth', 'x', { status: 403 }))).toContain('HTTP 403')
    expect(say(new GatewayError('auth', 'x', { status: 401 }))).toContain('HTTP 401')
    expect(say(new GatewayError('redirect', 'x', { redirectedTo: 'elsewhere.example.com' }))).toContain(
      'elsewhere.example.com'
    )
    expect(say(new GatewayError('config', 'x'))).toBe('Something went wrong.')
  })

  it('is read in the language in use when it is asked for', async () => {
    const english = say(new GatewayError('network', 'x'))

    await setLanguageChoice('nl')

    expect(say(new GatewayError('network', 'x'))).not.toBe(english)
    expect(say(new GatewayError('network', 'x'))).toContain(host)
  })
})
