/**
 * The schedule builder and the schedule in words: every form the gateway's parser documents is built, read back into
 * the mode that wrote it, and described in each of the three languages; a form it cannot express is shown as it is.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { resetLocale, setLanguageChoice } from '../../i18n/locale'
import {
  buildSchedule,
  DEFAULT_SCHEDULE_DRAFT,
  describeSchedule,
  draftFromSchedule,
  parseClock,
  type ScheduleDraft,
  validateCronExpression
} from './schedule'

afterEach(() => {
  resetLocale()
  resetActiveLocale()
})

const draft = (patch: Partial<ScheduleDraft>): ScheduleDraft => ({ ...DEFAULT_SCHEDULE_DRAFT, ...patch })

describe('buildSchedule', () => {
  it.each<[string, Partial<ScheduleDraft>, string]>([
    ['an interval in minutes', { mode: 'interval', intervalValue: '30', intervalUnit: 'minutes' }, 'every 30m'],
    ['an interval in hours', { mode: 'interval', intervalValue: '2', intervalUnit: 'hours' }, 'every 2h'],
    ['an interval in days', { mode: 'interval', intervalValue: ' 1 ', intervalUnit: 'days' }, 'every 1d'],
    ['every day', { mode: 'daily', time: '09:00', weekdays: [] }, 'every day at 9am'],
    [
      'every day, all seven chosen',
      { mode: 'daily', time: '18:30', weekdays: [0, 1, 2, 3, 4, 5, 6] },
      'every day at 6:30pm'
    ],
    [
      'weekdays, in the parser keyword form',
      { mode: 'daily', time: '08:15', weekdays: [1, 2, 3, 4, 5] },
      'weekdays at 8:15am'
    ],
    ['weekends', { mode: 'daily', time: '00:00', weekdays: [6, 0] }, 'weekends at 12am'],
    ['named days', { mode: 'daily', time: '12:00', weekdays: [5, 1] }, 'every monday, friday at 12pm'],
    ['a cron expression, whitespace tidied', { mode: 'cron', cronExpression: '  0   9 * * 1-5 ' }, '0 9 * * 1-5'],
    ['a delay', { mode: 'once', onceValue: 'In 2H' }, 'in 2h'],
    ['a timestamp', { mode: 'once', onceValue: '2026-09-20T09:00' }, '2026-09-20T09:00']
  ])('writes %s the way the parser reads it', (_name, patch, expected) => {
    expect(buildSchedule(draft(patch))).toEqual({ ok: true, schedule: expected })
  })

  it.each<[string, Partial<ScheduleDraft>]>([
    ['an empty interval', { mode: 'interval', intervalValue: '' }],
    ['a zero interval', { mode: 'interval', intervalValue: '0' }],
    ['a fractional interval', { mode: 'interval', intervalValue: '1.5' }],
    ['a time that is not a time', { mode: 'daily', time: '25:00' }],
    ['no time', { mode: 'daily', time: '' }],
    ['a cron with four fields', { mode: 'cron', cronExpression: '0 9 * *' }],
    ['a cron with an hour out of range', { mode: 'cron', cronExpression: '0 24 * * *' }],
    ['a delay without a unit', { mode: 'once', onceValue: 'in 2' }],
    ['words', { mode: 'once', onceValue: 'tomorrow' }]
  ])('refuses %s, in words', (_name, patch) => {
    const built = buildSchedule(draft(patch))

    expect(built.ok).toBe(false)
    expect(built.ok ? '' : built.error.length).toBeGreaterThan(10)
  })
})

describe('validateCronExpression', () => {
  it('lets through what only the gateway can judge: names and steps', () => {
    expect(validateCronExpression('*/15 * * * MON-FRI')).toBeNull()
    expect(validateCronExpression('0 9 1 JAN *')).toBeNull()
  })

  it('names the field that is out of range', () => {
    expect(validateCronExpression('60 * * * *')).toContain('minute')
    expect(validateCronExpression('0 0 32 * *')).toContain('day of month')
    expect(validateCronExpression('0 0 * 13 *')).toContain('month')
    expect(validateCronExpression('0 0 * * 8')).toContain('day of week')
    expect(validateCronExpression('0 0 * * !')).toContain('day of week')
  })
})

describe('parseClock', () => {
  it('reads HH:MM and nothing else', () => {
    expect(parseClock('09:05')).toEqual({ hour: 9, minute: 5 })
    expect(parseClock('9:05')).toEqual({ hour: 9, minute: 5 })
    expect(parseClock('24:00')).toBeNull()
    expect(parseClock('9am')).toBeNull()
  })
})

describe('draftFromSchedule', () => {
  it.each<[string, Partial<ScheduleDraft>]>([
    ['every 30m', { mode: 'interval', intervalValue: '30', intervalUnit: 'minutes' }],
    ['every 2 hours', { mode: 'interval', intervalValue: '2', intervalUnit: 'hours' }],
    ['every hour', { mode: 'interval', intervalValue: '1', intervalUnit: 'hours' }],
    ['in 2h', { mode: 'once', onceValue: 'in 2h' }],
    ['once in 2h', { mode: 'once', onceValue: 'in 2h' }],
    ['once at 2026-09-20 09:00', { mode: 'once', onceValue: '2026-09-20 09:00' }],
    ['2026-09-20T09:00:00Z', { mode: 'once', onceValue: '2026-09-20T09:00:00Z' }],
    ['every day at 9am', { mode: 'daily', time: '09:00', weekdays: [] }],
    ['weekdays at 9am', { mode: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] }],
    ['every friday 16:30', { mode: 'daily', time: '16:30', weekdays: [5] }],
    ['every mon, wed and fri at noon', { mode: 'daily', time: '12:00', weekdays: [1, 3, 5] }],
    ['0 9 * * 1-5', { mode: 'cron', cronExpression: '0 9 * * 1-5' }],
    ['0 9 * * * *', { mode: 'cron', cronExpression: '0 9 * * * *' }]
  ])('opens %j on the mode that wrote it', (schedule, expected) => {
    expect(draftFromSchedule(schedule)).toEqual(draft(expected))
  })

  it('opens an empty schedule on the default', () => {
    expect(draftFromSchedule('')).toEqual(DEFAULT_SCHEDULE_DRAFT)
    expect(draftFromSchedule(null)).toEqual(DEFAULT_SCHEDULE_DRAFT)
  })

  it('builds back what it read, for the forms the builder writes', () => {
    for (const schedule of [
      'every 30m',
      'every 2h',
      'every day at 9am',
      'weekdays at 8:15am',
      '0 9 * * 1-5',
      'in 2h'
    ]) {
      expect(buildSchedule(draftFromSchedule(schedule))).toEqual({ ok: true, schedule })
    }
  })
})

describe('describeSchedule', () => {
  it.each<[string, string]>([
    ['every 1m', 'Every minute'],
    ['every 30m', 'Every 30 minutes'],
    ['every hour', 'Every hour'],
    ['every 2h', 'Every 2 hours'],
    ['every 1d', 'Every day'],
    ['every 3 days', 'Every 3 days'],
    ['in 1h', 'Once, in 1 hour'],
    ['once in 30m', 'Once, in 30 minutes'],
    ['once in 2d', 'Once, in 2 days'],
    ['once at 2026-09-20 09:00', 'Once, at 2026-09-20 09:00'],
    ['2026-09-20T09:00:00', 'Once, at 2026-09-20 09:00:00'],
    ['every day at 9am', 'Every day at 9:00 AM'],
    ['weekdays at 9am', 'On weekdays at 9:00 AM'],
    ['weekends at 6:30pm', 'On weekends at 6:30 PM'],
    ['every friday 16:30', 'Every Friday at 4:30 PM'],
    ['every monday, wednesday at 9am', 'Every Monday and Wednesday at 9:00 AM'],
    ['0 9 * * *', 'Every day at 9:00 AM'],
    ['30 7 * * 1-5', 'On weekdays at 7:30 AM'],
    ['0 9 * * 0,6', 'On weekends at 9:00 AM'],
    ['0 9 * * 1,3,5', 'Every Monday, Wednesday, and Friday at 9:00 AM'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['0 * * * *', 'Every hour'],
    ['0 9 15 * *', 'Monthly, on day 15 at 9:00 AM']
  ])('says %j as %j', (schedule, words) => {
    expect(describeSchedule(schedule)).toBe(words)
  })

  it('shows what it cannot put into words exactly as stored', () => {
    expect(describeSchedule('0 9 * 1 1-5')).toBe('0 9 * 1 1-5')
    expect(describeSchedule('15 9-17 * * *')).toBe('15 9-17 * * *')
    expect(describeSchedule('whenever')).toBe('whenever')
  })

  it('says a missing schedule as a dash', () => {
    expect(describeSchedule('')).toBe('—')
    expect(describeSchedule(undefined)).toBe('—')
  })

  it('speaks Dutch and German, with the weekdays the browser spells', async () => {
    await setLanguageChoice('nl')
    expect(describeSchedule('every 2h')).toBe('Elke 2 uur')
    expect(describeSchedule('weekdays at 9am')).toContain('Op werkdagen om')
    expect(describeSchedule('every monday, friday at 9am')).toBe('Elke maandag en vrijdag om 9:00')
    expect(describeSchedule('in 2h')).toBe('Eenmalig, over 2 uur')

    await setLanguageChoice('de')
    expect(describeSchedule('every 30m')).toBe('Alle 30 Minuten')
    expect(describeSchedule('every monday, friday at 9am')).toBe('Jeden Montag und Freitag um 9:00')
    expect(describeSchedule('0 9 15 * *')).toBe('Monatlich, am 15. um 9:00')
  })
})
