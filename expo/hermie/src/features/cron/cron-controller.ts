/**
 * Everything the Crons screen needs from the gateway.
 *
 * The cron surface is split across two transports and the split is not
 * arbitrary, so it is worth stating once instead of guessing at each call site:
 *
 * - The **list** is HTTP `GET /api/cron/jobs?profile=all`. That is the only
 *   call that answers for every profile: `cron.manage` is a `_scoped_rpc`, so
 *   it binds HERMES_HOME to the ONE profile in its params and answers from that
 *   profile's cron store alone (`tui_gateway/methods_tools.py::_profile_scoped_rpc`).
 *   A WS list without a `profile` therefore reports the launch profile's jobs
 *   and nothing else — which is why a cron owned by a bot profile used to be
 *   invisible here while the dashboard, which uses this route, listed it.
 *   Every row comes back tagged with its `profile` (`_annotate_cron_job`), and
 *   the route always lists disabled jobs, so the Paused section still fills.
 * - One WS `cron.manage {action:'list'}` rides along for **`gateway_running`**
 *   alone — the flag that says whether the scheduler process is alive, which no
 *   HTTP route reports. Its jobs are discarded and its failure is swallowed: a
 *   list that renders without knowing the scheduler's state beats no list.
 * - **Pause, resume and creation** are WS `cron.manage`, each carrying the
 *   job's `profile` so the scope lands on the right store. Unlike the HTTP
 *   routes it does not search for the owner, so a missing `profile` is not a
 *   slow path but a wrong one: the job is simply "not found".
 * - **Everything else** is HTTP, because it has no WS equivalent: the full
 *   prompt (`GET`), edits (`PUT {updates}`), deletion, `trigger`, the run
 *   history, and the delivery targets.
 *
 * Mutations do not patch the store optimistically. Every one of them makes the
 * gateway broadcast `cron.changed`, and the debounced refetch that follows is
 * the truth — including `next_run_at`, which only the server can compute.
 */
import type { GatewayHttp } from '@hermie/gateway-client'
import type { TranscriptRow } from '@hermie/transcript'

import type { ChatGateway } from '../../gateway/link'
import type { CronState } from '../../store/cron'
import {
  type CronDeliveryTarget,
  cronJobFromRow,
  type CronJob,
  type CronRun,
  cronRunFromRow,
  deliveryTargetFromRow
} from './model'

/** `cron.changed` fires about once per scheduler tick; coalesce a burst. */
export const CRON_CHANGED_DEBOUNCE_MS = 750

/** How many run sessions the detail screen asks for. */
export const RUN_HISTORY_LIMIT = 20

type StoreApi<T> = {
  getState: () => T
  setState: (partial: Partial<T>) => void
}

export interface CronControllerOptions {
  gateway: ChatGateway
  /** The REST half. Null on a connection that has not come up yet. */
  http: GatewayHttp | null
  store: StoreApi<CronState>
  debounceMs?: number
}

export interface CronJobInput {
  name: string
  prompt: string
  schedule: string
  deliver: string
  repeat?: number
  /** Whose cron store to create the job in. Absent means the launch profile. */
  profile?: string | null
}

export class CronController {
  private readonly gateway: ChatGateway
  private readonly http: GatewayHttp | null
  private readonly store: StoreApi<CronState>
  private readonly debounceMs: number

  private unsubscribe: (() => void) | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private refreshInFlight: Promise<CronJob[]> | null = null

  constructor(options: CronControllerOptions) {
    this.gateway = options.gateway
    this.http = options.http ?? null
    this.store = options.store
    this.debounceMs = options.debounceMs ?? CRON_CHANGED_DEBOUNCE_MS
  }

  /** Subscribe to `cron.changed` and take a first reading. */
  start(): void {
    this.unsubscribe?.()
    this.unsubscribe = this.gateway.on('cron.changed', () => this.scheduleRefresh())
    void this.refresh().catch(() => undefined)
    void this.loadDeliveryTargets()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null

    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.refresh().catch(() => undefined)
    }, this.debounceMs)
  }

  /** Re-read the list. Concurrent callers share one round trip. */
  refresh(): Promise<CronJob[]> {
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }

    const run = this.loadList().finally(() => {
      this.refreshInFlight = null
    })

    this.refreshInFlight = run

    return run
  }

  private async loadList(): Promise<CronJob[]> {
    this.store.getState().setLoading(true)

    try {
      // The two halves are independent, and only the HTTP one may fail the
      // read: the scheduler flag is a decoration on a list, not a reason to
      // have none.
      const [body, running] = await Promise.all([
        this.get<unknown>('/api/cron/jobs?profile=all'),
        this.loadGatewayRunning()
      ])

      const jobs = listRows(body).map(cronJobFromRow)

      this.store.getState().setJobs(jobs, running)

      return jobs
    } catch (error) {
      this.store.getState().setError(messageOf(error))

      throw error
    } finally {
      this.store.getState().setLoading(false)
    }
  }

  /**
   * `gateway_running`, the one thing only `cron.manage` says.
   *
   * `include_disabled` is still forwarded: the flag rides on the job list, and
   * `_action_list` attaches it only when the list came back non-empty, so a
   * gateway whose every job is paused would otherwise never report it.
   */
  private async loadGatewayRunning(): Promise<boolean | null> {
    try {
      const result = await this.gateway.request('cron.manage', { action: 'list', include_disabled: true })

      // An absent flag stays unknown rather than becoming "not running".
      return typeof result?.gateway_running === 'boolean' ? result.gateway_running : null
    } catch {
      return null
    }
  }

  /** The full job, including the prompt the list row only previews. */
  async loadDetail(job: Pick<CronJob, 'id' | 'profile'>): Promise<CronJob> {
    const body = await this.get<Record<string, unknown>>(this.jobPath(job))
    const detail = cronJobFromRow(unwrapJob(body))
    const merged: CronJob = { ...detail, ...(detail.profile ? {} : { profile: job.profile }) }

    this.store.getState().setDetail(merged)

    return merged
  }

  async loadRuns(job: Pick<CronJob, 'id' | 'profile'>): Promise<CronRun[]> {
    const body = await this.get<Record<string, unknown>>(
      this.jobPath(job, '/runs', { limit: String(RUN_HISTORY_LIMIT) })
    )
    const rows = Array.isArray(body?.runs) ? body.runs : []
    const runs = rows.filter(isRecord).map(cronRunFromRow)

    this.store.getState().setRuns(job.id, runs)

    return runs
  }

  async loadDeliveryTargets(): Promise<CronDeliveryTarget[]> {
    try {
      const body = await this.get<Record<string, unknown>>('/api/cron/delivery-targets')
      const rows = Array.isArray(body?.targets) ? body.targets : []
      const targets = rows.filter(isRecord).map(deliveryTargetFromRow)

      this.store.getState().setDeliveryTargets(targets.length ? targets : [LOCAL_TARGET])

      return targets
    } catch {
      // A gateway that cannot list its targets still delivers locally, and an
      // editor with one option beats an editor that refuses to open.
      this.store.getState().setDeliveryTargets([LOCAL_TARGET])

      return [LOCAL_TARGET]
    }
  }

  /** The transcript of one run session. Runs are sessions `cron_{job}_{ts}`. */
  async loadRunTranscript(runId: string, profile: string | null): Promise<TranscriptRow[]> {
    const result = await this.gateway.request('session.history', {
      session_id: runId,
      ...(profile ? { profile } : {})
    })

    return (result?.messages ?? []) as TranscriptRow[]
  }

  pause(job: Pick<CronJob, 'id' | 'profile'>): Promise<void> {
    return this.manage(job, 'pause')
  }

  resume(job: Pick<CronJob, 'id' | 'profile'>): Promise<void> {
    return this.manage(job, 'resume')
  }

  private async manage(job: Pick<CronJob, 'id' | 'profile'>, action: 'pause' | 'resume'): Promise<void> {
    await this.mutate(job.id, async () => {
      const result = await this.gateway.request('cron.manage', {
        action,
        name: job.id,
        ...(job.profile ? { profile: job.profile } : {})
      })

      if (result?.success === false) {
        throw new Error(result.error ?? `The gateway refused to ${action} this cron.`)
      }
    })
  }

  /** `POST .../trigger` — fire the job now; the gateway answers the refreshed job. */
  async runNow(job: Pick<CronJob, 'id' | 'profile'>): Promise<void> {
    await this.mutate(job.id, async () => {
      await this.post(this.jobPath(job, '/trigger'))
    })
  }

  async create(input: CronJobInput): Promise<void> {
    const result = await this.gateway.request('cron.manage', {
      action: 'add',
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      deliver: input.deliver,
      ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
      // The scope decides which cron store the job is written to, so this is
      // the whole of "create it for that bot"; there is no owner field.
      ...(input.profile ? { profile: input.profile } : {})
    })

    if (result?.success === false) {
      throw new Error(result.error ?? 'The gateway refused the cron.')
    }

    await this.refresh()
  }

  /** `PUT {updates}` — a merge, not a replace; untouched fields keep their value. */
  async update(job: Pick<CronJob, 'id' | 'profile'>, input: CronJobInput): Promise<CronJob> {
    return this.mutate(job.id, async () => {
      const body = await this.put<Record<string, unknown>>(this.jobPath(job), {
        updates: {
          name: input.name,
          schedule: input.schedule,
          prompt: input.prompt,
          deliver: input.deliver,
          ...(input.repeat === undefined ? {} : { repeat: input.repeat })
        }
      })

      const updated = cronJobFromRow(unwrapJob(body))
      const merged: CronJob = { ...updated, ...(updated.profile ? {} : { profile: job.profile }) }

      this.store.getState().setDetail(merged)

      return merged
    })
  }

  async remove(job: Pick<CronJob, 'id' | 'profile'>): Promise<void> {
    await this.mutate(job.id, async () => {
      await this.delete(this.jobPath(job))
      this.store.getState().removeJob(job.id)
    })
  }

  /** Run one mutation with the row marked busy and failures surfaced. */
  private async mutate<T>(jobId: string, run: () => Promise<T>): Promise<T> {
    this.store.getState().setBusy(jobId, true)

    try {
      const value = await run()
      // The broadcast will land too, debounced; this is the immediate one, so a
      // tap does not look ignored for three quarters of a second.
      await this.refresh().catch(() => undefined)

      return value
    } catch (error) {
      this.store.getState().setError(messageOf(error))

      throw error
    } finally {
      this.store.getState().setBusy(jobId, false)
    }
  }

  private jobPath(job: Pick<CronJob, 'id' | 'profile'>, suffix = '', extra: Record<string, string> = {}): string {
    const query = new URLSearchParams(extra)

    // Without it these routes fall back to `_find_cron_job_profile`, which
    // walks every profile's store and takes the first id that matches — so
    // omitting it is not just a wasted search but a coin toss between two
    // profiles that named a job the same thing.
    if (job.profile) {
      query.set('profile', job.profile)
    }

    const search = query.toString()

    return `/api/cron/jobs/${encodeURIComponent(job.id)}${suffix}${search ? `?${search}` : ''}`
  }

  private get<T>(path: string): Promise<T> {
    return this.requireHttp().get<T>(path)
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.requireHttp().post<T>(path, body ?? {})
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.requireHttp().put<T>(path, body)
  }

  private delete<T>(path: string): Promise<T> {
    return this.requireHttp().delete<T>(path)
  }

  private requireHttp(): GatewayHttp {
    if (!this.http) {
      throw new Error('There is no gateway connection yet.')
    }

    return this.http
  }
}

const LOCAL_TARGET: CronDeliveryTarget = { id: 'local', name: 'Local (save only)', homeTargetSet: true }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * The rows out of a list response.
 *
 * `hermes serve` answers `GET /api/cron/jobs` with a bare array; a `{jobs: …}`
 * envelope is what every other cron route uses and what the WS half sends, so
 * both are read rather than one being declared correct.
 */
function listRows(body: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.jobs) ? body.jobs : []

  return rows.filter(isRecord)
}

/**
 * The job out of a detail/update response.
 *
 * `hermes serve` answers these with the stored job itself; a `{job: …}` wrapper
 * shows up on other builds, so both are accepted rather than one being declared
 * correct.
 */
function unwrapJob(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!body) {
    return {}
  }

  return isRecord(body.job) ? body.job : body
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
