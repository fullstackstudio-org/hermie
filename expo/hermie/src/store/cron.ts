/**
 * Crons state.
 *
 * Like the other stores here this is a plain reducer over data the gateway
 * already sent: the round trips live in `features/cron/cron-controller.ts`, so
 * this file can be read (and tested) without a socket in sight.
 *
 * Two things are worth knowing about the shape. The list is the HTTP
 * `GET /api/cron/jobs?profile=all` answer, which is the only one that spans
 * every profile; `gatewayRunning` rides along from a separate WS `cron.manage`
 * call, so it belongs to the list rather than to a job, and it is `null` — not
 * false — when that call did not answer. And a detail read never replaces
 * a list row: `details` is a separate map, because the detail read is the only
 * one that carries the full prompt and losing it on the next list refresh would
 * empty the editor mid-edit.
 */
import { create } from 'zustand'

import type { CronDeliveryTarget, CronJob, CronRun } from '../features/cron/model'

export interface CronState {
  jobs: CronJob[]
  /** Detail reads, by job id. Carries the full prompt the list rows do not have. */
  details: Record<string, CronJob>
  /** Run sessions per job id, newest first. */
  runs: Record<string, CronRun[]>
  deliveryTargets: CronDeliveryTarget[]
  /**
   * `gateway_running` from the last list answer: false means `hermes gateway`
   * (the scheduler) is down, so nothing fires however healthy a job looks.
   * `null` while no list answer has arrived yet.
   */
  gatewayRunning: boolean | null
  loading: boolean
  /** Job ids with a mutation in flight, so a row can disable its own buttons. */
  busy: Record<string, true>
  error: string | null
  /** `Date.now()` of the last successful list read. */
  refreshedAt: number | null

  setJobs: (jobs: CronJob[], gatewayRunning: boolean | null) => void
  setDetail: (job: CronJob) => void
  setRuns: (jobId: string, runs: CronRun[]) => void
  setDeliveryTargets: (targets: CronDeliveryTarget[]) => void
  removeJob: (jobId: string) => void
  setLoading: (loading: boolean) => void
  setBusy: (jobId: string, busy: boolean) => void
  setError: (error: string | null) => void
  reset: () => void
}

const INITIAL = {
  jobs: [] as CronJob[],
  details: {} as Record<string, CronJob>,
  runs: {} as Record<string, CronRun[]>,
  deliveryTargets: [] as CronDeliveryTarget[],
  gatewayRunning: null as boolean | null,
  loading: false,
  busy: {} as Record<string, true>,
  error: null as string | null,
  refreshedAt: null as number | null
}

export const useCronStore = create<CronState>(set => ({
  ...INITIAL,

  setJobs: (jobs, gatewayRunning) =>
    set(state => ({
      jobs,
      gatewayRunning,
      error: null,
      refreshedAt: Date.now(),
      // A job that is gone from the list is gone from the caches too, otherwise
      // a deleted routine keeps answering from `details` on the next open.
      details: pick(state.details, jobs),
      runs: pick(state.runs, jobs)
    })),

  setDetail: job =>
    set(state => ({
      details: { ...state.details, [job.id]: job },
      // Keep the list row in step with what the detail read just proved, so
      // going back does not show a stale schedule for a second.
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
    set(state => {
      if (busy) {
        return { busy: { ...state.busy, [jobId]: true as const } }
      }

      return { busy: omit(state.busy, jobId) }
    }),

  setError: error => set({ error }),

  reset: () => set({ ...INITIAL })
}))

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
