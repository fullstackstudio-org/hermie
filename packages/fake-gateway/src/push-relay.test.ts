/**
 * The relay half of the fake: the plugin advert's `push.relay`, a relay row
 * through `/__fake/push`, and the in-process relay stand-in itself.
 */
import { describe, expect, it } from 'vitest'

import { createFakeRelay } from './fake-relay'
import { PLUGIN_ADVERT, startFakeGateway, type FakeGateway } from './server'

const advertOf = async (gateway: FakeGateway): Promise<{ capabilities?: string[] } | undefined> => {
  const roster = (await fetch(`${gateway.url}/api/profiles`).then(response => response.json())) as {
    profiles: { ui_meta?: Record<string, { capabilities?: string[] }> }[]
  }

  return roster.profiles.map(row => row.ui_meta?.['hermie-plugin']).find(Boolean)
}

const RELAY_ROW = {
  v: 1,
  transport: 'relay',
  relay: 'https://push.hermie.dev',
  handle: 'h_test-handle-0001',
  secret: 'test-send-secret-0001',
  platform: 'ios',
  types: { message: true, request: true },
  preview: false,
  updatedAt: 1_790_001_453,
  enc: { alg: 'chacha20-poly1305', key: 'k', kid: 1 },
  futureField: { kept: true }
}

describe('the plugin advert and push.relay', () => {
  it('advertises push.relay by default, next to push.expo', async () => {
    expect(PLUGIN_ADVERT.capabilities).toEqual(expect.arrayContaining(['push.expo', 'push.relay']))

    const gateway = await startFakeGateway({ port: 0 })

    try {
      expect((await advertOf(gateway))?.capabilities).toEqual(expect.arrayContaining(['push.expo', 'push.relay']))
    } finally {
      await gateway.close()
    }
  })

  it('drops only push.relay when the notifier predates the relay', async () => {
    const gateway = await startFakeGateway({ port: 0, pushRelay: false })

    try {
      const capabilities = (await advertOf(gateway))?.capabilities ?? []

      expect(capabilities).not.toContain('push.relay')
      expect(capabilities).toContain('push.expo')
    } finally {
      await gateway.close()
    }
  })

  it('drops push.relay from an advert a test passed in, too', async () => {
    const gateway = await startFakeGateway({
      port: 0,
      pushRelay: false,
      plugin: { ...PLUGIN_ADVERT, capabilities: ['push.expo', 'push.relay'] }
    })

    try {
      expect((await advertOf(gateway))?.capabilities).toEqual(['push.expo'])
    } finally {
      await gateway.close()
    }
  })
})

describe('/__fake/push with a relay row', () => {
  it('stores a relay row and reads it back whole, `enc` and unknown fields included', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      const expoRow = { v: 1, transport: 'expo', token: 'ExponentPushToken[test-0001]', types: { message: true } }
      const set = await fetch(`${gateway.url}/__fake/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'registrations', registrations: { 'i-mac': RELAY_ROW, 'i-phone': expoRow } })
      })

      expect(set.status).toBe(200)

      const section = (await fetch(`${gateway.url}/__fake/push`).then(response => response.json())) as {
        registrations: Record<string, unknown>
      }

      expect(section.registrations).toEqual({ 'i-mac': RELAY_ROW, 'i-phone': expoRow })
    } finally {
      await gateway.close()
    }
  })
})

describe('the fake relay', () => {
  const send = async (relay: ReturnType<typeof createFakeRelay>, messages: unknown[], url?: string) =>
    relay.fetch(url ?? `${relay.origin}/v1/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, messages }),
      redirect: 'manual'
    })

  const message = (handle: string, secret = 's') => ({ handle, secret, message: { title: 't', body: 'b' } })

  it('answers sent per message and records what it delivered', async () => {
    const relay = createFakeRelay()
    const response = await send(relay, [message('h_a'), message('h_b')])

    expect(await response.json()).toEqual({
      results: [
        { handle: 'h_a', status: 'sent' },
        { handle: 'h_b', status: 'sent' }
      ]
    })
    expect(relay.delivered.map(entry => entry.handle)).toEqual(['h_a', 'h_b'])
    expect(relay.requests[0]?.redirect).toBe('manual')
  })

  it('answers gone for an unknown handle and for a wrong secret alike', async () => {
    const relay = createFakeRelay()

    relay.register('h_a', 'right')

    const body = (await (
      await send(relay, [message('h_a', 'right'), message('h_a', 'wrong'), message('h_x')])
    ).json()) as {
      results: { status: string }[]
    }

    expect(body.results.map(result => result.status)).toEqual(['sent', 'gone', 'gone'])
  })

  it('plays scripted answers in order, then falls back to the default', async () => {
    const relay = createFakeRelay()

    relay.answer('h_a', { status: 'limited', retryAfter: 2 }, 'rejected')

    const statuses = async () =>
      ((await (await send(relay, [message('h_a')])).json()) as { results: { status: string; retryAfter?: number }[] })
        .results[0]

    expect(await statuses()).toEqual({ handle: 'h_a', status: 'limited', retryAfter: 2 })
    expect(await statuses()).toEqual({ handle: 'h_a', status: 'rejected' })
    expect(await statuses()).toEqual({ handle: 'h_a', status: 'sent' })
  })

  it('fails a whole request on demand, and refuses what the real relay refuses', async () => {
    const relay = createFakeRelay()

    relay.failNext({ network: true })
    await expect(send(relay, [message('h_a')])).rejects.toThrow()

    relay.failNext({ status: 429, headers: { 'retry-after': '3' } })
    expect((await send(relay, [message('h_a')])).status).toBe(429)

    expect((await send(relay, [])).status).toBe(400)
    expect(
      (
        await send(
          relay,
          Array.from({ length: 21 }, (_v, i) => message(`h_${String(i)}`))
        )
      ).status
    ).toBe(400)
    expect((await send(relay, [message('h_a')], 'https://elsewhere.example/v1/send')).status).toBe(404)
    expect(relay.requests.map(request => request.url).at(-1)).toBe('https://elsewhere.example/v1/send')
  })

  it('holds every message to the relay’s own schema, and answers rejected for the one that fails it', async () => {
    const relay = createFakeRelay()
    const entry = (handle: string, message: unknown) => ({ handle, secret: 's', message })
    const cases: [string, unknown, string][] = [
      [
        'h_ok',
        {
          title: 't',
          body: 'b',
          category: 'hermie.request',
          thread: 'k:bot',
          collapseId: 'request:ab',
          priority: 'normal',
          ttl: 0,
          data: { v: 1 }
        },
        'sent'
      ],
      ['h_key', { title: 't', body: 'b', aps: {} }, 'invalid_message'],
      ['h_title', { title: '', body: 'b' }, 'invalid_message'],
      ['h_cat', { title: 't', body: 'b', category: 'has space' }, 'invalid_message'],
      ['h_collapse', { title: 't', body: 'b', collapseId: 'tab\there' }, 'invalid_message'],
      ['h_long_collapse', { title: 't', body: 'b', collapseId: 'x'.repeat(65) }, 'invalid_message'],
      ['h_thread', { title: 't', body: 'b', thread: 'x'.repeat(257) }, 'invalid_message'],
      ['h_empty_thread', { title: 't', body: 'b', thread: '' }, 'invalid_message'],
      ['h_ttl', { title: 't', body: 'b', ttl: 1.5 }, 'invalid_message'],
      ['h_big', { title: 't', body: 'x'.repeat(3_600) }, 'payload_too_large']
    ]
    const response = await send(
      relay,
      cases.map(([handle, message]) => entry(handle, message))
    )
    const results = ((await response.json()) as { results: { handle: string; status: string; reason?: string }[] })
      .results

    expect(results.map(result => result.reason ?? result.status)).toEqual(cases.map(([, , expected]) => expected))
  })

  it('refuses a body that is not JSON by its content type, and a handle or secret over 200 characters', async () => {
    const relay = createFakeRelay()
    const plain = await relay.fetch(`${relay.origin}/v1/send`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ v: 1, messages: [message('h_a')] })
    })

    expect(plain.status).toBe(415)
    expect((await send(relay, [message('h'.repeat(201))])).status).toBe(400)
  })
})
