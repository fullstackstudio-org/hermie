import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  birthdayProblem,
  buildCalendarItem,
  calendarItemProblem,
  cleanScanValue,
  pngOrSvgProblem,
  precisionProblem,
  presentContact,
  roundLocation,
  statementSha256,
  unrequestedKey
} from './device-requests'
import { composePatch, type FileHead, type FileKind } from './diff-hunks'
import { cleanText } from './passkey/confirm'
import { verbatimProblem } from './verbatim'

export { CalendarItemRefused } from './device-requests'

/**
 * The interactive server requests (`input.form`, `input.file`, `review.draft`, `review.diff`, `input.signature`,
 * `device.location`, `device.contact`, `device.calendar`, `device.scan`), as `contract/requests` defines them.
 *
 * This file is the gateway's checking of an ANSWER: the shape (`schema.json`, through a small checker
 * that knows exactly the keywords that file uses) and then the rules the schema cannot say (`README.md`
 * sections 3 to 12): required fields, ranges, steps, ISO 4217 minor units, datetimes with their zone and
 * offset, choice membership and counts, where files may live and how big they may be, what a draft may
 * contain, that every hunk of a diff is decided and the decision agrees with them. It returns the reason the gateway would refuse with, and nothing else; the request's life
 * (who is asked, the refusal cap, the clock) is `interactive-gate.ts`.
 *
 * No dependency: the checker is a page of code, and the contract files are read when first needed (the
 * fake is run from inside the repository, where they are).
 */

export const INTERACTIVE_METHODS = [
  'input.form',
  'input.file',
  'review.draft',
  'review.diff',
  'input.signature',
  'device.location',
  'device.contact',
  'device.calendar',
  'device.scan'
] as const

export type InteractiveMethod = (typeof INTERACTIVE_METHODS)[number]

export const isInteractiveMethod = (method: unknown): method is InteractiveMethod =>
  typeof method === 'string' && (INTERACTIVE_METHODS as readonly string[]).includes(method)

/** The device requests: they ask for something personal, so they have a window and a limiter of their own. */
export const isDeviceMethod = (method: string): boolean => method.startsWith('device.')

/**
 * The methods that need a NAMED acting person when a shared conversation's turn names nobody: approving a draft or a
 * diff, a signature and every device request (`README.md` section 3, "Who is asked").
 */
export const isStrictActingUserMethod = (method: string): boolean =>
  method.startsWith('review.') || method.startsWith('device.') || method === 'input.signature'

/** The `4041 cannot_show` reasons the contract lists; any other reason reaches the agent as `error_response`. */
export const CANNOT_SHOW_REASONS: ReadonlySet<string> = new Set([
  'no_camera',
  'no_microphone',
  'not_supported_on_device',
  'permission_denied',
  'location_unavailable',
  'upload_failed',
  'unsupported_version',
  'shutting_down',
  'declined'
])

/** What the agent is told of a client's `4041`: `cannot_show:<reason>` for a listed reason, else `error_response`. */
export const agentReasonOfError = (reason: string | undefined): string =>
  reason !== undefined && CANNOT_SHOW_REASONS.has(reason) ? `cannot_show:${reason}` : 'error_response'

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
 * `required`, `additionalProperties`, `minProperties`, `maxProperties` and `items`. A keyword it does not know is ignored
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

  if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
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

  if ((method.startsWith('input.') || isDeviceMethod(method)) && answer.status === 'skipped') {
    return params.optional === false ? 'not_optional' : null
  }

  try {
    switch (method) {
      case 'input.form':
        return refuseForm(params, answer)
      case 'input.file':
        return refuseFiles(params, answer)
      case 'review.diff':
        return refuseDiff(params, answer)
      case 'input.signature':
        return refuseSignature(params, answer)
      case 'device.location':
        return precisionProblem(String(params.precision), String(answer.precision))
      case 'device.contact':
        return refuseContact(params, answer.contact as Obj)
      case 'device.scan':
        return refuseScan(params, answer)
      // `device.calendar`: `done` says all there is.
      case 'device.calendar':
        return null
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

/**
 * What the agent is told for a `review.diff` the gateway took: each hunk's decision in the REQUEST's order and
 * with the request's ids (what the client sent is only the decisions), and for an approval the patch of exactly
 * the approved hunks, composed from the gateway's own copy of them, never from anything in the answer.
 */
export function acceptedDiff(params: Obj, result: Obj, head: FileHead): { hunks: Obj; approved_patch?: string } {
  const sent = result.hunks as Obj
  const hunks = (params.hunks as Obj[]).map(hunk => [String(hunk.id), sent[String(hunk.id)]] as const)

  if (result.decision !== 'approved') {
    return { hunks: Object.fromEntries(hunks) }
  }

  const approved = new Set(hunks.filter(([, decision]) => decision === 'approved').map(([id]) => id))

  return {
    hunks: Object.fromEntries(hunks),
    approved_patch: composePatch(head, params.hunks as { id: string; header: string; lines: string[] }[], approved)
  }
}

/** The file head of a request raised from params alone (no diff text): what the params say about the file. */
export function headOfParams(params: Obj): FileHead {
  const kind = String(params.kind ?? 'modify') as FileKind
  const path = String(params.path ?? '')
  const oldPath = typeof params.old_path === 'string' ? params.old_path : null

  switch (kind) {
    case 'new':
      return { kind, old: null, new: path }
    case 'delete':
      return { kind, old: path, new: null }
    case 'rename':
      return { kind, old: oldPath, new: path }
    default:
      return { kind: 'modify', old: path, new: path }
  }
}

/**
 * What the agent is told of a valid `input.signature` or `device.*` answer: only what the person chose to share, in
 * the gateway's own form, never the client's claim as it was. A skip is the skip.
 *
 * - `device.location`: rounded (`roundLocation`), with `lowered: true` when the person shared less than was asked;
 * - `device.contact`: the requested keys only, cleaned;
 * - `device.calendar`: `{saved: true, kind}`;
 * - `device.scan`: the value cleaned and whether cleaning changed it;
 * - `input.signature`: the statement hash, the client's `signed_at` and the gateway's own `received_at`, and both files.
 */
export function acceptedDevice(method: InteractiveMethod, params: Obj, answer: Obj, nowMs: number): Obj {
  if (answer.status === 'skipped') {
    return answer
  }

  switch (method) {
    case 'device.location': {
      const shared = roundLocation(answer, String(params.precision))

      return { status: 'answered', ...shared, ...(shared.precision === params.precision ? {} : { lowered: true }) }
    }

    case 'device.contact':
      return {
        status: 'answered',
        contact: presentContact(answer.contact as Obj, (params.fields ?? []) as unknown[])
      }

    case 'device.calendar':
      return { status: 'done', saved: true, kind: params.kind }

    case 'device.scan': {
      const value = cleanScanValue(answer.value)

      return { status: 'answered', value, symbology: answer.symbology, cleaned: value !== answer.value }
    }

    default:
      return {
        status: 'answered',
        signed: true,
        statement_sha256: answer.statement_sha256,
        signed_at: answer.signed_at,
        received_at: Math.floor(nowMs / 1000),
        files: (answer.files as Obj[]).map(file => ({
          path: file.path,
          name: cleanText(file.name, false).slice(0, 120) || String(file.path).split('/').pop(),
          mime: file.mime,
          bytes: file.bytes,
          sha256: file.sha256
        })),
        ...(typeof params.signer_name === 'string' && params.signer_name ? { signer_name: params.signer_name } : {})
      }
  }
}

/** What the agent receives of an `input.file` answer: the transcript of a voice note, cleaned (an empty one is none). */
export function acceptedFiles(answer: Obj): Obj {
  if (answer.status !== 'answered' || answer.text === undefined || answer.text === null) {
    return answer
  }

  const { text: _sent, ...rest } = answer
  const text = cleanText(answer.text, true)

  return text ? { ...rest, text } : rest
}

/**
 * Why a signature's files, read after the request settled, are not what they say (`file:<n>:<word>`), or `null`. `read`
 * is the fake's upload store: a file it holds must be the declared size and hash and the type its `mime` names (the
 * gateway reads the whole file); one it does not hold was never uploaded to the fake and is not judged, as for
 * `input.file`.
 */
export function signatureFilesProblem(
  answer: Obj,
  read: (path: string) => { content: Buffer; sha256: string } | undefined
): string | null {
  for (const [index, file] of (answer.files as Obj[]).entries()) {
    const held = read(String(file.path))

    if (!held) {
      continue
    }

    if (held.content.length !== Number(file.bytes)) {
      return `file:${index}:size`
    }

    if (held.sha256 !== file.sha256) {
      return `file:${index}:hash`
    }

    if (pngOrSvgProblem(String(file.mime), held.content)) {
      return `file:${index}:type`
    }
  }

  return null
}

// ── calendar items and frames the gateway would not build ───────────────────

/**
 * The `item` of a `device.calendar` request from what the agent passed: cleaned, bounded, checked against the
 * contract's `CalendarItem`. Throws `CalendarItemRefused` with what to fix.
 */
export function calendarItemOf(raw: unknown, contract = loadContract()): Obj {
  const model = (contract.schema.$defs as Obj).CalendarItem as Obj

  return buildCalendarItem(raw, {
    matches: (schema, value) => matches(contract.schema, schema, value),
    properties: model.properties as Obj,
    helpers: { isCalendarDate, instantMs: text => instantMs(text)?.ms ?? null }
  })
}

const hasRepeats = (list: unknown): boolean => Array.isArray(list) && new Set(list).size !== list.length

/**
 * Why the gateway would never BUILD these params, or `null` (for the methods of phases 1 to 3 that have such rules:
 * `input.file`, `input.signature` and `device.*`; a form's and a diff's own are the builders' and are not ported): the shape (`schema.json`) and the rules the schema cannot
 * say (the `cross_field` invalid frames of `examples.json`): an upload's total below one file; a recording asked for
 * an image or a photo asked for a recording; a signature with room for fewer than two files, or a statement that cannot
 * be shown as it is; a repeated contact field or scan format; a calendar item that contradicts itself, a reminder with
 * an end. The control route does not refuse such params (a client's reading of one can be tried on purpose); an agent
 * could never send them.
 */
export function frameProblem(method: InteractiveMethod, params: unknown, contract = loadContract()): string | null {
  if (!matchesParams(method, params, contract)) {
    return 'bad_shape'
  }

  const frame = params as Obj
  const upload = isObject(frame.upload) ? frame.upload : undefined

  if (upload && Number(upload.max_total_bytes) < Number(upload.max_bytes)) {
    return 'upload:total_below_file'
  }

  switch (method) {
    case 'input.file':
      return frame.capture !== undefined &&
        frame.capture !== null &&
        (frame.capture === 'audio') !== (frame.accept === 'audio')
        ? 'capture:audio_mismatch'
        : null
    case 'input.signature':
      if (Number(upload?.max_files) < 2) {
        return 'upload:max_files'
      }

      return verbatimProblem(String(frame.statement)) ? 'statement:not_verbatim' : null
    case 'device.contact':
      return hasRepeats(frame.fields) ? 'fields:repeated' : null
    case 'device.scan':
      return hasRepeats(frame.formats) ? 'formats:repeated' : null
    case 'device.calendar': {
      if (
        frame.kind === 'reminder' &&
        isObject(frame.item) &&
        frame.item.end !== undefined &&
        frame.item.end !== null
      ) {
        return 'item:reminder_has_end'
      }

      const problem = isObject(frame.item)
        ? calendarItemProblem(frame.item, { isCalendarDate, instantMs: text => instantMs(text)?.ms ?? null })
        : null

      return problem ? `item:${problem}` : null
    }

    default:
      return null
  }
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
export function isCalendarDate(text: string): boolean {
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
export function instantMs(text: string): { ms: number; offsetMinutes: number } | null {
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

/** The MIME type of a recording: `audio/` and a subtype, no parameters (`audio/mp4`, not `audio/webm;codecs=opus`). */
const AUDIO_MIME = /^audio\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/

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

    if (params.accept === 'audio' && !AUDIO_MIME.test(String(file.mime))) {
      return `file:${index}:not_audio`
    }

    total += Number(file.bytes)
  }

  if (typeof upload.max_total_bytes === 'number' && total > upload.max_total_bytes) {
    return 'files:too_large'
  }

  return refuseTranscript(params, answer, files)
}

/**
 * A transcript belongs to a recording: an `audio` request has one to give, an `any` request only when an `audio/*`
 * file came with it, an image or a document request never (`text:not_audio`).
 */
function refuseTranscript(params: Obj, answer: Obj, files: Obj[]): string | null {
  if (answer.text === undefined || answer.text === null || params.accept === 'audio') {
    return null
  }

  return params.accept === 'any' && files.some(file => String(file.mime).startsWith('audio/')) ? null : 'text:not_audio'
}

// ── input.signature, device.* ────────────────────────────────────────────────

/** The two files (as for `input.file`), their types and names, then the statement hash. */
function refuseSignature(params: Obj, answer: Obj): string | null {
  const upload = (isObject(params.upload) ? params.upload : {}) as Obj
  const files = answer.files as Obj[]
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

  if (typeof upload.max_total_bytes === 'number' && total > upload.max_total_bytes) {
    return 'files:too_large'
  }

  if (
    files
      .map(file => String(file.mime))
      .sort()
      .join(' ') !== 'image/png image/svg+xml'
  ) {
    return 'files:not_png_and_svg'
  }

  for (const [index, file] of files.entries()) {
    // The name the file is saved under says what it is: `.png` for the PNG, `.svg` for the SVG.
    if (
      !String(file.path)
        .toLowerCase()
        .endsWith(file.mime === 'image/png' ? '.png' : '.svg')
    ) {
      return `file:${index}:extension`
    }
  }

  return answer.statement_sha256 === statementSha256(String(params.statement)) ? null : 'statement:mismatch'
}

/** A key the request did not ask for, a birthday that is no day, then a contact with nothing usable in it. */
function refuseContact(params: Obj, contact: Obj): string | null {
  const requested = (Array.isArray(params.fields) ? params.fields : []) as unknown[]
  const key = unrequestedKey(contact, requested)

  if (key) {
    return `contact:${key}:not_requested`
  }

  if (typeof contact.birthday === 'string') {
    const problem = birthdayProblem(contact.birthday)

    if (problem) {
      return problem
    }
  }

  return Object.keys(presentContact(contact, requested)).length ? null : 'contact:empty'
}

/** A symbology the request did not list, then a value with nothing visible left once cleaned. */
function refuseScan(params: Obj, answer: Obj): string | null {
  const formats = Array.isArray(params.formats) ? params.formats : []

  if (formats.length && !formats.includes(answer.symbology)) {
    return 'symbology:not_requested'
  }

  return cleanScanValue(answer.value).trim() ? null : 'scan:empty'
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

// ── review.diff ──────────────────────────────────────────────────────────────

/**
 * Every hunk of the request decided exactly once, and a decision that agrees with them (README §7.2). The ids
 * are the GATEWAY's (`params.hunks`); a key the result model let through is a well-formed id, so a reason never
 * echoes text of the client's. First problem found: an id the request lacks (in the order of the answer), then
 * a hunk of the request the answer left out (in the order of the request), then `decision:inconsistent`:
 * `approved` with no hunk approved, or `rejected` with one approved.
 */
function refuseDiff(params: Obj, answer: Obj): string | null {
  const ids = ((params.hunks as Obj[]) ?? []).map(hunk => String(hunk.id))
  const decided = answer.hunks as Obj

  for (const key of Object.keys(decided)) {
    if (!ids.includes(key)) {
      return `hunk:${key}:unknown`
    }
  }

  for (const id of ids) {
    if (!(id in decided)) {
      return `hunk:${id}:missing`
    }
  }

  const anyApproved = ids.some(id => decided[id] === 'approved')

  return (answer.decision === 'approved') === anyApproved ? null : 'decision:inconsistent'
}
