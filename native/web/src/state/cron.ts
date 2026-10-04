/**
 * What the Crons pages know: the list of jobs, the detail reads, the run histories and the delivery targets.
 *
 * Written by the cron controller (`core/cron/controller.ts`) and nothing else; read by the Crons pages. A vanilla
 * zustand store, like the others in this directory, and kept in the Crons chunk: nothing on the first screen
 * reads it.
 *
 * Two things are worth knowing about the shape. The list is the HTTP `GET /api/cron/jobs?profile=all` answer,
 * which is the only one that spans every profile; `gatewayRunning` rides along from a separate `cron.manage`
 * call, so it belongs to the list rather than to a job, and it is `null`, not false, when that call did not
 * answer. And a detail read never replaces a list row: `details` is a separate map, because the detail read is the
 * only one that carries the full prompt and losing it on the next list refresh would empty the editor mid-edit.
 *
 * Ported from the Expo app's `store/cron.ts`.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { CronDeliveryTarget, CronJob, CronRun } from '../core/cron/model'

export interface CronState {
  jobs: CronJob[]
  /** Detail reads, by job id. Carries the full prompt the list rows do not have. */
  details: Record<string, CronJob>
  /** Run sessions per job id, newest first. */
  runs: Record<string, CronRun[]>
  deliveryTargets: CronDeliveryTarget[]
  /** `gateway_running` from the last list answer: false means the scheduler process is down. `null` until known. */
  gatewayRunning: boolean | null
  /** A list read is on its way. */
  loading: boolean
  /** A list read has finished, either way: what tells "no crons" from "not read yet". */
  loaded: boolean
  /** Job ids with a mutation in flight, so a row can disable its own buttons. */
  busy: Record<string, true>
  /** Why the last list read failed; `null` when it succeeded or none has finished. */
  error: string | null

  setJobs(jobs: CronJob[], gatewayRunning: boolean | null): void
  setDetail(job: CronJob): void
  setRuns(jobId: string, runs: CronRun[]): void
  setDeliveryTargets(targets: CronDeliveryTarget[]): void
  removeJob(jobId: string): void
  setLoading(loading: boolean): void
  setBusy(jobId: string, busy: boolean): void
  setError(error: string | null): void
  reset(): void
}

const INITIAL = {
  jobs: [] as CronJob[],
  details: {} as Record<string, CronJob>,
  runs: {} as Record<string, CronRun[]>,
  deliveryTargets: [] as CronDeliveryTarget[],
  gatewayRunning: null as boolean | null,
  loading: false,
  loaded: false,
  busy: {} as Record<string, true>,
  error: null as string | null
}

function pick<T>(map: Record<string, T>, jobs: readonly CronJob[]): Record<string, T> {
  const kept: Record<string, T> = {}

  for (const job of jobs) {
    const value = map[job.id]

    if (value !== undefined) {
      kept[job.id] = value
    }
  }

  return kept
}

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) {
    return map
  }

  const next = { ...map }

  delete next[key]

  return next
}

export function createCronStore(): StoreApi<CronState> {
  return createStore<CronState>(set => ({
    ...INITIAL,

    setJobs: (jobs, gatewayRunning) =>
      set(state => ({
        jobs,
        gatewayRunning,
        error: null,
        loaded: true,
        // A job that is gone from the list is gone from the caches too: a deleted cron must not keep answering
        // from `details` on the next open.
        details: pick(state.details, jobs),
        runs: pick(state.runs, jobs)
      })),

    setDetail: job =>
      set(state => ({
        details: { ...state.details, [job.id]: job },
        // Keep the list row in step with what the detail read just proved.
        jobs: state.jobs.map(row => (row.id === job.id ? { ...row, ...job, prompt: job.prompt || row.prompt } : row))
      })),

    setRuns: (jobId, runs) => set(state => ({ runs: { ...state.runs, [jobId]: runs } })),

    setDeliveryTargets: targets => set({ deliveryTargets: targets }),

    removeJob: jobId =>
      set(state => ({
        jobs: state.jobs.filter(job => job.id !== jobId),
        details: omit(state.details, jobId),
        runs: omit(state.runs, jobId)
      })),

    setLoading: loading => set({ loading }),

    setBusy: (jobId, busy) =>
      set(state => (busy ? { busy: { ...state.busy, [jobId]: true as const } } : { busy: omit(state.busy, jobId) })),

    setError: error => set({ error, loaded: true }),

    reset: () => set({ ...INITIAL })
  }))
}

/** The page's Crons state. */
export const cronStore: StoreApi<CronState> = createCronStore()
