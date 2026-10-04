/**
 * The cron controller against a hand-driven transport: the list is the HTTP answer for every profile, the scheduler
 * flag rides on the socket and may fail alone, every call after the list carries the job's profile, and a refusal
 * reaches the caller in the gateway's own sentence.
 */
import { GatewayError } from '@hermie/gateway-client'
import { describe, expect, it, vi } from 'vitest'

import { createCronStore } from '../../state/cron'
import { CronController, type CronTransport, messageOf } from './controller'

const ROWS = [
  { id: 'j1', name: 'Heartbeat', schedule: 'every 2h', prompt: 'Check', profile: 'default' },
  { id: 'j2', name: 'Scan', schedule: 'every 4h', prompt: 'Scan', profile: 'researcher', enabled: false }
]

function setup(
  over: {
    http?: Partial<Record<'get' | 'post' | 'put' | 'delete', ReturnType<typeof vi.fn>>>
    request?: (method: string, params: unknown) => unknown
  } = {}
) {
  const listeners: (() => void)[] = []
  const request = vi.fn(async (method: string, params: unknown) => {
    if (over.request) {
      return over.request(method, params)
    }

    return method === 'cron.manage' ? { success: true, gateway_running: true, job_id: 'new-id' } : { messages: [] }
  })
  const http = {
    get: vi.fn(async (path: string) => {
      if (path.startsWith('/api/cron/jobs?profile=all')) {
        return ROWS
      }

      if (path.startsWith('/api/cron/delivery-targets')) {
        return {
          targets: [
            { id: 'local', name: 'Local' },
            { id: 'bot-chat:researcher', name: 'Researcher chat' }
          ]
        }
      }

      if (path.includes('/runs')) {
        return { runs: [{ id: 'cron_j1_5', end_reason: 'done', started_at: 5 }] }
      }

      return { ...ROWS[0], prompt: 'The full prompt' }
    }),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({ ...ROWS[0], name: 'Renamed' })),
    delete: vi.fn(async () => ({ ok: true })),
    ...over.http
  } as unknown as CronTransport['http'] & Record<'get' | 'post' | 'put' | 'delete', ReturnType<typeof vi.fn>>
  const store = createCronStore()
  const gateway = {
    request,
    on: vi.fn((_type: string, listener: () => void) => {
      listeners.push(listener)

      return () => listeners.splice(listeners.indexOf(listener), 1)
    })
  } as unknown as CronTransport['gateway']
  const controller = new CronController({ transport: { gateway, http }, store, debounceMs: 5 })

  return { controller, store, http, request, listeners }
}

describe('refresh', () => {
  it('reads every profile over HTTP and the scheduler flag over the socket', async () => {
    const { controller, store, http, request } = setup()

    await controller.refresh()

    expect(http.get).toHaveBeenCalledWith('/api/cron/jobs?profile=all')
    expect(request).toHaveBeenCalledWith('cron.manage', { action: 'list', include_disabled: true })
    expect(store.getState()).toMatchObject({ loaded: true, error: null, gatewayRunning: true })
    expect(store.getState().jobs.map(job => [job.id, job.profile, job.enabled])).toEqual([
      ['j1', 'default', true],
      ['j2', 'researcher', false]
    ])
  })

  it('keeps the list when only the scheduler flag fails, and leaves the flag unknown', async () => {
    const { controller, store } = setup({
      request: () => {
        throw new Error('gateway not connected')
      }
    })

    await controller.refresh()

    expect(store.getState().jobs).toHaveLength(2)
    expect(store.getState().gatewayRunning).toBeNull()
  })

  it('records why the list failed, and says it is read', async () => {
    const { controller, store } = setup({
      http: {
        get: vi.fn(async () => {
          throw new Error('HTTP 500')
        })
      }
    })

    await expect(controller.refresh()).rejects.toThrow('HTTP 500')
    expect(store.getState()).toMatchObject({ loaded: true, error: 'HTTP 500', loading: false })
  })

  it('shares one round trip between callers that ask at once', async () => {
    const { controller, http } = setup()

    await Promise.all([controller.refresh(), controller.refresh()])

    expect(http.get).toHaveBeenCalledTimes(1)
  })

  it('reads again, once, after a burst of cron.changed', async () => {
    const { controller, http, listeners } = setup()

    controller.start()
    await vi.waitFor(() => expect(http.get).toHaveBeenCalledWith('/api/cron/jobs?profile=all'))
    http.get.mockClear()
    listeners.forEach(listener => listener())
    listeners.forEach(listener => listener())
    await vi.waitFor(() => expect(http.get).toHaveBeenCalledWith('/api/cron/jobs?profile=all'))
    controller.stop()

    expect(http.get.mock.calls.filter(([path]) => String(path).startsWith('/api/cron/jobs?'))).toHaveLength(1)
  })
})

describe('the detail, the runs and the targets', () => {
  it('asks for the job under its profile and keeps the full prompt apart from the list row', async () => {
    const { controller, store, http } = setup()

    await controller.refresh()
    const detail = await controller.loadDetail({ id: 'j2', profile: 'researcher' })

    expect(http.get).toHaveBeenCalledWith('/api/cron/jobs/j2?profile=researcher')
    expect(detail.prompt).toBe('The full prompt')
    expect(store.getState().details.j1?.prompt).toBe('The full prompt')
  })

  it('reads the run history with its limit, newest first as the gateway sent it', async () => {
    const { controller, store, http } = setup()

    await controller.loadRuns({ id: 'j1', profile: 'default' })

    expect(http.get).toHaveBeenCalledWith('/api/cron/jobs/j1/runs?limit=20&profile=default')
    expect(store.getState().runs.j1?.map(run => run.id)).toEqual(['cron_j1_5'])
  })

  it('lists the delivery targets, and offers local when the gateway cannot say', async () => {
    const { controller, store } = setup()

    await controller.loadDeliveryTargets()
    expect(store.getState().deliveryTargets.map(target => target.id)).toEqual(['local', 'bot-chat:researcher'])

    const failing = setup({
      http: {
        get: vi.fn(async () => {
          throw new Error('nope')
        })
      }
    })

    await failing.controller.loadDeliveryTargets()
    expect(failing.store.getState().deliveryTargets.map(target => target.id)).toEqual(['local'])
  })

  it('reads a run transcript as `session.history` under the cron’s profile, resuming nothing', async () => {
    const { controller, request } = setup({ request: () => ({ messages: [{ role: 'user', text: 'hi' }] }) })

    const rows = await controller.loadRunTranscript('cron_j1_5', 'researcher')

    expect(request).toHaveBeenCalledWith('session.history', { session_id: 'cron_j1_5', profile: 'researcher' })
    expect(rows).toHaveLength(1)
  })
})

describe('the actions', () => {
  it('pauses and resumes over the socket, scoped to the job’s profile', async () => {
    const { controller, request } = setup()

    await controller.pause({ id: 'j2', profile: 'researcher' })
    await controller.resume({ id: 'j1', profile: null })

    expect(request).toHaveBeenCalledWith('cron.manage', { action: 'pause', name: 'j2', profile: 'researcher' })
    expect(request).toHaveBeenCalledWith('cron.manage', { action: 'resume', name: 'j1' })
  })

  it('throws the gateway’s own sentence when it refuses, and clears the row’s busy mark', async () => {
    const { controller, store } = setup({ request: () => ({ success: false, error: 'No such job: j9' }) })

    await expect(controller.pause({ id: 'j9', profile: null })).rejects.toThrow('No such job: j9')
    expect(store.getState().busy).toEqual({})
  })

  it('marks the row busy while an action runs', async () => {
    let release = (): void => undefined
    const { controller, store } = setup({
      http: {
        post: vi.fn(
          () =>
            new Promise(resolve => {
              release = () => resolve({})
            })
        )
      }
    })
    const running = controller.runNow({ id: 'j1', profile: 'default' })

    expect(store.getState().busy).toEqual({ j1: true })
    release()
    await running
    expect(store.getState().busy).toEqual({})
  })

  it('triggers a run under the profile', async () => {
    const { controller, http } = setup()

    await controller.runNow({ id: 'j1', profile: 'default' })

    expect(http.post).toHaveBeenCalledWith('/api/cron/jobs/j1/trigger?profile=default', {})
  })

  it('creates through the socket in the scope it was given, and answers the new id', async () => {
    const { controller, request } = setup()

    const id = await controller.create({
      name: 'Nightly',
      prompt: 'Sweep',
      schedule: 'every 6h',
      deliver: 'local',
      profile: 'researcher'
    })

    expect(id).toBe('new-id')
    expect(request).toHaveBeenCalledWith('cron.manage', {
      action: 'add',
      name: 'Nightly',
      schedule: 'every 6h',
      prompt: 'Sweep',
      deliver: 'local',
      profile: 'researcher'
    })
  })

  it('says why a create was refused, in the gateway’s words', async () => {
    const { controller } = setup({ request: () => ({ success: false, error: "Invalid schedule 'soon'." }) })

    await expect(controller.create({ name: 'x', prompt: 'y', schedule: 'soon', deliver: 'local' })).rejects.toThrow(
      "Invalid schedule 'soon'."
    )
  })

  it('updates with a merge, leaving the schedule out when it was not changed', async () => {
    const { controller, http } = setup()

    await controller.update({ id: 'j1', profile: 'default' }, { name: 'Renamed', prompt: 'P', deliver: 'local' })

    expect(http.put).toHaveBeenCalledWith('/api/cron/jobs/j1?profile=default', {
      updates: { name: 'Renamed', prompt: 'P', deliver: 'local' }
    })
  })

  it('removes the job from the store as well as from the gateway', async () => {
    // After the delete the gateway's list no longer holds it, which is what the refresh that follows reads.
    const { controller, store, http } = setup({ http: { get: vi.fn(async () => [ROWS[1]]) } })

    await controller.remove({ id: 'j1', profile: 'default' })

    expect(http.delete).toHaveBeenCalledWith('/api/cron/jobs/j1?profile=default')
    expect(store.getState().jobs.map(job => job.id)).not.toContain('j1')
  })
})

describe('messageOf', () => {
  it('prefers the sentence a refusal carried', () => {
    const refusal = new GatewayError('protocol', 'PUT failed with HTTP 400.', {
      status: 400,
      hint: 'Invalid schedule.'
    })

    expect(messageOf(refusal)).toBe('Invalid schedule.')
    expect(messageOf(new Error('plain'))).toBe('plain')
    expect(messageOf('text')).toBe('text')
  })
})
