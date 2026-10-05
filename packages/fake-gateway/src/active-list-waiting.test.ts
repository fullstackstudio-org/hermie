/**
 * `session.active_list` says `waiting` for a session parked on an open server request.
 *
 * `LiveSessionStatus` has the word (`'idle' | 'starting' | 'waiting' | 'working' | 'streaming' | 'resuming'`) and the
 * agents overview of a client reads it: a bot waiting for the person is a different line from a bot that is working.
 * The fake only ever said `working`, so nothing a client built on `waiting` could be driven here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0
let sessionId = ''
let storedId = ''

const pending = new Map<number, (value: Record<string, unknown>) => void>()

function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++nextId

  return new Promise(resolve => {
    pending.set(id, resolve)
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function until(what: string, condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 10))
  }

  throw new Error(`timed out waiting for ${what}`)
}

const row = async (): Promise<Record<string, unknown> | undefined> =>
  (((await call('session.active_list', {})).sessions ?? []) as Record<string, unknown>[]).find(
    entry => entry.session_key === storedId
  )

beforeEach(async () => {
  gateway = await startFakeGateway({ port: 0, streamDelayMs: 150 })
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
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  storedId = String(gateway.state.profiles.find(entry => entry.name === 'researcher')?.canonical_session?.id)
  sessionId = String((await call('session.resume', { session_id: storedId, profile: 'researcher' })).session_id)
})

afterEach(async () => {
  socket.close()
  pending.clear()
  await gateway.close()
})

describe('session.active_list status', () => {
  it('is `working` while a turn runs and nothing waits for anybody', async () => {
    await call('prompt.submit', { session_id: sessionId, profile: 'researcher', text: 'Take your time.' })

    await until('the turn to be listed', async () => (await row()) !== undefined)

    expect((await row())?.status).toBe('working')
  })

  it('is `waiting` while the turn is parked on an approval, and not once it is answered', async () => {
    const requests: Record<string, unknown>[] = []

    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Record<string, unknown>

        if (typeof frame.method === 'string' && frame.method !== 'event' && frame.id !== undefined) {
          requests.push(frame)
        }
      }
    })

    await call('prompt.submit', { session_id: sessionId, profile: 'researcher', text: 'please approve this' })

    await until('the approval to be asked', async () => requests.length > 0)
    await until('the session to say waiting', async () => (await row())?.status === 'waiting')

    // Answer it: the turn goes on, and the session is a working one again (or finished, and so unlisted).
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id: requests[0]?.id, result: { choice: 'once' } })}\n`)

    await until('the session to stop waiting', async () => (await row())?.status !== 'waiting')
  })

  it('lists a session that waits for a staged request even when no turn runs in it', async () => {
    const raised = await fetch(`${gateway.url}/__fake/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'researcher', method: 'clarify', params: { question: 'Which one?' } })
    })

    expect(raised.status).toBeLessThan(300)

    await until('the session to say waiting', async () => (await row())?.status === 'waiting')
  })
})
