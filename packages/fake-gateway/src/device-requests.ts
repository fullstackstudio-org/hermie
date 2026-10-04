import { createHash } from 'node:crypto'

import { cleanText } from './passkey/confirm'
import { defaultIgnorable, INVISIBLE_LETTERS, MAX_COMBINING_MARKS, verbatimProblem } from './verbatim'

/**
 * What the gateway does with the answers of `input.signature` and the device requests (`device.location`,
 * `device.contact`, `device.calendar`, `device.scan`), as `contract/requests/README.md` sections 8 to 12 give it: a
 * port of the fork's `tui_gateway/interactive_device.py`, the pure functions both the answer check and the hand-off to
 * the agent use, so the two can never disagree about what an answer means.
 *
 * - `roundLocation`: what the agent receives of a location. `approximate` is rounded to two decimals and given an
 *   accuracy of at least 1,000 m, WHATEVER the client sent; `precise` keeps six decimals.
 * - `presentContact`: the contact reduced to the keys the request asked for, every string cleaned.
 * - `cleanScanValue`: a decoded code is untrusted text; control, format, private-use and invisible characters go.
 * - `statementSha256`: the SHA-256 of the UTF-8 bytes of a signature request's `statement` exactly as it went out.
 * - `buildCalendarItem`: the agent's calendar item as the contract's `CalendarItem`: strings the person will see are
 *   cleaned, anything over a bound is refused (never truncated), the rest is the contract's own model.
 * - `pngOrSvgProblem` (`signature-svg.ts`): a signature's two files are what they say.
 *
 * Nothing here does I/O or keeps state.
 */

export { pngOrSvgProblem } from './signature-svg'

type Obj = Record<string, unknown>

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

const codePoints = (value: string): number => [...value].length

/** The decimals a `precise` location keeps: 1e-6 degree is about 11 cm. */
export const PRECISE_DECIMALS = 6
export const LOCATION_APPROXIMATE_DECIMALS = 2
export const LOCATION_APPROXIMATE_MIN_ACCURACY_M = 1000

/** The contact keys, in the order the agent receives them. */
export const CONTACT_KEYS = ['name', 'phones', 'emails', 'postal', 'birthday', 'organization'] as const

const CONTACT_LIST_MAX: Record<string, number> = { phones: 5, emails: 5, postal: 3 }

export const CALENDAR_TITLE_MAX = 120
export const CALENDAR_NOTES_MAX = 2000
export const CALENDAR_LOCATION_MAX = 200
const CALENDAR_ITEM_KEYS = ['title', 'notes', 'start', 'end', 'all_day', 'location', 'url', 'alarm_minutes'] as const

// ── location ─────────────────────────────────────────────────────────────────

/** The less precise of the two: a client that shares more than was asked is treated as having shared what was asked. */
export const effectivePrecision = (requested: string, answered: string): 'approximate' | 'precise' =>
  requested === 'approximate' || answered === 'approximate' ? 'approximate' : 'precise'

/**
 * `round(value, decimals)` as Python does it: the nearest double-exact decimal, ties to even (`0.125` to two places
 * is `0.12`), never a negative zero. `toFixed` rounds an exact tie up, so the tie is found on the exact expansion.
 */
export function roundHalfEven(value: number, decimals: number): number {
  const negative = value < 0
  const [whole, fraction = ''] = Math.abs(value)
    .toFixed(Math.min(100, decimals + 30))
    .split('.') as [string, string?]
  const kept = BigInt(whole + fraction.slice(0, decimals))
  const rest = fraction.slice(decimals)
  const half = rest[0] === '5' && /^0*$/.test(rest.slice(1))
  const up = rest[0] !== undefined && (rest[0] > '5' || (rest[0] === '5' && !half) || (half && kept % 2n === 1n))
  const scaled = (up ? kept + 1n : kept).toString().padStart(decimals + 1, '0')
  const text = decimals ? `${scaled.slice(0, -decimals)}.${scaled.slice(-decimals)}` : scaled
  const rounded = Number(text)

  return rounded === 0 ? 0 : negative ? -rounded : rounded
}

/** `{lat, lon, accuracy_m, at, precision}` as the agent receives them, from a validated answer. */
export function roundLocation(answer: Obj, requested: string): Obj {
  const precision = effectivePrecision(requested, String(answer.precision))
  const decimals = precision === 'approximate' ? LOCATION_APPROXIMATE_DECIMALS : PRECISE_DECIMALS
  const accuracy =
    precision === 'approximate'
      ? Math.max(Number(answer.accuracy_m), LOCATION_APPROXIMATE_MIN_ACCURACY_M)
      : Number(answer.accuracy_m)

  return {
    lat: roundHalfEven(Number(answer.lat), decimals),
    lon: roundHalfEven(Number(answer.lon), decimals),
    accuracy_m: roundHalfEven(accuracy, 1),
    at: Math.trunc(Number(answer.at)),
    precision
  }
}

/** `precision:too_precise` when the client shares `precise` for an `approximate` request. */
export const precisionProblem = (requested: string, answered: string): string | null =>
  requested === 'approximate' && answered === 'precise' ? 'precision:too_precise' : null

// ── contact ──────────────────────────────────────────────────────────────────

/** The first contact key (in `CONTACT_KEYS` order) the answer carries that the request did not ask for, whatever its value. */
export function unrequestedKey(contact: Obj, requested: unknown[]): string | null {
  const asked = new Set(requested.map(String))

  return CONTACT_KEYS.find(key => key in contact && !asked.has(key)) ?? null
}

/**
 * The requested keys of `contact`, cleaned, in `CONTACT_KEYS` order, with nothing empty left in: a string is one
 * cleaned line (a postal address keeps its line breaks), a list holds at most as many entries as the contract allows,
 * a birthday is as sent.
 */
export function presentContact(contact: Obj, requested: unknown[]): Obj {
  const asked = new Set(requested.map(String))
  const out: Obj = {}

  for (const key of CONTACT_KEYS) {
    const value = contact[key]

    if (
      !asked.has(key) ||
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && !value.length)
    ) {
      continue
    }

    if (key in CONTACT_LIST_MAX) {
      const items = (value as unknown[])
        .slice(0, CONTACT_LIST_MAX[key])
        .map(item => cleanText(item, key === 'postal'))
        .filter(Boolean)

      if (items.length) {
        out[key] = items
      }
    } else if (key === 'birthday') {
      out[key] = String(value)
    } else {
      const text = cleanText(value, false)

      if (text) {
        out[key] = text
      }
    }
  }

  return out
}

/** `contact:birthday:invalid` for a day that does not exist (the pattern only checks the digits); February 29 counts. */
export function birthdayProblem(value: string): string | null {
  const parts = value.split('-')
  const [year, month, day] = value.startsWith('--')
    ? [2000, Number(parts[2]), Number(parts[3])]
    : [Number(parts[0]), Number(parts[1]), Number(parts[2])]
  const date = new Date(Date.UTC(2000, month - 1, day))

  date.setUTCFullYear(year)

  const exists =
    Number.isInteger(year) &&
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day

  return exists ? null : 'contact:birthday:invalid'
}

// ── scan ─────────────────────────────────────────────────────────────────────

const COMBINING = /^[\p{Mn}\p{Me}]$/u
const LINE_SEPARATOR = /^[\p{Zl}\p{Zp}]$/u
const SPACE_SEPARATOR = /^\p{Zs}$/u
const NOT_SHOWN = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]$/u

/**
 * The decoded text of a code with what a person cannot see, or what could hide something, taken out: control characters
 * other than a line break (a tab becomes a space), format characters (bidi overrides and isolates, zero-width),
 * surrogates, private-use, default-ignorable and invisible code points, and combining marks past four on one
 * character. Line and paragraph separators become newlines and every other kind of space a plain space. Nothing is
 * trimmed or collapsed: `WIFI:T:WPA;S:my  net;;` stays as it is.
 */
export function cleanScanValue(value: unknown): string {
  const raw = (value === undefined || value === null || value === '' ? '' : String(value))
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
  const out: string[] = []
  let marks = 0

  for (const ch of raw) {
    const combining = COMBINING.test(ch)

    if (INVISIBLE_LETTERS.has(ch) || defaultIgnorable(ch)) {
      marks = combining ? marks : 0

      continue
    }

    if (combining) {
      marks += 1

      if (marks <= MAX_COMBINING_MARKS) {
        out.push(ch)
      }

      continue
    }

    marks = 0

    if (ch === '\n' || LINE_SEPARATOR.test(ch)) {
      out.push('\n')
    } else if (ch === '\t' || SPACE_SEPARATOR.test(ch)) {
      out.push(' ')
    } else if (!NOT_SHOWN.test(ch)) {
      out.push(ch)
    }
  }

  return out.join('')
}

// ── signature ────────────────────────────────────────────────────────────────

/** Lowercase hex SHA-256 of the UTF-8 bytes of `statement`, exactly as it is (no normalisation, no trimming). */
export const statementSha256 = (statement: string): string =>
  createHash('sha256').update(Buffer.from(statement, 'utf8')).digest('hex')

// ── calendar ─────────────────────────────────────────────────────────────────

/** A problem the agent must fix in a calendar item; the message says what. */
export class CalendarItemRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CalendarItemRefused'
  }
}

/**
 * The consistency rules of the contract's `CalendarItem` model, which the schema cannot say: a date or an instant to
 * match `all_day`, days that exist, `end` not before `start` and only with it, an alarm needs a start, a URL that can
 * be shown as it is. `null` or the message.
 */
export function calendarItemProblem(
  item: Obj,
  helpers: { isCalendarDate: (text: string) => boolean; instantMs: (text: string) => number | null }
): string | null {
  const url = item.url

  if (typeof url === 'string') {
    const problem = verbatimProblem(url)

    if (problem) {
      return `url cannot be shown as it is (${problem})`
    }
  }

  const allDay = item.all_day === true

  for (const name of ['start', 'end'] as const) {
    const value = item[name]

    if (typeof value === 'string' && !value.includes('T') !== allDay) {
      return `${name} is ${allDay ? 'an instant' : 'a date'}; ${allDay ? 'an all-day item takes dates' : 'a timed item takes instants'}`
    }
  }

  // The calendar itself: a day that does not exist (2026-02-30) is not one.
  const when = (value: unknown): string | number | null | undefined => {
    if (typeof value !== 'string') {
      return undefined
    }

    if (value.includes('T')) {
      return helpers.instantMs(value)
    }

    return helpers.isCalendarDate(value) ? value : null
  }
  const start = when(item.start)
  const end = when(item.end)

  if (start === null || end === null) {
    return `${start === null ? 'start' : 'end'} is not a day that exists`
  }

  if (end !== undefined && start === undefined) {
    return 'end needs start'
  }

  if (start !== undefined && end !== undefined && end < start) {
    return 'end is before start'
  }

  if (item.alarm_minutes !== undefined && item.alarm_minutes !== null && start === undefined) {
    return 'alarm_minutes needs start'
  }

  return null
}

/**
 * The `item` of a `device.calendar` request from what the agent passed. Text the person sees (title, notes, location)
 * is cleaned and refused when over its bound, not truncated; `start`, `end`, `url` and `alarm_minutes` are machine
 * values and are refused, never rewritten, when they are not what the contract takes. Throws `CalendarItemRefused`
 * with what to fix, never the agent's own value.
 */
export function buildCalendarItem(
  raw: unknown,
  contract: {
    matches: (schema: unknown, value: unknown) => boolean
    properties: Record<string, unknown>
    helpers: Parameters<typeof calendarItemProblem>[1]
  }
): Obj {
  const keys = CALENDAR_ITEM_KEYS.join(', ')

  if (!isObject(raw)) {
    throw new CalendarItemRefused(`item must be an object with at least a title (keys: ${keys})`)
  }

  const unknown = Object.keys(raw).filter(key => !(CALENDAR_ITEM_KEYS as readonly string[]).includes(key))

  if (unknown.length) {
    const listed = unknown
      .slice(0, 5)
      .map(key => `'${key.slice(0, 40)}'`)
      .join(', ')

    throw new CalendarItemRefused(`item has keys that are not part of a calendar item: ${listed}. Allowed: ${keys}.`)
  }

  const text = (key: string, limit: number, multiline: boolean, required = false): string => {
    const value = raw[key]

    if (value === undefined || value === null) {
      if (required) {
        throw new CalendarItemRefused(`item.${key} is required`)
      }

      return ''
    }

    if (typeof value !== 'string') {
      throw new CalendarItemRefused(`item.${key} must be a string`)
    }

    const cleaned = cleanText(value, multiline)

    if (required && !cleaned) {
      throw new CalendarItemRefused(`item.${key} is required`)
    }

    if (codePoints(cleaned) > limit) {
      throw new CalendarItemRefused(`item.${key} is ${codePoints(cleaned)} characters; the limit is ${limit}.`)
    }

    return cleaned
  }

  const out: Obj = { title: text('title', CALENDAR_TITLE_MAX, false, true) }
  const notes = text('notes', CALENDAR_NOTES_MAX, true)
  const location = text('location', CALENDAR_LOCATION_MAX, false)

  if (notes) {
    out.notes = notes
  }

  if (location) {
    out.location = location
  }

  for (const key of ['start', 'end', 'url'] as const) {
    if (raw[key] !== undefined && raw[key] !== null) {
      if (typeof raw[key] !== 'string') {
        throw new CalendarItemRefused(`item.${key} must be a string`)
      }

      out[key] = raw[key]
    }
  }

  if (raw.all_day !== undefined && raw.all_day !== null) {
    if (typeof raw.all_day !== 'boolean') {
      throw new CalendarItemRefused('item.all_day must be true or false')
    }

    if (raw.all_day) {
      out.all_day = true
    }
  }

  if (raw.alarm_minutes !== undefined && raw.alarm_minutes !== null) {
    if (typeof raw.alarm_minutes !== 'number' || !Number.isInteger(raw.alarm_minutes)) {
      throw new CalendarItemRefused('item.alarm_minutes must be a whole number of minutes')
    }

    out.alarm_minutes = raw.alarm_minutes
  }

  // The contract's model: the shape first (the field, never its value), then the rules it cannot say.
  const bad = Object.keys(out).find(key => !contract.matches(contract.properties[key], out[key]))

  if (bad) {
    throw new CalendarItemRefused(`item: ${bad}: does not match the form the contract takes`)
  }

  const problem = calendarItemProblem(out, contract.helpers)

  if (problem) {
    throw new CalendarItemRefused(`item: ${problem}`)
  }

  return out
}
