/**
 * The pages a reply used (`contract/sources/`), as the fake gateway ends a turn with them: `sources` on
 * `message.complete`, `display_metadata.sources` on the reply's row (`session.history` and the REST transcript), and no
 * key at all on a reply that used none. The `markup` key of `client.capabilities` is in `client-capabilities.test.ts`.
 *
 * Every list the fake sends is checked against the contract's own schema and rules, not against a copy of them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import examples from '../../../contract/sources/examples.json'
import schema from '../../../contract/sources/schema.json'
import { type FakeGateway, startFakeGateway } from './server'
import { SOURCE_SAMPLES, type WireSource } from './sources'

const URL_PATTERN = new RegExp(schema.$defs.Source.properties.url.pattern, 'u')

/** The contract's `Source`, checked by hand (this package has no JSON Schema validator). */
function assertContractEntry(entry: WireSource): void {
  expect(Object.keys(entry).sort()).toEqual([...schema.$defs.Source.required].sort())
  expect(entry.url.length).toBeLessThanOrEqual(schema.$defs.Source.properties.url.maxLength)
  expect(entry.url).toMatch(URL_PATTERN)
  expect(Array.from(entry.title).length).toBeLessThanOrEqual(schema.$defs.Source.properties.title.maxLength)
  expect(schema.$defs.SourceVia.enum).toContain(entry.via)
}

function assertContractList(list: WireSource[]): void {
  expect(list.length).toBeGreaterThanOrEqual(schema.minItems)
  expect(list.length).toBeLessThanOrEqual(schema.maxItems)
  expect(new Set(list.map(entry => entry.url)).size).toBe(list.length)
  list.forEach(assertContractEntry)
  // Every `read` entry first.
  const firstFound = list.findIndex(entry => entry.via === 'found')

  if (firstFound >= 0) {
    expect(list.slice(firstFound).every(entry => entry.via === 'found')).toBe(true)
  }
}

describe('the sample lists', () => {
  it.each(Object.entries(SOURCE_SAMPLES))('%s is a list the contract allows', (_name, list) => {
    assertContractList(list)
  })

  it('starts with the contract’s own example', () => {
    expect(SOURCE_SAMPLES.guide).toEqual(examples.message_complete.sources)
  })
})

describe('a reply that used pages', () => {
  let gateway: FakeGateway
  let socket: WebSocket
  let nextId = 0
  const pending = new Map<number, (value: Record<string, unknown>) => void>()
  const events: { type: string; payload: Record<string, unknown> }[] = []

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId

    return new Promise(resolve => {
      pending.set(id, resolve)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const turn = async (text: string): Promise<{ complete: Record<string, unknown>; sessionId: string }> => {
    const stored = gateway.state.profiles.find(row => row.name === 'researcher')?.canonical_session?.id
    const resumed = await call('session.resume', { session_id: stored, profile: 'researcher' })
    const sessionId = String(resumed.session_id)

    events.length = 0
    await call('prompt.submit', { session_id: sessionId, profile: 'researcher', text })

    for (let attempt = 0; attempt < 500 && !events.some(event => event.type === 'message.complete'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    const complete = events.find(event => event.type === 'message.complete')

    expect(complete).toBeDefined()

    return { complete: complete?.payload ?? {}, sessionId }
  }

  beforeEach(async () => {
    gateway = await startFakeGateway({ port: 0, streamDelayMs: 1 })
    events.length = 0
    socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])
    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>

        if (typeof frame.id === 'number' && pending.has(frame.id)) {
          pending.get(frame.id)?.((frame.result ?? {}) as Record<string, unknown>)
          pending.delete(frame.id)
        } else if (frame.method === 'event') {
          const params = frame.params as Record<string, unknown>

          events.push({ type: String(params.type ?? ''), payload: (params.payload ?? {}) as Record<string, unknown> })
        }
      }
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  })

  afterEach(async () => {
    socket.close()
    pending.clear()
    await gateway.close()
  })

  it('sends them with message.complete, and keeps them on the row for a reload', async () => {
    const { complete, sessionId } = await turn('please show sources')

    expect(complete.sources).toEqual(examples.message_complete.sources)
    assertContractList(complete.sources as WireSource[])

    const history = await call('session.history', { session_id: sessionId, profile: 'researcher' })
    const rows = (history.messages ?? []) as { role: string; display_metadata?: { sources?: unknown } }[]

    expect(rows.at(-1)?.role).toBe('assistant')
    expect(rows.at(-1)?.display_metadata).toEqual({ sources: complete.sources })
  })

  it('shows the same list on the REST transcript', async () => {
    const { complete } = await turn('please show many sources')

    expect(complete.sources).toEqual(SOURCE_SAMPLES.search)

    const stored = gateway.state.profiles.find(row => row.name === 'researcher')?.canonical_session?.id
    const response = await fetch(`${gateway.url}/api/sessions/${stored}/messages?profile=researcher`)
    const body = (await response.json()) as { messages: { role: string; display_metadata?: unknown }[] }

    expect(response.status).toBe(200)
    expect(body.messages.at(-1)?.display_metadata).toEqual({ sources: SOURCE_SAMPLES.search })
  })

  it('sends a title that names another place than its address as it is: the client shows the domain', async () => {
    const { complete } = await turn('please show misleading sources')

    expect(complete.sources).toEqual(SOURCE_SAMPLES.misleading)
  })

  it('sends no key at all for a reply that used none, never an empty list', async () => {
    const { complete, sessionId } = await turn('hello there')

    expect('sources' in complete).toBe(false)

    const history = await call('session.history', { session_id: sessionId, profile: 'researcher' })
    const rows = (history.messages ?? []) as { role: string; display_metadata?: unknown }[]

    expect(rows.at(-1)?.display_metadata ?? null).toBeNull()
  })
})
