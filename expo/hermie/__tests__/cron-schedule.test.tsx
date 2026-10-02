/**
 * The schedule builder is a pure function, and this is the table of what it
 * emits. Every expectation here is a form `cron/jobs.py::parse_schedule`
 * documents; if one of them changes, the routine fires at the wrong time and
 * nothing else in the app would notice.
 */
import {
  buildSchedule,
  clockPhrase,
  DEFAULT_SCHEDULE_DRAFT,
  daySpecFor,
  draftFromSchedule,
  parseClock,
  type ScheduleDraft,
  validateCronExpression
} from '../src/features/cron/schedule'

const draft = (partial: Partial<ScheduleDraft>): ScheduleDraft => ({ ...DEFAULT_SCHEDULE_DRAFT, ...partial })

const built = (partial: Partial<ScheduleDraft>): string => {
  const result = buildSchedule(draft(partial))

  if (!result.ok) {
    throw new Error(`expected a schedule, got: ${result.error}`)
  }

  return result.schedule
}

describe('interval mode', () => {
  it('writes "every 30m"', () => {
    expect(built({ mode: 'interval', intervalValue: '30', intervalUnit: 'minutes' })).toBe('every 30m')
  })

  it('writes hours and days with the unit letters the parser takes', () => {
    expect(built({ mode: 'interval', intervalValue: '2', intervalUnit: 'hours' })).toBe('every 2h')
    expect(built({ mode: 'interval', intervalValue: '1', intervalUnit: 'days' })).toBe('every 1d')
  })

  it('refuses a value that is not a whole number of units', () => {
    expect(buildSchedule(draft({ mode: 'interval', intervalValue: '' }))).toMatchObject({ ok: false })
    expect(buildSchedule(draft({ mode: 'interval', intervalValue: '0' }))).toMatchObject({ ok: false })
    expect(buildSchedule(draft({ mode: 'interval', intervalValue: 'soon' }))).toMatchObject({ ok: false })
  })
})

describe('daily and weekly mode', () => {
  it('writes "every day at 9am" when no weekday is picked', () => {
    expect(built({ mode: 'daily', time: '09:00', weekdays: [] })).toBe('every day at 9am')
  })

  it('writes "every monday 9am" for a single day', () => {
    expect(built({ mode: 'daily', time: '09:00', weekdays: [1] })).toBe('every monday at 9am')
  })

  it('writes "weekdays at 9am" for Monday through Friday', () => {
    expect(built({ mode: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] })).toBe('weekdays at 9am')
  })

  it('writes the weekend keyword for Saturday and Sunday', () => {
    expect(built({ mode: 'daily', time: '16:30', weekdays: [0, 6] })).toBe('weekends at 4:30pm')
  })

  it('lists several days, in week order whatever order they were tapped', () => {
    expect(built({ mode: 'daily', time: '08:00', weekdays: [3, 1] })).toBe('every monday, wednesday at 8am')
  })

  it('treats all seven days as "day"', () => {
    expect(built({ mode: 'daily', time: '08:00', weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe('every day at 8am')
  })

  it('refuses a time it cannot read', () => {
    expect(buildSchedule(draft({ mode: 'daily', time: '9' }))).toMatchObject({ ok: false })
    expect(buildSchedule(draft({ mode: 'daily', time: '25:00' }))).toMatchObject({ ok: false })
  })
})

describe('clock formatting', () => {
  it('uses the meridiem forms the parser accepts', () => {
    expect(clockPhrase(9, 0)).toBe('9am')
    expect(clockPhrase(8, 30)).toBe('8:30am')
    expect(clockPhrase(0, 0)).toBe('12am')
    expect(clockPhrase(12, 0)).toBe('12pm')
    expect(clockPhrase(18, 5)).toBe('6:05pm')
  })

  it('reads HH:MM back', () => {
    expect(parseClock('09:00')).toEqual({ hour: 9, minute: 0 })
    expect(parseClock('23:59')).toEqual({ hour: 23, minute: 59 })
    expect(parseClock('24:00')).toBeNull()
    expect(parseClock('9am')).toBeNull()
  })
})

describe('day specs', () => {
  it('maps a selection onto the phrase the parser understands', () => {
    expect(daySpecFor([])).toEqual({ phrase: 'day', every: true })
    expect(daySpecFor([1, 2, 3, 4, 5])).toEqual({ phrase: 'weekdays', every: false })
    expect(daySpecFor([6, 0])).toEqual({ phrase: 'weekends', every: false })
    expect(daySpecFor([2])).toEqual({ phrase: 'tuesday', every: true })
  })
})

describe('cron mode', () => {
  it('passes a five-field expression through untouched', () => {
    expect(built({ mode: 'cron', cronExpression: '0 9 * * 1-5' })).toBe('0 9 * * 1-5')
  })

  it('normalises the spacing but not the fields', () => {
    expect(built({ mode: 'cron', cronExpression: '  */15   9  *  *  MON-FRI ' })).toBe('*/15 9 * * MON-FRI')
  })

  it('counts the fields', () => {
    expect(validateCronExpression('0 9 * *')).not.toBeNull()
    expect(validateCronExpression('0 9 * * * *')).not.toBeNull()
    expect(validateCronExpression('0 9 * * 1-5')).toBeNull()
  })

  it('checks each field against its own range', () => {
    expect(validateCronExpression('61 9 * * 1')).not.toBeNull()
    expect(validateCronExpression('0 25 * * 1')).not.toBeNull()
    expect(validateCronExpression('0 9 32 * 1')).not.toBeNull()
    expect(validateCronExpression('0 9 * 13 1')).not.toBeNull()
    expect(validateCronExpression('0 9 * * 8')).not.toBeNull()
  })

  it('rejects an alphabet the parser would not take', () => {
    expect(validateCronExpression('0 9 * * mon;tue')).not.toBeNull()
  })
})

describe('once mode', () => {
  it('writes a delay as "in 2h"', () => {
    expect(built({ mode: 'once', onceValue: 'in 2h' })).toBe('in 2h')
    expect(built({ mode: 'once', onceValue: 'IN 45 MIN' })).toBe('in 45 min')
  })

  it('passes an ISO date-time through', () => {
    expect(built({ mode: 'once', onceValue: '2026-09-20T09:00' })).toBe('2026-09-20T09:00')
    expect(built({ mode: 'once', onceValue: '2026-09-20' })).toBe('2026-09-20')
  })

  it('refuses anything else, rather than sending the gateway a guess', () => {
    expect(buildSchedule(draft({ mode: 'once', onceValue: 'tomorrow' }))).toMatchObject({ ok: false })
    expect(buildSchedule(draft({ mode: 'once', onceValue: 'in a bit' }))).toMatchObject({ ok: false })
  })
})

describe('reading a stored schedule back into the builder', () => {
  it('lands on the mode that wrote it', () => {
    expect(draftFromSchedule('every 30m')).toMatchObject({
      mode: 'interval',
      intervalValue: '30',
      intervalUnit: 'minutes'
    })
    expect(draftFromSchedule('every 2h')).toMatchObject({ mode: 'interval', intervalValue: '2', intervalUnit: 'hours' })
    expect(draftFromSchedule('in 2h')).toMatchObject({ mode: 'once', onceValue: 'in 2h' })
    expect(draftFromSchedule('2026-09-20T09:00')).toMatchObject({ mode: 'once' })
    expect(draftFromSchedule('weekdays at 9am')).toMatchObject({
      mode: 'daily',
      time: '09:00',
      weekdays: [1, 2, 3, 4, 5]
    })
    expect(draftFromSchedule('every monday 9am')).toMatchObject({ mode: 'daily', time: '09:00', weekdays: [1] })
  })

  it('keeps a schedule the builder cannot express verbatim, as Cron', () => {
    // Six fields: `parse_schedule` takes it, the builder never writes it.
    expect(draftFromSchedule('0 0 9 * * 1')).toMatchObject({ mode: 'cron', cronExpression: '0 0 9 * * 1' })
  })

  it('round-trips every form the builder emits', () => {
    for (const schedule of ['every 30m', 'every 2h', 'every day at 9am', 'weekdays at 9am', '0 9 * * 1-5', 'in 2h']) {
      const result = buildSchedule(draftFromSchedule(schedule))

      expect(result.ok && result.schedule).toBe(schedule)
    }
  })
})
