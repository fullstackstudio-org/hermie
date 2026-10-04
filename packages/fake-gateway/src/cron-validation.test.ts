/**
 * The fake gateway refuses a schedule the way the real one does (`cron/jobs.py::parse_schedule`): over the socket as
 * `{success: false, error}`, over REST as a 400 with `{detail}`, and a refused create or edit changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { scheduleRefusal } from './cron-schedule'
import { type FakeGateway, startFakeGateway } from './server'

describe('scheduleRefusal', () => {
  it.each([
    '30m',
    'every 30m',
    'every hour',
    'every 2 hours',
    'in 2h',
    'weekdays at 9am',
    'every day at 9am',
    'every monday 9am',
    'every friday 16:30',
    'every monday, wednesday at 9:30am',
    '0 9 * * 1-5',
    '*/15 * * * MON-FRI',
    '2026-09-20T09:00:00',
    '2026-09-20 09:00'
  ])('takes %j', schedule => {
    expect(scheduleRefusal(schedule)).toBeNull()
  })

  it.each<[string, RegExp]>([
    ['every banana', /^Invalid duration: 'banana'/u],
    ['every 5', /^Invalid duration: '5'/u],
    ['in soon', /^Invalid duration 'soon' after 'in '/u],
    ['2026-13-45', /^Invalid timestamp '2026-13-45'/u],
    ['soon', /^Invalid schedule 'soon'\. Use:/u],
    ['0 9 * *', /^Invalid schedule '0 9 \* \*'/u],
    ['', /^Invalid schedule ''/u]
  ])('refuses %j in the gateway’s own sentence', (schedule, sentence) => {
    expect(scheduleRefusal(schedule)).toMatch(sentence)
  })
})

describe('a refused schedule', () => {
  let gateway: FakeGateway
  let socket: WebSocket

  const call = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1e9)
      const onMessage = (data: unknown): void => {
        for (const line of String(data).split('\n')) {
          if (!line.trim()) {
            continue
          }

          const frame = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown }

          if (frame.id === id) {
            socket.off('message', onMessage)

            if (frame.error) {
              reject(new Error(JSON.stringify(frame.error)))
            } else {
              resolve(frame.result ?? {})
            }
          }
        }
      }

      socket.on('message', onMessage)
      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  beforeEach(async () => {
    gateway = await startFakeGateway({ port: 0 })
    socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  })

  afterEach(async () => {
    socket.close()
    await gateway.close()
  })

  const jobCount = async (): Promise<number> =>
    ((await (await fetch(`${gateway.url}/api/cron/jobs`)).json()) as unknown[]).length

  it('is `{success: false, error}` over the socket, and creates nothing', async () => {
    const before = await jobCount()
    const result = await call('cron.manage', {
      action: 'add',
      name: 'Odd',
      schedule: 'every banana',
      prompt: 'x',
      deliver: 'local'
    })

    expect(result).toMatchObject({ success: false })
    expect(String(result.error)).toContain("Invalid duration: 'banana'")
    expect(await jobCount()).toBe(before)
  })

  it('is a 400 with the sentence in `detail` over REST, on create and on edit, and changes nothing', async () => {
    const before = await jobCount()
    const created = await fetch(`${gateway.url}/api/cron/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Odd', schedule: 'soon', prompt: 'x', deliver: 'local' })
    })

    expect(created.status).toBe(400)
    expect(((await created.json()) as { detail: string }).detail).toMatch(/^Invalid schedule 'soon'/u)
    expect(await jobCount()).toBe(before)

    const edited = await fetch(`${gateway.url}/api/cron/jobs/job-heartbeat`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ updates: { schedule: 'in soon' } })
    })

    expect(edited.status).toBe(400)
    expect(((await edited.json()) as { detail: string }).detail).toContain("after 'in '")

    const job = (await (await fetch(`${gateway.url}/api/cron/jobs/job-heartbeat`)).json()) as { schedule: string }

    expect(job.schedule).toBe('every 2h')
  })
})
