// @vitest-environment node
/**
 * Two pages of one person against the fake gateway in cookie mode, each signed
 * in through its own cookie jar, booted, connected (`connectGateway`) and
 * following its `ui_meta` (`connectUiMeta`) with its own stores and its own
 * disk: the black box plan W-20a asks for.
 *
 * What it proves: a conflict on the app-wide section (a page writing under a
 * revision another client has moved on from) is resolved by the per-key
 * compare-and-swap, the re-read and the dates, and neither side's unknown keys
 * are lost in it: not the profile's keys another tool owns (`hermes-bots`, the
 * plugin's advert, a foreign key), not a bot section's field this build does
 * not know, and not the fields of the app section that another build wrote,
 * before or during the conflict. The fake's own `ui-meta.test.ts` is the
 * control: it pins that the gateway keeps every key a write does not name and
 * refuses a stale revision with `{ expected, actual }`.
 *
 * Node rather than jsdom, as in `gateway-client.integration.test.ts`.
 */
import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { APP_DOCUMENT_PATH, deriveBasePath, type ResolvedBasePath } from '../boot/base-path'
import { boot } from '../boot/boot'
import { MemoryChatCache } from '../platform/chat-cache'
import { createKeyValueStore } from '../platform/key-value-store'
import { createAppStampStore } from '../state/app-stamp'
import { createBotsStore } from '../state/bots'
import { createConnectionStore } from '../state/connection'
import { uiMetaUserIdOf } from '../state/device-context'
import { createLayoutStore } from '../state/layout'
import { createPluginStore } from '../state/plugin'
import { createTextSizeStore } from '../state/text-size'
import { browserFetch } from '../test-support/browser-fetch'
import { fakeNetwork, fakeVisibility } from '../test-support/fake-watchers'
import { connectGateway, type GatewayClient } from './gateway-client'
import type { ChatGateway } from './link'
import { connectUiMeta, type UiMetaRuntime } from './ui-meta-bridge'

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

/** What a page's `profiles.configure` calls were answered with. */
interface Answer {
  params: Record<string, unknown>
  conflicts: Record<string, unknown> | undefined
}

/** One signed-in page on `gateway`, connected and following its `ui_meta`, with a clock of its own. */
async function openPage(gateway: FakeGateway, now: () => number) {
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
  const storage = createKeyValueStore({ namespace: basePath.namespace, storage: null })
  const stores = { connection: createConnectionStore(), bots: createBotsStore(), plugin: createPluginStore() }
  const client: GatewayClient = connectGateway({
    baseUrl: (basePath as ResolvedBasePath).baseUrl,
    credentials: state.session.credentials,
    fetchImpl: browser.fetch,
    storage,
    cache: new MemoryChatCache(),
    visibility,
    network: fakeNetwork(true),
    stores,
    tuning: { backoffDelayMs: () => 50 }
  })
  const answers: Answer[] = []
  // The page's connection, with its `profiles.configure` answers written down.
  const recording: Pick<ChatGateway, 'request' | 'on'> = {
    request: (async (method: string, params?: Record<string, unknown>) => {
      const result = await (client.gateway.request as (m: string, p?: unknown) => Promise<unknown>)(method, params)

      if (method === 'profiles.configure') {
        const applied = (result as { applied?: { ui_meta_conflicts?: Record<string, unknown> } }).applied

        answers.push({ params: params ?? {}, conflicts: applied?.ui_meta_conflicts })
      }

      return result
    }) as ChatGateway['request'],
    on: client.gateway.on.bind(client.gateway)
  }
  const layout = createLayoutStore()
  const textSize = createTextSizeStore()
  const appStamp = createAppStampStore()
  const uiMeta: UiMetaRuntime = connectUiMeta({
    gateway: recording,
    connection: stores.connection,
    bots: stores.bots,
    storage,
    userId: uiMetaUserIdOf(state.identity),
    stores: { layout, textSize, appStamp },
    visibility,
    debounceMs: 0,
    now
  })

  stops.push(
    () => client.stop(),
    () => uiMeta.stop()
  )

  return { client, uiMeta, layout, textSize, appStamp, answers, appKey: () => uiMeta.bridge.appKey ?? '' }
}

type Page = Awaited<ReturnType<typeof openPage>>

/** Another client of the same gateway, writing raw: a newer build, another tool. */
const raw = (page: Page, method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
  (page.client.gateway.request as (m: string, p?: unknown) => Promise<unknown>)(method, params)

interface Row {
  name: string
  is_default?: boolean
  ui_meta?: Record<string, unknown>
}

const roster = async (page: Page): Promise<Row[]> =>
  ((await raw(page, 'profiles.list')) as { profiles: Row[] }).profiles

const defaultRow = async (page: Page): Promise<Row> => {
  const rows = await roster(page)

  return rows.find(row => row.is_default) ?? (rows[0] as Row)
}

const NOW = Math.floor(Date.now() / 1000)

/** Two pages of one person, connected, each having taken the gateway's copy and folded the roster in. */
async function twoPages(clocks: { a: number; b: number }) {
  const gateway = await startFakeGateway({ port: 0, host: '127.0.0.1', auth: 'cookie' })

  gateways.push(gateway)

  const a = await openPage(gateway, () => clocks.a)
  const b = await openPage(gateway, () => clocks.b)

  for (const page of [a, b]) {
    await waitFor(() => expect(page.client.stores.connection.getState().status).toBe('ready'))
    await waitFor(() => expect(page.uiMeta.bridge.mode).toBe('synced'))
    await waitFor(() => expect(page.layout.getState().entries.length).toBeGreaterThan(0))
  }

  expect(a.appKey()).toBe(b.appKey())
  expect(a.appKey()).toMatch(/^hermie-app:./u)

  const home = (await defaultRow(a)).name
  const bot = (await roster(a)).find(row => row.name !== home)?.name ?? home

  // Keys this build does not own and fields it does not know, written by
  // other clients before either page takes another look: a foreign key on the
  // profile, a field on a bot's section, and a field in the app section from
  // a newer build of this app.
  await raw(a, 'profiles.configure', { name: home, ui_meta: { 'other-tool': { keep: true } } })
  await raw(a, 'profiles.configure', {
    name: bot,
    ui_meta: { hermie: { v: 1, colour: 'teal', futureBotField: 'kept' } }
  })

  const section = (await defaultRow(a)).ui_meta?.[a.appKey()] as Record<string, unknown>

  await raw(a, 'profiles.configure', {
    name: home,
    ui_meta: { [a.appKey()]: { ...section, futureFromNewerBuild: { nested: [1, 2] }, updatedAt: NOW - 50 } }
  })

  await a.uiMeta.bridge.reconcile()
  await b.uiMeta.bridge.reconcile()

  for (const page of [a, b]) {
    expect(page.uiMeta.bridge.documents.app?.futureFromNewerBuild).toEqual({ nested: [1, 2] })
    expect(page.layout.getState().accents[bot]).toBe('teal')
  }

  return { gateway, a, b, home, bot }
}

describe('two pages, one person, one conflict', () => {
  it('resolves a stale write by the dates, and loses neither side’s unknown keys', async () => {
    const { a, b, home, bot } = await twoPages({ a: NOW, b: NOW + 100 })

    // Another build writes the section under the revision both pages read,
    // adding a field of its own. Both pages now hold a stale revision.
    const current = (await defaultRow(a)).ui_meta?.[a.appKey()] as Record<string, unknown>

    await raw(a, 'profiles.configure', {
      name: home,
      ui_meta: { [a.appKey()]: { ...current, addedDuringTheConflict: 'by another build', updatedAt: NOW - 10 } }
    })

    // Page B, whose clock says a later second, makes two choices and archives a
    // bot without looking at the gateway first.
    b.layout.getState().setMute(home, 0)
    b.textSize.getState().setTextSize('large')
    b.layout.getState().setArchived(bot, true)

    await waitFor(async () => {
      const row = await defaultRow(a)

      expect((row.ui_meta?.[b.appKey()] as { mutes?: unknown }).mutes).toEqual({ [home]: 0 })
    })
    await waitFor(() => expect(b.uiMeta.bridge.pending).toBe(false))

    // It was refused once, with the revision that won, and sent again.
    const refused = b.answers.filter(answer => answer.conflicts && b.appKey() in answer.conflicts)

    expect(refused.length).toBeGreaterThanOrEqual(1)

    const rows = await roster(a)
    const homeMeta = rows.find(row => row.name === home)?.ui_meta ?? {}
    const botMeta = rows.find(row => row.name === bot)?.ui_meta ?? {}
    const app = homeMeta[b.appKey()] as Record<string, unknown>

    // B's choices, under B's date: the newer choice won the section.
    expect(app).toMatchObject({ mutes: { [home]: 0 }, textSize: 'large', v: 1 })
    expect(app.updatedAt).toBeGreaterThanOrEqual(NOW + 100)
    // The newer build's fields, the one written before and the one written during.
    expect(app.futureFromNewerBuild).toEqual({ nested: [1, 2] })
    expect(app.addedDuringTheConflict).toBe('by another build')
    // The keys other tools own on the profile, untouched.
    expect(homeMeta['other-tool']).toEqual({ keep: true })
    expect(homeMeta).toHaveProperty('hermes-bots')
    expect(homeMeta).toHaveProperty('hermie-plugin')
    // And the bot's section: B's archive, beside a field this build cannot read.
    expect(botMeta.hermie).toEqual({ v: 1, colour: 'teal', futureBotField: 'kept', archived: true })

    // Page A follows on its next reconcile, and keeps every unknown key too.
    await a.uiMeta.bridge.reconcile()

    expect(a.layout.getState().mutes).toEqual({ [home]: 0 })
    expect(a.textSize.getState().textSize).toBe('large')
    expect(a.layout.getState().archived).toEqual({ [bot]: true })
    expect(a.uiMeta.bridge.documents.app).toMatchObject({
      futureFromNewerBuild: { nested: [1, 2] },
      addedDuringTheConflict: 'by another build'
    })
  })

  it('takes the gateway’s copy when its choice is the newer one, and still loses nothing', async () => {
    const { a, b, home } = await twoPages({ a: NOW, b: NOW + 100 })

    // A choice made elsewhere AFTER the one page B is about to make.
    const current = (await defaultRow(a)).ui_meta?.[a.appKey()] as Record<string, unknown>

    await raw(a, 'profiles.configure', {
      name: home,
      ui_meta: {
        [a.appKey()]: { ...current, textSize: 'xlarge', addedDuringTheConflict: 'newer', updatedAt: NOW + 500 }
      }
    })

    b.textSize.getState().setTextSize('small')

    await waitFor(() => expect(b.textSize.getState().textSize).toBe('xlarge'))
    await waitFor(() => expect(b.uiMeta.bridge.pending).toBe(false))

    const app = (await defaultRow(a)).ui_meta?.[b.appKey()] as Record<string, unknown>

    // The newer choice stands, B adopted it with its date, and nothing either
    // side carried is gone.
    expect(app.textSize).toBe('xlarge')
    expect(app.updatedAt).toBe(NOW + 500)
    expect(app.futureFromNewerBuild).toEqual({ nested: [1, 2] })
    expect(app.addedDuringTheConflict).toBe('newer')
    expect(b.appStamp.getState().updatedAt).toBe(NOW + 500)
    expect(b.uiMeta.bridge.documents.app?.addedDuringTheConflict).toBe('newer')
  })
})
