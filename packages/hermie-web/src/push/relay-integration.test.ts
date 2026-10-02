/**
 * The relay transport end to end: a fake gateway holding a relay row, the real
 * daemon watching it, and an in-process relay answering for the project's
 * origin. What this adds over `relay.test.ts` is the part only the whole chain
 * can show — the watcher's shared rules decide, the sender delivers, and a
 * `gone` answer retires the row through the same path an Expo
 * `DeviceNotRegistered` takes.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createFakeRelay, type FakeGateway, type FakeRelay, startFakeGateway } from '@hermie/fake-gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startPushDaemon, type PushDaemon } from './daemon'
import { EXPO_SEND_URL } from './expo'
import { PUSH_SECTION_VERSION } from './registrations'

const relayRow = (over: Record<string, unknown> = {}) => ({
  v: PUSH_SECTION_VERSION,
  transport: 'relay',
  relay: 'https://push.hermie.dev',
  handle: 'h_test-handle-0001',
  secret: 'test-send-secret-0001',
  platform: 'ios',
  types: { message: true, request: true, cron: true },
  // Asked for, and must not be honoured: see the privacy case below.
  preview: true,
  updatedAt: 1,
  ...over
})

const expoRow = () => ({
  v: PUSH_SECTION_VERSION,
  transport: 'expo',
  token: 'ExponentPushToken[phone]',
  platform: 'android',
  types: { message: true, request: true, cron: true },
  preview: true,
  updatedAt: 1
})

let gateway: FakeGateway
let daemon: PushDaemon
let relay: FakeRelay
let expoBodies: Record<string, unknown>[]
let lines: string[]

const realFetch = globalThis.fetch

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> => {
  const until = Date.now() + timeoutMs

  while (Date.now() < until) {
    if (predicate()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error(`timed out waiting for ${label}`)
}

const start = async (registrations: Record<string, unknown>, relays?: string[]) => {
  // No `hermie` plugin, so this daemon is the gateway's notifier.
  gateway = await startFakeGateway({ port: 0, streamDelayMs: 1, plugin: false, pushRegistrations: registrations })
  daemon = await startPushDaemon({
    gatewayUrl: gateway.url,
    stateDir: await mkdtemp(path.join(tmpdir(), 'hermie-push-relay-')),
    version: '9.9.9',
    log: line => lines.push(line),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)

      if (url.startsWith(gateway.url.replace(/\/$/, ''))) {
        return realFetch(input as string, init)
      }

      if (url === EXPO_SEND_URL) {
        expoBodies.push(...(JSON.parse(String(init?.body)) as Record<string, unknown>[]))

        return new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), { status: 200 })
      }

      return relay.fetch(input, init)
    }) as typeof fetch,
    pollReceipts: false,
    sleep: () => Promise.resolve(),
    random: () => 0,
    ...(relays ? { relays } : {}),
    tuning: { openingGraceMs: 0, registrationTtlMs: 0 }
  })
  await waitFor(() => (daemon.watcher?.resumed.length ?? 0) > 1, 'both chats to be resumed')
}

const turn = async (): Promise<void> => {
  const response = await fetch(`${gateway.url}/__fake/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'researcher', user: 'how did it go?', assistant: 'the confidential figures' })
  })

  expect(response.status).toBe(200)
}

beforeEach(() => {
  relay = createFakeRelay()
  expoBodies = []
  lines = []
})

afterEach(async () => {
  await daemon.stop()
  await gateway.close()
})

describe('a relay registration on a gateway', () => {
  it('is notified through the relay, with the bot name and event type and never the text', async () => {
    await start({ mac: relayRow(), phone: expoRow() })
    await turn()

    await waitFor(() => relay.delivered.length > 0 && expoBodies.length > 0, 'both sends')

    const delivered = relay.delivered[0]

    expect(delivered?.handle).toBe('h_test-handle-0001')
    expect(delivered?.message.title).toBe('Researcher')
    expect(delivered?.message.body).toBe('sent you a message')
    expect(JSON.stringify(relay.requests)).not.toContain('confidential')
    // The Expo device asked for a preview and gets one: the rule is per relay
    // row, not a change to anybody else's notifications.
    expect(expoBodies[0]?.body).toBe('the confidential figures')
  })

  it('retires a row the relay calls gone, as the Expo path does', async () => {
    relay.answer('h_test-handle-0001', 'gone')
    await start({ mac: relayRow() })
    await turn()

    await waitFor(() => Boolean(daemon.state.invalid.mac), 'the row to be retired')

    // Retired rows are not sent to again.
    await fetch(`${gateway.url}/__fake/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'writer', user: 'and now?', assistant: 'done' })
    })
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(relay.requests).toHaveLength(1)
  })

  it('serves the same device again once it registers again, under the same installation id', async () => {
    relay.answer('h_test-handle-0001', 'gone')
    await start({ mac: relayRow() })
    await turn()
    await waitFor(() => Boolean(daemon.state.invalid.mac), 'the row to be retired')

    // The device registers with the relay again and rewrites its row: same
    // installation id, a new handle and secret, a newer `updatedAt`.
    const rewritten = relayRow({
      handle: 'h_test-handle-0002',
      secret: 'test-send-secret-0002',
      updatedAt: Math.floor(Date.now() / 1000) + 60
    })
    const set = await fetch(`${gateway.url}/__fake/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'registrations', registrations: { mac: rewritten } })
    })

    expect(set.status).toBe(200)

    await fetch(`${gateway.url}/__fake/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'writer', user: 'and now?', assistant: 'done' })
    })
    await waitFor(() => relay.delivered.length > 0, 'the delivery to the new registration')

    expect(relay.delivered.map(entry => entry.handle)).toEqual(['h_test-handle-0002'])
  })

  it('is not sent to when it names a relay outside the allow-list', async () => {
    await start({ mac: relayRow({ relay: 'https://collector.example.net' }), phone: expoRow() })
    await turn()

    await waitFor(() => expoBodies.length > 0, 'the Expo send')
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(relay.requests).toEqual([])
    expect(daemon.state.invalid.mac).toBeUndefined()
    expect(lines.join('\n')).toMatch(/not_allowed ×1/)
  })

  it('says push.relay in the availability stamp, and only with a relay to send to', async () => {
    await start({ phone: expoRow() })

    const stamped = async (): Promise<string[]> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const push = (await fetch(`${gateway.url}/__fake/push`).then(response => response.json())) as {
          capabilities?: string[]
        }

        if (push.capabilities) {
          return push.capabilities
        }

        await new Promise(resolve => setTimeout(resolve, 10))
      }

      throw new Error('no availability stamp')
    }

    expect(await stamped()).toEqual(['push.expo', 'push.webpush', 'push.relay'])

    await daemon.stop()
    await gateway.close()
    await start({ phone: expoRow() }, [])

    expect(await stamped()).toEqual(['push.expo', 'push.webpush'])
  })
})
