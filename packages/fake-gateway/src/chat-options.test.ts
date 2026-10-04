/**
 * The per-chat options a client switches with `config.set` (fast mode, reasoning effort, model) and the
 * context usage it reads with `session.usage`: kept on the session they were set on, answered with the
 * session's new `info`, and an expensive model written only when the client says it confirmed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

interface Frame {
  id?: string
  method?: string
  params?: { type?: string; session_id?: string; payload?: Record<string, unknown> }
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

let gateway: FakeGateway
let socket: WebSocket
let nextId = 0
const frames: Frame[] = []

const call = (method: string, params: Record<string, unknown> = {}): Promise<Frame> => {
  const id = `y-${(nextId += 1)}`

  return new Promise(resolve => {
    const onMessage = (data: unknown): void => {
      for (const line of String(data).split('\n')) {
        if (!line.trim()) {
          continue
        }

        const frame = JSON.parse(line) as Frame

        if (frame.id === id) {
          socket.off('message', onMessage)
          resolve(frame)
        }
      }
    }

    socket.on('message', onMessage)
    socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

/** Resume a bot's chat: its runtime session id and what `info` says about it. */
const resume = async (profile: string): Promise<{ id: string; info: Record<string, unknown> }> => {
  const listed = await call('session.list', { profile, title: 'Bot Chat', include_hidden: true })
  const chat = (listed.result as { sessions: Record<string, unknown>[] }).sessions[0] ?? {}
  const resumed = await call('session.resume', { session_id: String(chat.id), omit_messages: true })
  const result = resumed.result as { session_id: string; info: Record<string, unknown> }

  return { id: result.session_id, info: result.info }
}

beforeEach(async () => {
  frames.length = 0
  gateway = await startFakeGateway({ port: 0 })
  socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])
  socket.on('message', data => {
    for (const line of String(data).split('\n')) {
      if (line.trim()) {
        frames.push(JSON.parse(line) as Frame)
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
  await gateway.close()
})

const model = (info: Record<string, unknown>): unknown => info.model

describe('chat options over config.set', () => {
  it('switches fast mode and reasoning effort for that session only', async () => {
    const researcher = await resume('researcher')
    const writer = await resume('writer')

    expect(researcher.info.fast).toBe(false)
    expect(researcher.info.reasoning_effort).toBe('medium')

    const fast = await call('config.set', {
      key: 'fast',
      value: 'fast',
      session_id: researcher.id,
      profile: 'researcher'
    })

    expect(fast.result).toMatchObject({ key: 'fast', info: { fast: true } })

    const effort = await call('config.set', {
      key: 'reasoning',
      value: 'high',
      session_id: researcher.id,
      profile: 'researcher',
      scope: 'session'
    })

    expect(effort.result).toMatchObject({
      key: 'reasoning',
      scope: 'session',
      info: { fast: true, reasoning_effort: 'high' }
    })

    const events = frames.filter(
      frame =>
        frame.method === 'event' && frame.params?.type === 'session.info' && frame.params.session_id === researcher.id
    )

    expect(events.at(-1)?.params?.payload?.reasoning_effort).toBe('high')
    expect((await resume('writer')).info.reasoning_effort).toBe('medium')
    expect(writer.id).not.toBe(researcher.id)

    const off = await call('config.set', { key: 'fast', value: 'normal', session_id: researcher.id })

    expect(off.result).toMatchObject({ info: { fast: false } })
  })

  it('refuses a fast word upstream does not take', async () => {
    const researcher = await resume('researcher')
    const refused = await call('config.set', { key: 'fast', value: 'true', session_id: researcher.id })

    expect(refused.error?.code).toBe(4002)
  })

  it('writes a model switch and reports it in info', async () => {
    const researcher = await resume('researcher')
    const set = await call('config.set', {
      key: 'model',
      value: 'second-provider/reasoner-2',
      session_id: researcher.id,
      profile: 'researcher'
    })

    expect(set.error).toBeUndefined()
    expect(set.result).toMatchObject({ key: 'model', info: { model: 'second-provider/reasoner-2' } })
    expect(model((await resume('researcher')).info)).toBe('second-provider/reasoner-2')
  })

  it('answers an expensive model with confirm_required and writes nothing until it is confirmed', async () => {
    const researcher = await resume('researcher')
    const before = model(researcher.info)
    const asked = await call('config.set', {
      key: 'model',
      value: 'example-provider/expensive-model',
      session_id: researcher.id,
      profile: 'researcher'
    })

    expect(asked.result).toMatchObject({ key: 'model', confirm_required: true })
    expect(typeof asked.result?.confirm_message).toBe('string')
    expect(asked.result?.info).toBeUndefined()
    expect(model((await resume('researcher')).info)).toBe(before)

    const confirmed = await call('config.set', {
      key: 'model',
      value: 'example-provider/expensive-model',
      session_id: researcher.id,
      profile: 'researcher',
      confirm_expensive_model: true
    })

    expect(confirmed.result).toMatchObject({ info: { model: 'example-provider/expensive-model' } })
  })
})

describe('session.usage', () => {
  it('reports the window and what fills it, and the same figures ride on the resume', async () => {
    const researcher = await resume('researcher')
    const usage = await call('session.usage', { session_id: researcher.id, profile: 'researcher' })

    expect(usage.error).toBeUndefined()
    expect(usage.result?.context_max).toBeGreaterThan(0)
    expect(usage.result?.context_used).toBeGreaterThan(0)
    expect((researcher.info.usage as Record<string, unknown>).context_max).toBe(usage.result?.context_max)
  })
})
