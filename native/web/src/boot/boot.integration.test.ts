// @vitest-environment node
/**
 * Boot against the fake gateway in cookie mode, the way a browser on the
 * gateway's own origin does: sign in through the gateway's
 * `/auth/password-login` (the request its `/login` page makes), then boot,
 * read the identity, mint a socket ticket on the session, and sign out.
 *
 * Node rather than jsdom, on purpose: the network half of the boot touches no
 * DOM, and this proves it. The only browser behaviour the session needs is a
 * cookie jar for the page's origin, which `browserFetch` supplies; nothing in
 * the client reads or writes the cookie itself.
 */
import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { wsUrlFor } from '@hermie/gateway-client'
import { afterEach, describe, expect, it } from 'vitest'

import { FallbackChatCache, IndexedDbChatCache } from '../platform/chat-cache'
import { createKeyValueStore } from '../platform/key-value-store'
import { browserFetch } from '../test-support/browser-fetch'
import { createFakeIndexedDb } from '../test-support/fake-indexed-db'
import { APP_DOCUMENT_PATH, deriveBasePath, type ResolvedBasePath } from './base-path'
import { boot, bootWithToken } from './boot'
import { claimForOwner, type BounceEnvironment, loginUrl, signOut } from './login-bounce'

const gateways: FakeGateway[] = []

afterEach(async () => {
  while (gateways.length) {
    await gateways.pop()?.close()
  }
})

async function start(auth: 'cookie' | 'token' | 'none'): Promise<{ gateway: FakeGateway; basePath: ResolvedBasePath }> {
  const gateway = await startFakeGateway({ port: 0, host: '127.0.0.1', auth })
  gateways.push(gateway)

  const basePath = deriveBasePath({ origin: new URL(gateway.url).origin, pathname: APP_DOCUMENT_PATH })

  if (!basePath.ok) {
    throw new Error('the fake gateway’s address is not a client path')
  }

  return { gateway, basePath }
}

/** What the gateway's `/login` page does with what the person typed. */
async function signInAsTester(browser: ReturnType<typeof browserFetch>, gateway: FakeGateway): Promise<void> {
  const response = await browser.fetch(`${gateway.url}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'hunter2', next: APP_DOCUMENT_PATH })
  })

  expect(response.status).toBe(200)
}

const fakeState = async (gateway: FakeGateway) =>
  (await (await fetch(`${gateway.url}/__fake/state`)).json()) as { ticketsMinted: number }

describe('boot against the fake gateway (cookie mode)', () => {
  it('needs a sign-in before one, and is signed in as the person after it', async () => {
    const { gateway, basePath } = await start('cookie')
    const browser = browserFetch(new URL(gateway.url).origin)

    expect(await boot(basePath, { fetchImpl: browser.fetch })).toMatchObject({ kind: 'needs_signin' })

    await signInAsTester(browser, gateway)
    // The session is the browser's: an HttpOnly cookie in its jar, not a value the client holds.
    expect(browser.cookies.size).toBe(1)

    const state = await boot(basePath, { fetchImpl: browser.fetch })

    expect(state.kind).toBe('signed_in')

    if (state.kind !== 'signed_in') {
      return
    }

    expect(state.probe.authRequired).toBe(true)
    expect(state.probe.authFlows).toContain('cookie')
    expect(state.identity.userId).toBe('tester@example.invalid')
    expect(state.identity.provider).not.toBe('')
    expect(state.author?.id).toBe(`${state.identity.provider}:tester@example.invalid`)
    // Every call after the probe asked for the same-origin cookie and nothing wider.
    expect(browser.modes.filter(mode => mode !== undefined)).toEqual(
      browser.modes.filter(mode => mode !== undefined).map(() => 'same-origin')
    )
  })

  it('mints a socket ticket on the session, one per dial', async () => {
    const { gateway, basePath } = await start('cookie')
    const browser = browserFetch(new URL(gateway.url).origin)

    await signInAsTester(browser, gateway)
    const state = await boot(basePath, { fetchImpl: browser.fetch })

    if (state.kind !== 'signed_in') {
      throw new Error(`expected signed_in, got ${state.kind}`)
    }

    const before = (await fakeState(gateway)).ticketsMinted
    const first = await state.session.credentials.dialPlan(wsUrlFor(basePath.baseUrl), {})
    const second = await state.session.credentials.dialPlan(wsUrlFor(basePath.baseUrl), {})

    expect(first.protocols?.[0]).toBe('hermes-gateway-v1')
    expect(first.protocols?.[1]).toMatch(/^hermes-gateway-ticket\./u)
    expect(second.protocols?.[1]).not.toBe(first.protocols?.[1])
    expect((await fakeState(gateway)).ticketsMinted).toBe(before + 2)
  })

  it('needs a sign-in again when the gateway ends the session', async () => {
    const { gateway, basePath } = await start('cookie')
    const browser = browserFetch(new URL(gateway.url).origin)

    await signInAsTester(browser, gateway)
    expect((await boot(basePath, { fetchImpl: browser.fetch })).kind).toBe('signed_in')

    await fetch(`${gateway.url}/__fake/expire-sessions`, { method: 'POST', body: '{}' })

    expect(await boot(basePath, { fetchImpl: browser.fetch })).toMatchObject({ kind: 'needs_signin' })
  })

  it('signs out at the gateway, leaves nothing of the person behind, and goes to /login', async () => {
    const { gateway, basePath } = await start('cookie')
    const browser = browserFetch(new URL(gateway.url).origin)
    const cache = new FallbackChatCache(new IndexedDbChatCache(basePath.namespace, createFakeIndexedDb().factory))
    const store = createKeyValueStore({ namespace: basePath.namespace, storage: null })

    await signInAsTester(browser, gateway)
    const state = await boot(basePath, { fetchImpl: browser.fetch })

    if (state.kind !== 'signed_in') {
      throw new Error(`expected signed_in, got ${state.kind}`)
    }

    await claimForOwner({ cache, store }, state.author?.id)
    await cache.write({ bot: 'researcher', itemsJson: '{}', lastRowId: 1, lastSeq: 1, epoch: null, updatedAt: 1 })
    store.setSync('watermarks', '{}')
    store.setSync('device.language', 'de')

    const assigned: string[] = []
    const environment: BounceEnvironment = {
      location: { pathname: basePath.appPath, search: '', hash: '', assign: url => assigned.push(url) },
      history: { state: null, replaceState: () => {} },
      sessionStorage: null
    }

    await signOut({ basePath, credentials: state.session.credentials, cache, store, environment })

    expect(browser.cookies.size).toBe(0)
    expect(await cache.read('researcher')).toBeNull()
    expect(await store.keys()).toEqual(['device.language'])
    expect(assigned).toEqual([loginUrl(basePath)])
    expect(await boot(basePath, { fetchImpl: browser.fetch })).toMatchObject({ kind: 'needs_signin' })
  })
})

describe('boot against the fake gateway (session token)', () => {
  it('reads the token from the dashboard’s bootstrap and connects on it', async () => {
    const { gateway, basePath } = await start('token')
    const browser = browserFetch(new URL(gateway.url).origin)
    const state = await boot(basePath, { fetchImpl: browser.fetch })

    expect(state).toMatchObject({ kind: 'token_ready', probe: { authRequired: false } })

    if (state.kind !== 'token_ready') {
      return
    }

    // The REST half carries the gateway's own token as the header the gateway reads.
    expect(await state.session.http.requestHeaders()).toEqual({ 'X-Hermes-Session-Token': gateway.state.token })
    // No cookie was needed or set.
    expect(browser.cookies.size).toBe(0)

    // The socket half: `?token=` on the gateway's socket address, which the gateway takes.
    const plan = await state.session.credentials.dialPlan(wsUrlFor(basePath.baseUrl), {})

    expect(new URL(plan.url).searchParams.get('token')).toBe(gateway.state.token)
  })

  it('needs the token typed once the gateway has another one, and takes the right one', async () => {
    const { gateway, basePath } = await start('token')
    const fetchImpl = browserFetch(new URL(gateway.url).origin).fetch
    const first = await boot(basePath, { fetchImpl })

    if (first.kind !== 'token_ready') {
      throw new Error(`expected token_ready, got ${first.kind}`)
    }

    // The gateway restarted with a fresh token: the old one is refused.
    const old = gateway.state.token

    gateway.state.token = 'rotated-token'

    expect(await bootWithToken(basePath, first.probe, old, { fetchImpl })).toMatchObject({
      kind: 'needs_token',
      reason: 'rejected'
    })
    expect(await bootWithToken(basePath, first.probe, 'rotated-token', { fetchImpl })).toMatchObject({
      kind: 'token_ready'
    })
  })

  it('asks for the token on a gateway whose index carries none (--auth none)', async () => {
    const { basePath } = await start('none')

    expect(await boot(basePath, { fetchImpl: browserFetch(new URL(basePath.baseUrl).origin).fetch })).toMatchObject({
      kind: 'needs_token',
      reason: 'absent',
      probe: { authRequired: false }
    })
  })
})
