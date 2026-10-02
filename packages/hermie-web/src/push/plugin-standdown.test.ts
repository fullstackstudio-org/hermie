/**
 * What `hermie-web --push` leaves to the gateway's `hermie` plugin, and what it
 * never does.
 *
 * ADR-0017's amendment made the plugin the notifier and this daemon the
 * fallback, and the two must not deliver one notification to one device
 * twice. Before this, the daemon did not look at the plugin at all. Now it
 * leaves to the plugin exactly what the plugin can deliver:
 *
 *  - Web Push: never — a browser subscribed with THIS daemon's VAPID key.
 *  - `dm`: never — the plugin has no hook that produces one.
 *  - Expo: when the plugin's advert lists `push.expo`.
 *  - relay: when it lists `push.relay` AND the row's relay is on its `relayOrigins`.
 *
 * And it believes the advert only off the default profile, only while a
 * heartbeat (where one is promised) is fresh, and not at all under
 * `--push-ignore-plugin`.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createFakeRelay, type FakeGateway, PLUGIN_ADVERT, startFakeGateway } from '@hermie/fake-gateway'
import { afterEach, describe, expect, it } from 'vitest'

import { startPushDaemon, type PushDaemon } from './daemon'
import { EXPO_SEND_URL } from './expo'
import { PUSH_SECTION_VERSION, pushRegistrationOf, type PushRegistration } from './registrations'
import { HERMIE_PLUGIN_KEY, PLUGIN_HEARTBEAT_MISSES, pluginDelivers, pluginPushAdvertOf, readRoster } from './roster'
import { generateSubscriptionKeys } from './web-push'

const subscription = generateSubscriptionKeys()
const TYPES = { message: true, request: true, dm: true, cron: true, cron_done: true, cron_failed: true }

const REGISTRATIONS = {
  phone: {
    v: PUSH_SECTION_VERSION,
    transport: 'expo',
    token: 'ExponentPushToken[phone]',
    platform: 'android',
    types: TYPES,
    preview: false,
    updatedAt: 1
  },
  browser: {
    v: PUSH_SECTION_VERSION,
    transport: 'webpush',
    endpoint: 'https://push.test/subscription',
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    platform: 'web',
    types: TYPES,
    preview: false,
    updatedAt: 1
  },
  mac: {
    v: PUSH_SECTION_VERSION,
    transport: 'relay',
    relay: 'https://push.hermie.dev',
    handle: 'h_test-handle-0001',
    secret: 'test-send-secret-0001',
    platform: 'macos',
    types: TYPES,
    preview: false,
    updatedAt: 1
  }
}

const reg = (id: keyof typeof REGISTRATIONS, over: Record<string, unknown> = {}): PushRegistration =>
  pushRegistrationOf(id, { ...REGISTRATIONS[id], ...over }) as PushRegistration

const NOW = 1_790_001_500

describe('which notifications are the plugin’s', () => {
  const plugin = pluginPushAdvertOf(PLUGIN_ADVERT)

  it('reads the fixture as a plugin that delivers Expo and relay on the project’s relay', () => {
    expect(plugin).toMatchObject({
      pushOn: true,
      relayOrigins: ['https://push.hermie.dev'],
      capabilities: expect.arrayContaining(['push.expo', 'push.relay']) as unknown
    })
  })

  it('never takes Web Push: the browser subscribed with this daemon’s key', () => {
    for (const type of ['message', 'request', 'cron'] as const) {
      expect(pluginDelivers(plugin, reg('browser'), type, NOW)).toBe(false)
    }
  })

  it('never takes a bot-to-bot DM, on any transport: the plugin cannot produce one', () => {
    for (const id of ['phone', 'browser', 'mac'] as const) {
      expect(pluginDelivers(plugin, reg(id), 'dm', NOW)).toBe(false)
    }
  })

  it('takes Expo only when it lists push.expo', () => {
    expect(pluginDelivers(plugin, reg('phone'), 'message', NOW)).toBe(true)

    const noExpo = pluginPushAdvertOf({ ...PLUGIN_ADVERT, capabilities: ['push.webpush', 'push.relay'] })

    expect(pluginDelivers(noExpo, reg('phone'), 'message', NOW)).toBe(false)
  })

  it('takes a relay row only when it lists push.relay and the row’s relay is one it posts to', () => {
    expect(pluginDelivers(plugin, reg('mac'), 'message', NOW)).toBe(true)
    expect(pluginDelivers(plugin, reg('mac', { relay: 'https://relay.example.org' }), 'message', NOW)).toBe(false)

    const noRelay = pluginPushAdvertOf({ ...PLUGIN_ADVERT, capabilities: ['push.expo'] })
    const noOrigins = pluginPushAdvertOf({ ...PLUGIN_ADVERT, relayOrigins: undefined })

    expect(pluginDelivers(noRelay, reg('mac'), 'message', NOW)).toBe(false)
    expect(pluginDelivers(noOrigins, reg('mac'), 'message', NOW)).toBe(false)
  })

  it('takes nothing while its push module is off or planned, or from an advert of a newer contract', () => {
    for (const push of ['off', 'planned']) {
      const advert = pluginPushAdvertOf({ ...PLUGIN_ADVERT, modules: { push } })

      expect(pluginDelivers(advert, reg('phone'), 'message', NOW)).toBe(false)
    }

    expect(pluginPushAdvertOf({ ...PLUGIN_ADVERT, v: 2 })).toBeNull()
  })

  it('believes an advert with a heartbeat only while it is fresh, and one without as it stands', () => {
    const beating = (updatedAt: number) => pluginPushAdvertOf({ ...PLUGIN_ADVERT, heartbeat: 60, updatedAt })

    expect(pluginDelivers(beating(NOW - 60 * PLUGIN_HEARTBEAT_MISSES + 1), reg('phone'), 'message', NOW)).toBe(true)
    expect(pluginDelivers(beating(NOW - 60 * PLUGIN_HEARTBEAT_MISSES), reg('phone'), 'message', NOW)).toBe(false)
    expect(pluginDelivers(pluginPushAdvertOf({ ...PLUGIN_ADVERT, updatedAt: 1 }), reg('phone'), 'message', NOW)).toBe(
      true
    )
  })

  it('reads the advert off the default profile only', () => {
    const row = (name: string, uiMeta: Record<string, unknown>, isDefault = false) => ({
      name,
      is_default: isDefault,
      ui_meta: uiMeta
    })

    expect(readRoster({ profiles: [row('a', { [HERMIE_PLUGIN_KEY]: PLUGIN_ADVERT }, true)] }).plugin?.pushOn).toBe(true)
    expect(
      readRoster({ profiles: [row('a', { [HERMIE_PLUGIN_KEY]: PLUGIN_ADVERT }), row('b', {}, true)] }).plugin
    ).toBe(null)
  })
})

describe('a gateway whose plugin delivers push', () => {
  let gateway: FakeGateway
  let daemon: PushDaemon
  let outgoing: { url: string; body: string }[]
  let lines: string[]

  const start = async (
    plugin: Record<string, unknown> | false,
    options: { ignorePlugin?: boolean; registrations?: Record<string, unknown> } = {}
  ): Promise<void> => {
    const relay = createFakeRelay()
    const realFetch = globalThis.fetch

    outgoing = []
    lines = []
    gateway = await startFakeGateway({
      port: 0,
      streamDelayMs: 1,
      plugin,
      pushRegistrations: options.registrations ?? REGISTRATIONS
    })
    daemon = await startPushDaemon({
      gatewayUrl: gateway.url,
      stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-push-standdown-')),
      log: line => lines.push(line),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)

        if (url.startsWith(gateway.url.replace(/\/$/, ''))) {
          return realFetch(input as string, init)
        }

        outgoing.push({ url, body: typeof init?.body === 'string' ? init.body : '' })

        if (url === EXPO_SEND_URL) {
          return new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), { status: 200 })
        }

        return url.startsWith('https://push.hermie.dev')
          ? relay.fetch(input, init)
          : new Response(null, { status: 201 })
      }) as typeof fetch,
      ...(options.ignorePlugin ? { ignorePlugin: true } : {}),
      pollReceipts: false,
      sleep: () => Promise.resolve(),
      random: () => 0,
      tuning: { openingGraceMs: 0, registrationTtlMs: 0 }
    })

    await until(() => (daemon.watcher?.resumed.length ?? 0) >= 2)
  }

  const until = async (predicate: () => boolean, ms = 3000): Promise<void> => {
    const stop = Date.now() + ms

    while (!predicate() && Date.now() < stop) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  const transports = (): string[] =>
    [
      ...new Set(
        outgoing.map(call =>
          call.url === EXPO_SEND_URL ? 'expo' : call.url.startsWith('https://push.hermie.dev') ? 'relay' : 'webpush'
        )
      )
    ].sort()

  const turn = async (user: string): Promise<void> => {
    await fetch(`${gateway.url}/__fake/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'researcher', user, assistant: 'noted' })
    })
  }

  afterEach(async () => {
    await daemon.stop()
    await gateway.close()
  })

  it('still sends Web Push, and leaves Expo and the relay to the plugin', async () => {
    await start(PLUGIN_ADVERT)
    await turn('how did it go?')
    await until(() => outgoing.length > 0)
    // Room for anything else that was going to be sent.
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(transports()).toEqual(['webpush'])
    expect(lines.some(line => line.includes('2 device(s) left to the gateway’s hermie plugin'))).toBe(true)
  })

  it('says so, with the advert’s age and the way out', async () => {
    await start(PLUGIN_ADVERT)

    const warning = lines.find(line => line.includes('says it delivers'))

    expect(warning).toContain('expo and relay (https://push.hermie.dev)')
    expect(warning).toContain(new Date((PLUGIN_ADVERT.updatedAt as number) * 1000).toISOString())
    expect(warning).toContain('--push-ignore-plugin')
  })

  it('sends a bot-to-bot DM on every transport, because the plugin cannot', async () => {
    await start(PLUGIN_ADVERT)
    await fetch(`${gateway.url}/__fake/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'dm', profile: 'researcher', from: 'Writer', handle: 'writer' })
    })
    await until(() => transports().length === 3)

    expect(transports()).toEqual(['expo', 'relay', 'webpush'])
  })

  it('serves a relay row the plugin will not post to', async () => {
    await start(
      { ...PLUGIN_ADVERT, relayOrigins: ['https://relay.example.org'] },
      { registrations: { mac: REGISTRATIONS.mac, phone: REGISTRATIONS.phone } }
    )
    await turn('and now?')
    await until(() => outgoing.length > 0)
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(transports()).toEqual(['relay'])
  })

  it('keeps push.webpush in its availability stamp, and drops what it leaves to the plugin', async () => {
    await start(PLUGIN_ADVERT)

    let stamp: { capabilities?: string[]; relayOrigins?: string[] } = {}

    await until(() => {
      void fetch(`${gateway.url}/__fake/push`)
        .then(response => response.json())
        .then(body => {
          stamp = body as typeof stamp
        })

      return Boolean(stamp.capabilities)
    })

    expect(stamp.capabilities).toEqual(['push.webpush'])
    expect(stamp.relayOrigins).toEqual([])
  })

  it('sends on every transport, as before, where there is no plugin', async () => {
    await start(false)
    await turn('how did it go?')
    await until(() => transports().length === 3)

    expect(transports()).toEqual(['expo', 'relay', 'webpush'])
  })

  it('sends on every transport when told to ignore the plugin', async () => {
    await start(PLUGIN_ADVERT, { ignorePlugin: true })
    await turn('how did it go?')
    await until(() => transports().length === 3)

    expect(transports()).toEqual(['expo', 'relay', 'webpush'])
  })
})
