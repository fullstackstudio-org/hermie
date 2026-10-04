/**
 * What a form sheet holds while a person fills it in, and what that comes to as an answer (`contract/requests/`
 * README §4): the raw value each input has, the value (or the problem) it stands for, and the datetime zone
 * arithmetic the answer needs.
 *
 * **Mirrors the gateway.** `evaluate` checks one field the way the gateway does and names the first problem in the
 * gateway's order (`missing`, `type`, `format`, `too_long`, `zone`, `offset`, `order`, `not_an_option`, `duplicate`,
 * `below_min`/`above_max`, `not_integer`, `step`, `too_few`/`too_many`), so the sheet shows next to a field the
 * problem the gateway would have refused it for, before anything is sent; the gateway still decides, and a refusal
 * (`field:<id>:<problem>`) is shown the same way (`parseFieldRefusal`). The reasons are the contract's words.
 *
 * **Inputs are text.** A native input hands over a string (`<input type=number>` too), so every raw value is a
 * string, a boolean or a list of strings; the value a field stands for (a JSON number, a decimal STRING for an
 * amount, an instant with its offset and zone) is made here and nowhere else.
 *
 * **Datetimes** are a wall-clock value in a zone (the field's `tz`, else the device's), and the answer carries that
 * zone's offset at that instant, and the zone in brackets (RFC 9557): `2026-10-03T14:30+02:00[Europe/Amsterdam]`. A
 * wall-clock time that does not exist in the zone (a clock that jumps forward over it) is the `offset` problem; one
 * that happens twice takes the first.
 *
 * Nothing here is kept: these are pure functions of what the sheet passes in.
 */
import {
  type FormField,
  type FormValue,
  instantSeconds,
  isCalendarDate,
  isZone,
  milli,
  minorUnits,
  onStep
} from './interactive-types'

/** A problem the gateway names for a field (README §4), in the order it checks them. */
export type Problem =
  | 'missing'
  | 'type'
  | 'format'
  | 'too_long'
  | 'zone'
  | 'offset'
  | 'order'
  | 'not_an_option'
  | 'duplicate'
  | 'below_min'
  | 'above_max'
  | 'not_integer'
  | 'step'
  | 'too_few'
  | 'too_many'

const PROBLEMS: ReadonlySet<string> = new Set<Problem>([
  'missing',
  'type',
  'format',
  'too_long',
  'zone',
  'offset',
  'order',
  'not_an_option',
  'duplicate',
  'below_min',
  'above_max',
  'not_integer',
  'step',
  'too_few',
  'too_many'
])

/** What an input holds: text, a switch, the options ticked, or the two ends of a range. */
export type RawValue = string | boolean | readonly string[] | { start: string; end: string }

export type Evaluated = { none: true } | { value: FormValue } | { problem: Problem }

const FIELD_REFUSAL = /^field:([a-z][a-z0-9_]{0,31}):([a-z_]+)$/u

/** `field:<id>:<problem>` as the field it names and the problem; `null` for any other reason. */
export function parseFieldRefusal(reason: string | null): { id: string; problem: Problem | 'unknown' } | null {
  const match = reason === null ? null : FIELD_REFUSAL.exec(reason)

  if (!match) {
    return null
  }

  const problem = match[2] ?? ''

  return { id: match[1] ?? '', problem: PROBLEMS.has(problem) ? (problem as Problem) : 'unknown' }
}

// ── zones ────────────────────────────────────────────────────────────────────────────────────────

/** The device's IANA zone, `UTC` when the runtime cannot say. */
export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

interface Wall {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone)

  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
    formatters.set(zone, found)
  }

  return found
}

/** A wall-clock reading as milliseconds, as if it were UTC (`Date.UTC` would take a year below 100 for 19xx). */
function asUtc(wall: Wall): number {
  const date = new Date(0)

  date.setUTCFullYear(wall.year, wall.month - 1, wall.day)
  date.setUTCHours(wall.hour, wall.minute, wall.second, 0)

  return date.getTime()
}

/** The wall clock of `zone` at `ms` (an instant). */
function wallOf(zone: string, ms: number): Wall {
  const out: Wall = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }

  for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
    const value = Number(part.value)

    if (part.type === 'year') out.year = value
    else if (part.type === 'month') out.month = value
    else if (part.type === 'day') out.day = value
    else if (part.type === 'hour') out.hour = value === 24 ? 0 : value
    else if (part.type === 'minute') out.minute = value
    else if (part.type === 'second') out.second = value
  }

  return out
}

/** The zone's offset from UTC at an instant, in milliseconds (positive east). */
function offsetMsAt(zone: string, ms: number): number {
  const whole = Math.floor(ms / 1000) * 1000

  return asUtc(wallOf(zone, whole)) - whole
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

/** `+02:00`; `null` for an offset that is not a whole number of minutes (no `±HH:MM` says it). */
function offsetText(offsetMs: number): string | null {
  const minutes = offsetMs / 60_000

  if (!Number.isInteger(minutes)) {
    return null
  }

  const abs = Math.abs(minutes)

  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** `UTC+02:00`, the zone's offset now (or at `at`), for a line that says which zone a time is in. */
export function zoneOffsetLabel(zone: string, at = Date.now()): string {
  try {
    const text = offsetText(offsetMsAt(zone, at))

    return text === null ? 'UTC' : text === '+00:00' ? 'UTC' : `UTC${text}`
  } catch {
    return 'UTC'
  }
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/u

/** `YYYY-MM-DDTHH:MM[:SS]` as a wall clock, or `null` when it is not a real date and time. */
function parseWall(text: string): Wall | null {
  const match = WALL.exec(text)

  if (!match || !isCalendarDate(`${match[1]}-${match[2]}-${match[3]}`)) {
    return null
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0)
  }
}

const DAY_MS = 86_400_000

/**
 * The instant a wall-clock reading is in `zone`, in milliseconds: the first one when the reading happens twice (a
 * clock turned back), `null` when it never happens (a clock jumped over it).
 */
function instantOfWall(zone: string, wall: Wall): number | null {
  const reading = asUtc(wall)
  const candidates = new Set([
    reading - offsetMsAt(zone, reading - DAY_MS),
    reading - offsetMsAt(zone, reading + DAY_MS)
  ])
  const hits = [...candidates].filter(instant => asUtc(wallOf(zone, instant)) === reading).sort((a, b) => a - b)

  return hits[0] ?? null
}

/** `YYYY-MM-DDTHH:MM`, with `:SS` only when the seconds are not zero. */
function wallText(wall: Wall): string {
  const base = `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`

  return wall.second === 0 ? base : `${base}:${pad(wall.second)}`
}

/**
 * An instant of the contract (`YYYY-MM-DDTHH:MM[:SS]±HH:MM`) as the wall-clock reading a `datetime-local` input
 * takes, in `zone`; `''` for text that is not an instant, or a zone this runtime does not know.
 */
export function instantToInput(instant: string | undefined, zone: string): string {
  const seconds = instantSeconds(instant)

  if (seconds === null || !isZone(zone)) {
    return ''
  }

  return wallText(wallOf(zone, seconds * 1000))
}

// ── raw values ───────────────────────────────────────────────────────────────────────────────────

/** The zone a datetime field's answer is in: the field's `tz`, else the device's. */
export const zoneOf = (field: FormField, device: string): string => ('tz' in field && field.tz ? field.tz : device)

/** What a field's input holds before the person touches it: the request's default, or nothing. */
export function initialRaw(field: FormField, device: string): RawValue {
  switch (field.kind) {
    case 'text':
    case 'amount':
    case 'date':
    case 'time':
      return field.default ?? ''
    case 'number':
      return field.default === undefined ? '' : String(field.default)
    case 'datetime':
      return instantToInput(field.default, zoneOf(field, device))
    case 'daterange':
      return field.default ? { start: field.default.start, end: field.default.end } : { start: '', end: '' }
    case 'choice':
      return field.multiple
        ? Array.isArray(field.default)
          ? [...field.default]
          : typeof field.default === 'string'
            ? [field.default]
            : []
        : typeof field.default === 'string'
          ? field.default
          : ''
    case 'toggle':
      return field.default ?? false
    case 'unknown':
      return ''
  }
}

// ── evaluating ───────────────────────────────────────────────────────────────────────────────────

const NONE: Evaluated = { none: true }
const problem = (name: Problem): Evaluated => ({ problem: name })

/** A line break of any kind: a one-line text holds none (the contract's list). */
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/u
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u
const DECIMAL = /^-?(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,3})?$/u
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u

const lengthOf = (value: string): number => Array.from(value).length

/** An amount as typed, with a comma for the decimal separator taken as a point (`12,50`), nothing else changed. */
export function amountText(raw: string): string {
  const text = raw.trim()

  return text.includes(',') && !text.includes('.') && text.split(',').length === 2 ? text.replace(',', '.') : text
}

function evaluateText(field: Extract<FormField, { kind: 'text' }>, raw: string): Evaluated {
  if (raw === '') {
    return field.required ? problem('missing') : NONE
  }

  if (!field.multiline && LINE_BREAK.test(raw)) {
    return problem('format')
  }

  if (lengthOf(raw) > field.maxLength) {
    return problem('too_long')
  }

  return { value: raw }
}

function evaluateNumber(field: Extract<FormField, { kind: 'number' }>, raw: string): Evaluated {
  const text = raw.trim()

  if (text === '') {
    return field.required ? problem('missing') : NONE
  }

  const value = Number(text)

  if (!NUMBER.test(text) || !Number.isFinite(value)) {
    return problem('format')
  }

  if (field.min !== undefined && value < field.min) {
    return problem('below_min')
  }

  if (field.max !== undefined && value > field.max) {
    return problem('above_max')
  }

  if (field.integer && !Number.isInteger(value)) {
    return problem('not_integer')
  }

  if (!onStep(text, field.min, field.step)) {
    return problem('step')
  }

  return { value }
}

function evaluateAmount(field: Extract<FormField, { kind: 'amount' }>, raw: string): Evaluated {
  const text = amountText(raw)

  if (text === '') {
    return field.required ? problem('missing') : NONE
  }

  if (!DECIMAL.test(text)) {
    return problem('format')
  }

  const decimals = text.split('.')[1]?.length ?? 0

  if (decimals > minorUnits(field.currency)) {
    return problem('format')
  }

  const amount = milli(text)
  const low = milli(field.min)
  const high = milli(field.max)

  if (amount !== null && low !== null && amount < low) {
    return problem('below_min')
  }

  if (amount !== null && high !== null && amount > high) {
    return problem('above_max')
  }

  return { value: text }
}

function evaluateDate(field: Extract<FormField, { kind: 'date' }>, raw: string): Evaluated {
  if (raw === '') {
    return field.required ? problem('missing') : NONE
  }

  if (!isCalendarDate(raw)) {
    return problem('format')
  }

  if (field.min !== undefined && raw < field.min) {
    return problem('below_min')
  }

  if (field.max !== undefined && raw > field.max) {
    return problem('above_max')
  }

  return { value: raw }
}

function evaluateTime(field: Extract<FormField, { kind: 'time' }>, raw: string): Evaluated {
  if (raw === '') {
    return field.required ? problem('missing') : NONE
  }

  if (!TIME.test(raw)) {
    return problem('format')
  }

  if (field.min !== undefined && raw < field.min) {
    return problem('below_min')
  }

  if (field.max !== undefined && raw > field.max) {
    return problem('above_max')
  }

  return { value: raw }
}

function evaluateDatetime(field: Extract<FormField, { kind: 'datetime' }>, raw: string, device: string): Evaluated {
  if (raw === '') {
    return field.required ? problem('missing') : NONE
  }

  const wall = parseWall(raw)

  if (!wall) {
    return problem('format')
  }

  const zone = zoneOf(field, device)

  if (!isZone(zone)) {
    return problem('zone')
  }

  const instant = instantOfWall(zone, wall)
  const offset = instant === null ? null : offsetText(offsetMsAt(zone, instant))

  if (instant === null || offset === null) {
    return problem('offset')
  }

  const seconds = instant / 1000
  const low = instantSeconds(field.min)
  const high = instantSeconds(field.max)

  if (low !== null && seconds < low) {
    return problem('below_min')
  }

  if (high !== null && seconds > high) {
    return problem('above_max')
  }

  return { value: `${wallText(wall)}${offset}[${zone}]` }
}

function evaluateRange(
  field: Extract<FormField, { kind: 'daterange' }>,
  raw: { start: string; end: string }
): Evaluated {
  if (raw.start === '' && raw.end === '') {
    return field.required ? problem('missing') : NONE
  }

  if (!isCalendarDate(raw.start) || !isCalendarDate(raw.end)) {
    return problem('format')
  }

  if (raw.end < raw.start) {
    return problem('order')
  }

  if (field.min !== undefined && raw.start < field.min) {
    return problem('below_min')
  }

  if (field.max !== undefined && raw.start > field.max) {
    return problem('above_max')
  }

  if (field.min !== undefined && raw.end < field.min) {
    return problem('below_min')
  }

  if (field.max !== undefined && raw.end > field.max) {
    return problem('above_max')
  }

  return { value: { start: raw.start, end: raw.end } }
}

function evaluateChoice(field: Extract<FormField, { kind: 'choice' }>, raw: string | readonly string[]): Evaluated {
  const known = new Set(field.options.map(option => option.value))

  if (!field.multiple) {
    const one = typeof raw === 'string' ? raw : ''

    if (one === '') {
      return field.required ? problem('missing') : NONE
    }

    return known.has(one) ? { value: one } : problem('not_an_option')
  }

  const list = typeof raw === 'string' ? [] : raw

  if (list.length === 0) {
    return field.required ? problem('missing') : NONE
  }

  if (list.some(value => !known.has(value))) {
    return problem('not_an_option')
  }

  if (new Set(list).size !== list.length) {
    return problem('duplicate')
  }

  if (field.minSelected !== undefined && list.length < field.minSelected) {
    return problem('too_few')
  }

  if (field.maxSelected !== undefined && list.length > field.maxSelected) {
    return problem('too_many')
  }

  // In the options' order, so the answer reads the same however the boxes were ticked.
  return { value: field.options.map(option => option.value).filter(value => list.includes(value)) }
}

/** One field's value, nothing, or the first problem the gateway would name, from what its input holds. */
export function evaluate(field: FormField, raw: RawValue | undefined, device: string): Evaluated {
  switch (field.kind) {
    case 'text':
      return typeof raw === 'string' ? evaluateText(field, raw) : problem('type')
    case 'number':
      return typeof raw === 'string' ? evaluateNumber(field, raw) : problem('type')
    case 'amount':
      return typeof raw === 'string' ? evaluateAmount(field, raw) : problem('type')
    case 'date':
      return typeof raw === 'string' ? evaluateDate(field, raw) : problem('type')
    case 'time':
      return typeof raw === 'string' ? evaluateTime(field, raw) : problem('type')
    case 'datetime':
      return typeof raw === 'string' ? evaluateDatetime(field, raw, device) : problem('type')
    case 'daterange':
      return typeof raw === 'object' && !Array.isArray(raw)
        ? evaluateRange(field, raw as { start: string; end: string })
        : problem('type')
    case 'choice':
      return typeof raw === 'string' || Array.isArray(raw)
        ? evaluateChoice(field, raw as string | readonly string[])
        : problem('type')
    case 'toggle':
      return typeof raw === 'boolean' ? { value: raw } : problem('type')
    case 'unknown':
      return NONE
  }
}

/** The answer's values and every field's problem, from what the inputs hold. A field without a value is left out. */
export function evaluateForm(
  fields: readonly FormField[],
  raws: Readonly<Record<string, RawValue>>,
  device: string
): { values: Record<string, FormValue>; problems: Record<string, Problem> } {
  const values: Record<string, FormValue> = {}
  const problems: Record<string, Problem> = {}

  for (const field of fields) {
    const result = evaluate(field, raws[field.id], device)

    if ('value' in result) {
      values[field.id] = result.value
    } else if ('problem' in result) {
      problems[field.id] = result.problem
    }
  }

  return { values, problems }
}

// ── what a bound says ────────────────────────────────────────────────────────────────────────────

/**
 * A field's `min` or `max` as the sheet words it: numbers as they are, an amount with its currency, a date or a time
 * as the contract writes it, an instant as the wall-clock reading in the field's zone.
 */
export function boundText(field: FormField, which: 'min' | 'max', device: string): string {
  switch (field.kind) {
    case 'number':
      return String(field[which] ?? '')
    case 'amount':
      return field[which] === undefined ? '' : `${field[which]} ${field.currency}`
    case 'date':
    case 'time':
    case 'daterange':
      return field[which] ?? ''
    case 'datetime': {
      const reading = instantToInput(field[which], zoneOf(field, device))

      return reading.replace('T', ' ')
    }
    default:
      return ''
  }
}

/** How many decimals an amount in `currency` takes (ISO 4217's minor unit). */
export const decimalsOf = (currency: string): number => minorUnits(currency)
