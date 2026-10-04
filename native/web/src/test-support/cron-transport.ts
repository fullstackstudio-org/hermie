/**
 * A cron surface that answers like a gateway, in memory, for the Crons page tests: the HTTP routes of
 * `hermes_cli/web_routers/cron.py` the page uses and the socket's `cron.manage` and `session.history`, in the shapes
 * `packages/fake-gateway` serves (stored jobs keyed `id` over HTTP, `job_id` rows over the socket).
 */
import { vi } from 'vitest'

import type { CronTransport } from '../core/cron/controller'

export interface FakeJob extends Record<string, unknown> {
  id: string
  name: string
  profile: string
}

export const heartbeat = (): FakeJob => ({
  id: 'job-heartbeat',
  profile: 'default',
  name: 'VM heartbeat',
  schedule: 'every 2h',
  prompt: 'Check the VM and summarize disk and memory.',
  deliver: 'local',
  enabled: true,
  state: 'scheduled',
  next_run_at: new Date(Date.now() + 7_200_000).toISOString(),
  last_run_at: new Date(Date.now() - 3_600_000).toISOString(),
  last_status: 'ok',
  repeat: null,
  skills: []
})

export const digest = (): FakeJob => ({
  id: 'job-digest',
  profile: 'default',
  name: 'Weekly digest',
  schedule: 'every friday 16:30',
  prompt: 'Write a short digest of this week.',
  deliver: 'bot-chat:researcher',
  enabled: true,
  state: 'scheduled',
  next_run_at: new Date(Date.now() + 86_400_000).toISOString(),
  last_run_at: new Date(Date.now() - 7_200_000).toISOString(),
  last_status: 'error',
  last_error: "RuntimeError: Cron job 'Weekly digest' has no model configured. Set one with `hermes cron edit`.",
  repeat: null,
  skills: ['research']
})

export const cleanup = (): FakeJob => ({
  id: 'job-cleanup',
  profile: 'researcher',
  name: 'Inbox cleanup',
  schedule: 'every day at 6pm',
  prompt: 'Archive what is answered.',
  deliver: 'local',
  enabled: false,
  state: 'paused',
  next_run_at: null,
  last_run_at: null,
  last_status: null,
  paused_reason: 'Paused from the desktop app',
  repeat: null,
  skills: []
})

export const RUNS = [
  {
    id: 'cron_job-heartbeat_1790000000',
    source: 'cron',
    title: 'VM heartbeat',
    end_reason: 'done',
    started_at: Math.floor(Date.now() / 1000) - 3_600,
    ended_at: Math.floor(Date.now() / 1000) - 3_560,
    message_count: 3,
    preview: 'Done: nothing needs your attention.'
  },
  {
    id: 'cron_job-heartbeat_1789900000',
    source: 'cron',
    title: 'VM heartbeat',
    end_reason: 'interrupted',
    started_at: Math.floor(Date.now() / 1000) - 90_000,
    ended_at: Math.floor(Date.now() / 1000) - 89_960,
    message_count: 3,
    preview: 'The check did not complete.'
  }
]

export interface FakeCronOptions {
  jobs?: FakeJob[]
  gatewayRunning?: boolean
  /** Make the list read answer this error. */
  listFails?: string
  /** The schedule the gateway refuses, with its sentence. */
  refuseSchedule?: (schedule: string) => string | null
}

export function fakeCron(options: FakeCronOptions = {}) {
  let jobs = (options.jobs ?? [heartbeat(), digest(), cleanup()]).map(job => ({ ...job }))
  const listeners = new Set<() => void>()
  const changed = (): void => listeners.forEach(listener => listener())
  const find = (id: string) => jobs.find(job => job.id === id)

  const get = vi.fn(async (path: string) => {
    const url = new URL(path, 'http://gateway.test')

    if (url.pathname === '/api/cron/jobs') {
      if (options.listFails) {
        throw new Error(options.listFails)
      }

      return jobs
    }

    if (url.pathname === '/api/cron/delivery-targets') {
      return {
        targets: [
          { id: 'local', name: 'Local (save only)' },
          { id: 'bot-chat:researcher', name: 'Bot chat: researcher' }
        ]
      }
    }

    const match = /^\/api\/cron\/jobs\/([^/]+)(\/runs)?$/u.exec(url.pathname)
    const job = match ? find(decodeURIComponent(match[1]!)) : undefined

    if (!job) {
      throw new Error('The gateway has no GET endpoint (HTTP 404).')
    }

    return match?.[2] ? { runs: job.id === 'job-heartbeat' ? RUNS : [] } : job
  })

  const put = vi.fn(async (path: string, body: unknown) => {
    const job = find(decodeURIComponent(new URL(path, 'http://gateway.test').pathname.split('/')[4]!))!
    const updates = (body as { updates: Record<string, unknown> }).updates

    if (typeof updates.schedule === 'string') {
      const refusal = options.refuseSchedule?.(updates.schedule)

      if (refusal) {
        throw Object.assign(new Error('PUT failed with HTTP 400.'), { hint: refusal })
      }
    }

    Object.assign(job, updates)
    changed()

    return job
  })

  const post = vi.fn(async (path: string) => {
    const job = find(decodeURIComponent(new URL(path, 'http://gateway.test').pathname.split('/')[4]!))!

    job.last_run_at = new Date().toISOString()
    job.last_status = 'ok'
    changed()

    return job
  })

  const del = vi.fn(async (path: string) => {
    jobs = jobs.filter(
      job => job.id !== decodeURIComponent(new URL(path, 'http://gateway.test').pathname.split('/')[4]!)
    )
    changed()

    return { ok: true }
  })

  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'session.history') {
      return {
        count: 3,
        messages: [
          {
            role: 'user',
            text: 'Check the VM and summarize disk and memory.',
            row_id: 1,
            timestamp: RUNS[0]!.started_at
          },
          {
            role: 'assistant',
            text: 'All clear: disk at 41%, memory at 58%.',
            row_id: 2,
            timestamp: RUNS[0]!.started_at + 12
          }
        ]
      }
    }

    const action = params.action
    const name = String(params.name ?? '')

    if (action === 'list') {
      return { success: true, jobs: [], gateway_running: options.gatewayRunning ?? true }
    }

    if (action === 'add') {
      const refusal = options.refuseSchedule?.(String(params.schedule))

      if (refusal) {
        return { success: false, error: refusal }
      }

      const job: FakeJob = {
        ...heartbeat(),
        id: `job-${jobs.length + 1}`,
        name,
        schedule: String(params.schedule),
        prompt: String(params.prompt),
        deliver: String(params.deliver),
        profile: typeof params.profile === 'string' ? params.profile : 'default',
        last_run_at: null,
        last_status: null
      }

      jobs.push(job)
      changed()

      return { success: true, job_id: job.id, job: { ...job, job_id: job.id } }
    }

    const job = jobs.find(
      entry => (entry.id === name || entry.name === name) && entry.profile === (params.profile ?? 'default')
    )

    if (!job) {
      return { success: false, error: `No such job: ${name}` }
    }

    job.enabled = action === 'resume'
    job.state = action === 'resume' ? 'scheduled' : 'paused'
    changed()

    return { success: true, job: { ...job, job_id: job.id } }
  })

  const transport = {
    gateway: {
      request,
      on: vi.fn((_type: string, listener: () => void) => {
        listeners.add(listener)

        return () => listeners.delete(listener)
      })
    },
    http: { get, post, put, delete: del }
  } as unknown as CronTransport

  return { transport, jobs: () => jobs, get, post, put, del, request, changed }
}
