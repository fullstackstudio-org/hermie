// @vitest-environment node
/**
 * The interactive model against the fake gateway (cookie mode), the way a page runs it: signed
 * in, connected over the runtime's own `WebSocket`, the advert riding in the passkey model's
 * second `client.capabilities` call, and `request.answer` checked by the gateway itself. What
 * this proves that the unit tests cannot: the gateway only sends the methods the page listed,
 * it takes an example answer, it refuses a bad one with `4034 {reason}` and leaves the request
 * open, it counts ten refusals, a `4041` reaches it with its `data.reason`, and `expires_at`
 * ends the request on both sides.
 */
import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'

import { APP_DOCUMENT_PATH, deriveBasePath, type ResolvedBasePath } from '../../boot/base-path'
import { boot } from '../../boot/boot'
import { MemoryChatCache } from '../../platform/chat-cache'
import { createKeyValueStore } from '../../platform/key-value-store'
import { createPasskeyPins } from '../../platform/passkey-pins'
import { createSocketFactoryWithOutbox, ErrorDataOutbox } from '../../platform/socket'
import { createBotsStore } from '../../state/bots'
import { createConnectionStore } from '../../state/connection'
import { createInteractiveStore, type InteractiveState } from '../../state/interactive'
import { createPasskeysStore } from '../../state/passkeys'
import { createPluginStore } from '../../state/plugin'
import { browserFetch } from '../../test-support/browser-fetch'
import { fakeNetwork, fakeVisibility } from '../../test-support/fake-watchers'
import { softWebAuthn } from '../../test-support/soft-webauthn'
import { connectGateway, type GatewayClient } from '../gateway-client'
import { createPasskeyClient } from '../passkey/client'
import { PasskeyModel } from '../passkey/model'
import { type EngineCall, recordingEngine } from '../../test-support/interactive-gateway'
import { type InteractiveModel, InteractiveModel as Model, interactiveAdvert } from './interactive'

const BASE = 'http://127.0.0.1'

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

const viewOf = async (gateway: FakeGateway, id: string): Promise<Json> =>
  (await (await fetch(`${gateway.url}/__fake/request/${id}`)).json()) as Json

interface Page {
  gateway: FakeGateway
  client: GatewayClient
  model: InteractiveModel
  store: StoreApi<InteractiveState>
  engine: EngineCall[]
}

/** A signed-in, connected page whose passkey model carries the interactive advert. */
async function openPage(): Promise<Page> {
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
  const failWithData = (
    request: { id: string; fail: (code: number, message: string) => void },
    code: number,
    message: string,
    data: Record<string, unknown>
  ): void => outbox.with(request.id, code, data, () => request.fail(code, message))
  const store = createInteractiveStore()
  const engine = recordingEngine()
  /** Which chat holds which runtime session: the page's only chat holds whatever session the fake raises on. */
  const model = new Model({
    gateway: client.gateway,
    store,
    chatFor: () => 'researcher',
    engine: engine.engine,
    failWithData
  })
  const memory = new Map<string, string>()
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    key: (index: number) => [...memory.keys()][index] ?? null,
    get length() {
      return memory.size
    }
  }
  const passkeys = new PasskeyModel({
    gateway: client.gateway,
    client: createPasskeyClient(gateway.url, browser.fetch),
    webauthn: softWebAuthn(BASE),
    baseUrl: BASE,
    pins: createPasskeyPins({ store: createKeyValueStore({ namespace: '/', storage }), baseUrl: BASE, storage }),
    store: createPasskeysStore(),
    failWithData,
    // The advert is off by default until the sheets exist (`ADVERTISE_INTERACTIVE_REQUESTS`): these tests turn it on.
    requests: interactiveAdvert(model, { enabled: true })
  })

  passkeys.start()
  model.start()
  stops.push(
    () => model.stop(),
    () => passkeys.stop(),
    () => client.stop()
  )

  await waitFor(async () =>
    expect(((await fakeState(gateway)).clientCapabilities as Json[]).some(call => Array.isArray(call.requests))).toBe(
      true
    )
  )

  return { gateway, client, model, store, engine: engine.calls }
}

const raise = (gateway: FakeGateway, method: string, params: Record<string, unknown> = {}) =>
  control(gateway, '/__fake/request', { method, params })

const requests = (page: Page) => page.store.getState().requests

describe('the interactive model against the fake gateway', () => {
  it('advertises the three methods in the second capabilities call, which the gateway accepts', async () => {
    const page = await openPage()
    const calls = (await fakeState(page.gateway)).clientCapabilities as Json[]

    expect(calls.at(-1)).toMatchObject({
      server_requests: true,
      requests: ['input.form', 'input.file', 'review.draft']
    })
    // The passkey level is not on offer here: the second call carries the methods alone.
    expect(calls.at(-1)?.confirm ?? []).toEqual([])
    expect(calls.at(-1)?.confirm_passkey).toBeUndefined()
  })

  it('shows an example form, takes the example answer and ends the request', async () => {
    const page = await openPage()
    const raised = await raise(page.gateway, 'input.form')

    expect(raised.status).toBe(200)
    await waitFor(() => expect(requests(page)).toHaveLength(1))
    expect(requests(page)[0]).toMatchObject({ id: raised.body.id, method: 'input.form', bot: 'researcher' })
    expect(page.engine.map(call => call.call)).toEqual(['asked'])

    const ask = requests(page)[0]?.ask

    expect(ask?.method).toBe('input.form')

    // What the contract's own example answers (`contract/requests/examples.json`).
    const outcome = await page.model.answer(raised.body.id as string, {
      status: 'answered',
      values: {
        name: 'Ada Lovelace',
        guests: 2,
        stay: { start: '2026-11-14', end: '2026-11-16' },
        budget: '180.00',
        arrival: '2026-11-14',
        check_in: '15:00',
        call_at: '2026-11-10T10:00:00+01:00[Europe/Amsterdam]',
        room: 'double',
        extras: ['breakfast'],
        newsletter: false,
        notes: 'Arriving late.'
      }
    })

    expect(outcome).toEqual({ kind: 'sent' })
    expect(requests(page)).toEqual([])
    await waitFor(async () => expect((await viewOf(page.gateway, raised.body.id)).outcome).toBe('answered'))
    expect(page.engine.at(-1)).toMatchObject({ call: 'answered', summary: { status: 'answered' } })
  })

  it('refuses a bad answer with 4034 and its reason, leaves the request open, and takes the corrected one', async () => {
    const page = await openPage()
    const raised = await raise(page.gateway, 'input.form')
    const id = raised.body.id as string

    await waitFor(() => expect(requests(page)).toHaveLength(1))

    const outcome = await page.model.answer(id, { status: 'answered', values: { guests: 2 } })

    expect(outcome).toEqual({ kind: 'refused', reason: 'field:name:missing' })
    expect(requests(page)[0]).toMatchObject({ refusal: 'field:name:missing', version: 2 })
    expect((await viewOf(page.gateway, id)).open).toBe(true)

    const fixed = await page.model.answer(id, {
      status: 'answered',
      values: { name: 'Ada', guests: 2, stay: { start: '2026-11-14', end: '2026-11-16' } }
    })

    expect(fixed).toEqual({ kind: 'sent' })
  })

  it('ends at the tenth refused answer, which says too_many_attempts and withdraws it', async () => {
    const page = await openPage()
    const raised = await raise(page.gateway, 'input.form')
    const id = raised.body.id as string

    await waitFor(() => expect(requests(page)).toHaveLength(1))

    for (let attempt = 1; attempt < 10; attempt += 1) {
      await expect(page.model.answer(id, { status: 'answered', values: {} })).resolves.toMatchObject({
        kind: 'refused'
      })
    }

    // The gateway's `request.cancel too_many_attempts` and its error answer cross: either one ends it here.
    const last = await page.model.answer(id, { status: 'answered', values: {} })

    expect(['ended', 'closed']).toContain(last.kind)
    expect(requests(page)).toEqual([])
    expect(page.store.getState().notices.researcher?.notice).toEqual({ kind: 'withdrawn' })
    expect((await viewOf(page.gateway, id)).outcome).toBe('too_many_attempts')
  })

  it('skips with {status: skipped}', async () => {
    const page = await openPage()
    const raised = await raise(page.gateway, 'input.file')

    await waitFor(() => expect(requests(page)).toHaveLength(1))
    await expect(page.model.skip(raised.body.id)).resolves.toEqual({ kind: 'sent' })
    await waitFor(async () =>
      expect((await viewOf(page.gateway, raised.body.id)).answer).toEqual({ status: 'skipped' })
    )
  })

  it('answers 4041 cannot_show with its reason on the real socket, and the gateway says unavailable', async () => {
    const page = await openPage()
    const raised = await raise(page.gateway, 'input.file')

    await waitFor(() => expect(requests(page)).toHaveLength(1))
    expect(page.model.cannotShow(raised.body.id, 'no_camera')).toBe('sent')

    await waitFor(async () => {
      const view = await viewOf(page.gateway, raised.body.id)

      expect(view.outcome).toBe('unavailable')
      expect(view.error).toMatchObject({ code: 4041, message: 'cannot_show', data: { reason: 'no_camera' } })
    })
    expect(page.store.getState().notices.researcher?.notice).toEqual({
      kind: 'cannot_show',
      method: 'input.file',
      reason: 'no_camera'
    })
  })

  it('approves a draft: the gateway computes edited, and the summary says the same', async () => {
    const page = await openPage()
    const raised = await raise(page.gateway, 'review.draft')

    await waitFor(() => expect(requests(page)).toHaveLength(1))

    const ask = requests(page)[0]?.ask

    if (ask?.method !== 'review.draft') {
      throw new Error('not a draft')
    }

    await expect(
      page.model.answer(raised.body.id, { decision: 'approved', text: `${ask.text}\nP.S.` })
    ).resolves.toEqual({
      kind: 'sent'
    })
    await waitFor(async () => expect((await viewOf(page.gateway, raised.body.id)).answer?.edited).toBe(true))
    expect(page.engine.at(-1)).toMatchObject({ summary: { decision: 'approved', edited: true } })
  })

  it('closes at expires_at on both sides: the gateway withdraws it with a timeout, and the sheet’s chat says so', async () => {
    const page = await openPage()
    const raised = await raise(page.gateway, 'input.form')

    await waitFor(() => expect(requests(page)).toHaveLength(1))
    await control(page.gateway, `/__fake/request/${raised.body.id}/expire`)

    await waitFor(() => expect(requests(page)).toEqual([]))
    expect(page.store.getState().notices.researcher?.notice).toEqual({ kind: 'expired' })
  })

  it('gets nothing from a gateway when the page has not advertised: the request is not sent at all', async () => {
    const gateway = await startFakeGateway({ port: 0, host: '127.0.0.1', auth: 'cookie' })

    gateways.push(gateway)

    const raised = await raise(gateway, 'input.form')

    expect(raised.status).toBe(409)
    expect(raised.body.error).toBe('no_capable_client')
  })
})
