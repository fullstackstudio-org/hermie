// @vitest-environment node
/**
 * Reading the token again after the gateway refused it: against routes of our own for every branch, and
 * against the fake gateway in `--auth token` rotating its token as a restarted gateway does.
 */
import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { SessionTokenCredentials } from '@hermie/gateway-client'
import { afterEach, describe, expect, it } from 'vitest'

import { browserFetch } from '../test-support/browser-fetch'
import { fakeFetch, gatedRoutes, json, meRoute, type RecordedCall, ungatedRoutes } from '../test-support/fake-fetch'
import { APP_DOCUMENT_PATH, deriveBasePath, type ResolvedBasePath } from './base-path'
import { boot } from './boot'
import { rereadToken } from './token-recovery'

const basePath = deriveBasePath({
  origin: 'https://gateway.example.com',
  pathname: APP_DOCUMENT_PATH
}) as ResolvedBasePath

const OLD = 'tok-old'
const NEW = 'tok-new'

const dashboard = (token: string | null) => () =>
  new Response(
    `<!doctype html><script>${token === null ? '' : `window.__HERMES_SESSION_TOKEN__="${token}";`}</script>`,
    { status: 200, headers: { 'content-type': 'text/html' } }
  )
const profiles = (accepted: string) => (call: RecordedCall) =>
  call.headers['x-hermes-session-token'] === accepted ? json(200, {}) : json(401, { detail: 'Unauthorized' })

const holding = (token: string) => new SessionTokenCredentials({ token })

describe('rereadToken', () => {
  it('restarts on a new token the gateway takes', async () => {
    const { fetch } = fakeFetch({ ...ungatedRoutes, 'GET /': dashboard(NEW), 'GET /api/profiles': profiles(NEW) })
    const result = await rereadToken(basePath, holding(OLD), { fetchImpl: fetch })

    expect(result).toMatchObject({ kind: 'restart', state: { kind: 'token_ready' } })

    if (result.kind === 'restart' && result.state.kind === 'token_ready') {
      expect(await result.state.session.http.requestHeaders()).toEqual({ 'X-Hermes-Session-Token': NEW })
    }
  })

  it('is unchanged when the dashboard still carries the refused token, without checking it again', async () => {
    const { fetch, calls } = fakeFetch({
      ...ungatedRoutes,
      'GET /': dashboard(OLD),
      'GET /api/profiles': profiles(NEW)
    })

    expect(await rereadToken(basePath, holding(OLD), { fetchImpl: fetch })).toEqual({ kind: 'unchanged' })
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/api/status', '/'])
  })

  it('fails when the probe, the page or the new token fails', async () => {
    const offline = await rereadToken(basePath, holding(OLD), {
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch'))
    })
    const noToken = await rereadToken(basePath, holding(OLD), {
      fetchImpl: fakeFetch({ ...ungatedRoutes, 'GET /': dashboard(null) }).fetch
    })
    const refused = await rereadToken(basePath, holding(OLD), {
      fetchImpl: fakeFetch({ ...ungatedRoutes, 'GET /': dashboard(NEW), 'GET /api/profiles': profiles('other') }).fetch
    })

    expect([offline, noToken, refused]).toEqual([{ kind: 'failed' }, { kind: 'failed' }, { kind: 'failed' }])
  })

  it('goes to the cookie flow when the gateway turned sign-in on meanwhile', async () => {
    const signedIn = await rereadToken(basePath, holding(OLD), {
      fetchImpl: fakeFetch({ ...gatedRoutes, 'GET /api/auth/me': meRoute }).fetch
    })
    const signedOut = await rereadToken(basePath, holding(OLD), {
      fetchImpl: fakeFetch({ ...gatedRoutes, 'GET /api/auth/me': () => json(401, {}) }).fetch
    })

    expect(signedIn).toMatchObject({ kind: 'restart', state: { kind: 'signed_in' } })
    expect(signedOut).toMatchObject({ kind: 'restart', state: { kind: 'needs_signin' } })
  })
})

describe('rereadToken against the fake gateway', () => {
  let gateway: FakeGateway | undefined

  afterEach(async () => {
    await gateway?.close()
    gateway = undefined
  })

  it('follows a restart that minted a new token, and stays put while the token is the same', async () => {
    gateway = await startFakeGateway({ port: 0, host: '127.0.0.1', auth: 'token', token: OLD })

    const path = deriveBasePath({ origin: new URL(gateway.url).origin, pathname: APP_DOCUMENT_PATH })

    if (!path.ok) {
      throw new Error('the fake gateway’s address is not a client path')
    }

    const fetchImpl = browserFetch(new URL(gateway.url).origin).fetch
    const first = await boot(path, { fetchImpl })

    if (first.kind !== 'token_ready') {
      throw new Error(`expected token_ready, got ${first.kind}`)
    }

    expect(await rereadToken(path, first.session.credentials, { fetchImpl })).toEqual({ kind: 'unchanged' })

    gateway.state.token = NEW

    const after = await rereadToken(path, first.session.credentials, { fetchImpl })

    expect(after).toMatchObject({ kind: 'restart', state: { kind: 'token_ready' } })

    if (after.kind === 'restart' && after.state.kind === 'token_ready') {
      const plan = await after.state.session.credentials.dialPlan('ws://127.0.0.1/api/ws', {})

      expect(new URL(plan.url).searchParams.get('token')).toBe(NEW)
    }
  })
})
