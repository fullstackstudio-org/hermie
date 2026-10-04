/**
 * The cron model: one shape for a cron job, whichever surface it arrived on.
 *
 * The gateway has two surfaces and they do not agree. `cron.manage {action:
 * 'list'}` answers `_format_job` rows, which key the job as `job_id` and carry
 * a `prompt_preview`; the HTTP routes answer the STORED job, which keys it as
 * `id` and carries the full `prompt`. Normalising both here lets the list, the
 * detail page and the editor read the same fields.
 *
 * Two fields differ by more than their name:
 *
 *  - **schedule.** `_format_job` flattens it to the human `schedule_display`
 *    string, while the stored job keeps the PARSED spec (an object) under
 *    `schedule` and the readable string under `schedule_display`.
 *  - **repeat.** `_format_job` renders it ("forever", "once", "2/3"); the stored
 *    job keeps `{times, completed}`, `times: null` meaning forever. Only the
 *    count is modelled: a rendered string cannot be counted back.
 *
 * Ported from the Expo app's `features/cron/model.ts`. Differences: the words
 * come from the generated catalogue (`strings.cron`) and relative times from
 * `Intl` (`i18n/format.ts`), so Dutch and German read in their own order.
 */
import type { CronJobRow } from '@hermes/shared/gateway-contract'

import { strings } from '../../generated/strings'
import { formatRelative } from '../../i18n/format'

export type CronStatus = 'ok' | 'failed' | 'paused' | 'pending'

export interface CronJob {
  id: string
  name: string
  /** The schedule as the gateway displays it (`every 2h`, `0 9 * * 1-5`); not a prediction of when it fires. */
  schedule: string
  /** The full prompt, present only on a detail read. */
  prompt: string
  promptPreview: string
  deliver: string
  enabled: boolean
  state: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  lastError: string | null
  pausedAt: string | null
  pausedReason: string | null
  /** How many times in total; null is "until removed". */
  repeat: number | null
  skills: string[]
  model: string | null
  /**
   * Which profile's cron store the job lives in. The HTTP list tags every row with it; every mutation and
   * detail read hands it back, because `cron.manage` binds HERMES_HOME to it.
   */
  profile: string | null
}

export interface CronRun {
  id: string
  /** Unix seconds (or milliseconds; see `epochMs`). */
  startedAt: number | null
  endedAt: number | null
  lastActive: number | null
  status: string | null
  messageCount: number
  preview: string
  title: string
}

export interface CronDeliveryTarget {
  id: string
  name: string
  homeTargetSet: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const nullableStr = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value)
  }

  return null
}

/** The schedule as a line, from either surface (`cron/jobs.py::_schedule_display_for_job`). */
function scheduleDisplay(record: Record<string, unknown>): string {
  const display = str(record.schedule_display).trim()

  if (display) {
    return display
  }

  const schedule = record.schedule

  if (typeof schedule === 'string') {
    return schedule
  }

  if (isRecord(schedule)) {
    for (const key of ['display', 'value', 'expr', 'run_at']) {
      const text = str(schedule[key]).trim()

      if (text) {
        return text
      }
    }
  }

  return ''
}

/** `{times, completed}` from the stored job, or a plain count. */
const repeatTimes = (value: unknown): number | null => num(isRecord(value) ? value.times : value)

/** A missed fire is an OBJECT (`{at, detail}`); the detail is the sentence worth showing. */
function lastFireError(value: unknown): string | null {
  return isRecord(value) ? nullableStr(value.detail) : nullableStr(value)
}

/** Normalise either surface's row. `job_id` wins when both keys are present. */
export function cronJobFromRow(row: CronJobRow | Record<string, unknown>): CronJob {
  const record = row as Record<string, unknown>
  const skills = Array.isArray(record.skills)
    ? record.skills.filter((skill): skill is string => typeof skill === 'string')
    : []

  return {
    id: str(record.job_id) || str(record.id),
    name: str(record.name),
    schedule: scheduleDisplay(record),
    prompt: str(record.prompt),
    promptPreview: str(record.prompt_preview) || str(record.prompt),
    deliver: str(record.deliver) || 'local',
    // A row that says nothing about `enabled` is an enabled row: the scheduler treats a missing flag as on.
    enabled: record.enabled === undefined || record.enabled === null ? true : record.enabled !== false,
    state: str(record.state),
    nextRunAt: nullableStr(record.next_run_at),
    lastRunAt: nullableStr(record.last_run_at),
    lastStatus: nullableStr(record.last_status),
    lastError:
      nullableStr(record.last_error) ??
      lastFireError(record.last_fire_error) ??
      nullableStr(record.last_delivery_error),
    pausedAt: nullableStr(record.paused_at),
    pausedReason: nullableStr(record.paused_reason),
    repeat: repeatTimes(record.repeat),
    skills,
    model: nullableStr(record.model),
    profile: nullableStr(record.profile) ?? nullableStr(record.profile_name)
  }
}

/**
 * One `/runs` row. They are ordinary session rows, in `list_sessions_rich` shape: there is NO `status`
 * column, the outcome is `end_reason`.
 */
export function cronRunFromRow(row: Record<string, unknown>): CronRun {
  return {
    id: str(row.id),
    startedAt: num(row.started_at),
    endedAt: num(row.ended_at),
    lastActive: num(row.last_active),
    status: nullableStr(row.status) ?? nullableStr(row.end_reason),
    messageCount: num(row.message_count) ?? 0,
    preview: str(row.preview),
    title: str(row.title)
  }
}

export function deliveryTargetFromRow(row: Record<string, unknown>): CronDeliveryTarget {
  const id = str(row.id) || str(row.name)

  return { id, name: str(row.name) || id, homeTargetSet: row.home_target_set !== false }
}

const FAILED_STATUS = new Set(['error', 'failed', 'failure', 'fail'])
const OK_STATUS = new Set(['ok', 'success', 'succeeded', 'completed', 'done', 'idle'])

/**
 * The state of a routine.
 *
 * Paused beats failed on purpose: a paused routine is not going to retry, so the first thing to say about it is
 * that it is off. The error itself is still on the row underneath.
 */
export function cronStatusOf(job: CronJob): CronStatus {
  if (!job.enabled || job.state === 'paused') {
    return 'paused'
  }

  const status = (job.lastStatus ?? '').toLowerCase()

  if (job.lastError || FAILED_STATUS.has(status)) {
    return 'failed'
  }

  return OK_STATUS.has(status) ? 'ok' : 'pending'
}

export const cronStatusLabel = (status: CronStatus): string => strings.cron.status[status]

/**
 * A gateway status word as a reader would say it: the catalogue's own word where it has one, the gateway's word
 * with its underscores taken out where it does not (`end_reason` is free text: `interrupted`, `cron_complete`).
 */
export function statusWord(raw: string | null | undefined): string | null {
  const word = (raw ?? '').trim().toLowerCase()

  if (!word) {
    return null
  }

  if (OK_STATUS.has(word)) {
    return strings.cron.status.ok
  }

  if (FAILED_STATUS.has(word)) {
    return strings.cron.status.failed
  }

  if (word === 'running') {
    return strings.cron.status.running
  }

  const plain = word.replace(/[_-]+/gu, ' ')

  return plain.charAt(0).toUpperCase() + plain.slice(1)
}

/** Does this run's outcome read as a success? An absent status is one: a finished run says nothing else. */
export function runSucceeded(run: Pick<CronRun, 'status'>): boolean {
  const word = (run.status ?? '').trim().toLowerCase()

  return !word || OK_STATUS.has(word)
}

/** The row's WHEN column: a micro label over a value. */
export interface CronRowWhen {
  label: string
  value: string
}

/**
 * What a row says about when a job runs, given what it actually is: a paused job is not going anywhere (what is
 * left to say is when it last ran), an active one whose `next_run_at` slipped into the past is `overdue`, and
 * otherwise the next run, then the last run, then "Not scheduled".
 */
export function cronRowWhen(job: CronJob, now: number = Date.now()): CronRowWhen {
  const lastRun = relativeTime(job.lastRunAt, now)

  if (cronStatusOf(job) === 'paused') {
    return { label: strings.cron.list.lastLabel, value: lastRun ?? strings.cron.detail.unknown }
  }

  const nextAt = job.nextRunAt ? Date.parse(job.nextRunAt) : NaN

  if (Number.isFinite(nextAt) && nextAt < now) {
    return { label: strings.cron.list.nextLabel, value: strings.cron.list.overdue }
  }

  const nextRun = relativeTime(job.nextRunAt, now)

  if (nextRun) {
    return { label: strings.cron.list.nextLabel, value: nextRun }
  }

  if (lastRun) {
    return { label: strings.cron.list.lastLabel, value: lastRun }
  }

  return { label: strings.cron.list.nextLabel, value: strings.cron.list.noNextRun }
}

/** The job one id names, or nothing. */
export const cronJobFor = (jobs: readonly CronJob[], jobId: string): CronJob | null =>
  jobId ? (jobs.find(job => job.id === jobId) ?? null) : null

// The scheduler stores `last_error` as raw exception text, e.g.
// "RuntimeError: Cron job 'x' has no model configured (job.model=None, …)".
// A row needs the first plain sentence; the detail page still shows the rest.
const ERROR_PREFIX_RE = /^(?:[A-Za-z_][\w.]*(?:Error|Exception)|Exception):\s*/u
const ERROR_MARKER_RE = /^\[[a-z_]+(?::[a-z_]+)?\]\s*/u
const ERROR_EMOJI_RE = /^(?:⚠️?|🛑|❌|\u{1F6AB})\s*/u
const ERROR_SUMMARY_MAX = 200

/** Port of the desktop's `lastErrorSummary`, so every client says the same thing. */
export function lastErrorSummary(lastError: string | null | undefined): string {
  let text = (lastError ?? '').trim()

  // Wrappers nest (marker, then emoji, then exception class); peel until stable.
  for (let previous = ''; previous !== text;) {
    previous = text
    text = text.replace(ERROR_MARKER_RE, '').replace(ERROR_EMOJI_RE, '').replace(ERROR_PREFIX_RE, '').trimStart()
  }

  const sentenceEnd = text.search(/\. |\n/u)
  const sentence = (sentenceEnd === -1 ? text : text.slice(0, sentenceEnd + 1)).trim()

  return sentence.length > ERROR_SUMMARY_MAX ? `${sentence.slice(0, ERROR_SUMMARY_MAX - 1).trimEnd()}…` : sentence
}

/**
 * "in 2 hours", "5 minutes ago": relative, never absolute. The gateway's timezone is not the browser's, and an
 * absolute time in the browser's zone is wrong in a way nobody notices until a routine fires an hour off.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) {
    return null
  }

  const at = Date.parse(iso)

  if (!Number.isFinite(at)) {
    return null
  }

  return Math.abs(at - now) < 45_000 ? strings.cron.relative.now : formatRelative(at - now)
}

/** Epoch seconds or milliseconds from a session row, as milliseconds. */
export const epochMs = (value: number | null): number | null =>
  value === null ? null : value > 1e12 ? value : value * 1000

/** A session row's time as one relative phrase. */
export function relativeEpoch(value: number | null, now: number = Date.now()): string | null {
  const ms = epochMs(value)

  return ms === null ? null : relativeTime(new Date(ms).toISOString(), now)
}

/**
 * Where a job delivers, when that is somebody's chat.
 *
 * `bot-chat:<name>` names the bot; a bare `bot-chat` is the chat of the profile that owns the job. Anything else
 * (`local`, a messaging platform) is not a chat of this client.
 */
export function deliveredBot(job: Pick<CronJob, 'deliver' | 'profile'>): string | null {
  const deliver = job.deliver.trim()

  if (deliver === 'bot-chat') {
    return job.profile
  }

  return deliver.startsWith('bot-chat:') ? deliver.slice('bot-chat:'.length).trim() || job.profile : null
}
