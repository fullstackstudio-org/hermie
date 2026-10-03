import { GatewayError } from '@hermie/gateway-client'
import { afterEach, describe, expect, it } from 'vitest'

import { resetLocale, setLanguageChoice } from '../i18n/locale'
import { fakeFetch, gatedRoutes, json, meRoute, ungatedRoutes } from '../test-support/fake-fetch'
import { deriveBasePath, type ResolvedBasePath } from './base-path'
import { boot, describeBootFailure } from './boot'

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

  it('stops at token mode on an ungated gateway, without asking who is signed in', async () => {
    const { fetch, calls } = fakeFetch(ungatedRoutes)

    expect(await boot(basePath, { fetchImpl: fetch })).toMatchObject({ kind: 'token_mode' })
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/api/status'])
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
