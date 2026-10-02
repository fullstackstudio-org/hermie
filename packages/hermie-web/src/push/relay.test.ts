/**
 * The relay sender, against an in-process relay.
 *
 * What is pinned here is mostly what must NOT happen: a request to an origin
 * the allow-list does not name, a redirect followed, a second retry, message
 * text in a relay body, a secret in a log line. The happy path is one case.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createFakeRelay, type FakeRelay } from '@hermie/fake-gateway'
import { describe, expect, it, vi } from 'vitest'

import type { PushMessage } from './expo'
import { eventIdOf, type NotifiableEvent, pushMessageFor } from './payload'
import { pushRegistrationOf, type PushRegistration, type PushType } from './registrations'
import {
  createRelayBackoff,
  handleHint,
  RELAY_BATCH_SIZE,
  RELAY_COLLAPSE_ID_LIMIT,
  RELAY_DEFAULT_ORIGIN,
  RELAY_MAX_RETRY_WAIT_SECONDS,
  RELAY_ORIGIN_BACKOFF_SECONDS,
  RELAY_REQUEST_LIMIT_BYTES,
  relayMessageFor,
  sendRelay,
  type RelayOptions
} from './relay'

const SECRET = 'test-send-secret-do-not-log'

const relayRow = (installationId: string, over: Partial<PushRegistration> = {}): PushRegistration => ({
  installationId,
  owner: '',
  transport: 'relay',
  relay: RELAY_DEFAULT_ORIGIN,
  handle: `h_handle-for-${installationId}`,
  secret: SECRET,
  platform: 'ios',
  types: { message: true, request: true, dm: true, cron: true, cron_done: true, cron_failed: true },
  preview: false,
  updatedAt: 0,
  ...over
})

const EVENT: NotifiableEvent = {
  type: 'message',
  bot: 'researcher',
  botLabel: 'Researcher',
  sessionId: 'session-1',
  sessionKind: 'canonical',
  gatewayKey: 'bf796761db84e312',
  preview: 'the confidential plan for Tuesday'
}

const MESSAGE: PushMessage = { ...pushMessageFor(EVENT, false), eventId: 'session-1:message:7' }

interface Harness {
  relay: FakeRelay
  lines: string[]
  sleeps: number[]
  options: RelayOptions
}

const harness = (over: Partial<RelayOptions> = {}): Harness => {
  const relay = createFakeRelay()
  const lines: string[] = []
  const sleeps: number[] = []

  return {
    relay,
    lines,
    sleeps,
    options: {
      allowList: [RELAY_DEFAULT_ORIGIN],
      fetchImpl: relay.fetch,
      log: line => lines.push(line),
      sleep: async ms => {
        sleeps.push(ms)
      },
      ...over
    }
  }
}

const sentBodies = (relay: FakeRelay) =>
  relay.requests.map(request => request.body as { v: number; messages: Record<string, unknown>[] })

describe('one notification through the relay', () => {
  it('posts the abstract message to the relay’s send route, with the handle and secret per message', async () => {
    const h = harness()
    const result = await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(result).toEqual({ dead: [], outcomes: [{ installationId: 'mac', status: 'sent' }] })
    expect(h.relay.requests).toHaveLength(1)

    const request = h.relay.requests[0]

    expect(request?.url).toBe('https://push.hermie.dev/v1/send')
    expect(request?.method).toBe('POST')
    expect(request?.headers['content-type']).toBe('application/json')
    expect(request?.redirect).toBe('manual')
    expect(request?.timed).toBe(true)
    expect(request?.body).toEqual({
      v: 1,
      messages: [
        {
          handle: 'h_handle-for-mac',
          secret: SECRET,
          message: {
            title: 'Researcher',
            body: 'sent you a message',
            thread: 'bf796761db84e312:researcher',
            collapseId: 'session-1:message:7',
            priority: 'high',
            ttl: 3600,
            data: {
              bot: 'researcher',
              type: 'message',
              session: 'session-1',
              sessionId: 'session-1',
              sessionKind: 'canonical',
              gatewayKey: 'bf796761db84e312'
            }
          }
        }
      ]
    })
  })

  it('gives an approval the contract’s category and request id', () => {
    const message = relayMessageFor(
      pushMessageFor({ ...EVENT, type: 'request', requestMethod: 'approval', requestId: 'appr-1' }, false)
    )

    expect(message.category).toBe('hermie.request')
    expect((message.data as Record<string, unknown>).requestId).toBe('appr-1')
  })

  it('leaves the collapse id out when there is no event id, rather than sending it empty', () => {
    const { eventId: _none, ...plain } = MESSAGE

    expect(relayMessageFor(plain)).not.toHaveProperty('collapseId')
  })

  it('keeps a long event id to the 64 bytes APNs allows, stably', () => {
    const long = 'x'.repeat(200)
    const first = relayMessageFor({ ...MESSAGE, eventId: long }).collapseId as string

    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(RELAY_COLLAPSE_ID_LIMIT)
    expect(relayMessageFor({ ...MESSAGE, eventId: long }).collapseId).toBe(first)
  })
})

describe('the allow-list decides, not the row', () => {
  it('sends to the project’s relay by default', async () => {
    const h = harness()

    await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(h.relay.requests.map(request => request.url)).toEqual(['https://push.hermie.dev/v1/send'])
  })

  it('sends to a custom relay on a custom list, and not to the default one', async () => {
    const custom = createFakeRelay({ origin: 'https://relay.example.org' })
    const h = harness({ allowList: ['https://relay.example.org/'], fetchImpl: custom.fetch })
    const result = await sendRelay(
      [relayRow('a', { relay: 'https://relay.example.org' }), relayRow('b')],
      MESSAGE,
      h.options
    )

    expect(custom.requests.map(request => request.url)).toEqual(['https://relay.example.org/v1/send'])
    expect(custom.delivered.map(entry => entry.handle)).toEqual(['h_handle-for-a'])
    expect(result.outcomes).toContainEqual({ installationId: 'b', status: 'skipped', reason: 'not_allowed' })
  })

  it('never contacts an origin a row names that the list does not, and does not retire the row', async () => {
    const h = harness()
    const result = await sendRelay([relayRow('evil', { relay: 'https://collector.example.net' })], MESSAGE, h.options)

    expect(h.relay.requests).toEqual([])
    expect(result.dead).toEqual([])
    expect(h.lines.join('\n')).toMatch(/not on the allow-list/)
    expect(h.lines.join('\n')).not.toContain('collector.example.net')
  })

  it('sends nothing at all with an empty list', async () => {
    const h = harness({ allowList: [] })

    await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(h.relay.requests).toEqual([])
  })

  it('ignores the Expo and Web Push rows it is handed', async () => {
    const h = harness()

    await sendRelay(
      [{ ...relayRow('x'), transport: 'expo', token: 'ExponentPushToken[x]', relay: undefined, handle: undefined }],
      MESSAGE,
      h.options
    )

    expect(h.relay.requests).toEqual([])
  })
})

describe('batches', () => {
  it('sends at most twenty messages per request', async () => {
    const h = harness()
    const rows = Array.from({ length: 45 }, (_value, index) => relayRow(`d${String(index).padStart(2, '0')}`))
    const result = await sendRelay(rows, MESSAGE, h.options)

    expect(sentBodies(h.relay).map(body => body.messages.length)).toEqual([RELAY_BATCH_SIZE, RELAY_BATCH_SIZE, 5])
    expect(result.outcomes.filter(outcome => outcome.status === 'sent')).toHaveLength(45)
  })

  it('splits by encoded size, staying under 7.5 KB a request, well inside the relay’s 8 KB', async () => {
    const h = harness()
    // The longest handles and secrets the relay accepts, so twenty messages
    // would not fit in one request.
    const rows = Array.from({ length: 20 }, (_value, index) =>
      relayRow(`d${String(index)}`, {
        handle: `h_${'a'.repeat(190)}${String(index).padStart(2, '0')}`,
        secret: 's'.repeat(200)
      })
    )

    await sendRelay(rows, MESSAGE, h.options)

    expect(h.relay.requests.length).toBeGreaterThan(1)

    for (const request of h.relay.requests) {
      expect(Buffer.byteLength(JSON.stringify(request.body))).toBeLessThanOrEqual(RELAY_REQUEST_LIMIT_BYTES)
    }

    expect(RELAY_REQUEST_LIMIT_BYTES).toBe(7_680)
    expect(h.relay.delivered).toHaveLength(20)
  })

  it('packs realistic approvals as tightly as 7.5 KB allows, and no tighter', async () => {
    const h = harness()
    const approval = pushMessageFor(
      {
        ...EVENT,
        type: 'request',
        requestMethod: 'approval',
        requestId: 'appr-1',
        eventId: eventIdOf('request', 's', 'a')
      },
      false
    )
    const rows = Array.from({ length: 20 }, (_value, index) =>
      relayRow(`d${String(index)}`, {
        handle: `h_${'A'.repeat(20)}${String(index).padStart(2, '0')}`,
        secret: 'S'.repeat(43)
      })
    )

    await sendRelay(rows, approval, h.options)

    const bodies = sentBodies(h.relay)
    const entryBytes = Buffer.byteLength(JSON.stringify(bodies[0]?.messages[0]))
    const sizes = bodies.map(body => Buffer.byteLength(JSON.stringify(body)))

    // A real approval entry is several hundred bytes, so twenty do not fit in
    // one request: the sender splits, and fills each request until the next
    // entry would cross the limit.
    expect(entryBytes).toBeGreaterThan(400)
    expect(bodies.length).toBeGreaterThan(1)
    expect(bodies.reduce((total, body) => total + body.messages.length, 0)).toBe(20)

    for (const size of sizes.slice(0, -1)) {
      expect(size).toBeLessThanOrEqual(RELAY_REQUEST_LIMIT_BYTES)
      expect(size + 1 + entryBytes).toBeGreaterThan(RELAY_REQUEST_LIMIT_BYTES)
    }

    expect(h.relay.delivered).toHaveLength(20)
  })

  it('never puts one handle in a request twice, even with two different secrets', async () => {
    const h = harness()

    await sendRelay(
      [relayRow('old', { handle: 'h_same', secret: 'stale' }), relayRow('new', { handle: 'h_same', secret: 'fresh' })],
      MESSAGE,
      h.options
    )

    expect(
      sentBodies(h.relay).map(body => body.messages.map(entry => `${String(entry.handle)}/${String(entry.secret)}`))
    ).toEqual([['h_same/stale'], ['h_same/fresh']])
  })

  it('sends once to rows naming the same relay, handle and secret, and answers for each of them', async () => {
    const h = harness()

    h.relay.answer('h_twin', 'gone')

    const result = await sendRelay(
      [relayRow('a', { handle: 'h_twin', secret: 'x' }), relayRow('b', { handle: 'h_twin', secret: 'x' })],
      MESSAGE,
      h.options
    )

    expect(sentBodies(h.relay).map(body => body.messages.length)).toEqual([1])
    expect(result.dead).toEqual(['a', 'b'])
  })

  it('refuses a message over the relay’s 3.5 KB cap without sending it', async () => {
    const h = harness()
    const result = await sendRelay([relayRow('mac')], { ...MESSAGE, title: 'x'.repeat(4000) }, h.options)

    expect(h.relay.requests).toEqual([])
    expect(result.outcomes).toEqual([{ installationId: 'mac', status: 'rejected', reason: 'payload_too_large' }])
  })
})

describe('a request the relay refuses whole', () => {
  it('sends each entry again on its own, once, so one bad row costs only itself', async () => {
    const h = harness()

    // The batch is refused, then the first entry alone is refused too.
    h.relay.failNext({ status: 413, body: { error: 'request_too_large' } })
    h.relay.failNext({ status: 400, body: { error: 'invalid_request' } })

    const result = await sendRelay([relayRow('bad'), relayRow('b'), relayRow('c')], MESSAGE, h.options)

    expect(sentBodies(h.relay).map(body => body.messages.length)).toEqual([3, 1, 1, 1])
    expect(result.outcomes).toEqual([
      { installationId: 'bad', status: 'rejected', reason: 'http_400' },
      { installationId: 'b', status: 'sent' },
      { installationId: 'c', status: 'sent' }
    ])
    expect(result.dead).toEqual([])
  })

  it('does not send a single refused entry again', async () => {
    const h = harness()

    h.relay.failNext({ status: 400, body: { error: 'invalid_request' } })

    const result = await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(h.relay.requests).toHaveLength(1)
    expect(result.outcomes).toEqual([{ installationId: 'mac', status: 'rejected', reason: 'http_400' }])
  })
})

describe('never blocking the sender', () => {
  const clocked = () => {
    let at = 1_800_000_000_000
    const backoff = createRelayBackoff()
    const h = harness({ backoff, now: () => at })

    return { h, backoff, advance: (seconds: number) => (at += seconds * 1000) }
  }

  it('leaves a relay alone after a whole request failed twice, then tries it again once the time has passed', async () => {
    const { h, backoff, advance } = clocked()

    h.relay.failNext({ status: 503 })
    h.relay.failNext({ status: 503 })

    const first = await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(first.outcomes).toEqual([{ installationId: 'mac', status: 'retry', reason: 'dropped' }])
    expect(backoff.origins.get(RELAY_DEFAULT_ORIGIN)).toBeGreaterThan(0)

    const during = await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(h.relay.requests).toHaveLength(2)
    expect(during.outcomes).toEqual([{ installationId: 'mac', status: 'skipped', reason: 'relay_backoff' }])

    advance(RELAY_ORIGIN_BACKOFF_SECONDS + 1)
    await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(h.relay.requests).toHaveLength(3)
    expect(h.relay.delivered).toHaveLength(1)
  })

  it('drops at once, and backs the relay off for as long as it asked, when a 429 asks for too long', async () => {
    const { h, backoff, advance } = clocked()

    h.relay.failNext({ status: 429, headers: { 'retry-after': '600' } })

    await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(h.sleeps).toEqual([])
    expect(h.relay.requests).toHaveLength(1)
    expect(backoff.origins.get(RELAY_DEFAULT_ORIGIN)).toBe(1_800_000_000_000 + 600_000)

    advance(599)
    await sendRelay([relayRow('mac')], MESSAGE, h.options)
    expect(h.relay.requests).toHaveLength(1)

    advance(2)
    await sendRelay([relayRow('mac')], MESSAGE, h.options)
    expect(h.relay.requests).toHaveLength(2)
  })

  it('stops asking a relay that failed a whole request for the rest of that round', async () => {
    const { h } = clocked()
    const rows = Array.from({ length: 45 }, (_value, index) => relayRow(`d${String(index)}`))

    h.relay.failNext({ network: true })
    h.relay.failNext({ network: true })

    await sendRelay(rows, MESSAGE, h.options)

    // One request per round, not three: the other two batches were not sent.
    expect(h.relay.requests).toHaveLength(2)
  })

  it('leaves a rate-limited device alone, and only that device', async () => {
    const { h, backoff, advance } = clocked()

    h.relay.answer('h_handle-for-busy', { status: 'limited', retryAfter: 20, reason: 'handle_rate_limited' })

    const first = await sendRelay([relayRow('busy'), relayRow('calm')], MESSAGE, h.options)

    expect(h.sleeps).toEqual([])
    expect(first.outcomes).toContainEqual({ installationId: 'busy', status: 'limited', reason: 'dropped' })
    expect(backoff.handles.get(`${RELAY_DEFAULT_ORIGIN} h_handle-for-busy`)).toBe(1_800_000_000_000 + 20_000)

    const second = await sendRelay([relayRow('busy'), relayRow('calm')], MESSAGE, h.options)

    expect(second.outcomes).toContainEqual({ installationId: 'busy', status: 'skipped', reason: 'handle_backoff' })
    expect(h.relay.delivered.map(entry => entry.handle)).toEqual(['h_handle-for-calm', 'h_handle-for-calm'])

    advance(21)
    await sendRelay([relayRow('busy')], MESSAGE, h.options)
    expect(h.relay.delivered.map(entry => entry.handle)).toContain('h_handle-for-busy')
  })
})

describe('what the relay answers', () => {
  it('retires a device the relay calls gone, exactly as Expo’s DeviceNotRegistered', async () => {
    const h = harness()

    h.relay.answer('h_handle-for-old', 'gone')

    const result = await sendRelay([relayRow('old'), relayRow('new')], MESSAGE, h.options)

    expect(result.dead).toEqual(['old'])
    expect(h.relay.requests).toHaveLength(1)
  })

  it('treats an unknown handle and a wrong secret alike: gone', async () => {
    const h = harness()

    h.relay.register('h_handle-for-mac', 'a-different-secret')

    expect((await sendRelay([relayRow('mac')], MESSAGE, h.options)).dead).toEqual(['mac'])
  })

  it('logs and drops a rejected message, without retrying or retiring', async () => {
    const h = harness()

    h.relay.answer('h_handle-for-mac', { status: 'rejected', reason: 'payload_too_large' })

    const result = await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(result.dead).toEqual([])
    expect(h.relay.requests).toHaveLength(1)
    expect(h.lines.join('\n')).toMatch(/rejected.*payload_too_large/)
  })

  it('retries once after `retry`, honouring retryAfter', async () => {
    const h = harness()

    h.relay.answer('h_handle-for-mac', { status: 'retry', retryAfter: 3 })

    const result = await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(h.sleeps).toEqual([3000])
    expect(h.relay.requests).toHaveLength(2)
    expect(result.outcomes).toEqual([{ installationId: 'mac', status: 'sent' }])
  })

  it('retries once after `limited`, and drops it when the retry is limited too', async () => {
    const h = harness()

    h.relay.answer('h_handle-for-mac', { status: 'limited', retryAfter: 2 }, { status: 'limited', retryAfter: 2 })

    const result = await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(h.relay.requests).toHaveLength(2)
    expect(result.dead).toEqual([])
    expect(result.outcomes).toEqual([{ installationId: 'mac', status: 'limited', reason: 'dropped' }])
  })

  it('retries only the messages that asked for it', async () => {
    const h = harness()

    h.relay.answer('h_handle-for-a', 'retry')

    await sendRelay([relayRow('a'), relayRow('b')], MESSAGE, h.options)

    expect(sentBodies(h.relay).map(body => body.messages.map(entry => entry.handle))).toEqual([
      ['h_handle-for-a', 'h_handle-for-b'],
      ['h_handle-for-a']
    ])
  })

  it('drops instead of waiting when the relay asks for longer than the bound', async () => {
    const h = harness()

    h.relay.answer('h_handle-for-mac', { status: 'limited', retryAfter: RELAY_MAX_RETRY_WAIT_SECONDS + 1 })

    const result = await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(h.sleeps).toEqual([])
    expect(h.relay.requests).toHaveLength(1)
    expect(result.outcomes).toEqual([{ installationId: 'mac', status: 'limited', reason: 'dropped' }])
  })

  it('retries a network failure once, then drops it', async () => {
    const once = harness()

    once.relay.failNext({ network: true })
    expect((await sendRelay([relayRow('mac')], MESSAGE, once.options)).outcomes).toEqual([
      { installationId: 'mac', status: 'sent' }
    ])
    expect(once.relay.requests).toHaveLength(2)

    const twice = harness()

    twice.relay.failNext({ network: true })
    twice.relay.failNext({ network: true })

    const result = await sendRelay([relayRow('mac')], MESSAGE, twice.options)

    expect(twice.relay.requests).toHaveLength(2)
    expect(result).toEqual({ dead: [], outcomes: [{ installationId: 'mac', status: 'retry', reason: 'dropped' }] })
  })

  it('reads a 429 as limited, with the Retry-After header', async () => {
    const h = harness()

    h.relay.failNext({ status: 429, headers: { 'retry-after': '4' } })

    await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(h.sleeps).toEqual([4000])
    expect(h.relay.delivered).toHaveLength(1)
  })

  it('reads a 5xx as retry and a 4xx as rejected', async () => {
    const server = harness()

    server.relay.failNext({ status: 503 })
    await sendRelay([relayRow('mac')], MESSAGE, server.options)
    expect(server.relay.requests).toHaveLength(2)

    const client = harness()

    client.relay.failNext({ status: 400, body: { error: 'invalid_request' } })

    const result = await sendRelay([relayRow('mac')], MESSAGE, client.options)

    expect(client.relay.requests).toHaveLength(1)
    expect(result.outcomes).toEqual([{ installationId: 'mac', status: 'rejected', reason: 'http_400' }])
  })

  it('does not follow a redirect, and does not retry one', async () => {
    const h = harness()

    h.relay.failNext({ status: 307, headers: { location: 'https://collector.example.net/v1/send' } })

    const result = await sendRelay([relayRow('mac')], MESSAGE, h.options)

    expect(h.relay.requests.map(request => request.url)).toEqual(['https://push.hermie.dev/v1/send'])
    expect(result.outcomes).toEqual([{ installationId: 'mac', status: 'rejected', reason: 'redirect' }])
  })

  it('gives up on a relay that does not answer within the timeout', async () => {
    const lines: string[] = []
    const hanging = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
    ) as unknown as typeof fetch
    const result = await sendRelay([relayRow('mac')], MESSAGE, {
      allowList: [RELAY_DEFAULT_ORIGIN],
      fetchImpl: hanging,
      timeoutMs: 20,
      sleep: async () => undefined,
      log: line => lines.push(line)
    })

    expect(hanging).toHaveBeenCalledTimes(2)
    expect(result.outcomes).toEqual([{ installationId: 'mac', status: 'retry', reason: 'dropped' }])
    expect(lines.join('\n')).toMatch(/timeout/)
  })
})

describe('privacy', () => {
  it('never puts message text in a relay body, even for a device that asked for a preview', async () => {
    const h = harness()
    const previewed = pushMessageFor(EVENT, true)

    // The preview really is in the message the other transports would send…
    expect(previewed.body).toContain('confidential plan')

    await sendRelay([relayRow('mac', { preview: true })], previewed, h.options)

    // …and nowhere in what reached the relay.
    expect(JSON.stringify(h.relay.requests)).not.toContain('confidential')
    expect(h.relay.delivered[0]?.message.body).toBe('sent you a message')
  })

  it('reads every relay row as preview: false, whatever it says', () => {
    const row = {
      v: 1,
      transport: 'relay',
      relay: RELAY_DEFAULT_ORIGIN,
      handle: 'h_x',
      secret: 's',
      platform: 'ios',
      types: { message: true },
      preview: true
    }

    expect(pushRegistrationOf('mac', row)?.preview).toBe(false)
    expect(pushRegistrationOf('mac', { ...row, enc: { kid: 1, key: 'k' } })?.preview).toBe(false)
  })

  it('never logs a secret or a whole handle', async () => {
    const h = harness()

    h.relay.answer('h_handle-for-a', { status: 'rejected', reason: 'bad' })
    h.relay.answer('h_handle-for-b', { status: 'limited', retryAfter: 600 })
    h.relay.answer('h_handle-for-c', 'retry', 'retry')

    await sendRelay(
      [relayRow('a'), relayRow('b'), relayRow('c'), relayRow('z', { relay: 'https://x.example' })],
      MESSAGE,
      h.options
    )

    const log = h.lines.join('\n')

    expect(h.lines.length).toBeGreaterThanOrEqual(4)
    expect(log).not.toContain(SECRET)
    expect(log).not.toMatch(/h_handle-for-[abcz]/)
    expect(handleHint('h_handle-for-a')).toBe('h_handle…')
  })
})

/**
 * Every type, said the way this daemon says it, checked against the one push
 * contract file every sender and app conforms to.
 */
/**
 * The plugin's `push/events.py::event_id`, run in Python on these inputs. A
 * copy that drifted from it would give the two notifiers different collapse
 * ids for the same fact.
 */
describe('the event id', () => {
  it.each([
    [['request', 'session-1', 'appr-1'], 'request:e79a31a5f5e83a0039f266e520e055fa'],
    [['message', 'sess', '7'], 'message:c9954a2311e825a284ab3a784b556699'],
    [['clarify', 's', 'srq-2'], 'clarify:f04a7b9eb4b2c9747e34ad2d70987417'],
    [['cron_done', 's\u00e9ance', '12'], 'cron_done:bb294fcc74527e35e4bd52ed0083be54'],
    [['message', '\u{1F600} emoji', 'x"q\\'], 'message:47ee3af7c83ab4ad5a228727a49e6589'],
    [['turn_failed', 'tab\there', '\u2028line\u007f'], 'turn_failed:0f0d62d3391b0d2a09a8ad521deb1630'],
    [['request', null, 'r'], 'request:f8e61e0ba10e8714c40e75ef3b75e2cd'],
    [['cron_failed', 's', 12], 'cron_failed:2a65423a1d59ef88b1f2965bc29facd5']
  ] as const)('agrees with the plugin on %j', (args, expected) => {
    const [kind, ...parts] = args

    expect(eventIdOf(kind, ...parts)).toBe(expected)
  })

  it('is what the watcher stamps on a notification, and fits a collapse id', () => {
    const id = eventIdOf('cron_failed', 'session-1', '12')

    expect(id).toMatch(/^[a-z_]+:[0-9a-f]{32}$/u)
    expect(Buffer.byteLength(id)).toBeLessThanOrEqual(RELAY_COLLAPSE_ID_LIMIT)
  })
})

describe('the push contract', () => {
  interface ContractField {
    key: string
    type: 'string' | 'boolean' | 'number'
    required: boolean
    enum?: string[]
    pattern?: string
    const?: unknown
    requiredWhen?: Record<string, string>
  }

  const contract = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../../../contract/push/contract.json'), 'utf8')
  ) as {
    types: string[]
    legacyTypes: Record<string, string>
    category: { id: string; when: { type: string; method: string } }
    android: { channels: { id: string; type: string }[] }
    data: { fields: ContractField[] }
  }

  const events: NotifiableEvent[] = [
    { ...EVENT, type: 'message', eventId: eventIdOf('message', 'session-1', '7') },
    {
      ...EVENT,
      type: 'request',
      requestMethod: 'approval',
      requestId: 'appr-1',
      eventId: eventIdOf('request', 'session-1', 'appr-1')
    },
    { ...EVENT, type: 'request', requestMethod: 'clarify', requestId: 'srq-2' },
    { ...EVENT, type: 'cron', cron: true, cronCertain: true, name: 'Morning digest' },
    { ...EVENT, type: 'cron_done', cron: true, cronCertain: true, jobId: 'job-8f3a-unique', name: 'Morning digest' },
    { ...EVENT, type: 'cron_failed', cron: true, cronCertain: false, failed: true, jobId: 'job-8f3a-unique' },
    { ...EVENT, type: 'cron_failed', cron: true, cronCertain: true, failed: true, jobId: 'job-8f3a-unique' },
    { ...EVENT, type: 'dm', name: 'Writer' },
    { ...EVENT, type: 'message', gatewayKey: undefined, sessionKind: undefined },
    { ...EVENT, type: 'message', sessionId: '' }
  ]

  const conforms = (data: Record<string, unknown>): void => {
    const fields = new Map(contract.data.fields.map(field => [field.key, field]))

    for (const [key, value] of Object.entries(data)) {
      const field = fields.get(key)

      expect({ key, known: Boolean(field) }).toEqual({ key, known: true })

      if (!field) {
        continue
      }

      expect({ key, type: typeof value }).toEqual({ key, type: field.type })

      if (field.enum && !(key === 'type' && String(value) in contract.legacyTypes)) {
        expect(field.enum).toContain(value)
      }

      if (field.pattern) {
        expect(String(value)).toMatch(new RegExp(field.pattern, 'u'))
      }

      if (field.const !== undefined) {
        expect(value).toBe(field.const)
      }

      // Optional fields are omitted, never sent empty.
      expect(value === '' || value === null).toBe(false)
    }

    for (const field of contract.data.fields) {
      const when = field.requiredWhen
      const required = field.required || (when && Object.entries(when).every(([key, value]) => data[key] === value))

      if (required) {
        expect({ key: field.key, present: field.key in data }).toEqual({ key: field.key, present: true })
      }
    }
  }

  it.each(events.map(event => [`${event.type}${event.requestMethod ? `/${event.requestMethod}` : ''}`, event]))(
    '%s: the data bag, the category and the channel conform',
    (_label, event) => {
      for (const preview of [false, true]) {
        const message = pushMessageFor(event as NotifiableEvent, preview)
        const relayed = relayMessageFor(message)
        const e = event as NotifiableEvent

        conforms(message.data)
        conforms(relayed.data as Record<string, unknown>)

        const wantsCategory =
          e.type === contract.category.when.type && e.requestMethod === contract.category.when.method

        expect(message.categoryId).toBe(wantsCategory ? contract.category.id : undefined)
        expect(relayed.category).toBe(wantsCategory ? contract.category.id : undefined)
        expect(contract.android.channels.map(channel => channel.id)).toContain(message.channelId)

        if ((contract.types as string[]).includes(e.type)) {
          expect(message.channelId).toBe(e.type)
        }

        // `jobId` is carried and never shown.
        if (e.jobId) {
          expect(message.data.jobId).toBe(e.jobId)
          expect(`${message.title} ${message.body} ${String(relayed.title)} ${String(relayed.body)}`).not.toContain(
            e.jobId
          )
        }

        // The relay's collapse id is the payload's event id, and is absent without one.
        expect(relayed.collapseId).toBe(e.eventId)
      }
    }
  )

  it('requires a request id of an approval only; a clarify carries one when the sender knows it', () => {
    const field = contract.data.fields.find(entry => entry.key === 'requestId')

    expect(field?.requiredWhen).toEqual({ type: 'request', method: 'approval' })
    expect(
      pushMessageFor({ ...EVENT, type: 'request', requestMethod: 'clarify', requestId: 'srq-2' }, false).data
    ).toMatchObject({
      method: 'clarify',
      requestId: 'srq-2'
    })
    expect(
      pushMessageFor({ ...EVENT, type: 'request', requestMethod: 'approval', requestId: 'a' }, false).data.method
    ).toBe('approval')
  })

  it('treats the session id as optional, and omits it rather than sending it empty', () => {
    expect(contract.data.fields.find(entry => entry.key === 'sessionId')?.required).toBe(false)

    const data = pushMessageFor({ ...EVENT, sessionId: '' }, false).data

    expect(data).not.toHaveProperty('sessionId')
    expect(data).not.toHaveProperty('session')
  })

  it('names one channel per contract type, and every type this daemon can send has one', () => {
    const types: PushType[] = ['message', 'request', 'cron', 'cron_done', 'cron_failed']

    for (const type of types) {
      expect(contract.android.channels).toContainEqual({ id: type, type })
    }
  })
})
