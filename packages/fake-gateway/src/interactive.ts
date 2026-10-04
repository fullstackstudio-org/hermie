import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The interactive server requests (`input.form`, `input.file`, `review.draft`), as
 * `contract/requests` defines them.
 *
 * This file is the gateway's checking of an ANSWER: the shape (`schema.json`, through a small checker
 * that knows exactly the keywords that file uses) and then the rules the schema cannot say (`README.md`
 * sections 3 to 6): required fields, ranges, steps, ISO 4217 minor units, datetimes with their zone and
 * offset, choice membership and counts, where files may live and how big they may be, what a draft may
 * contain. It returns the reason the gateway would refuse with, and nothing else; the request's life
 * (who is asked, the refusal cap, the clock) is `interactive-gate.ts`.
 *
 * No dependency: the checker is a page of code, and the contract files are read when first needed (the
 * fake is run from inside the repository, where they are).
 */

export const INTERACTIVE_METHODS = ['input.form', 'input.file', 'review.draft'] as const

export type InteractiveMethod = (typeof INTERACTIVE_METHODS)[number]

export const isInteractiveMethod = (method: unknown): method is InteractiveMethod =>
  typeof method === 'string' && (INTERACTIVE_METHODS as readonly string[]).includes(method)

type Obj = Record<string, unknown>

/** What `contract/requests` is, parsed. */
export interface RequestsContract {
  schema: Obj
  examples: Obj
}

let loaded: RequestsContract | undefined

/**
 * Where `contract/requests` is: `HERMIE_REQUESTS_CONTRACT` when set, else the nearest one above the
 * working directory (the fake runs from inside the repository: `npm run fake-gateway`, the test runners).
 * The search starts at the working directory, not at this file, so it needs no `import.meta`.
 */
function contractDirectory(): string {
  const named = process.env.HERMIE_REQUESTS_CONTRACT

  if (named) {
    return resolve(named)
  }

  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, 'contract', 'requests')

    if (existsSync(join(candidate, 'schema.json'))) {
      return candidate
    }

    if (dirname(dir) === dir) {
      throw new Error('contract/requests not found above the working directory; set HERMIE_REQUESTS_CONTRACT')
    }
  }
}

/** `contract/requests/schema.json` and `examples.json`, read once. */
export function loadContract(): RequestsContract {
  if (!loaded) {
    const dir = contractDirectory()
    const read = (name: string): Obj => JSON.parse(readFileSync(join(dir, name), 'utf8'))

    loaded = { schema: read('schema.json'), examples: read('examples.json') }
  }

  return loaded
}

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

const codePoints = (value: string): number => [...value].length

// ── the schema checker ───────────────────────────────────────────────────────

/**
 * Does `value` satisfy `schema`? Draft 2020-12 as `schema.json` uses it: `$ref` into `$defs`, `oneOf`,
 * `anyOf`, `const`, `enum`, `type`, `pattern`, the length / size / range keywords, `properties`,
 * `required`, `additionalProperties`, `maxProperties` and `items`. A keyword it does not know is ignored
 * (`title`, `description`, `default`, `discriminator`: annotations here).
 */
export function matches(root: Obj, schema: unknown, value: unknown): boolean {
  if (schema === true || schema === undefined) {
    return true
  }

  if (!isObject(schema)) {
    return false
  }

  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace(/^#\/\$defs\//, '')
    const target = (root.$defs as Obj | undefined)?.[name]

    return target !== undefined && matches(root, target, value)
  }

  if ('const' in schema && schema.const !== value) {
    return false
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return false
  }

  if (typeof schema.type === 'string' && !isType(schema.type, value)) {
    return false
  }

  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(option => matches(root, option, value))) {
    return false
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(option => matches(root, option, value)).length !== 1) {
    return false
  }

  if (typeof value === 'string') {
    return matchesString(schema, value)
  }

  if (typeof value === 'number') {
    return matchesNumber(schema, value)
  }

  if (Array.isArray(value)) {
    return matchesArray(root, schema, value)
  }

  return isObject(value) ? matchesObject(root, schema, value) : true
}

function isType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isObject(value)
    default:
      return true
  }
}

function matchesString(schema: Obj, value: string): boolean {
  const length = codePoints(value)

  if (typeof schema.minLength === 'number' && length < schema.minLength) {
    return false
  }

  if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
    return false
  }

  return typeof schema.pattern !== 'string' || new RegExp(schema.pattern, 'u').test(value)
}

function matchesNumber(schema: Obj, value: number): boolean {
  return (
    (typeof schema.minimum !== 'number' || value >= schema.minimum) &&
    (typeof schema.maximum !== 'number' || value <= schema.maximum) &&
    (typeof schema.exclusiveMinimum !== 'number' || value > schema.exclusiveMinimum) &&
    (typeof schema.exclusiveMaximum !== 'number' || value < schema.exclusiveMaximum)
  )
}

function matchesArray(root: Obj, schema: Obj, value: unknown[]): boolean {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    return false
  }

  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    return false
  }

  return schema.items === undefined || value.every(item => matches(root, schema.items, item))
}

function matchesObject(root: Obj, schema: Obj, value: Obj): boolean {
  const properties = isObject(schema.properties) ? schema.properties : {}
  const keys = Object.keys(value)

  if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
    return false
  }

  if (schema.propertyNames !== undefined && keys.some(key => !matches(root, schema.propertyNames, key))) {
    return false
  }

  if (Array.isArray(schema.required) && schema.required.some(key => !(key in value))) {
    return false
  }

  return keys.every(key => {
    if (key in properties) {
      return matches(root, properties[key], value[key])
    }

    return schema.additionalProperties === false ? false : matches(root, schema.additionalProperties, value[key])
  })
}

/** Does `result` match the method's result schema (`schema.json`, `methods[method].result`)? */
export function matchesResult(method: InteractiveMethod, result: unknown, contract = loadContract()): boolean {
  const entry = (contract.schema.methods as Obj)[method] as Obj

  return matches(contract.schema, entry.result, result)
}

/** Does `params` match the method's params schema? A client's `cross_field` frames still match. */
export function matchesParams(method: InteractiveMethod, params: unknown, contract = loadContract()): boolean {
  const entry = (contract.schema.methods as Obj)[method] as Obj

  return matches(contract.schema, entry.params, params)
}

// ── defaults ─────────────────────────────────────────────────────────────────

/** The seconds a request waits when the caller names no `expires_at`: the contract's 300 s. */
export const DEFAULT_TIMEOUT_SECONDS = 300

/**
 * The params the fake raises when the caller gives none: the first frame of `examples.json` for the
 * method, without its `session_id` (the transport's) and with an `expires_at` that is still in the future.
 */
export function defaultParams(method: InteractiveMethod, nowMs: number, contract = loadContract()): Obj {
  const entry = (contract.examples.methods as Obj)[method] as Obj
  const frame = (entry.frames as Obj[])[0] as Obj
  const { session_id: _session, ...params } = frame.params as Obj

  return { ...params, expires_at: Math.floor(nowMs / 1000) + DEFAULT_TIMEOUT_SECONDS }
}

// ── answers ──────────────────────────────────────────────────────────────────

/** The first reason an answer is refused for, or `null` when the gateway takes it. */
export function refusalFor(
  method: InteractiveMethod,
  params: Obj,
  result: unknown,
  contract = loadContract()
): string | null {
  if (!matchesResult(method, result, contract)) {
    return 'bad_shape'
  }

  const answer = result as Obj

  if (method !== 'review.draft' && answer.status === 'skipped') {
    return params.optional === false ? 'not_optional' : null
  }

  try {
    switch (method) {
      case 'input.form':
        return refuseForm(params, answer)
      case 'input.file':
        return refuseFiles(params, answer)
      default:
        return refuseDraft(params, answer)
    }
  } catch {
    // A request raised with params the contract's models would never have built (the control call
    // allows it) cannot be checked against itself: take the answer rather than invent a reason.
    return null
  }
}

/** What the agent is told for a `review.draft` the gateway took: the text it will use, and whether it was edited. */
export function acceptedDraft(params: Obj, result: Obj): { text: string; edited: boolean } {
  const text = stripLineEnds(String(result.text))

  return { text, edited: text !== stripLineEnds(String(params.text ?? '')) }
}

// ── input.form ───────────────────────────────────────────────────────────────

const STRING_KINDS = new Set(['text', 'amount', 'date', 'time', 'datetime'])

function refuseForm(params: Obj, answer: Obj): string | null {
  const fields = (Array.isArray(params.fields) ? params.fields : []) as Obj[]
  const values = answer.values as Obj
  const ids = new Set(fields.map(field => field.id))

  for (const id of Object.keys(values)) {
    if (!ids.has(id)) {
      return `field:${id}:unknown`
    }
  }

  for (const field of fields) {
    const problem = refuseField(field, values[String(field.id)])

    if (problem) {
      return `field:${String(field.id)}:${problem}`
    }
  }

  return null
}

/** `""` counts as no value for every string-valued kind, and `[]` for a multiple choice. */
function hasNoValue(field: Obj, value: unknown): boolean {
  if (value === undefined) {
    return true
  }

  if (value === '') {
    return STRING_KINDS.has(String(field.kind)) || (field.kind === 'choice' && field.multiple !== true)
  }

  return field.kind === 'choice' && field.multiple === true && Array.isArray(value) && value.length === 0
}

/** The first problem of one value against its field, or `null`. */
function refuseField(field: Obj, value: unknown): string | null {
  if (hasNoValue(field, value)) {
    return field.required === true ? 'missing' : null
  }

  switch (field.kind) {
    case 'text':
      return refuseText(field, value)
    case 'number':
      return refuseNumber(field, value)
    case 'amount':
      return refuseAmount(field, value)
    case 'date':
      return refuseDate(field, value)
    case 'time':
      return refuseTime(field, value)
    case 'datetime':
      return refuseDatetime(field, value)
    case 'daterange':
      return refuseDaterange(field, value)
    case 'choice':
      return refuseChoice(field, value)
    case 'toggle':
      return typeof value === 'boolean' ? null : 'type'
    // A kind this fake does not know is not its business: the contract says clients decline it.
    default:
      return null
  }
}

function refuseText(field: Obj, value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'type'
  }

  if (field.multiline !== true && /[\r\n]/.test(value)) {
    return 'format'
  }

  return codePoints(value) > (typeof field.max_length === 'number' ? field.max_length : 4000) ? 'too_long' : null
}

function refuseNumber(field: Obj, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'type'
  }

  if (typeof field.min === 'number' && value < field.min) {
    return 'below_min'
  }

  if (typeof field.max === 'number' && value > field.max) {
    return 'above_max'
  }

  if (field.integer === true && !Number.isInteger(value)) {
    return 'not_integer'
  }

  if (typeof field.step === 'number' && field.step > 0) {
    const steps = (value - (typeof field.min === 'number' ? field.min : 0)) / field.step

    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      return 'step'
    }
  }

  return null
}

/** ISO 4217 minor units that are not 2. Anything else has two. */
const MINOR_UNITS: Record<string, number> = {
  ...Object.fromEntries(
    'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF'.split(' ').map(code => [code, 0])
  ),
  ...Object.fromEntries('BHD IQD JOD KWD LYD OMR TND'.split(' ').map(code => [code, 3]))
}

const AMOUNT = /^-?(0|[1-9][0-9]{0,14})(\.[0-9]{1,3})?$/

/** A decimal string as an exact integer count of 1e-9, so `0.10` and `0.1` compare equal. */
function decimalUnits(text: string): bigint | null {
  const parsed = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim())

  if (!parsed) {
    return null
  }

  const fraction = (parsed[3] ?? '').padEnd(9, '0').slice(0, 9)
  const units = BigInt(`${parsed[2]}${fraction}`)

  return parsed[1] ? -units : units
}

function refuseAmount(field: Obj, value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'type'
  }

  const decimals = value.split('.')[1]?.length ?? 0
  const allowed = MINOR_UNITS[String(field.currency)] ?? 2

  if (!AMOUNT.test(value) || decimals > allowed) {
    return 'format'
  }

  const amount = decimalUnits(value) as bigint
  const min = typeof field.min === 'string' ? decimalUnits(field.min) : null
  const max = typeof field.max === 'string' ? decimalUnits(field.max) : null

  if (min !== null && amount < min) {
    return 'below_min'
  }

  return max !== null && amount > max ? 'above_max' : null
}

/** A real calendar date `YYYY-MM-DD`. */
function isCalendarDate(text: string): boolean {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)

  if (!parsed) {
    return false
  }

  const [year, month, day] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])]
  const date = new Date(Date.UTC(2000, month - 1, day))

  date.setUTCFullYear(year)

  return month >= 1 && month <= 12 && day >= 1 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Dates and times in their fixed-width formats compare as the strings they are. */
function refuseBounds(field: Obj, value: string): string | null {
  if (typeof field.min === 'string' && value < field.min) {
    return 'below_min'
  }

  return typeof field.max === 'string' && value > field.max ? 'above_max' : null
}

function refuseDate(field: Obj, value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'type'
  }

  return isCalendarDate(value) ? refuseBounds(field, value) : 'format'
}

function refuseTime(field: Obj, value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'type'
  }

  return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value) ? refuseBounds(field, value) : 'format'
}

const INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?([+-])(\d{2}):(\d{2})$/

/** An instant with a numeric offset as epoch milliseconds, or `null` when it is not one. */
function instantMs(text: string): { ms: number; offsetMinutes: number } | null {
  const parsed = INSTANT.exec(text)

  if (!parsed || !isCalendarDate(parsed[1] as string)) {
    return null
  }

  const [hour, minute, second] = [Number(parsed[2]), Number(parsed[3]), Number(parsed[4] ?? 0)]
  const [offsetHour, offsetMinute] = [Number(parsed[6]), Number(parsed[7])]

  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return null
  }

  const offsetMinutes = (parsed[5] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute)
  const [year, month, day] = (parsed[1] as string).split('-').map(Number) as [number, number, number]
  const wall = new Date(Date.UTC(2000, month - 1, day, hour, minute, second))

  wall.setUTCFullYear(year)

  return { ms: wall.getTime() - offsetMinutes * 60_000, offsetMinutes }
}

/** The zone's offset in minutes at an instant; `null` when the zone is not one this runtime knows. */
function zoneOffsetMinutes(zone: string, ms: number): number | null {
  // An IANA name: no offsets (`+02:00`), which the runtime would take as a zone of its own.
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone)) {
    return null
  }

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    }).formatToParts(new Date(ms))
    const part = (type: string) => Number(parts.find(entry => entry.type === type)?.value)
    const wall = new Date(Date.UTC(2000, part('month') - 1, part('day'), part('hour'), part('minute'), part('second')))

    wall.setUTCFullYear(part('year'))

    return Math.round((wall.getTime() - Math.floor(ms / 1000) * 1000) / 60_000)
  } catch {
    return null
  }
}

const DATETIME_VALUE = /^(.+?)\[([^\]]*)\]$/

function refuseDatetime(field: Obj, value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'type'
  }

  const split = DATETIME_VALUE.exec(value)
  const instant = split ? instantMs(split[1] as string) : null

  if (!split || !instant) {
    return 'format'
  }

  const zone = split[2] as string
  const offset = zoneOffsetMinutes(zone, instant.ms)

  if (offset === null || (typeof field.tz === 'string' && field.tz !== zone)) {
    return 'zone'
  }

  if (offset !== instant.offsetMinutes) {
    return 'offset'
  }

  const min = typeof field.min === 'string' ? instantMs(field.min) : null
  const max = typeof field.max === 'string' ? instantMs(field.max) : null

  if (min && instant.ms < min.ms) {
    return 'below_min'
  }

  return max && instant.ms > max.ms ? 'above_max' : null
}

function refuseDaterange(field: Obj, value: unknown): string | null {
  if (!isObject(value) || typeof value.start !== 'string' || typeof value.end !== 'string') {
    return 'type'
  }

  if (!isCalendarDate(value.start) || !isCalendarDate(value.end)) {
    return 'format'
  }

  // Structural first: a range that runs backwards is `order` whatever the bounds say.
  if (value.end < value.start) {
    return 'order'
  }

  if (typeof field.min === 'string' && value.start < field.min) {
    return 'below_min'
  }

  return typeof field.max === 'string' && value.end > field.max ? 'above_max' : null
}

function refuseChoice(field: Obj, value: unknown): string | null {
  const options = new Set(((Array.isArray(field.options) ? field.options : []) as Obj[]).map(option => option.value))

  if (field.multiple !== true) {
    if (typeof value !== 'string') {
      return 'type'
    }

    return options.has(value) ? null : 'not_an_option'
  }

  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    return 'type'
  }

  if (value.some(item => !options.has(item))) {
    return 'not_an_option'
  }

  if (new Set(value).size !== value.length) {
    return 'duplicate'
  }

  if (typeof field.min_selected === 'number' && value.length < field.min_selected) {
    return 'too_few'
  }

  return typeof field.max_selected === 'number' && value.length > field.max_selected ? 'too_many' : null
}

// ── input.file ───────────────────────────────────────────────────────────────

/**
 * `.`, `..` and empty segments of an absolute path resolved lexically (`README.md` section 5); `null` when
 * the path is not absolute or climbs above `/`.
 */
export function resolveLexically(path: string): string | null {
  if (!path.startsWith('/')) {
    return null
  }

  const out: string[] = []

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }

    if (segment === '..') {
      if (out.length === 0) {
        return null
      }

      out.pop()
    } else {
      out.push(segment)
    }
  }

  return `/${out.join('/')}`
}

/**
 * Is `path` an entry DIRECTLY in `dir`: both resolved lexically, the path is not the directory itself, its
 * parent is the directory exactly and its last segment is a name. The upload layout is flat, so a file in a
 * subdirectory, the directory itself and a sibling that shares a prefix are all outside.
 */
export function isDirectlyIn(dir: string, path: string): boolean {
  const base = resolveLexically(dir)
  const resolved = resolveLexically(path)

  if (base === null || resolved === null || resolved === base) {
    return false
  }

  const cut = resolved.lastIndexOf('/')
  const parent = cut === 0 ? '/' : resolved.slice(0, cut)
  const name = resolved.slice(cut + 1)

  return parent === base && name !== '' && name !== '.' && name !== '..'
}

function refuseFiles(params: Obj, answer: Obj): string | null {
  const upload = (isObject(params.upload) ? params.upload : {}) as Obj
  const files = answer.files as Obj[]
  const maxFiles = typeof upload.max_files === 'number' ? upload.max_files : Number.POSITIVE_INFINITY

  if (files.length > maxFiles || (files.length > 1 && params.multiple !== true)) {
    return 'files:too_many'
  }

  let total = 0

  for (const [index, file] of files.entries()) {
    if (typeof upload.dir === 'string' && !isDirectlyIn(upload.dir, String(file.path))) {
      return `file:${index}:outside_dir`
    }

    if (typeof upload.max_bytes === 'number' && Number(file.bytes) > upload.max_bytes) {
      return `file:${index}:too_large`
    }

    total += Number(file.bytes)
  }

  return typeof upload.max_total_bytes === 'number' && total > upload.max_total_bytes ? 'files:too_large' : null
}

// ── review.draft ─────────────────────────────────────────────────────────────

/** What Python's `str.isspace` counts that `\s` does not: the information separators and NEL. */
// eslint-disable-next-line no-control-regex -- the information separators are whitespace to Python
const TRAILING_SPACE = /[\s\u001c-\u001f\u0085]+$/u

/**
 * Whitespace at the end of each line (every `str.isspace` character: `\r`, NBSP, U+3000, U+2028, U+0085, ...)
 * and blank lines at the end of the text go before any check or comparison; the gateway keeps the text
 * without them.
 */
export function stripLineEnds(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(TRAILING_SPACE, ''))
    .join('\n')
    .replace(/\n+$/, '')
}

/** Controls, format and bidi characters, line and paragraph separators: nothing that cannot be shown as it is. */
const NOT_VERBATIM = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]/u

function refuseDraft(params: Obj, answer: Obj): string | null {
  if (answer.decision !== 'approved') {
    return null
  }

  const text = stripLineEnds(String(answer.text))

  if (NOT_VERBATIM.test(text.replaceAll('\n', ''))) {
    return 'text:not_verbatim'
  }

  return params.editable === false && text !== stripLineEnds(String(params.text ?? '')) ? 'text:edited' : null
}
