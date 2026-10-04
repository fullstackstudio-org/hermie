/**
 * The gateway's refusals of a schedule, as `cron/jobs.py::parse_schedule` words them.
 *
 * The fake answers every well-formed job; this is what makes it refuse a schedule it should refuse, in the
 * gateway's own sentence, so a client's "the gateway said no" path can be driven end to end. It judges the SHAPE the
 * parser accepts, not the arithmetic of a cron expression (`croniter` does that, and a fake has no use for a second
 * implementation of it): a five-field expression made of cron characters is taken.
 *
 * Over the socket the refusal is `{success: false, error}` (the `cronjob` tool's own failure answer); over REST it is
 * a 400 with FastAPI's `{detail}`.
 */

const DURATION = /^(\d*)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/u

const WEEKDAYS = new Set([
  'sunday',
  'sun',
  'monday',
  'mon',
  'tuesday',
  'tue',
  'tues',
  'wednesday',
  'wed',
  'weds',
  'thursday',
  'thu',
  'thur',
  'thurs',
  'friday',
  'fri',
  'saturday',
  'sat'
])

const DAY_KEYWORDS = new Set(['day', 'daily', 'everyday', 'weekday', 'weekdays', 'weekend', 'weekends'])

/** `_parse_clock_time`: `9am`, `9:30am`, `14:00`, `7`, `noon`, `midnight`. */
function clockTime(text: string): boolean {
  const value = text.trim().toLowerCase().replace(/ /gu, '')

  if (value === 'noon' || value === 'midday' || value === 'midnight') {
    return true
  }

  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/u.exec(value)

  if (!match) {
    return false
  }

  const hour = Number(match[1])
  const minute = Number(match[2] ?? 0)

  return match[3] ? hour >= 1 && hour <= 12 && minute <= 59 : hour <= 23 && minute <= 59
}

/** `_natural_every_to_cron`: `<when> [at] <time>`. */
function dayAndTime(rest: string): boolean {
  const tokens = rest.toLowerCase().replace(/,/gu, ' ').split(/\s+/u).filter(Boolean)

  if (tokens.length === 0) {
    return false
  }

  let index = 1

  if (!DAY_KEYWORDS.has(tokens[0]!)) {
    index = tokens.length
    let days = 0

    for (const [position, token] of tokens.entries()) {
      if (token === 'and') {
        continue
      }

      if (!WEEKDAYS.has(token)) {
        index = position
        break
      }

      days += 1
    }

    if (days === 0) {
      return false
    }
  }

  const time = tokens.slice(index)

  if (time[0] === 'at') {
    time.shift()
  }

  return time.length > 0 && clockTime(time.join(' '))
}

const duration = (text: string): boolean => DURATION.test(text.trim().toLowerCase())

const refusal = (original: string): string =>
  `Invalid schedule '${original}'. Use:\n` +
  `  - Interval: '30m', 'every 30m', 'every 2h' (recurring)\n` +
  `  - One-shot delay: 'in 30m', 'in 2h' (fires once)\n` +
  `  - Weekly/daily: 'every monday 9am', 'weekdays at 9am' (recurring)\n` +
  `  - Cron: '0 9 * * *' (cron expression)\n` +
  `  - Timestamp: '2026-02-03T14:00:00' (one-shot at time)`

/** Why the gateway would refuse this schedule, in its own words, or null when it would take it. */
export function scheduleRefusal(schedule: string): string | null {
  const original = schedule.trim()
  const lower = original.toLowerCase()
  const every = lower.startsWith('every ')
  const rest = every ? original.slice(6).trim() : lower

  if (dayAndTime(rest)) {
    return null
  }

  if (every) {
    return duration(rest)
      ? null
      : `Invalid duration: '${rest.toLowerCase()}'. Use format like '30m', '2h', '1d', or a bare unit like 'hour' (defaults to 1).`
  }

  const parts = original.split(/\s+/u)

  if (parts.length >= 5 && parts.slice(0, 5).every(part => /^[A-Za-z\d*\-,/]+$/u.test(part))) {
    return null
  }

  if (original.includes('T') || /^\d{4}-\d{2}-\d{2}/u.test(original)) {
    return Number.isNaN(Date.parse(original.replace('Z', '+00:00')))
      ? `Invalid timestamp '${original}': Invalid isoformat string: '${original}'`
      : null
  }

  if (lower.startsWith('in ')) {
    const text = original.slice(3).trim()

    return duration(text) ? null : `Invalid duration '${text}' after 'in '. Use e.g. 'in 30m', 'in 2h'.`
  }

  return duration(original) ? null : refusal(original)
}
