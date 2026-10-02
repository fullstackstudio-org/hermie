/**
 * The schedule builder, as pure functions.
 *
 * The gateway does not take a structured schedule: `cron.manage add` and
 * `PUT /api/cron/jobs/{id}` both take one string, which `cron/jobs.py`
 * `parse_schedule` reads. So the builder's whole job is to emit a string that
 * parser accepts, and the safest way to know it does is to emit only the forms
 * the parser documents:
 *
 * - `every 30m` / `every 2h` / `every 1d` — recurring interval.
 * - `every day at 9am`, `every monday 9am`, `weekdays at 9am` — a weekday/time
 *   phrase the parser turns into a 5-field cron expression.
 * - a raw 5-field cron expression.
 * - `in 2h`, or an ISO timestamp — one-shot.
 *
 * Everything here is deliberately free of React and of the clock: the screen
 * passes a draft in and gets a string or an error out, which is what makes the
 * table of cases in `cron-schedule.test.ts` worth reading.
 *
 * The preview it returns is a description of what was built, never a prediction
 * of when the job fires. Only the gateway knows that (it owns the timezone and
 * the DST rules), which is why the editor shows the server's `next_run_at`
 * after a save rather than a number computed here.
 */
import { cronStrings } from './strings'

export type ScheduleMode = 'interval' | 'daily' | 'cron' | 'once'

export type IntervalUnit = 'minutes' | 'hours' | 'days'

export interface ScheduleDraft {
  mode: ScheduleMode
  /** Kept as text: a partially typed number must not snap back to a default. */
  intervalValue: string
  intervalUnit: IntervalUnit
  /** `HH:MM`, 24-hour. */
  time: string
  /** Cron weekday numbering: 0 = Sunday … 6 = Saturday. Empty means every day. */
  weekdays: number[]
  cronExpression: string
  /** `in 2h`, or an ISO date-time. */
  onceValue: string
}

export type ScheduleResult = { ok: true; schedule: string; preview: string } | { ok: false; error: string }

export const DEFAULT_SCHEDULE_DRAFT: ScheduleDraft = {
  mode: 'interval',
  intervalValue: '30',
  intervalUnit: 'minutes',
  time: '09:00',
  weekdays: [],
  cronExpression: '0 9 * * 1-5',
  onceValue: 'in 2h'
}

const UNIT_SUFFIX: Record<IntervalUnit, string> = { minutes: 'm', hours: 'h', days: 'd' }

const WEEKDAY_WORDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

/** Field bounds `croniter` enforces, in the order a 5-field expression writes them. */
const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  // 7 is Sunday in croniter as well as 0.
  { name: 'day of week', min: 0, max: 7 }
] as const

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/
const DURATION_RE = /^\d*\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i

/** `(9, 0)` → `9am`, `(8, 30)` → `8:30am`, `(0, 0)` → `12am`. */
export function clockPhrase(hour: number, minute: number): string {
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  const suffix = hour < 12 ? 'am' : 'pm'

  return minute === 0 ? `${hour12}${suffix}` : `${hour12}:${String(minute).padStart(2, '0')}${suffix}`
}

/** `09:00` → `{hour: 9, minute: 0}`; anything else → null. */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())

  if (!match) {
    return null
  }

  const hour = Number(match[1])
  const minute = Number(match[2])

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    return null
  }

  return { hour, minute }
}

/** The day part of a weekday/time phrase, or null when the selection has no phrase. */
export function daySpecFor(weekdays: readonly number[]): { phrase: string; every: boolean } | null {
  const days = [...new Set(weekdays)].filter(day => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b)

  if (days.length === 0 || days.length === 7) {
    return { phrase: 'day', every: true }
  }

  if (days.length === 5 && days.every(day => day >= 1 && day <= 5)) {
    // The parser's own keyword, and the one the brief names.
    return { phrase: 'weekdays', every: false }
  }

  if (days.length === 2 && days[0] === 0 && days[1] === 6) {
    return { phrase: 'weekends', every: false }
  }

  return { phrase: days.map(day => WEEKDAY_WORDS[day]).join(', '), every: true }
}

/**
 * Validate one 5-field cron expression the way the gateway's parser would
 * accept it, minus the parts only `croniter` can judge.
 *
 * It checks what a client can check without guessing: the field count, the
 * alphabet, and that every number in a field is inside that field's range. A
 * name like `MON` or a step like `*\/15` passes through — the parser allows
 * both, and refusing them here would be the app inventing a stricter contract
 * than the server has.
 */
export function validateCronExpression(expression: string): string | null {
  const fields = expression.trim().split(/\s+/).filter(Boolean)

  if (fields.length !== CRON_FIELDS.length) {
    return cronStrings.schedule.errors.cronFieldCount
  }

  for (let index = 0; index < CRON_FIELDS.length; index += 1) {
    const spec = CRON_FIELDS[index]!
    const value = fields[index]!

    if (!/^[A-Za-z0-9*\-,/]+$/.test(value)) {
      return cronStrings.schedule.errors.cronField(spec.name, value)
    }

    const numbers = value.match(/\d+/g) ?? []

    if (numbers.some(number => Number(number) < spec.min || Number(number) > spec.max)) {
      return cronStrings.schedule.errors.cronField(spec.name, value)
    }
  }

  return null
}

/** Build the schedule string the gateway parses, or the reason it cannot be built. */
export function buildSchedule(draft: ScheduleDraft): ScheduleResult {
  switch (draft.mode) {
    case 'interval': {
      const value = Number(draft.intervalValue.trim())

      if (!Number.isInteger(value) || value < 1) {
        return { ok: false, error: cronStrings.schedule.errors.interval }
      }

      const schedule = `every ${value}${UNIT_SUFFIX[draft.intervalUnit]}`

      return { ok: true, schedule, preview: schedule }
    }

    case 'daily': {
      const clock = parseClock(draft.time)

      if (!clock) {
        return { ok: false, error: cronStrings.schedule.errors.time }
      }

      const spec = daySpecFor(draft.weekdays)!
      const time = clockPhrase(clock.hour, clock.minute)
      // "every day at 9am" and "every monday 9am" both parse; "weekdays at 9am"
      // is the keyword form, which the parser reads without the "every" prefix.
      const schedule = spec.every ? `every ${spec.phrase} at ${time}` : `${spec.phrase} at ${time}`

      return { ok: true, schedule, preview: schedule }
    }

    case 'cron': {
      const expression = draft.cronExpression.trim().replace(/\s+/g, ' ')
      const error = validateCronExpression(expression)

      if (error) {
        return { ok: false, error }
      }

      return { ok: true, schedule: expression, preview: expression }
    }

    case 'once': {
      const value = draft.onceValue.trim()

      if (/^in\s+/i.test(value)) {
        const duration = value.replace(/^in\s+/i, '').trim()

        if (!DURATION_RE.test(duration)) {
          return { ok: false, error: cronStrings.schedule.errors.once }
        }

        const schedule = `in ${duration.toLowerCase()}`

        return { ok: true, schedule, preview: schedule }
      }

      if (ISO_DATE_RE.test(value)) {
        return { ok: true, schedule: value, preview: value }
      }

      return { ok: false, error: cronStrings.schedule.errors.once }
    }

    default:
      return { ok: false, error: cronStrings.schedule.errors.interval }
  }
}

/**
 * Read a stored schedule string back into a draft, so opening the editor on an
 * existing routine lands on the mode that wrote it.
 *
 * A schedule the builder cannot express — a six-field expression, a phrase with
 * named months — comes back as Cron with the raw string in the field, because
 * showing it verbatim is honest and rewriting it would silently change when the
 * routine fires.
 */
export function draftFromSchedule(schedule: string | null | undefined): ScheduleDraft {
  const raw = (schedule ?? '').trim()

  if (!raw) {
    return { ...DEFAULT_SCHEDULE_DRAFT }
  }

  const interval = /^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(raw)

  if (interval) {
    const unitLetter = interval[2]!.toLowerCase()[0]

    return {
      ...DEFAULT_SCHEDULE_DRAFT,
      mode: 'interval',
      intervalValue: interval[1]!,
      intervalUnit: unitLetter === 'h' ? 'hours' : unitLetter === 'd' ? 'days' : 'minutes'
    }
  }

  const once = /^in\s+(.+)$/i.exec(raw)

  if (once || ISO_DATE_RE.test(raw)) {
    return { ...DEFAULT_SCHEDULE_DRAFT, mode: 'once', onceValue: raw }
  }

  const phrase = parseDayTimePhrase(raw)

  if (phrase) {
    return { ...DEFAULT_SCHEDULE_DRAFT, mode: 'daily', time: phrase.time, weekdays: phrase.weekdays }
  }

  return { ...DEFAULT_SCHEDULE_DRAFT, mode: 'cron', cronExpression: raw }
}

/** The inverse of the daily/weekly branch, for `draftFromSchedule` and the list row. */
function parseDayTimePhrase(raw: string): { weekdays: number[]; time: string } | null {
  const lower = raw.toLowerCase().replace(/,/g, ' ')
  const tokens = lower
    .replace(/^every\s+/, '')
    .split(/\s+/)
    .filter(Boolean)

  if (tokens.length < 2) {
    return null
  }

  const keyword: Record<string, number[]> = {
    day: [],
    daily: [],
    everyday: [],
    weekday: [1, 2, 3, 4, 5],
    weekdays: [1, 2, 3, 4, 5],
    weekend: [0, 6],
    weekends: [0, 6]
  }

  let weekdays: number[] | null = null
  let index = 0

  if (tokens[0]! in keyword) {
    weekdays = keyword[tokens[0]!]!
    index = 1
  } else {
    const days: number[] = []

    while (index < tokens.length) {
      const token = tokens[index]!

      if (token === 'and') {
        index += 1
        continue
      }

      const day = WEEKDAY_WORDS.findIndex(word => word === token || word.slice(0, 3) === token)

      if (day === -1) {
        break
      }

      if (!days.includes(day)) {
        days.push(day)
      }

      index += 1
    }

    if (days.length === 0) {
      return null
    }

    weekdays = days
  }

  const rest = tokens.slice(index).filter(token => token !== 'at')

  if (rest.length === 0) {
    return null
  }

  const clock = parseClockPhrase(rest.join(''))

  return clock
    ? { weekdays, time: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}` }
    : null
}

/** `9am` / `9:30am` / `14:00` / `noon` → 24-hour parts, mirroring `_parse_clock_time`. */
function parseClockPhrase(text: string): { hour: number; minute: number } | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, '')

  if (value === 'noon' || value === 'midday') {
    return { hour: 12, minute: 0 }
  }

  if (value === 'midnight') {
    return { hour: 0, minute: 0 }
  }

  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(value)

  if (!match) {
    return null
  }

  let hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  const meridiem = match[3]

  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null
    }

    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0)
  }

  return hour > 23 || minute > 59 ? null : { hour, minute }
}
