/**
 * The schedule builder, and the schedule in words, as pure functions.
 *
 * The gateway does not take a structured schedule: `cron.manage add` and `PUT /api/cron/jobs/{id}` both take one
 * string, which `cron/jobs.py::parse_schedule` reads. So the builder's job is to emit a string that parser
 * accepts, and the safest way to know it does is to emit only the forms the parser documents:
 *
 *  - `every 30m` / `every 2h` / `every 1d`: a recurring interval;
 *  - `every day at 9am`, `every monday 9am`, `weekdays at 9am`: a weekday and time, which the parser turns into a
 *    5-field cron expression;
 *  - a raw 5-field cron expression;
 *  - `in 2h`, or an ISO timestamp: one-shot.
 *
 * Nothing here is React or the clock: a draft goes in and a string or an error comes out. The words it returns
 * describe what was built; they are never a prediction of when the job fires. Only the gateway knows that (it owns
 * the timezone and the DST rules), which is why the pages show the gateway's `next_run_at`.
 *
 * Ported from the Expo app's `features/cron/schedule.ts`; `describeSchedule` is new (there the string was shown as
 * written).
 */
import { strings } from '../../generated/strings'
import { formatDate, formatTime } from '../../i18n/format'
import { activeLocale } from '../../i18n/active-locale'
import { cronWebStrings } from '../../i18n/cron-strings'

export type ScheduleMode = 'interval' | 'daily' | 'cron' | 'once'

export type IntervalUnit = 'minutes' | 'hours' | 'days'

export interface ScheduleDraft {
  mode: ScheduleMode
  /** Kept as text: a partially typed number must not snap back to a default. */
  intervalValue: string
  intervalUnit: IntervalUnit
  /** `HH:MM`, 24-hour. */
  time: string
  /** Cron weekday numbering: 0 = Sunday ... 6 = Saturday. Empty means every day. */
  weekdays: number[]
  cronExpression: string
  /** `in 2h`, or an ISO date-time. */
  onceValue: string
}

export type ScheduleResult = { ok: true; schedule: string } | { ok: false; error: string }

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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/u
const DURATION_RE = /^\d*\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/iu
const INTERVAL_RE = /^every\s+(\d*)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/iu

/** `(9, 0)` becomes `9am`, `(8, 30)` `8:30am`, `(0, 0)` `12am`: the phrase the gateway's parser reads. */
export function clockPhrase(hour: number, minute: number): string {
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  const suffix = hour < 12 ? 'am' : 'pm'

  return minute === 0 ? `${hour12}${suffix}` : `${hour12}:${String(minute).padStart(2, '0')}${suffix}`
}

/** `09:00` becomes `{hour: 9, minute: 0}`; anything else, null. */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(text.trim())

  if (!match) {
    return null
  }

  const hour = Number(match[1])
  const minute = Number(match[2])

  return Number.isInteger(hour) && Number.isInteger(minute) && hour <= 23 && minute <= 59 ? { hour, minute } : null
}

/** The day part of a weekday/time phrase. An empty or complete selection is "every day". */
export function daySpecFor(weekdays: readonly number[]): { phrase: string; every: boolean } {
  const days = [...new Set(weekdays)].filter(day => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b)

  if (days.length === 0 || days.length === 7) {
    return { phrase: 'day', every: true }
  }

  if (days.length === 5 && days.every(day => day >= 1 && day <= 5)) {
    // The parser's own keyword.
    return { phrase: 'weekdays', every: false }
  }

  if (days.length === 2 && days[0] === 0 && days[1] === 6) {
    return { phrase: 'weekends', every: false }
  }

  return { phrase: days.map(day => WEEKDAY_WORDS[day]).join(', '), every: true }
}

/**
 * Validate one 5-field cron expression the way the gateway's parser would accept it, minus the parts only
 * `croniter` can judge: the field count, the alphabet, and that every number in a field is inside that field's
 * range. A name like `MON` or a step like `*\/15` passes through (the parser allows both), and refusing them here
 * would be this client inventing a stricter contract than the gateway has.
 */
export function validateCronExpression(expression: string): string | null {
  const fields = expression.trim().split(/\s+/u).filter(Boolean)

  if (fields.length !== CRON_FIELDS.length) {
    return strings.cron.schedule.errors.cronFieldCount
  }

  for (let index = 0; index < CRON_FIELDS.length; index += 1) {
    const spec = CRON_FIELDS[index]!
    const value = fields[index]!

    if (!/^[A-Za-z0-9*\-,/]+$/u.test(value)) {
      return strings.cron.schedule.errors.cronField({ field: spec.name, value })
    }

    const numbers = value.match(/\d+/gu) ?? []

    if (numbers.some(number => Number(number) < spec.min || Number(number) > spec.max)) {
      return strings.cron.schedule.errors.cronField({ field: spec.name, value })
    }
  }

  return null
}

/** Build the schedule string the gateway parses, or the reason it cannot be built. */
export function buildSchedule(draft: ScheduleDraft): ScheduleResult {
  switch (draft.mode) {
    case 'interval': {
      const value = Number(draft.intervalValue.trim())

      if (!draft.intervalValue.trim() || !Number.isInteger(value) || value < 1) {
        return { ok: false, error: strings.cron.schedule.errors.interval }
      }

      return { ok: true, schedule: `every ${value}${UNIT_SUFFIX[draft.intervalUnit]}` }
    }

    case 'daily': {
      const clock = parseClock(draft.time)

      if (!clock) {
        return { ok: false, error: strings.cron.schedule.errors.time }
      }

      const spec = daySpecFor(draft.weekdays)
      const time = clockPhrase(clock.hour, clock.minute)

      // "every day at 9am" and "every monday 9am" both parse; "weekdays at 9am" is the keyword form, which the
      // parser reads without the "every" prefix.
      return { ok: true, schedule: spec.every ? `every ${spec.phrase} at ${time}` : `${spec.phrase} at ${time}` }
    }

    case 'cron': {
      const expression = draft.cronExpression.trim().replace(/\s+/gu, ' ')
      const error = validateCronExpression(expression)

      return error ? { ok: false, error } : { ok: true, schedule: expression }
    }

    case 'once': {
      const value = draft.onceValue.trim()

      if (/^in\s+/iu.test(value)) {
        const duration = value.replace(/^in\s+/iu, '').trim()

        return DURATION_RE.test(duration)
          ? { ok: true, schedule: `in ${duration.toLowerCase()}` }
          : { ok: false, error: strings.cron.schedule.errors.once }
      }

      return ISO_DATE_RE.test(value)
        ? { ok: true, schedule: value }
        : { ok: false, error: strings.cron.schedule.errors.once }
    }
  }
}

/**
 * Read a stored schedule string back into a draft, so opening the editor on an existing cron lands on the mode
 * that wrote it. A schedule the builder cannot express (a six-field expression, a phrase with named months) comes
 * back as Cron with the raw string in the field: showing it verbatim is honest, and rewriting it would silently
 * change when the cron fires.
 */
export function draftFromSchedule(schedule: string | null | undefined): ScheduleDraft {
  const raw = (schedule ?? '').trim()

  if (!raw) {
    return { ...DEFAULT_SCHEDULE_DRAFT }
  }

  const interval = INTERVAL_RE.exec(raw)

  if (interval) {
    const unitLetter = interval[2]!.toLowerCase()[0]

    return {
      ...DEFAULT_SCHEDULE_DRAFT,
      mode: 'interval',
      intervalValue: interval[1] || '1',
      intervalUnit: unitLetter === 'h' ? 'hours' : unitLetter === 'd' ? 'days' : 'minutes'
    }
  }

  // The gateway displays a one-shot as `once in 2h` / `once at 2026-02-03 14:00`; the builder writes `in 2h`.
  const once = /^(?:once\s+)?in\s+(.+)$/iu.exec(raw)

  if (once) {
    return { ...DEFAULT_SCHEDULE_DRAFT, mode: 'once', onceValue: `in ${once[1]}` }
  }

  const stamp = /^(?:once\s+at\s+)?(.+)$/iu.exec(raw)?.[1] ?? raw

  if (ISO_DATE_RE.test(stamp)) {
    return { ...DEFAULT_SCHEDULE_DRAFT, mode: 'once', onceValue: stamp }
  }

  const phrase = parseDayTimePhrase(raw)

  if (phrase) {
    return { ...DEFAULT_SCHEDULE_DRAFT, mode: 'daily', time: phrase.time, weekdays: phrase.weekdays }
  }

  return { ...DEFAULT_SCHEDULE_DRAFT, mode: 'cron', cronExpression: raw }
}

const DAY_KEYWORDS: Record<string, number[]> = {
  day: [],
  daily: [],
  everyday: [],
  weekday: [1, 2, 3, 4, 5],
  weekdays: [1, 2, 3, 4, 5],
  weekend: [0, 6],
  weekends: [0, 6]
}

/** The inverse of the daily/weekly branch, for `draftFromSchedule` and `describeSchedule`. */
export function parseDayTimePhrase(raw: string): { weekdays: number[]; time: string } | null {
  const tokens = raw
    .toLowerCase()
    .replace(/,/gu, ' ')
    .replace(/^every\s+/u, '')
    .split(/\s+/u)
    .filter(Boolean)

  if (tokens.length < 2) {
    return null
  }

  let weekdays: number[]
  let index = 0

  if (tokens[0]! in DAY_KEYWORDS) {
    weekdays = DAY_KEYWORDS[tokens[0]!]!
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

/** `9am` / `9:30am` / `14:00` / `noon`, as 24-hour parts: `_parse_clock_time`. */
function parseClockPhrase(text: string): { hour: number; minute: number } | null {
  const value = text.trim().toLowerCase().replace(/\s+/gu, '')

  if (value === 'noon' || value === 'midday') {
    return { hour: 12, minute: 0 }
  }

  if (value === 'midnight') {
    return { hour: 0, minute: 0 }
  }

  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/u.exec(value)

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

// ── the schedule in words ────────────────────────────────────────────────────

/** The unit a duration is written in, and what it counts. */
function durationOf(text: string): { count: number; unit: IntervalUnit } | null {
  const match = /^(\d*)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/iu.exec(text.trim())

  if (!match) {
    return null
  }

  const letter = match[2]!.toLowerCase()[0]

  return {
    count: match[1] ? Number(match[1]) : 1,
    unit: letter === 'h' ? 'hours' : letter === 'd' ? 'days' : 'minutes'
  }
}

/** A clock time in the reader's own convention: 09:00 or 9:00 AM. */
function clockText(hour: number, minute: number): string {
  return formatTime(new Date(2026, 0, 4, hour, minute), { hour: 'numeric', minute: '2-digit' })
}

/** `Monday and Friday`, `maandag en vrijdag`: the weekdays as a list in the active language, as `Intl` spells them. */
function dayList(days: readonly number[]): string {
  // 4 January 2026 is a Sunday: weekday 0 in the gateway's numbering.
  const names = days.map(day => formatDate(new Date(2026, 0, 4 + day), { weekday: 'long' }))

  try {
    return new Intl.ListFormat(activeLocale(), { style: 'long', type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

const sortedDays = (days: readonly number[]): number[] =>
  [...new Set(days.map(day => (day === 7 ? 0 : day)))].sort((a, b) => a - b)

/** One cron field as a list of numbers, or null where it is anything but plain numbers, ranges and lists. */
function fieldNumbers(field: string, min: number, max: number): number[] | null {
  const out: number[] = []

  for (const part of field.split(',')) {
    const range = /^(\d+)(?:-(\d+))?$/u.exec(part)

    if (!range) {
      return null
    }

    const from = Number(range[1])
    const to = range[2] === undefined ? from : Number(range[2])

    if (from < min || to > max || from > to) {
      return null
    }

    for (let value = from; value <= to; value += 1) {
      out.push(value)
    }
  }

  return out
}

function describeCron(expression: string): string | null {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.trim().split(/\s+/u)

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek || expression.trim().split(/\s+/u).length !== 5) {
    return null
  }

  const every = /^\*\/(\d+)$/u.exec(minute)

  if (every && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return cronWebStrings.schedule.everyMinutes({ count: Number(every[1]) })
  }

  if (/^\d+$/u.test(minute) && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return Number(minute) === 0 ? cronWebStrings.schedule.everyHours({ count: 1 }) : null
  }

  const hours = /^\d+$/u.test(hour) ? Number(hour) : -1
  const minutes = /^\d+$/u.test(minute) ? Number(minute) : -1

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || month !== '*') {
    return null
  }

  const time = clockText(hours, minutes)

  if (dayOfMonth === '*') {
    if (dayOfWeek === '*') {
      return cronWebStrings.schedule.everyDayAt({ time })
    }

    const days = fieldNumbers(dayOfWeek, 0, 7)

    if (!days) {
      return null
    }

    const set = sortedDays(days)

    if (set.length === 7) {
      return cronWebStrings.schedule.everyDayAt({ time })
    }

    if (set.length === 5 && set.every(day => day >= 1 && day <= 5)) {
      return cronWebStrings.schedule.weekdaysAt({ time })
    }

    if (set.length === 2 && set[0] === 0 && set[1] === 6) {
      return cronWebStrings.schedule.weekendsAt({ time })
    }

    return cronWebStrings.schedule.daysAt({ days: dayList(set), time })
  }

  if (dayOfWeek === '*' && /^\d+$/u.test(dayOfMonth) && Number(dayOfMonth) >= 1 && Number(dayOfMonth) <= 31) {
    return cronWebStrings.schedule.monthlyAt({ day: dayOfMonth, time })
  }

  return null
}

/**
 * The schedule as a sentence, from the string the gateway shows (`schedule_display`): `every 2h`, `weekdays at
 * 9am`, `0 9 * * 1-5`, `once in 2h`, `once at 2026-09-20 09:00`.
 *
 * Only the forms the parser documents are put into words, and anything else is shown exactly as stored: a
 * cron expression nobody can read is still better than a friendly sentence that describes a different schedule.
 */
export function describeSchedule(schedule: string | null | undefined): string {
  const raw = (schedule ?? '').trim()

  if (!raw) {
    return strings.cron.detail.unknown
  }

  const interval = INTERVAL_RE.exec(raw)

  if (interval) {
    const duration = durationOf(`${interval[1] ?? ''}${interval[2] ?? ''}`)

    if (duration) {
      return duration.unit === 'minutes'
        ? cronWebStrings.schedule.everyMinutes({ count: duration.count })
        : duration.unit === 'hours'
          ? cronWebStrings.schedule.everyHours({ count: duration.count })
          : cronWebStrings.schedule.everyDays({ count: duration.count })
    }
  }

  const once = /^(?:once\s+)?in\s+(.+)$/iu.exec(raw)

  if (once) {
    const duration = durationOf(once[1]!)

    if (duration) {
      return duration.unit === 'minutes'
        ? cronWebStrings.schedule.onceInMinutes({ count: duration.count })
        : duration.unit === 'hours'
          ? cronWebStrings.schedule.onceInHours({ count: duration.count })
          : cronWebStrings.schedule.onceInDays({ count: duration.count })
    }

    return raw
  }

  const stamp = /^once\s+at\s+(.+)$/iu.exec(raw)?.[1] ?? raw

  if (ISO_DATE_RE.test(stamp)) {
    return cronWebStrings.schedule.onceAt({ when: stamp.replace('T', ' ') })
  }

  const phrase = parseDayTimePhrase(raw)

  if (phrase) {
    const clock = parseClock(phrase.time)

    if (clock) {
      const time = clockText(clock.hour, clock.minute)
      const days = daySpecFor(phrase.weekdays)

      if (days.every) {
        return phrase.weekdays.length === 0 || phrase.weekdays.length === 7
          ? cronWebStrings.schedule.everyDayAt({ time })
          : cronWebStrings.schedule.daysAt({ days: dayList(sortedDays(phrase.weekdays)), time })
      }

      return days.phrase === 'weekdays'
        ? cronWebStrings.schedule.weekdaysAt({ time })
        : cronWebStrings.schedule.weekendsAt({ time })
    }
  }

  return describeCron(raw) ?? raw
}
