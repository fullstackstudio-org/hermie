/**
 * `hermie-web --push` stands down where the gateway's `hermie` plugin delivers
 * push.
 *
 * ADR-0017's amendment made the plugin the notifier and this daemon the
 * fallback, and said the two must not both run: every registered device would
 * hear about everything twice. Until this change the daemon did not look — it
 * sent whatever the plugin advertised. Now it reads the plugin's advert off the
 * roster and, while it says the push module is on, sends nothing on ANY
 * transport. These cases pin both halves: silence with the plugin, unchanged
 * delivery without it (or with its push module off).
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createFakeRelay, type FakeGateway, PLUGIN_ADVERT, startFakeGateway } from '@hermie/fake-gateway'
import { afterEach, describe, expect, it } from 'vitest'

import { startPushDaemon, type PushDaemon } from './daemon'
import { EXPO_SEND_URL } from './expo'
import { PUSH_SECTION_VERSION } from './registrations'
import { HERMIE_PLUGIN_KEY, readRoster } from './roster'
import { generateSubscriptionKeys } from './web-push'

const subscription = generateSubscriptionKeys()
const TYPES = { message: true, request: true, cron: true }

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

describe('reading the plugin’s advert off the roster', () => {
  const row = (name: string, uiMeta: Record<string, unknown>, isDefault = false) => ({
    name,
    is_default: isDefault,
    ui_meta: uiMeta
  })

  it('says the plugin delivers push when its push module is on', () => {
    expect(readRoster({ profiles: [row('a', { [HERMIE_PLUGIN_KEY]: PLUGIN_ADVERT }, true)] }).pluginPush).toBe(true)
  })

  it('says nothing about a gateway with no advert, or a push module that is off or planned', () => {
    expect(readRoster({ profiles: [row('a', {}, true)] }).pluginPush).toBe(false)

    for (const push of ['off', 'planned']) {
      const advert = { ...PLUGIN_ADVERT, modules: { ...(PLUGIN_ADVERT.modules as object), push } }

      expect(readRoster({ profiles: [row('a', { [HERMIE_PLUGIN_KEY]: advert }, true)] }).pluginPush).toBe(false)
    }
  })

  it('reads an advert from a newer contract as no advert, as the app does', () => {
    expect(
      readRoster({ profiles: [row('a', { [HERMIE_PLUGIN_KEY]: { ...PLUGIN_ADVERT, v: 2 } }, true)] }).pluginPush
    ).toBe(false)
  })

  it('lets the default profile’s advert win, and otherwise takes the first one it finds', () => {
    const off = { ...PLUGIN_ADVERT, modules: { push: 'off' } }

    expect(
      readRoster({
        profiles: [row('a', { [HERMIE_PLUGIN_KEY]: PLUGIN_ADVERT }), row('b', { [HERMIE_PLUGIN_KEY]: off }, true)]
      }).pluginPush
    ).toBe(false)
    expect(
      readRoster({ profiles: [row('a', { [HERMIE_PLUGIN_KEY]: PLUGIN_ADVERT }), row('b', {}, true)] }).pluginPush
    ).toBe(true)
  })
})

describe('a gateway whose plugin delivers push', () => {
  let gateway: FakeGateway
  let daemon: PushDaemon
  let outgoing: string[]
  let lines: string[]

  const start = async (plugin: Record<string, unknown> | false): Promise<void> => {
    const relay = createFakeRelay()
    const realFetch = globalThis.fetch

    outgoing = []
    lines = []
    gateway = await startFakeGateway({ port: 0, streamDelayMs: 1, plugin, pushRegistrations: REGISTRATIONS })
    daemon = await startPushDaemon({
      gatewayUrl: gateway.url,
      stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-push-standdown-')),
      log: line => lines.push(line),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)

        if (url.startsWith(gateway.url.replace(/\/$/, ''))) {
          return realFetch(input as string, init)
        }

        outgoing.push(url)

        if (url === EXPO_SEND_URL) {
          return new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), { status: 200 })
        }

        return url.startsWith('https://push.hermie.dev')
          ? relay.fetch(input, init)
          : new Response(null, { status: 201 })
      }) as typeof fetch,
      pollReceipts: false,
      sleep: () => Promise.resolve(),
      random: () => 0,
      tuning: { openingGraceMs: 0, registrationTtlMs: 0, approvalPollMs: 20 }
    })

    const until = Date.now() + 5000

    while ((daemon.watcher?.resumed.length ?? 0) < 2 && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  /** A finished turn and an open approval: two events, through both notification paths. */
  const happen = async (): Promise<void> => {
    await fetch(`${gateway.url}/__fake/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'researcher', user: 'how did it go?', assistant: 'all done' })
    })
    void gateway.raiseApprovalOn({ command: 'rm -rf ./build' }).catch(() => undefined)
  }

  const settle = async (predicate: () => boolean, ms = 3000): Promise<void> => {
    const until = Date.now() + ms

    while (!predicate() && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  afterEach(async () => {
    await daemon.stop()
    await gateway.close()
  })

  it('sends nothing at all, on any transport, and says why', async () => {
    await start(PLUGIN_ADVERT)
    await happen()
    // The approval is raised on the gateway too; the approval poll (every 20 ms
    // here) is skipped outright while the plugin is the notifier, so the only
    // trace of standing down is the turn's line.
    await settle(() => lines.some(line => line.includes('not notifying')))
    // Room for anything that was going to be sent anyway: ten poll intervals.
    await new Promise(resolve => setTimeout(resolve, 200))

    expect(outgoing).toEqual([])
    expect(lines.some(line => line.includes('hermie plugin delivers push; not notifying'))).toBe(true)
    expect(lines.some(line => line.includes('so this daemon sends nothing'))).toBe(true)

    // And its availability stamp claims nothing, `push.relay` least of all: an
    // app must not swap its Expo row for a relay row on this daemon's word.
    const stamp = (await fetch(`${gateway.url}/__fake/push`).then(response => response.json())) as {
      capabilities?: unknown
      relayOrigins?: unknown
    }

    expect(stamp.capabilities).toEqual([])
    expect(stamp.relayOrigins).toEqual([])
  })

  it('sends to every transport, as before, where there is no plugin', async () => {
    await start(false)
    await happen()
    await settle(
      () => outgoing.includes(EXPO_SEND_URL) && outgoing.some(url => url.startsWith('https://push.hermie.dev'))
    )

    expect(outgoing).toContain(EXPO_SEND_URL)
    expect(outgoing).toContain('https://push.test/subscription')
    expect(outgoing).toContain('https://push.hermie.dev/v1/send')
  })

  it('sends as before where the plugin is installed with its push module off', async () => {
    await start({ ...PLUGIN_ADVERT, modules: { ...(PLUGIN_ADVERT.modules as object), push: 'off' } })
    await happen()
    await settle(() => outgoing.includes(EXPO_SEND_URL))

    expect(outgoing).toContain(EXPO_SEND_URL)
  })
})
