// @vitest-environment node
/**
 * The passkey model against the fake gateway (cookie mode, the level on, its
 * base URL `https://gw.example.test`), the way a page on that origin runs it:
 * signed in, connected over the runtime's own `WebSocket`, the six routes on the
 * cookie session with the page's `Origin`, and a software authenticator in place
 * of the browser's sheet (`test-support/soft-webauthn.ts`). The gateway verifies
 * every assertion itself, so a model that commits to the wrong thing fails here.
 *
 * One cross-check ties the construction to the TypeScript reference: the
 * challenge the model asked the authenticator to sign equals the one the fake
 * gateway's own `SoftAuthenticator` computes for the same frame.
 */
import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { SoftAuthenticator } from '@hermie/fake-gateway/testing/soft-authenticator'
import type { ServerRequest } from '@hermes/shared/json-rpc-channel'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { APP_DOCUMENT_PATH, deriveBasePath, type ResolvedBasePath } from '../../boot/base-path'
import { boot } from '../../boot/boot'
import { MemoryChatCache } from '../../platform/chat-cache'
import { createKeyValueStore, type StorageLike } from '../../platform/key-value-store'
import { createPasskeyPins } from '../../platform/passkey-pins'
import { createSocketFactoryWithOutbox, ErrorDataOutbox } from '../../platform/socket'
import { createBotsStore } from '../../state/bots'
import { createConnectionStore } from '../../state/connection'
import { createPasskeysStore, type PasskeysState } from '../../state/passkeys'
import { createPluginStore } from '../../state/plugin'
import { type BrowserFetch, browserFetch } from '../../test-support/browser-fetch'
import { fakeNetwork, fakeVisibility } from '../../test-support/fake-watchers'
import { type SoftWebAuthn, softWebAuthn } from '../../test-support/soft-webauthn'
import { connectGateway, type GatewayClient } from '../gateway-client'
import { createPasskeyClient } from './client'
import { PasskeyActionError, PasskeyModel, type SelfEnrolStash } from './model'
import type { StoreApi } from 'zustand/vanilla'

const BASE = 'https://gw.example.test'

const gateways: FakeGateway[] = []
const stops: (() => void)[] = []

afterEach(async () => {
  while (stops.length) {
    stops.pop()?.()
  }

  while (gateways.length) {
    await gateways.pop()?.close()
  }
})

const waitFor = <T>(check: () => T | Promise<T>): Promise<T> => vi.waitFor(check, { timeout: 5_000, interval: 20 })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake's state is JSON
type Json = Record<string, any>

async function control(
  gateway: FakeGateway,
  path: string,
  body: unknown = {}
): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  return { status: response.status, body: (await response.json()) as Json }
}

const fakeState = async (gateway: FakeGateway): Promise<Json> =>
  (await (await fetch(`${gateway.url}/__fake/state`)).json()) as Json

/** A memory `localStorage`, shared by the key-value store and the pins' scan. */
function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()

  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
    key: index => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    }
  }
}

interface Page {
  gateway: FakeGateway
  client: GatewayClient
  model: PasskeyModel
  store: StoreApi<PasskeysState>
  webauthn: SoftWebAuthn
  storage: ReturnType<typeof memoryStorage>
  /** Every `confirm` frame the connection delivered, raw. */
  frames: ServerRequest[]
  /** The browser's cookie jar and the page's `fetch` over it. */
  browser: BrowserFetch
  /** Adding a passkey by signing in again: the tab's stash and the trip to the sign-in page. */
  trip: Trip
}

/** The tab's `sessionStorage` stash, and what the trip to the gateway's sign-in page did. */
interface Trip {
  stash: SelfEnrolStash & { raw(): string | null }
  /** The `login_path` the page was sent to, with `next` as the page appends it. */
  bounced: string[]
  /** The sign-in page's answer to each trip (the simulated sign-in comes back as a redirect to `next`). */
  signedIn: Promise<Response>[]
}

function memoryStash(initial: string | null = null): Trip['stash'] & { raw(): string | null } {
  let raw = initial

  return {
    raw: () => raw,
    read() {
      try {
        const parsed = JSON.parse(raw ?? 'null') as { grant_id?: string; expires_at?: number } | null

        return parsed?.grant_id && typeof parsed.expires_at === 'number'
          ? { grantId: parsed.grant_id, expiresAt: parsed.expires_at }
          : null
      } catch {
        return null
      }
    },
    write(entry) {
      raw = JSON.stringify({ grant_id: entry.grantId, expires_at: entry.expiresAt })

      return true
    },
    clear() {
      raw = null
    }
  }
}

/** A gateway that knows the level and lists `https://gw.example.test`. */
async function passkeyGateway(): Promise<FakeGateway> {
  const gateway = await startFakeGateway({ port: 0, host: '127.0.0.1', auth: 'cookie', passkey: { baseUrls: [BASE] } })

  gateways.push(gateway)

  return gateway
}

/** A signed-in page on `gateway`, connected, with a passkey model of its own. */
async function openPage(
  gateway: FakeGateway,
  options: {
    storage?: ReturnType<typeof memoryStorage>
    sessions?: () => { sessionId: string; lastSeen: number }[]
    /** Wait until the level is accepted (the default), or only until the capability calls ran. */
    advertised?: boolean
    /** The browser of an earlier page (a reload keeps the cookies), already signed in. */
    browser?: BrowserFetch
    /** The tab's stash of an earlier page (a reload keeps `sessionStorage`). */
    stash?: Trip['stash']
  } = {}
): Promise<Page> {
  const basePath = deriveBasePath({ origin: new URL(gateway.url).origin, pathname: APP_DOCUMENT_PATH })

  if (!basePath.ok) {
    throw new Error('the fake gateway’s address is not a client path')
  }

  const browser = options.browser ?? browserFetch(new URL(gateway.url).origin)

  if (!options.browser) {
    const signIn = await browser.fetch(`${gateway.url}/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'hunter2', next: APP_DOCUMENT_PATH })
    })

    expect(signIn.status).toBe(200)
  }

  const state = await boot(basePath, { fetchImpl: browser.fetch })

  if (state.kind !== 'signed_in') {
    throw new Error(`expected signed_in, got ${state.kind}`)
  }

  const outbox = new ErrorDataOutbox()
  const client = connectGateway({
    baseUrl: (basePath as ResolvedBasePath).baseUrl,
    credentials: state.session.credentials,
    fetchImpl: browser.fetch,
    socketFactory: createSocketFactoryWithOutbox(outbox),
    storage: createKeyValueStore({ namespace: basePath.namespace, storage: null }),
    cache: new MemoryChatCache(),
    visibility: fakeVisibility('visible'),
    network: fakeNetwork(true),
    stores: { connection: createConnectionStore(), bots: createBotsStore(), plugin: createPluginStore() },
    tuning: { backoffDelayMs: () => 50 }
  })
  const frames: ServerRequest[] = []

  // Registered first and never accepting, so it sees every frame the model gets.
  client.gateway.onRequest(request => {
    frames.push(request)

    return false
  })

  const storage = options.storage ?? memoryStorage()
  const kv = createKeyValueStore({ namespace: '/', storage })
  const webauthn = softWebAuthn(BASE)
  const store = createPasskeysStore()
  // The page's origin is `https://gw.example.test`; the fake listens on 127.0.0.1, so the page's
  // `Origin` is added the way the browser adds it.
  const pageFetch: typeof browser.fetch = (input, init = {}) =>
    browser.fetch(input, { ...init, headers: { ...(init.headers as Record<string, string>), origin: BASE } })
  const trip: Trip = { stash: options.stash ?? memoryStash(), bounced: [], signedIn: [] }
  const model = new PasskeyModel({
    gateway: client.gateway,
    client: createPasskeyClient(gateway.url, pageFetch),
    webauthn,
    baseUrl: BASE,
    pins: createPasskeyPins({ store: kv, baseUrl: BASE, storage }),
    store,
    selfEnrolment: {
      stash: trip.stash,
      // The browser leaves for the sign-in page: top level, with `next` appended, the jar riding along. The
      // fake plays the identity provider and answers with a redirect back to `next`.
      bounce: loginPath => {
        const url = `${loginPath}&next=${encodeURIComponent(APP_DOCUMENT_PATH)}`

        trip.bounced.push(url)
        trip.signedIn.push(browser.fetch(`${gateway.url}${url}`, { redirect: 'manual', headers: { origin: BASE } }))

        return true
      }
    },
    ...(options.sessions ? { openSessions: options.sessions } : {}),
    failWithData: (request, code, message, data) =>
      outbox.with(request.id, code, data, () => request.fail(code, message))
  })

  model.start()
  stops.push(
    () => model.stop(),
    () => client.stop()
  )

  if (options.advertised === false) {
    await waitFor(() => expect(store.getState().capability).not.toBeNull())
  } else {
    await waitFor(() => expect(store.getState().capability?.accepted).toContain('passkey'))
  }

  return { gateway, client, model, store, webauthn, storage, frames, browser, trip }
}

async function enrol(page: Page): Promise<string> {
  const { body } = await control(page.gateway, '/__fake/passkey/code', {})
  const credential = await page.model.enrol(body.code as string)

  return credential.id
}

async function raise(
  gateway: FakeGateway,
  text: { title?: string; summary: string; detail?: string }
): Promise<{ status: number; body: Json }> {
  return control(gateway, '/__fake/request', { method: 'confirm', params: { level: 'passkey', ...text } })
}

const confirmation = (page: Page, id: string) => page.store.getState().confirmations.find(entry => entry.id === id)

const outcomeOf = async (gateway: FakeGateway, id: string): Promise<Json | undefined> =>
  ((await fakeState(gateway)).passkey.outcomes as Json[]).find(outcome => outcome.request_id === id)

describe('the passkey model against the fake gateway', () => {
  it('advertises the level for its own host only, in the second capabilities call', async () => {
    const page = await openPage(await passkeyGateway())
    const state = await fakeState(page.gateway)

    expect(page.store.getState().capability).toEqual({ verdict: { kind: 'advertised' }, accepted: ['passkey'] })
    expect(state.clientCapabilities.at(-1)).toMatchObject({
      server_requests: true,
      confirm: ['passkey'],
      confirm_passkey: { v: 1, kind: 'web', rp_id: 'gw.example.test' }
    })
    expect(page.store.getState().supported).toBe(true)
  })

  it('enrols with an operator code, pins the gateway id and lists the passkey', async () => {
    const page = await openPage(await passkeyGateway())
    const id = await enrol(page)
    const state = await fakeState(page.gateway)

    expect(page.store.getState().credentials.map(credential => credential.id)).toEqual([id])
    expect(page.store.getState().credentials[0]?.name).toBe('Hermie — gw.example.test')
    expect(page.store.getState().credentials[0]?.rp_id).toBe('gw.example.test')
    expect([...page.storage.map.keys()]).toContain('hermie:/:device.passkey.pin@https://gw.example.test')
    expect(
      JSON.parse(page.storage.map.get('hermie:/:device.passkey.pin@https://gw.example.test') ?? '{}')
    ).toMatchObject({ gateway_id: state.passkey.gateway_id })
    // This browser holds a passkey for the gateway already: the authenticator refuses a second one.
    await expect(page.model.enrol('00000-00000-00000-00000')).rejects.toMatchObject({
      problem: { kind: 'ceremony', problem: { kind: 'exists' } }
    })
    // Another authenticator needs a code of its own: a code is used once.
    page.webauthn.held.length = 0
    await expect(page.model.enrol('00000-00000-00000-00000')).rejects.toMatchObject({
      problem: { kind: 'refused', error: 'code_invalid' }
    })
    await expect(page.model.enrol('not a code')).rejects.toBeInstanceOf(PasskeyActionError)
  })

  it('confirms: the gateway verifies the assertion and only its commit says verified', async () => {
    const page = await openPage(await passkeyGateway())

    await enrol(page)

    const raised = await raise(page.gateway, {
      title: 'Delete backups',
      summary: 'Delete 3 old backups.',
      detail: 'rm -rf /srv/backups/2024-*\nkeep: /srv/backups/latest'
    })

    expect(raised.status).toBe(200)

    const id = raised.body.request_id as string

    await waitFor(() => expect(confirmation(page, id)?.phase).toEqual({ kind: 'waiting' }))
    expect(confirmation(page, id)).toMatchObject({
      title: 'Delete backups',
      summary: 'Delete 3 old backups.',
      detail: 'rm -rf /srv/backups/2024-*\nkeep: /srv/backups/latest',
      baseUrl: BASE,
      userName: expect.any(String)
    })

    await page.model.confirm(id)

    expect(confirmation(page, id)?.phase).toEqual({ kind: 'received' })
    await waitFor(async () =>
      expect(await outcomeOf(page.gateway, id)).toMatchObject({ outcome: 'confirmed', verified: true })
    )
    // The answer never says `verified` itself.
    const answer = ((await fakeState(page.gateway)).serverRequestAnswers as Json[]).find(entry => entry.id === id)

    expect(answer?.result).toMatchObject({
      decision: 'confirmed',
      method: 'passkey',
      passkey: { v: 1, base_url: BASE }
    })
    expect(answer?.result).not.toHaveProperty('verified')

    // The TypeScript reference computes the same challenge for the same frame.
    const frame = page.frames.find(request => request.id === id) as ServerRequest
    const reference = SoftAuthenticator.web(BASE).answer({ id, params: frame.params as never }, { baseUrl: BASE })
    const referenceChallenge = JSON.parse(
      Buffer.from(reference.passkey.client_data_json, 'base64url').toString('utf8')
    ).challenge

    expect(page.webauthn.challenges.at(-1)).toBe(referenceChallenge)
  })

  it('declines with exactly the decline, and the sheet goes', async () => {
    const page = await openPage(await passkeyGateway())

    await enrol(page)

    const id = (await raise(page.gateway, { summary: 'Send the invoice.' })).body.request_id as string

    await waitFor(() => expect(confirmation(page, id)).toBeDefined())
    await page.model.decline(id)

    expect(confirmation(page, id)).toMatchObject({ phase: { kind: 'declined' }, dismissed: true })
    expect(
      ((await fakeState(page.gateway)).serverRequestAnswers as Json[]).find(entry => entry.id === id)?.result
    ).toEqual({ decision: 'declined', method: 'tap' })
    await waitFor(async () =>
      expect(await outcomeOf(page.gateway, id)).toMatchObject({ outcome: 'declined', verified: false })
    )
  })

  it('shows a refusal as a retryable state, and the fifth settles it as too many attempts', async () => {
    const page = await openPage(await passkeyGateway())

    await enrol(page)
    page.webauthn.swapKey()

    const id = (await raise(page.gateway, { summary: 'Pay 120.00 EUR.' })).body.request_id as string

    await waitFor(() => expect(confirmation(page, id)).toBeDefined())

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await page.model.confirm(id)
      expect(confirmation(page, id)?.phase).toEqual({ kind: 'refused', reason: 'signature_invalid' })
    }

    await page.model.confirm(id)

    expect(confirmation(page, id)).toMatchObject({
      phase: { kind: 'ended', end: { kind: 'too_many_attempts' } },
      dismissed: false
    })
    await waitFor(async () =>
      expect(await outcomeOf(page.gateway, id)).toMatchObject({ outcome: 'unavailable', reason: 'verification_failed' })
    )
  })

  it('takes a received answer back when the commit fails (revoked meanwhile)', async () => {
    const page = await openPage(await passkeyGateway())

    await enrol(page)

    const id = (await raise(page.gateway, { summary: 'Rotate the key.' })).body.request_id as string

    await waitFor(() => expect(confirmation(page, id)).toBeDefined())
    expect((await control(page.gateway, '/__fake/passkey/revoke', { user: 'tester', all: true })).status).toBe(200)

    await page.model.confirm(id)

    expect(confirmation(page, id)).toMatchObject({
      phase: { kind: 'ended', end: { kind: 'verification_failed' } },
      dismissed: false
    })
    await waitFor(async () =>
      expect(await outcomeOf(page.gateway, id)).toMatchObject({ outcome: 'unavailable', verified: false })
    )
  })

  it('ends a confirmation the gateway timed out, and closes it quietly', async () => {
    const page = await openPage(await passkeyGateway())

    await enrol(page)

    const id = (await raise(page.gateway, { summary: 'Restart the service.' })).body.request_id as string

    await waitFor(() => expect(confirmation(page, id)).toBeDefined())
    await control(page.gateway, '/__fake/passkey/expire', { request_id: id })
    await waitFor(() =>
      expect(confirmation(page, id)).toMatchObject({
        phase: { kind: 'ended', end: { kind: 'timed_out' } },
        dismissed: true
      })
    )
  })

  it('lets go of a confirmation the gateway timed out while the socket was down, when it reads the open requests again', async () => {
    const gateway = await passkeyGateway()
    let sessionId = ''
    const page = await openPage(gateway, { sessions: () => (sessionId ? [{ sessionId, lastSeen: 0 }] : []) })

    await enrol(page)

    const raised = await raise(gateway, { summary: 'Restart the service.' })
    const id = raised.body.request_id as string

    sessionId = raised.body.session_id as string
    await waitFor(() => expect(confirmation(page, id)?.phase).toEqual({ kind: 'waiting' }))

    // The socket drops, and the gateway gives up on the request while nobody is listening: its
    // `request.cancel timeout` goes to no one.
    await control(gateway, '/__fake/drop-sockets')
    expect((await control(gateway, '/__fake/passkey/expire', { request_id: id })).status).toBe(200)

    // Back on a new socket the page reads the open requests again, and this one is not among them.
    await waitFor(() =>
      expect(confirmation(page, id)).toMatchObject({
        phase: { kind: 'ended', end: { kind: 'closed_here' } },
        dismissed: true
      })
    )
  })

  it('closing the browser sheet sends nothing; a ceremony that cannot run answers 4040 with the reason', async () => {
    const page = await openPage(await passkeyGateway())

    await enrol(page)

    const id = (await raise(page.gateway, { summary: 'Merge the branch.' })).body.request_id as string

    await waitFor(() => expect(confirmation(page, id)).toBeDefined())

    page.webauthn.next = { kind: 'cancelled' }
    await page.model.confirm(id)
    expect(confirmation(page, id)?.phase).toEqual({ kind: 'waiting' })
    expect(((await fakeState(page.gateway)).serverRequestAnswers as Json[]).some(entry => entry.id === id)).toBe(false)

    page.webauthn.next = { kind: 'unavailable', reason: 'rp_not_configured' }
    await page.model.confirm(id)
    expect(confirmation(page, id)?.phase).toEqual({
      kind: 'ended',
      end: { kind: 'unavailable', reason: 'rp_not_configured' }
    })

    await waitFor(async () =>
      expect(
        ((await fakeState(page.gateway)).serverRequestAnswers as Json[]).find(entry => entry.id === id)?.error
      ).toEqual({
        code: 4040,
        message: 'passkey ceremony unavailable',
        data: { reason: 'rp_not_configured' }
      })
    )
    await waitFor(async () =>
      expect(await outcomeOf(page.gateway, id)).toMatchObject({ outcome: 'unavailable', reason: 'error_response' })
    )
  })

  it('reads the open requests again once the level is accepted on a new socket', async () => {
    const gateway = await passkeyGateway()
    const first = await openPage(gateway)

    await enrol(first)

    const raised = await raise(gateway, { summary: 'Publish the release.' })
    const id = raised.body.request_id as string
    const sessionId = raised.body.session_id as string

    // A second page signed in as the same person, opened after the request was raised: the gateway
    // only shows it the request once it has advertised the level.
    const second = await openPage(gateway, { sessions: () => [{ sessionId, lastSeen: 0 }] })

    await waitFor(() => expect(confirmation(second, id)?.phase).toEqual({ kind: 'waiting' }))
    expect(second.frames.find(request => request.id === id)?.replayed).toBe(true)
  })

  it('mints an invite and revokes a passkey with a step-up', async () => {
    const page = await openPage(await passkeyGateway())
    const id = await enrol(page)
    const invite = await page.model.mintInvite()

    expect(invite.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/u)

    await page.model.revoke(id)

    expect(page.store.getState().credentials).toEqual([])
    // Revoking one's own passkey through the page is no news to the page.
    expect(page.store.getState().notices).toEqual([])
  })

  it('says when a passkey was added without this page', async () => {
    const page = await openPage(await passkeyGateway())

    await enrol(page)
    await control(page.gateway, '/__fake/passkey/changed', {
      user: 'tester',
      change: 'added',
      credential: { id: 'c29tZXdoZXJlLWVsc2U', name: 'Hermie — a phone', rp_id: 'confirm.hermie.dev' }
    })

    await waitFor(() =>
      expect(page.store.getState().notices.map(notice => notice.notice)).toEqual([
        { kind: 'credential_added', name: 'Hermie — a phone' }
      ])
    )
  })

  it('does not advertise to a gateway that presents another id than the one pinned, and says so', async () => {
    const storage = memoryStorage()

    storage.setItem(
      'hermie:/:device.passkey.pin@https://gw.example.test',
      JSON.stringify({ gateway_id: 'AAAAAAAAAAAAAAAAAAAAAA' })
    )

    const page = await openPage(await passkeyGateway(), { storage, advertised: false })

    expect(page.store.getState().capability).toEqual({ verdict: { kind: 'gateway_id_mismatch' }, accepted: [] })
    expect(page.store.getState().notices.map(notice => notice.notice)).toContainEqual({ kind: 'gateway_id_mismatch' })
    expect(((await fakeState(page.gateway)).clientCapabilities as Json[]).some(entry => entry.confirm_passkey)).toBe(
      false
    )
  })
})

describe('adding a passkey by signing in again, against the fake gateway', () => {
  const REAUTH_COOKIE = '__Host-hermes_reauth'

  /** Leave for the sign-in page and come back: the page the person sees after the redirect, with the same cookies. */
  async function signInAgain(page: Page): Promise<Page> {
    await page.model.startSelfEnrolment()

    const answer = await page.trip.signedIn.at(-1)

    expect(answer?.status).toBe(302)
    expect(answer?.headers.get('location')).toBe(APP_DOCUMENT_PATH)

    return openPage(page.gateway, { browser: page.browser, stash: page.trip.stash })
  }

  it('offers it in the status the gateway gives a signed-in person', async () => {
    const page = await openPage(await passkeyGateway())

    await page.model.refresh()

    expect(page.store.getState().status?.self_enrol).toEqual({ available: true, reason: '', cooling_off_s: 0 })
    expect(page.store.getState().selfEnrolSupported).toBe(true)
    expect(page.store.getState().selfEnrolment).toBeNull()
  })

  it('goes from the click to a listed self credential: grant, sign-in, ceremony, finish', async () => {
    const page = await openPage(await passkeyGateway())
    // The click, the trip to the gateway's own sign-in page, and the page loaded again once it is back.
    const back = await signInAgain(page)

    // The page left with the grant id on the URL and `next` appended.
    expect(page.trip.bounced).toHaveLength(1)
    expect(page.trip.bounced[0]).toMatch(
      /^\/auth\/login\?provider=self-hosted&reauth=[\w-]{22}&next=%2Fdashboard-plugins%2Fhermie%2Fapp%2Findex\.html$/u
    )
    // The binding is a cookie the page never saw; the stash holds the grant id and its deadline and nothing else.
    expect(page.browser.cookies.has(REAUTH_COOKIE)).toBe(true)

    const stashed = JSON.parse(page.trip.stash.raw() ?? '{}') as Record<string, unknown>

    expect(Object.keys(stashed).sort()).toEqual(['expires_at', 'grant_id'])
    expect(page.trip.bounced[0]).toContain(`reauth=${String(stashed.grant_id)}`)
    expect(page.trip.stash.raw()).not.toContain(page.browser.cookies.get(REAUTH_COOKIE) ?? 'no cookie')

    // The reloaded page finds the grant waiting for a click.
    expect(back.store.getState().selfEnrolment).toEqual({ expiresAt: stashed.expires_at })

    const credential = await back.model.finishSelfEnrolment()

    expect(credential).toMatchObject({ name: 'Hermie — gw.example.test', rp_id: 'gw.example.test' })
    expect(back.store.getState().credentials).toEqual([expect.objectContaining({ id: credential.id })])
    expect(back.store.getState().credentials[0]).toMatchObject({ created_via: 'self' })
    // Nothing is left: the stash, the waiting state and the binding cookie (cleared by the finish).
    expect(back.trip.stash.raw()).toBeNull()
    expect(back.store.getState().selfEnrolment).toBeNull()
    expect(back.browser.cookies.has(REAUTH_COOKIE)).toBe(false)
    expect(back.store.getState().pinned).toBe(true)

    const state = await fakeState(back.gateway)

    expect(state.passkey.credentials).toEqual([expect.objectContaining({ created_via: 'self' })])
    expect(state.passkey.grants).toEqual([expect.objectContaining({ state: 'spent' })])
  })

  it('is spent by the credential: the same grant does not enrol a second', async () => {
    const page = await openPage(await passkeyGateway())
    const back = await signInAgain(page)
    const stashed = back.trip.stash.raw()

    await back.model.finishSelfEnrolment()

    // A second authenticator, the same stash and the same cookie (as if the tab had kept both).
    back.webauthn.held.length = 0
    back.trip.stash.write({
      grantId: (JSON.parse(stashed ?? '{}') as { grant_id: string }).grant_id,
      expiresAt: Math.floor(Date.now() / 1000) + 300
    })
    await expect(back.model.finishSelfEnrolment()).rejects.toMatchObject({
      problem: { kind: 'refused', error: 'reauth_invalid' }
    })
    expect(back.trip.stash.raw()).toBeNull()
    expect(((await fakeState(back.gateway)).passkey.credentials as Json[]).length).toBe(1)
  })

  it('keeps the grant when the person closes the browser’s sheet, and the next click completes it', async () => {
    const page = await openPage(await passkeyGateway())
    const back = await signInAgain(page)

    back.webauthn.next = { kind: 'cancelled' }
    await expect(back.model.finishSelfEnrolment()).rejects.toMatchObject({
      problem: { kind: 'ceremony', problem: { kind: 'cancelled' } }
    })
    expect(back.trip.stash.raw()).not.toBeNull()
    expect(back.store.getState().selfEnrolment).not.toBeNull()

    await expect(back.model.finishSelfEnrolment()).resolves.toMatchObject({ rp_id: 'gw.example.test' })
    expect(back.trip.stash.raw()).toBeNull()
  })

  it('says not_fresh when the sign-in never came back, and forgets the grant', async () => {
    const page = await openPage(await passkeyGateway())
    // A grant opened by hand: the page has it and the cookie, but the sign-in page was never visited.
    const opened = await page.browser.fetch(`${page.gateway.url}/api/auth/passkeys/reauth/begin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: '{}'
    })
    const grant = (await opened.json()) as { grant_id: string; expires_at: number }

    expect(opened.status).toBe(200)
    expect(page.browser.cookies.has(REAUTH_COOKIE)).toBe(true)

    const idle = await openPage(page.gateway, { browser: page.browser, stash: page.trip.stash })

    idle.trip.stash.write({ grantId: grant.grant_id, expiresAt: grant.expires_at })

    await expect(idle.model.finishSelfEnrolment()).rejects.toMatchObject({
      problem: { kind: 'refused', status: 403, error: 'reauth_invalid', reason: 'not_fresh' }
    })
    expect(idle.trip.stash.raw()).toBeNull()
  })

  it.each([['user_mismatch'], ['provider_mismatch'], ['auth_time_missing'], ['auth_not_fresh']])(
    'names why a sign-in that did not count did not: %s',
    async failure => {
      const gateway = await passkeyGateway()

      expect((await control(gateway, '/__fake/passkey/reauth', { fail: failure })).status).toBe(200)

      const page = await openPage(gateway)
      const back = await signInAgain(page)

      await expect(back.model.finishSelfEnrolment()).rejects.toMatchObject({
        problem: { kind: 'refused', status: 403, error: 'reauth_invalid', reason: 'failed', failure }
      })
      expect(back.trip.stash.raw()).toBeNull()
      expect(back.store.getState().selfEnrolment).toBeNull()
      expect(((await fakeState(gateway)).passkey.credentials as Json[]).length).toBe(0)
    }
  )

  it('says unknown when the grant ran out at the gateway', async () => {
    const gateway = await passkeyGateway()
    const page = await openPage(gateway)
    const back = await signInAgain(page)

    expect((await control(gateway, '/__fake/passkey/expire', { grants: true })).status).toBe(200)
    await expect(back.model.finishSelfEnrolment()).rejects.toMatchObject({
      problem: { kind: 'refused', error: 'reauth_invalid', reason: 'unknown' }
    })
    expect(back.trip.stash.raw()).toBeNull()
  })

  it('is refused for a grant presented without the browser that opened it (the id alone is nothing)', async () => {
    const gateway = await passkeyGateway()
    const page = await openPage(gateway)

    await page.model.startSelfEnrolment()
    await page.trip.signedIn.at(-1)

    // Another browser of the same person: signed in, holding the stash value, without the binding cookie.
    const other = await openPage(gateway, { stash: memoryStash(page.trip.stash.raw()) })

    await expect(other.model.finishSelfEnrolment()).rejects.toMatchObject({
      problem: { kind: 'refused', error: 'reauth_invalid', reason: 'unknown' }
    })
  })

  it('says it is switched off, and the code path still works', async () => {
    const gateway = await passkeyGateway()

    expect((await control(gateway, '/__fake/passkey/enable', { self_enrol: { enabled: false } })).status).toBe(200)

    const page = await openPage(gateway)

    await page.model.refresh()
    expect(page.store.getState().status?.self_enrol).toMatchObject({ available: false, reason: 'disabled' })
    await expect(page.model.startSelfEnrolment()).rejects.toMatchObject({
      problem: { kind: 'self_enrol_unavailable', reason: 'disabled' }
    })
    expect(page.trip.bounced).toEqual([])
    await expect(enrol(page)).resolves.toEqual(expect.any(String))
  })

  it('says the provider cannot ask again, and leaves the code path alone', async () => {
    const gateway = await passkeyGateway()

    expect((await control(gateway, '/__fake/passkey/enable', { provider_reauth: false })).status).toBe(200)

    const page = await openPage(gateway)

    await expect(page.model.startSelfEnrolment()).rejects.toMatchObject({
      problem: { kind: 'self_enrol_unavailable', reason: 'provider_no_reauth' }
    })
    await expect(enrol(page)).resolves.toEqual(expect.any(String))
  })

  it('carries the limit of five grants in ten minutes, with the wait the gateway asked for', async () => {
    const page = await openPage(await passkeyGateway())

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.model.startSelfEnrolment()
    }

    await expect(page.model.startSelfEnrolment()).rejects.toMatchObject({
      problem: { kind: 'refused', status: 429, error: 'rate_limited', retryAfter: 600 }
    })
  })

  it('lists a credential that is still cooling off with its usable_from', async () => {
    const gateway = await passkeyGateway()

    expect((await control(gateway, '/__fake/passkey/enable', { self_enrol: { cooling_off_s: 600 } })).status).toBe(200)

    const page = await openPage(gateway)
    const back = await signInAgain(page)
    const credential = await back.model.finishSelfEnrolment()
    const listed = back.store.getState().credentials.find(entry => entry.id === credential.id)

    expect(typeof listed?.usable_from).toBe('number')
    expect(listed?.usable_from).toBeGreaterThan(Date.now() / 1000)
    expect(back.store.getState().status?.self_enrol).toMatchObject({ available: true, cooling_off_s: 600 })
  })
})
