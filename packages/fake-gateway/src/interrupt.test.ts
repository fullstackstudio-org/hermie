/**
 * `session.interrupt` stops the reply it interrupts.
 *
 * The fake scripts a whole reply up front, one timer per frame. Interrupting
 * used to publish the `message.complete` and leave every timer running, so the
 * rest of the reply kept arriving after the turn had ended — and a client drew
 * it as a new reply under the stopped one. A real agent stops talking when it
 * is interrupted; what it said stays in the history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

/** Long enough between frames for the interrupt to land mid-reply. */
const STREAM_DELAY_MS = 20

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0

const pending = new Map<number, (value: Record<string, unknown>) => void>()
const events: { type: string; payload: Record<string, unknown> }[] = []

function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++nextId

  return new Promise(resolve => {
    pending.set(id, resolve)
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function until(what: string, condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 5))
  }

  throw new Error(`timed out waiting for ${what}`)
}

beforeEach(async () => {
  gateway = await startFakeGateway({ port: 0, streamDelayMs: STREAM_DELAY_MS })
  events.length = 0
  nextId = 0
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

describe('session.interrupt', () => {
  it('stops the reply: nothing of it arrives after the interrupted completion, and what was said is kept', async () => {
    const stored = gateway.state.profiles.find(row => row.name === 'researcher')?.canonical_session?.id
    const resumed = await call('session.resume', { session_id: stored, profile: 'researcher' })
    const sessionId = String(resumed.session_id)

    await call('prompt.submit', { session_id: sessionId, profile: 'researcher', text: 'give me the long version' })
    await until('the first words', () => events.some(event => event.type === 'message.delta'))
    await call('session.interrupt', { session_id: sessionId, profile: 'researcher' })

    // Every frame the reply had scheduled would have gone out by now; the
    // ping's answer follows anything the socket was sent before it.
    await new Promise(resolve => setTimeout(resolve, STREAM_DELAY_MS * 80))
    await call('gateway.ping')

    const completions = events.filter(event => event.type === 'message.complete')
    const stoppedAt = events.findIndex(event => event.type === 'message.complete')

    expect(completions.map(event => event.payload.status)).toEqual(['interrupted'])
    expect(events.slice(stoppedAt + 1).map(event => event.type)).not.toContain('message.delta')

    const said = events
      .filter(event => event.type === 'message.delta')
      .map(event => String(event.payload.text ?? ''))
      .join('')
    const history = [...gateway.state.sessions.values()].find(session => session.id === sessionId)?.messages ?? []

    expect(said.length).toBeGreaterThan(0)
    expect(history.at(-1)).toMatchObject({ role: 'assistant', text: said })
  })
})
