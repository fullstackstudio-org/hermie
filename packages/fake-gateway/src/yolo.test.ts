/**
 * YOLO mode, as a client switches it: `config.set {key: 'yolo', scope: 'session'}`.
 *
 * `tui_gateway/methods_config_set.py::_set_yolo` flips the flag of ONE session and emits
 * `session.info` for it, so every page looking at the session learns the new state from the
 * event and not from its own click. The fake has to do the same three things: keep the flag on
 * the session it was set on, publish the event with `yolo` in it, and carry it on the next
 * `session.resume`.
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

describe('config.set yolo with scope session', () => {
  it('starts off, switches on for that session only, and says so in info and in a session.info event', async () => {
    const researcher = await resume('researcher')
    const writer = await resume('writer')

    expect(researcher.info.yolo).toBe(false)

    const set = await call('config.set', {
      key: 'yolo',
      value: 'on',
      session_id: researcher.id,
      profile: 'researcher',
      scope: 'session'
    })

    expect(set.error).toBeUndefined()
    expect(set.result).toMatchObject({ key: 'yolo', scope: 'session', info: { yolo: true } })

    const events = frames.filter(
      frame =>
        frame.method === 'event' && frame.params?.type === 'session.info' && frame.params.session_id === researcher.id
    )

    expect(events.at(-1)?.params?.payload?.yolo).toBe(true)
    // The other chat is not touched: the switch is the session's, not the gateway's.
    expect((await resume('writer')).info.yolo).toBe(false)
    expect(writer.id).not.toBe(researcher.id)
    expect((await resume('researcher')).info.yolo).toBe(true)
  })

  it('switches off again, and reads back as off', async () => {
    const researcher = await resume('researcher')

    await call('config.set', { key: 'yolo', value: 'on', session_id: researcher.id, scope: 'session' })

    const off = await call('config.set', { key: 'yolo', value: 'off', session_id: researcher.id, scope: 'session' })

    expect(off.result).toMatchObject({ info: { yolo: false } })
    expect((await call('config.get', { key: 'yolo', session_id: researcher.id })).result?.value).toBe('off')
    expect((await resume('researcher')).info.yolo).toBe(false)
  })
})
