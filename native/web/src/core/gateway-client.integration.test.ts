// @vitest-environment node
/**
 * The connection against the fake gateway in cookie mode, the way a page on
 * the gateway's own origin runs it: sign in through `/auth/password-login`,
 * boot, then `connectGateway` on the boot's session, over the runtime's own
 * `WebSocket` (Node 22 has the WHATWG one a browser has).
 *
 * What it proves (plan W-7a): the page connects, lists the bots, takes the
 * plugin advert off the same answer, survives the gateway dropping every socket
 * and comes back on a NEW ticket (the fake's ticket counter moves), replays the
 * session it was following, and does the same after a hidden spell longer than
 * the grace. Stopping it closes the socket and empties the stores.
 *
 * Node rather than jsdom, as in `boot.integration.test.ts`: none of this needs
 * a DOM, and the cookie jar of `browserFetch` is the only browser behaviour the
 * session depends on. The page's visibility and network are turned by hand.
 */
import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { APP_DOCUMENT_PATH, deriveBasePath, type ResolvedBasePath } from '../boot/base-path'
import { boot } from '../boot/boot'
import { MemoryChatCache } from '../platform/chat-cache'
import { createKeyValueStore } from '../platform/key-value-store'
import { createBotsStore } from '../state/bots'
import { createConnectionStore } from '../state/connection'
import { createPluginStore } from '../state/plugin'
import { browserFetch } from '../test-support/browser-fetch'
import { fakeNetwork, fakeVisibility } from '../test-support/fake-watchers'
import { bundledWebClient, webPushPublicKey } from './advert'
import type { ChatSessionIdSource } from './bots-controller'
import { connectGateway, type GatewayClient } from './gateway-client'

interface FakeState {
  connections: number
  openSockets: number
  ticketsMinted: number
  ticketsConsumed: number
  eventsSinceCalls: { session_id: string; last_seen: number }[]
  methodLog: string[]
}

const gateways: FakeGateway[] = []
const clients: GatewayClient[] = []

afterEach(async () => {
  while (clients.length) {
    clients.pop()?.stop()
  }

  while (gateways.length) {
    await gateways.pop()?.close()
  }
})

const fakeState = async (gateway: FakeGateway): Promise<FakeState> =>
  (await (await fetch(`${gateway.url}/__fake/state`)).json()) as FakeState

const control = async (gateway: FakeGateway, path: string, body: unknown = {}): Promise<Response> =>
  fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

/** A signed-in page on a fresh cookie-mode fake, connected, with its own stores and hand-turned watchers. */
async function connectedPage(options: { hiddenGraceMs?: number; chats?: ChatSessionIdSource } = {}) {
  const gateway = await startFakeGateway({ port: 0, host: '127.0.0.1', auth: 'cookie' })
  gateways.push(gateway)

  const basePath = deriveBasePath({ origin: new URL(gateway.url).origin, pathname: APP_DOCUMENT_PATH })

  if (!basePath.ok) {
    throw new Error('the fake gateway’s address is not a client path')
  }

  const browser = browserFetch(new URL(gateway.url).origin)
  const signIn = await browser.fetch(`${gateway.url}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'hunter2', next: APP_DOCUMENT_PATH })
  })

  expect(signIn.status).toBe(200)

  const state = await boot(basePath, { fetchImpl: browser.fetch })

  if (state.kind !== 'signed_in') {
    throw new Error(`expected signed_in, got ${state.kind}`)
  }

  const visibility = fakeVisibility('visible')
  const network = fakeNetwork(true)
  const stores = { connection: createConnectionStore(), bots: createBotsStore(), plugin: createPluginStore() }
  const before = await fakeState(gateway)
  const client = connectGateway({
    baseUrl: (basePath as ResolvedBasePath).baseUrl,
    credentials: state.session.credentials,
    fetchImpl: browser.fetch,
    storage: createKeyValueStore({ namespace: basePath.namespace, storage: null }),
    cache: new MemoryChatCache(),
    visibility,
    network,
    stores,
    ...(options.chats ? { chats: options.chats } : {}),
    // A short ladder, so a test waits on the gateway rather than on backoff.
    tuning: { backoffDelayMs: () => 50 },
    ...(options.hiddenGraceMs === undefined ? {} : { hiddenGraceMs: options.hiddenGraceMs })
  })

  clients.push(client)

  return { gateway, client, stores, visibility, network, before }
}

const waitFor = <T>(check: () => T | Promise<T>): Promise<T> => vi.waitFor(check, { timeout: 5_000, interval: 20 })

const profilesListCalls = (state: FakeState): number =>
  state.methodLog.filter(method => method === 'profiles.list').length

describe('the connection against the fake gateway (cookie mode)', () => {
  it('connects on a ticket, lists the bots and reads the plugin advert off the same answer', async () => {
    const { gateway, client, stores, before } = await connectedPage()

    await waitFor(() => expect(stores.connection.getState().status).toBe('ready'))
    await waitFor(() => expect(stores.bots.getState().refreshedAt).not.toBeNull())

    expect(stores.bots.getState().bots.map(bot => bot.name)).toEqual(['researcher', 'writer'])
    expect(stores.bots.getState().byName.researcher?.canonical?.id).toBeTruthy()
    expect(stores.plugin.getState().read).toBe(true)
    expect(bundledWebClient(stores.plugin.getState().advert)?.path).toBe(APP_DOCUMENT_PATH)
    expect(webPushPublicKey(stores.plugin.getState().advert)).toHaveLength(87)

    const after = await fakeState(gateway)

    expect(after.ticketsMinted).toBe(before.ticketsMinted + 1)
    expect(after.ticketsConsumed).toBe(before.ticketsConsumed + 1)
    expect(after.openSockets).toBe(1)
    expect(profilesListCalls(after)).toBe(1)
    // The REST half rides the same cookie session.
    await expect(client.http.authMe()).resolves.toMatchObject({ userId: 'tester@example.invalid' })
  })

  it('hands the chat store to the roster, which reads the open chats’ session ids to place a busy session on a bot', async () => {
    let reads = 0
    const chats: ChatSessionIdSource = {
      getState: () => {
        reads += 1

        return { chats: { researcher: { runtimeSessionId: 'runtime-researcher' } } }
      }
    }
    const { client, stores } = await connectedPage({ chats })

    await waitFor(() => expect(stores.bots.getState().refreshedAt).not.toBeNull())
    reads = 0
    await client.bots.refreshRunning()

    expect(reads).toBeGreaterThan(0)
  })

  it('survives the gateway dropping every socket, and comes back on a new ticket with a replay', async () => {
    const { gateway, client, stores } = await connectedPage()

    await waitFor(() => expect(stores.bots.getState().refreshedAt).not.toBeNull())

    // Follow a session, so the reconnect has something to replay: a turn on the
    // researcher's chat arrives as seq'd events, which set its watermark.
    const seen: string[] = []
    const stopListening = client.gateway.onAny(event => seen.push(event.type))

    expect(
      (await control(gateway, '/__fake/inject', { profile: 'researcher', user: 'Ping?', assistant: 'Pong.' })).status
    ).toBe(200)
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    stopListening()

    const before = await fakeState(gateway)
    const statuses: string[] = []
    const stopWatching = stores.connection.subscribe(state => statuses.push(state.status))

    expect((await (await control(gateway, '/__fake/drop-sockets')).json()) as { dropped: number }).toEqual({
      dropped: 1
    })

    await waitFor(async () => {
      const now = await fakeState(gateway)

      expect(now.ticketsMinted).toBeGreaterThan(before.ticketsMinted)
      expect(now.connections).toBeGreaterThan(before.connections)
      expect(now.openSockets).toBe(1)
    })
    await waitFor(() => expect(stores.connection.getState().status).toBe('ready'))
    stopWatching()

    // It went down and came back: the page saw the drop, not just the end state.
    expect(statuses.some(status => status !== 'ready')).toBe(true)

    // The roster is read again on the way back to ready, and the session it
    // was following is replayed from its watermark.
    await waitFor(async () => {
      const now = await fakeState(gateway)

      expect(profilesListCalls(now)).toBeGreaterThan(profilesListCalls(before))
      expect(now.eventsSinceCalls.length).toBeGreaterThan(before.eventsSinceCalls.length)
    })

    const after = await fakeState(gateway)

    expect(after.eventsSinceCalls.at(-1)?.last_seen).toBeGreaterThan(0)
    // The ticket the first dial spent was not offered again: every dial minted its own.
    expect(after.ticketsConsumed).toBe(after.connections)
    expect(stores.bots.getState().bots.map(bot => bot.name)).toEqual(['researcher', 'writer'])
  })

  it('closes after a hidden spell longer than the grace, and dials again with a fresh ticket when shown', async () => {
    const { gateway, stores, visibility } = await connectedPage({ hiddenGraceMs: 100 })

    await waitFor(() => expect(stores.connection.getState().status).toBe('ready'))

    const before = await fakeState(gateway)

    visibility.set('hidden')
    await waitFor(() => expect(stores.connection.getState().status).toBe('paused'))
    await waitFor(async () => expect((await fakeState(gateway)).openSockets).toBe(0))

    visibility.set('visible')
    await waitFor(() => expect(stores.connection.getState().status).toBe('ready'))

    const after = await fakeState(gateway)

    expect(after.ticketsMinted).toBe(before.ticketsMinted + 1)
    expect(after.openSockets).toBe(1)
  })

  it('keeps the socket through a hidden spell shorter than the grace', async () => {
    const { gateway, stores, visibility } = await connectedPage()

    await waitFor(() => expect(stores.connection.getState().status).toBe('ready'))

    const before = await fakeState(gateway)

    visibility.set('hidden')
    await new Promise(resolve => setTimeout(resolve, 100))
    visibility.set('visible')

    const after = await fakeState(gateway)

    expect(stores.connection.getState().status).toBe('ready')
    expect(after.ticketsMinted).toBe(before.ticketsMinted)
    expect(after.connections).toBe(before.connections)
  })

  it('says the session lapsed when the gateway ends it, and does not dial on', async () => {
    const { gateway, stores } = await connectedPage()

    await waitFor(() => expect(stores.connection.getState().status).toBe('ready'))
    await control(gateway, '/__fake/expire-sessions')
    await control(gateway, '/__fake/drop-sockets')

    await waitFor(() => expect(stores.connection.getState().status).toBe('needs_signin'))

    const settled = (await fakeState(gateway)).connections

    await new Promise(resolve => setTimeout(resolve, 300))

    expect((await fakeState(gateway)).connections).toBe(settled)
    expect(stores.connection.getState().status).toBe('needs_signin')
  })

  it('closes the socket and empties the stores when stopped', async () => {
    const { gateway, client, stores } = await connectedPage()

    await waitFor(() => expect(stores.bots.getState().refreshedAt).not.toBeNull())

    client.stop()
    client.stop()

    await waitFor(async () => expect((await fakeState(gateway)).openSockets).toBe(0))
    expect(stores.connection.getState().status).toBe('disconnected')
    expect(stores.bots.getState().bots).toEqual([])
    expect(stores.plugin.getState().read).toBe(false)
  })
})
