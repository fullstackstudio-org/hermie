/**
 * The cron model: both surfaces' rows read as one job, the states a row can be in, the words a row says about when,
 * and where a cron delivers.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { resetLocale } from '../../i18n/locale'
import {
  cronJobFromRow,
  cronRowWhen,
  cronRunFromRow,
  cronStatusOf,
  deliveredBot,
  lastErrorSummary,
  relativeEpoch,
  relativeTime,
  runSucceeded,
  statusWord,
  type CronJob
} from './model'

afterEach(() => {
  resetLocale()
  resetActiveLocale()
})

const NOW = Date.parse('2026-10-04T12:00:00Z')
const at = (ms: number): string => new Date(NOW + ms).toISOString()

const job = (patch: Partial<CronJob> = {}): CronJob => ({
  ...cronJobFromRow({ job_id: 'j1', name: 'Briefing', schedule: 'every 2h' }),
  ...patch
})

describe('cronJobFromRow', () => {
  it('reads a `cron.manage` row: job_id, a flat schedule, a prompt preview', () => {
    expect(
      cronJobFromRow({ job_id: 'j1', name: 'A', schedule: 'every 2h', prompt_preview: 'Check', repeat: 'forever' })
    ).toMatchObject({ id: 'j1', schedule: 'every 2h', promptPreview: 'Check', prompt: '', repeat: null })
  })

  it('reads a stored job: id, the parsed schedule as an object, the full prompt, `{times}` for repeat', () => {
    const row = cronJobFromRow({
      id: 'j2',
      name: 'B',
      schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
      schedule_display: 'every day at 9am',
      prompt: 'The whole prompt',
      repeat: { times: 3, completed: 1 },
      profile: 'researcher'
    })

    expect(row).toMatchObject({
      id: 'j2',
      schedule: 'every day at 9am',
      prompt: 'The whole prompt',
      promptPreview: 'The whole prompt',
      repeat: 3,
      profile: 'researcher'
    })
  })

  it('reads a schedule object that has no display from the first key it has', () => {
    expect(cronJobFromRow({ id: 'x', schedule: { kind: 'cron', expr: '0 9 * * *' } }).schedule).toBe('0 9 * * *')
    expect(cronJobFromRow({ id: 'x', schedule: { kind: 'nothing' } }).schedule).toBe('')
  })

  it('takes a row that says nothing about `enabled` as enabled', () => {
    expect(cronJobFromRow({ id: 'x' }).enabled).toBe(true)
    expect(cronJobFromRow({ id: 'x', enabled: false }).enabled).toBe(false)
  })

  it('finds the error wherever the gateway put it, a missed fire being an object', () => {
    expect(cronJobFromRow({ id: 'x', last_error: 'boom' }).lastError).toBe('boom')
    expect(cronJobFromRow({ id: 'x', last_fire_error: { at: 't', detail: 'never started' } }).lastError).toBe(
      'never started'
    )
    expect(cronJobFromRow({ id: 'x', last_delivery_error: 'no chat' }).lastError).toBe('no chat')
  })
})

describe('cronRunFromRow', () => {
  it('reads the outcome from `end_reason`: a session row has no status column', () => {
    expect(cronRunFromRow({ id: 'r', end_reason: 'interrupted', started_at: 5, message_count: '3' })).toMatchObject({
      id: 'r',
      status: 'interrupted',
      startedAt: 5,
      messageCount: 3
    })
  })

  it('tells a success from anything else, an absent status being a success', () => {
    expect(runSucceeded({ status: null })).toBe(true)
    expect(runSucceeded({ status: 'done' })).toBe(true)
    expect(runSucceeded({ status: 'interrupted' })).toBe(false)
  })
})

describe('cronStatusOf', () => {
  it('puts paused before failed: a paused cron is not going to retry', () => {
    expect(cronStatusOf(job({ enabled: false, lastError: 'boom' }))).toBe('paused')
    expect(cronStatusOf(job({ state: 'paused' }))).toBe('paused')
  })

  it('reads failed from an error or a failed status, ok from a good one, pending from neither', () => {
    expect(cronStatusOf(job({ lastError: 'boom' }))).toBe('failed')
    expect(cronStatusOf(job({ lastStatus: 'error' }))).toBe('failed')
    expect(cronStatusOf(job({ lastStatus: 'ok' }))).toBe('ok')
    expect(cronStatusOf(job({ lastStatus: null }))).toBe('pending')
  })
})

describe('statusWord', () => {
  it('uses one word for the gateway’s several words for one state, and makes an unknown one readable', () => {
    expect(statusWord('ok')).toBe('Success')
    expect(statusWord('completed')).toBe('Success')
    expect(statusWord('error')).toBe('Failed')
    expect(statusWord('rate_limited')).toBe('Rate limited')
    expect(statusWord('')).toBeNull()
    expect(statusWord(null)).toBeNull()
  })
})

describe('cronRowWhen', () => {
  it('says the next run for an active cron', () => {
    expect(cronRowWhen(job({ nextRunAt: at(2 * 3_600_000) }), NOW)).toEqual({ label: 'next', value: 'in 2 hours' })
  })

  it('says overdue, not a negative relative time, when the next run slipped into the past', () => {
    expect(cronRowWhen(job({ nextRunAt: at(-14 * 3_600_000) }), NOW)).toEqual({ label: 'next', value: 'Overdue' })
  })

  it('says the last run for a paused cron, even where a stale next run is still there', () => {
    expect(cronRowWhen(job({ enabled: false, nextRunAt: at(3_600_000), lastRunAt: at(-3 * 3_600_000) }), NOW)).toEqual({
      label: 'last',
      value: '3 hours ago'
    })
    expect(cronRowWhen(job({ enabled: false }), NOW)).toEqual({ label: 'last', value: '—' })
  })

  it('falls back to the last run, then to not scheduled', () => {
    expect(cronRowWhen(job({ lastRunAt: at(-60_000) }), NOW).label).toBe('last')
    expect(cronRowWhen(job(), NOW)).toEqual({ label: 'next', value: 'Not scheduled' })
  })
})

describe('relativeTime', () => {
  it('says now inside the first seconds, and nothing for a time it cannot read', () => {
    expect(relativeTime(at(10_000), NOW)).toBe('now')
    expect(relativeTime('not a time', NOW)).toBeNull()
    expect(relativeTime(null, NOW)).toBeNull()
  })

  it('reads epoch seconds and milliseconds alike', () => {
    expect(relativeEpoch((NOW - 3_600_000) / 1000, NOW)).toBe('1 hour ago')
    expect(relativeEpoch(NOW - 3_600_000, NOW)).toBe('1 hour ago')
    expect(relativeEpoch(null, NOW)).toBeNull()
  })
})

describe('lastErrorSummary', () => {
  it('peels the exception class and keeps the first sentence', () => {
    expect(
      lastErrorSummary(
        "RuntimeError: Cron job 'Weekly digest' has no model configured. Set one with `hermes cron edit`."
      )
    ).toBe("Cron job 'Weekly digest' has no model configured.")
  })

  it('peels nested wrappers, and bounds what is left', () => {
    expect(lastErrorSummary('[delivery:failed] ⚠️ ValueError: no chat')).toBe('no chat')
    expect(lastErrorSummary('x'.repeat(500)).length).toBe(200)
    expect(lastErrorSummary(null)).toBe('')
  })
})

describe('deliveredBot', () => {
  it('names the bot of a bot-chat target, and the owner’s profile for a bare one', () => {
    expect(deliveredBot({ deliver: 'bot-chat:researcher', profile: 'writer' })).toBe('researcher')
    expect(deliveredBot({ deliver: 'bot-chat', profile: 'writer' })).toBe('writer')
    expect(deliveredBot({ deliver: 'bot-chat:', profile: 'writer' })).toBe('writer')
  })

  it('names nobody for anything that is not a chat of this client', () => {
    expect(deliveredBot({ deliver: 'local', profile: 'writer' })).toBeNull()
    expect(deliveredBot({ deliver: 'telegram:123', profile: null })).toBeNull()
  })
})
