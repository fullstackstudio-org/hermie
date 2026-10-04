/**
 * The fake's delegation, as the Agents bar of a client drives it: a prompt that says "delegate" fans out three
 * children, and while one runs it can be listed (`subagent.list`), read (`subagent.tail`, which stops existing with the
 * child), corrected (`subagent.steer`) and stopped (`subagent.interrupt`, which ends it as `interrupted` and says so on
 * the stream). The frames are slowed so a test has a window in which a child is running.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

/** Long enough between a child's frames for a call to land while it runs. */
const STEP_MS = 60

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0
let sessionId = ''

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
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (condition()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 5))
  }

  throw new Error(`timed out waiting for ${what}`)
}

const children = async (): Promise<Record<string, unknown>[]> =>
  ((await call('subagent.list', { session_id: sessionId, profile: 'researcher' })).subagents ?? []) as Record<
    string,
    unknown
  >[]

/** Start the fan-out and wait for the first child to be running. */
async function delegate(): Promise<string> {
  await call('prompt.submit', { session_id: sessionId, profile: 'researcher', text: 'please delegate this' })
  await until('a child to run', () => events.some(event => event.type === 'subagent.start'))

  return String((await children())[0]?.subagent_id)
}

beforeEach(async () => {
  gateway = await startFakeGateway({ port: 0, streamDelayMs: 5, subagentStepMs: STEP_MS })
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

  const stored = gateway.state.profiles.find(row => row.name === 'researcher')?.canonical_session?.id

  sessionId = String((await call('session.resume', { session_id: stored, profile: 'researcher' })).session_id)
})

afterEach(async () => {
  socket.close()
  pending.clear()
  await gateway.close()
})

describe('subagent.list', () => {
  it('lists the children that are running, with their goal and the delegation they belong to', async () => {
    await delegate()

    const running = await children()

    expect(running.length).toBeGreaterThan(0)
    expect(running[0]).toMatchObject({
      goal: 'Audit the dependencies',
      status: expect.stringMatching(/running|queued/u)
    })
    expect(typeof running[0]?.subagent_id).toBe('string')
    expect(typeof running[0]?.child_session_id).toBe('string')
  })

  it('is empty before anything was delegated', async () => {
    expect(await children()).toEqual([])
  })
})

describe('subagent.tail', () => {
  it('reads a running child: its goal, what it is doing and how many tool calls it made', async () => {
    const id = await delegate()
    const tail = await call('subagent.tail', { session_id: sessionId, profile: 'researcher', subagent_id: id })

    expect(tail).toMatchObject({ subagent_id: id, available: true, truncated: false })
    expect(String(tail.text)).toContain('> Audit the dependencies')
    expect(String(tail.text)).toMatch(/· \d+ tool calls? so far/u)
  })

  it('says there is nothing to read for a child that is not there, and for one that has finished', async () => {
    const id = await delegate()

    expect(await call('subagent.tail', { session_id: sessionId, profile: 'researcher', subagent_id: 'nope' })).toEqual({
      subagent_id: 'nope',
      available: false,
      text: '',
      truncated: false
    })

    await until('the first child to finish', () =>
      events.some(event => event.type === 'subagent.complete' && event.payload.subagent_id === id)
    )

    expect(
      await call('subagent.tail', { session_id: sessionId, profile: 'researcher', subagent_id: id })
    ).toMatchObject({
      available: false,
      text: ''
    })
  })
})

describe('subagent.steer', () => {
  it('queues a correction for a running child, and the child’s tail shows it was taken', async () => {
    const id = await delegate()
    const steered = await call('subagent.steer', {
      session_id: sessionId,
      profile: 'researcher',
      subagent_id: id,
      text: 'Use the lockfile only'
    })

    expect(steered).toEqual({ status: 'queued', subagent_id: id, text: 'Use the lockfile only' })
    expect(
      String((await call('subagent.tail', { session_id: sessionId, profile: 'researcher', subagent_id: id })).text)
    ).toContain('· steer')
  })

  it('rejects a correction for a child that is not running', async () => {
    await delegate()

    expect(
      await call('subagent.steer', { session_id: sessionId, profile: 'researcher', subagent_id: 'gone', text: 'x' })
    ).toMatchObject({ status: 'rejected', subagent_id: 'gone' })
  })
})

describe('subagent.interrupt', () => {
  it('stops a running child: it leaves the roster and the stream says it was interrupted', async () => {
    const id = await delegate()

    expect(await call('subagent.interrupt', { session_id: sessionId, profile: 'researcher', subagent_id: id })).toEqual(
      {
        found: true,
        subagent_id: id
      }
    )

    await until('the interrupted completion', () =>
      events.some(event => event.type === 'subagent.complete' && event.payload.subagent_id === id)
    )

    const done = events.find(event => event.type === 'subagent.complete' && event.payload.subagent_id === id)

    expect(done?.payload).toMatchObject({ status: 'interrupted', summary: 'Stopped by the user.' })
    expect((await children()).map(child => child.subagent_id)).not.toContain(id)
  })

  it('answers that a child it does not know was not found, and stops nothing', async () => {
    await delegate()

    const before = (await children()).length

    expect(
      await call('subagent.interrupt', { session_id: sessionId, profile: 'researcher', subagent_id: 'nope' })
    ).toEqual({ found: false, subagent_id: 'nope' })
    expect((await children()).length).toBe(before)
  })

  it('finds a child once only: a second stop of the same child finds nothing', async () => {
    const id = await delegate()

    await call('subagent.interrupt', { session_id: sessionId, profile: 'researcher', subagent_id: id })
    expect(await call('subagent.interrupt', { session_id: sessionId, profile: 'researcher', subagent_id: id })).toEqual(
      {
        found: false,
        subagent_id: id
      }
    )
  })
})
