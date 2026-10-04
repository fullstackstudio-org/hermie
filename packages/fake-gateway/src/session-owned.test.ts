/**
 * `POST /__fake/session-owned`: a chat another Hermes window or terminal has open. Its `prompt.submit`
 * is refused the way the fork refuses it (`SessionOwnership`): code 4090, `data.reason`
 * `SESSION_NOT_OWNED`, and a message of the sentence for the reader and a `Details:` line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

type Frame = { result?: Record<string, unknown>; error?: { code?: number; message?: string; data?: unknown } }

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0

const pending = new Map<number, (frame: Frame) => void>()

function call(method: string, params: Record<string, unknown> = {}): Promise<Frame> {
  const id = ++nextId

  return new Promise(resolve => {
    pending.set(id, resolve)
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

const control = (body: Record<string, unknown>): Promise<Response> =>
  fetch(`${gateway.url}/__fake/session-owned`, { method: 'POST', body: JSON.stringify(body) })

beforeEach(async () => {
  gateway = await startFakeGateway({ port: 0 })
  nextId = 0
  socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])
  socket.on('message', data => {
    for (const line of String(data).split('\n')) {
      if (!line.trim()) {
        continue
      }

      const frame = JSON.parse(line) as Frame & { id?: number }

      if (typeof frame.id === 'number') {
        pending.get(frame.id)?.(frame)
        pending.delete(frame.id)
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

describe('session-owned', () => {
  it('refuses a prompt on the chat with 4090 and the reason, until it is let go', async () => {
    const stored = gateway.state.profiles.find(row => row.name === 'researcher')?.canonical_session?.id
    const resumed = await call('session.resume', { session_id: stored, profile: 'researcher' })
    const session = String(resumed.result?.session_id)

    expect((await control({ profile: 'researcher', details: 'session s1 opened by cli 4m ago.' })).status).toBe(200)

    const refused = await call('prompt.submit', { session_id: session, profile: 'researcher', text: 'hello' })

    expect(refused.error?.code).toBe(4090)
    expect(refused.error?.data).toEqual({ reason: 'SESSION_NOT_OWNED' })
    expect(refused.error?.message).toBe(
      'This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.\n' +
        'Details: session s1 opened by cli 4m ago.'
    )

    expect((await control({ profile: 'researcher', owned: false })).status).toBe(200)
    expect((await call('prompt.submit', { session_id: session, profile: 'researcher', text: 'hello' })).result).toEqual(
      {
        status: 'streaming'
      }
    )
  })

  it('fails every prompt with the message set in promptFailure, whatever its length', async () => {
    const stored = gateway.state.profiles.find(row => row.name === 'researcher')?.canonical_session?.id
    const session = String(
      (await call('session.resume', { session_id: stored, profile: 'researcher' })).result?.session_id
    )

    gateway.state.promptFailure = 'x'.repeat(5000)

    const failed = await call('prompt.submit', { session_id: session, profile: 'researcher', text: 'hello' })

    expect(failed.error?.code).toBe(5000)
    expect(failed.error?.message).toHaveLength(5000)
  })

  it('is 404 for a chat the gateway does not have', async () => {
    expect((await control({ session_id: 'nobody' })).status).toBe(404)
  })
})
