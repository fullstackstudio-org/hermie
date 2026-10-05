/**
 * `session.interrupt_all` stops every running turn in one call.
 *
 * The fork's method (`methods_session.py`): the caller's own running turns across profiles, or one profile's,
 * answered as the sessions it stopped (runtime id, stored id, profile, title, source) and three counts. A turn
 * stopped this way ends as `session.interrupt` ends it: nothing more of the reply arrives, what was said stays.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

const STREAM_DELAY_MS = 20

type Frame = { result?: Record<string, unknown>; error?: { code?: number } }

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0

const pending = new Map<number, (frame: Frame) => void>()
const events: { type: string; payload: Record<string, unknown> }[] = []

function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++nextId

  return new Promise((resolve, reject) => {
    pending.set(id, frame => {
      if (frame.error) {
        reject(Object.assign(new Error('rpc error'), { code: frame.error.code }))
      } else {
        resolve(frame.result ?? {})
      }
    })
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

const stage = async (body: Record<string, unknown>): Promise<void> => {
  await fetch(`${gateway.url}/__fake/stop-all`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST'
  })
}

/** A turn streaming in `profile`'s own chat. */
async function startTurn(profile: string): Promise<string> {
  const stored = gateway.state.profiles.find(row => row.name === profile)?.canonical_session?.id
  const resumed = await call('session.resume', { profile, session_id: stored })
  const sessionId = String(resumed.session_id)

  await call('prompt.submit', { profile, session_id: sessionId, text: 'give me the long version' })

  return sessionId
}

beforeEach(async () => {
  gateway = await startFakeGateway({ port: 0, streamDelayMs: STREAM_DELAY_MS })
  events.length = 0
  nextId = 0
  pending.clear()
  socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

  socket.on('message', data => {
    for (const line of String(data).split('\n')) {
      if (!line.trim()) {
        continue
      }

      const frame = JSON.parse(line) as Record<string, unknown>

      if (typeof frame.id === 'number' && pending.has(frame.id)) {
        pending.get(frame.id)?.(frame as Frame)
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

describe('session.interrupt_all', () => {
  it('stops every running turn in one call and names each one it stopped', async () => {
    const researcher = await startTurn('researcher')
    const writer = await startTurn('writer')

    await until('both replies to stream', () => events.filter(event => event.type === 'message.delta').length >= 2)

    const answer = await call('session.interrupt_all')
    const stopped = answer.stopped as Record<string, unknown>[]

    expect(Object.keys(answer).sort()).toEqual(['already_idle', 'failed', 'not_allowed', 'stopped'])
    expect(stopped.map(entry => entry.session_id).sort()).toEqual([researcher, writer].sort())
    expect(stopped.map(entry => entry.profile).sort()).toEqual(['researcher', 'writer'])

    for (const entry of stopped) {
      expect(Object.keys(entry).sort()).toEqual(['profile', 'session_id', 'session_key', 'source', 'title'])
      expect(typeof entry.session_key).toBe('string')
    }

    expect(answer.failed).toBe(0)
    expect(answer.not_allowed).toBe(0)

    // Each ended as an interrupted turn, and nothing of either reply arrives after.
    await new Promise(resolve => setTimeout(resolve, STREAM_DELAY_MS * 80))
    await call('gateway.ping')
    expect(events.filter(event => event.type === 'message.complete').map(event => event.payload.status)).toEqual([
      'interrupted',
      'interrupted'
    ])
    expect(gateway.state.runningSessions.size).toBe(0)
  })

  it('limits the stop to one profile when it is given', async () => {
    await startTurn('researcher')
    const writer = await startTurn('writer')

    await until('both replies to stream', () => events.filter(event => event.type === 'message.delta').length >= 2)

    const answer = await call('session.interrupt_all', { profile: 'writer' })

    expect((answer.stopped as Record<string, unknown>[]).map(entry => entry.session_id)).toEqual([writer])
    expect(gateway.state.runningSessions.size).toBe(1)
  })

  it('counts a session with no turn as already idle, and stops nothing', async () => {
    await call('session.resume', {
      profile: 'researcher',
      session_id: gateway.state.profiles.find(row => row.name === 'researcher')?.canonical_session?.id
    })

    const answer = await call('session.interrupt_all')

    expect(answer.stopped).toEqual([])
    expect(answer.already_idle).toBeGreaterThan(0)
  })

  it('says what a test staged for the turns it may not stop and the ones that failed', async () => {
    await stage({ failed: 1, notAllowed: 2 })

    const answer = await call('session.interrupt_all')

    expect(answer).toMatchObject({ failed: 1, not_allowed: 2, stopped: [] })
  })

  it('refuses a profile the gateway does not serve with 4064', async () => {
    await expect(call('session.interrupt_all', { profile: 'nobody' })).rejects.toMatchObject({ code: 4064 })
  })

  it('answers -32601 on a gateway that predates it', async () => {
    await stage({ unsupported: true })

    await expect(call('session.interrupt_all')).rejects.toMatchObject({ code: -32601 })
  })
})
