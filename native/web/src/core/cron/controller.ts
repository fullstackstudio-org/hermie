/**
 * Everything the Crons pages need from the gateway.
 *
 * The cron surface is split across two transports, and the split is not arbitrary:
 *
 *  - The **list** is HTTP `GET /api/cron/jobs?profile=all`. That is the only call that answers for every profile:
 *    `cron.manage` is a `_scoped_rpc`, so it binds HERMES_HOME to the ONE profile in its params and answers from
 *    that profile's cron store alone (`tui_gateway/methods_tools.py`). A socket list without a `profile` reports
 *    the launch profile's jobs and nothing else, so a cron owned by a bot profile would be invisible. Every row
 *    comes back tagged with its `profile`, and the route lists disabled jobs too, so the Paused section fills.
 *  - One socket `cron.manage {action: 'list'}` rides along for **`gateway_running`** alone: whether the scheduler
 *    process is alive, which no HTTP route reports. Its jobs are discarded and its failure is swallowed: a list
 *    that renders without knowing the scheduler's state beats no list.
 *  - **Pause, resume and creation** are socket `cron.manage`, each carrying the job's `profile` so the scope lands
 *    on the right store. It does not search for the owner, so a missing `profile` is not a slow path but a wrong
 *    one: the job is "not found".
 *  - **Everything else** is HTTP, because it has no socket equivalent: the full prompt (`GET`), edits
 *    (`PUT {updates}`), deletion, `trigger`, the run history and the delivery targets.
 *
 * Mutations do not patch the store optimistically. Every one of them makes the gateway broadcast `cron.changed`,
 * and the refetch that follows is the truth, including `next_run_at`, which only the gateway can compute.
 *
 * Ported from the Expo app's `features/cron/cron-controller.ts`; it takes the two transports as two small
 * interfaces, so a test hands in a few functions rather than a connection.
 */
import type { TranscriptRow } from '@hermie/transcript'
import type { StoreApi } from 'zustand/vanilla'

import type { GatewayHttp } from '@hermie/gateway-client'

import { strings } from '../../generated/strings'
import type { CronState } from '../../state/cron'
import type { ChatGateway } from '../link'
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

/** How many run sessions the detail page asks for. */
export const RUN_HISTORY_LIMIT = 20

/** The two halves of the gateway the controller uses: the socket's calls and events, and the REST client. */
export interface CronTransport {
  gateway: Pick<ChatGateway, 'request' | 'on'>
  http: Pick<GatewayHttp, 'get' | 'post' | 'put' | 'delete'>
}

export interface CronControllerOptions {
  transport: CronTransport
  store: StoreApi<CronState>
  debounceMs?: number
}

/** What the editor saves. */
export interface CronJobInput {
  name: string
  prompt: string
  schedule: string
  deliver: string
  repeat?: number
  /** Whose cron store to create the job in. Absent means the launch profile. */
  profile?: string | null
}

/** What an edit saves: `PUT` merges, so a field left out keeps the gateway's value. */
export type CronJobUpdate = Omit<CronJobInput, 'schedule' | 'profile'> & { schedule?: string }

type JobRef = Pick<CronJob, 'id' | 'profile'>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The refusal's own sentence where the gateway gave one (`GatewayError.hint` carries a FastAPI `detail`). */
export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const hint = (error as { hint?: unknown }).hint

    return typeof hint === 'string' && hint.trim() ? hint : error.message
  }

  return String(error)
}

/**
 * The rows out of a list response. `hermes serve` answers `GET /api/cron/jobs` with a bare array; a `{jobs: ...}`
 * envelope is what every other cron route uses, so both are read.
 */
function listRows(body: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.jobs) ? body.jobs : []

  return rows.filter(isRecord)
}

/** The job out of a detail or update response: the stored job itself, or a `{job: ...}` wrapper. */
function unwrapJob(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!body) {
    return {}
  }

  return isRecord(body.job) ? body.job : body
}

/** The target every gateway delivers to, listed even before the call has answered: the editor is never empty. */
export const localTarget = (): CronDeliveryTarget => ({
  id: 'local',
  name: strings.cron.editor.deliverLocal,
  homeTargetSet: true
})

export class CronController {
  private readonly transport: CronTransport
  private readonly store: StoreApi<CronState>
  private readonly debounceMs: number

  private unsubscribe: (() => void) | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private refreshInFlight: Promise<CronJob[]> | null = null

  constructor(options: CronControllerOptions) {
    this.transport = options.transport
    this.store = options.store
    this.debounceMs = options.debounceMs ?? CRON_CHANGED_DEBOUNCE_MS
  }

  /** Follow `cron.changed`, and take a first reading. */
  start(): void {
    this.unsubscribe?.()
    this.unsubscribe = this.transport.gateway.on('cron.changed', () => this.scheduleRefresh())
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
      // The two halves are independent, and only the HTTP one may fail the read.
      const [body, running] = await Promise.all([
        this.transport.http.get<unknown>('/api/cron/jobs?profile=all'),
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
   * `gateway_running`, the one thing only `cron.manage` says. `include_disabled` is still forwarded: the flag rides
   * on the job list, and the gateway attaches it only when the list came back non-empty, so a gateway whose every
   * job is paused would otherwise never report it.
   */
  private async loadGatewayRunning(): Promise<boolean | null> {
    try {
      const result = await this.transport.gateway.request('cron.manage', { action: 'list', include_disabled: true })

      // An absent flag stays unknown rather than becoming "not running".
      return typeof result?.gateway_running === 'boolean' ? result.gateway_running : null
    } catch {
      return null
    }
  }

  /** The full job, including the prompt the list row only previews. */
  async loadDetail(job: JobRef): Promise<CronJob> {
    const body = await this.transport.http.get<Record<string, unknown>>(this.jobPath(job))
    const detail = cronJobFromRow(unwrapJob(body))
    const merged: CronJob = { ...detail, ...(detail.profile ? {} : { profile: job.profile }) }

    this.store.getState().setDetail(merged)

    return merged
  }

  async loadRuns(job: JobRef): Promise<CronRun[]> {
    const body = await this.transport.http.get<Record<string, unknown>>(
      this.jobPath(job, '/runs', { limit: String(RUN_HISTORY_LIMIT) })
    )
    const rows = Array.isArray(body?.runs) ? body.runs : []
    const runs = rows.filter(isRecord).map(cronRunFromRow)

    this.store.getState().setRuns(job.id, runs)

    return runs
  }

  async loadDeliveryTargets(): Promise<CronDeliveryTarget[]> {
    try {
      const body = await this.transport.http.get<Record<string, unknown>>('/api/cron/delivery-targets')
      const rows = Array.isArray(body?.targets) ? body.targets : []
      const targets = rows.filter(isRecord).map(deliveryTargetFromRow)

      this.store.getState().setDeliveryTargets(targets.length ? targets : [localTarget()])

      return targets
    } catch {
      // A gateway that cannot list its targets still delivers locally, and an editor with one option beats an
      // editor that refuses to open.
      this.store.getState().setDeliveryTargets([localTarget()])

      return [localTarget()]
    }
  }

  /** The transcript of one run session. Runs are sessions `cron_{job}_{ts}`; read-only, nothing is resumed. */
  async loadRunTranscript(runId: string, profile: string | null): Promise<TranscriptRow[]> {
    const result = await this.transport.gateway.request('session.history', {
      session_id: runId,
      ...(profile ? { profile } : {})
    })

    return (result?.messages ?? []) as TranscriptRow[]
  }

  pause(job: JobRef): Promise<void> {
    return this.manage(job, 'pause')
  }

  resume(job: JobRef): Promise<void> {
    return this.manage(job, 'resume')
  }

  private async manage(job: JobRef, action: 'pause' | 'resume'): Promise<void> {
    await this.mutate(job.id, async () => {
      const result = await this.transport.gateway.request('cron.manage', {
        action,
        name: job.id,
        ...(job.profile ? { profile: job.profile } : {})
      })

      if (result?.success === false) {
        throw new Error(result.error ?? `The gateway refused to ${action} this cron.`)
      }
    })
  }

  /** `POST .../trigger`: fire the job now. The schedule is unchanged. */
  async runNow(job: JobRef): Promise<void> {
    await this.mutate(job.id, async () => {
      await this.transport.http.post(this.jobPath(job, '/trigger'), {})
    })
  }

  /** Create a cron, and answer its id (empty when the gateway did not say). */
  async create(input: CronJobInput): Promise<string> {
    const result = await this.transport.gateway.request('cron.manage', {
      action: 'add',
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      deliver: input.deliver,
      ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
      // The scope decides which cron store the job is written to, so this is the whole of "create it for that
      // bot": there is no owner field.
      ...(input.profile ? { profile: input.profile } : {})
    })

    if (result?.success === false) {
      throw new Error(result.error ?? 'The gateway refused the cron.')
    }

    const id = result?.job_id ?? result?.job?.job_id ?? ''

    await this.refresh().catch(() => undefined)

    return typeof id === 'string' ? id : ''
  }

  /** `PUT {updates}`: a merge, not a replace; untouched fields keep their value. */
  update(job: JobRef, input: CronJobUpdate): Promise<CronJob> {
    return this.mutate(job.id, async () => {
      const body = await this.transport.http.put<Record<string, unknown>>(this.jobPath(job), {
        updates: {
          name: input.name,
          ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
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

  async remove(job: JobRef): Promise<void> {
    await this.mutate(job.id, async () => {
      await this.transport.http.delete(this.jobPath(job))
      this.store.getState().removeJob(job.id)
    })
  }

  /** Run one mutation with the row marked busy; a failure is thrown to the caller, who says it where it was asked. */
  private async mutate<T>(jobId: string, run: () => Promise<T>): Promise<T> {
    this.store.getState().setBusy(jobId, true)

    try {
      const value = await run()

      // The broadcast will land too, debounced; this is the immediate one, so a click does not look ignored.
      await this.refresh().catch(() => undefined)

      return value
    } finally {
      this.store.getState().setBusy(jobId, false)
    }
  }

  private jobPath(job: JobRef, suffix = '', extra: Record<string, string> = {}): string {
    const query = new URLSearchParams(extra)

    // Without it these routes fall back to `_find_cron_job_profile`, which walks every profile's store and takes
    // the first id that matches: a coin toss between two profiles that named a job the same thing.
    if (job.profile) {
      query.set('profile', job.profile)
    }

    const search = query.toString()

    return `/api/cron/jobs/${encodeURIComponent(job.id)}${suffix}${search ? `?${search}` : ''}`
  }
}
