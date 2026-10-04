/**
 * The interactive requests (`input.form`, `input.file`, `review.draft`) as the page
 * reads them: hand-written types for their params and their answers, and one
 * reader per method that turns a frame's params into those types.
 *
 * The contract is `contract/requests/` (README, `schema.json`, `examples.json`;
 * `interactive-types.test.ts` decodes every example frame and holds every invalid
 * one to the reader). The types are written here rather than generated because
 * `packages/hermes-shared` is upstream's and is never edited; the examples are what
 * keeps these honest.
 *
 * **What the reader promises.**
 *
 *  - Every string the sheet will draw has been through `displayText` (no control,
 *    format, bidirectional-override, private-use or unassigned characters, no runs
 *    of blank lines, bounded marks, a length limit per field), so one text cannot
 *    pass for another or paint over the sheet's own words. The two exceptions are
 *    named where they are: a draft's `text` is the thing being approved and is
 *    carried verbatim (the contract has the gateway refuse a text it cannot show as
 *    it is; the sheet marks what the eye cannot see), and an option's `value` and a
 *    field's `id` are identifiers the answer has to give back exactly.
 *  - A frame the gateway would never send (`invalid_frames` in the examples: ids
 *    that repeat, a default outside its own range, a datetime with `Z`, ...) is
 *    refused, so no sheet is built on contradictory fields. The reader answers with
 *    the reason the request is declined for (`CannotShowReason`).
 *  - A field kind this build does not know is an `unknown` field, not a refusal of
 *    the whole frame: the model declines the request with `not_supported_on_device`
 *    (README §7), and says so, instead of showing a form with a hole in it.
 *  - Nothing here holds what a person typed; these are the request's own words.
 */
import { displayText } from './secure-input'

/** The methods this page can read; the contract's three (phase 1). */
export const INTERACTIVE_METHODS = ['input.form', 'input.file', 'review.draft'] as const

export type InteractiveMethod = (typeof INTERACTIVE_METHODS)[number]

export const isInteractiveMethod = (method: string): method is InteractiveMethod =>
  (INTERACTIVE_METHODS as readonly string[]).includes(method)

/** The contract version this reader knows (README §2, `v`). */
export const CONTRACT_VERSION = 1

/** The limits of the contract, as the sheet texts are bounded to. */
export const LIMITS = Object.freeze({
  title: 80,
  summary: 500,
  detail: 2_000,
  actingUser: 64,
  fieldLabel: 60,
  fieldHint: 200,
  optionLabel: 80,
  optionValue: 64,
  textMaxLength: 4_000,
  fields: 12,
  options: 12,
  draftText: 20_000,
  draftSubject: 200,
  draftRecipient: 120,
  draftRecipients: 10,
  uploadDir: 1_024,
  uploadBytes: 104_857_600,
  uploadFiles: 10,
  comment: 1_000,
  transcript: 4_000
})

/** Why a request is declined with `4041 cannot_show` before any sheet is built. */
export type CannotShowReason = 'unsupported_version' | 'not_supported_on_device'

// ── params ───────────────────────────────────────────────────────────────────────────────────────

/** What every interactive request carries (README §2). */
export interface InteractiveEnvelope {
  /** The agent's heading, cleaned (one line). */
  title: string
  /** The agent's words: what it asks and why, cleaned. */
  summary: string
  /** Extra context, cleaned; shown monospaced. */
  detail?: string
  /** When the gateway stops waiting, Unix seconds on the gateway's clock. */
  expiresAt: number
  /** Skip is offered. */
  optional: boolean
  /** The name of the person the turn acts for, cleaned, when the gateway can name them. */
  actingUser?: string
}

interface FieldBase {
  /** `^[a-z][a-z0-9_]{0,31}$`, unique within the form: the answer's key. */
  id: string
  label: string
  hint?: string
  required: boolean
}

export interface TextField extends FieldBase {
  kind: 'text'
  multiline: boolean
  /** In code points; the contract's 4,000 when the frame names none. */
  maxLength: number
  /** A keyboard hint, not a check. */
  input: 'plain' | 'email' | 'phone' | 'url'
  default?: string
}

export interface NumberField extends FieldBase {
  kind: 'number'
  min?: number
  max?: number
  step?: number
  integer: boolean
  default?: number
}

export interface AmountField extends FieldBase {
  kind: 'amount'
  /** ISO 4217. */
  currency: string
  /** Decimal strings, never numbers. */
  min?: string
  max?: string
  default?: string
}

export interface DateField extends FieldBase {
  kind: 'date'
  min?: string
  max?: string
  /** An IANA zone: which day "today" is. */
  tz?: string
  default?: string
}

export interface TimeField extends FieldBase {
  kind: 'time'
  min?: string
  max?: string
  tz?: string
  default?: string
}

export interface DatetimeField extends FieldBase {
  kind: 'datetime'
  /** Instants: `YYYY-MM-DDTHH:MM[:SS]±HH:MM`, never `Z`. */
  min?: string
  max?: string
  tz?: string
  default?: string
}

export interface DaterangeField extends FieldBase {
  kind: 'daterange'
  min?: string
  max?: string
  tz?: string
  default?: { start: string; end: string }
}

export interface ChoiceOption {
  /** The identifier the answer gives back, as the gateway wrote it. */
  value: string
  label: string
}

export interface ChoiceField extends FieldBase {
  kind: 'choice'
  options: readonly ChoiceOption[]
  multiple: boolean
  minSelected?: number
  maxSelected?: number
  default?: string | readonly string[]
}

export interface ToggleField extends FieldBase {
  kind: 'toggle'
  default?: boolean
}

/** A kind a later contract added: the request cannot be shown here. */
export interface UnknownField {
  kind: 'unknown'
  /** The kind as it came, cleaned. */
  rawKind: string
  id: string
  label: string
  required: boolean
}

export type FormField =
  | TextField
  | NumberField
  | AmountField
  | DateField
  | TimeField
  | DatetimeField
  | DaterangeField
  | ChoiceField
  | ToggleField
  | UnknownField

export interface FormAsk extends InteractiveEnvelope {
  method: 'input.form'
  fields: readonly FormField[]
}

export type FileAccept = 'image' | 'document' | 'audio' | 'any'

export interface UploadRules {
  /** Absolute, under the session's working directory: where each file goes. */
  dir: string
  /** Bytes, per file. */
  maxBytes: number
  /** Bytes, all files together. */
  maxTotalBytes: number
  maxFiles: number
  /** Remove EXIF and GPS data from images before uploading. */
  stripMetadata: boolean
}

export interface FileAsk extends InteractiveEnvelope {
  method: 'input.file'
  accept: FileAccept
  /** A preference, never a forced camera; the page may ignore it. */
  capture?: 'photo' | 'scan' | 'audio'
  multiple: boolean
  upload: UploadRules
}

export type DraftKind = 'mail' | 'post' | 'message' | 'document'

export interface DraftAsk extends InteractiveEnvelope {
  method: 'review.draft'
  kind: DraftKind
  /**
   * The draft, VERBATIM: it is what will be sent, so it is not cleaned (cleaning would fold its blank lines and
   * change what the person approves). The gateway only builds a draft from text it can show as it is; the
   * sheet still marks what the eye cannot see.
   */
  text: string
  subject?: string
  recipients: readonly string[]
  /** The person may change the text before approving. */
  editable: boolean
}

export type InteractiveAsk = FormAsk | FileAsk | DraftAsk

export type ReadResult = { ok: true; ask: InteractiveAsk } | { ok: false; reason: CannotShowReason }

// ── answers (README §3-§6) ───────────────────────────────────────────────────────────────────────

/** One field's value in a form answer; a field without a value is left out, never `null`. */
export type FormValue = string | number | boolean | readonly string[] | { start: string; end: string }

export type FormAnswer = { status: 'answered'; values: Readonly<Record<string, FormValue>> } | { status: 'skipped' }

/** One uploaded file, by reference: the bytes went through the upload route. */
export interface UploadedFile {
  path: string
  name: string
  mime: string
  bytes: number
  sha256: string
}

export type FileAnswer = { status: 'answered'; files: readonly UploadedFile[]; text?: string } | { status: 'skipped' }

export type DraftAnswer = { decision: 'approved'; text: string } | { decision: 'rejected'; comment?: string }

export type InteractiveAnswer = FormAnswer | FileAnswer | DraftAnswer

// ── reading ──────────────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>

const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)
const isStr = (value: unknown): value is string => typeof value === 'string'
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)
const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Code points, not UTF-16 units: the contract's lengths. */
const lengthOf = (value: string): number => Array.from(value).length

const FIELD_ID = /^[a-z][a-z0-9_]{0,31}$/u
const CURRENCY = /^[A-Z]{3}$/u
const DECIMAL = /^(-?)(0|[1-9][0-9]{0,14})(?:\.([0-9]{1,3}))?$/u
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?([+-])(0\d|1\d|2[0-3]):([0-5]\d)$/u
/** A line break of any kind: a one-line text holds none. */
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/u

/** Raised inside the readers for a frame that cannot be shown; `readInteractiveParams` turns it into a reason. */
class Refused extends Error {
  constructor(readonly reason: CannotShowReason) {
    super(reason)
  }
}

function refuse(): never {
  throw new Refused('not_supported_on_device')
}

/** A real calendar date `YYYY-MM-DD`. */
function isCalendarDate(value: unknown): value is string {
  if (!isStr(value)) {
    return false
  }

  const match = DATE.exec(value)

  if (!match) {
    return false
  }

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const parsed = new Date(Date.UTC(year, month - 1, day))

  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

/** An instant `YYYY-MM-DDTHH:MM[:SS]±HH:MM` as epoch seconds, or `null` (no `Z`, no fractions, a real date). */
export function instantSeconds(value: unknown): number | null {
  if (!isStr(value)) {
    return null
  }

  const match = INSTANT.exec(value)

  if (!match || !isCalendarDate(`${match[1]}-${match[2]}-${match[3]}`)) {
    return null
  }

  const local = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0)
  )
  const offset = (Number(match[8]) * 60 + Number(match[9])) * 60 * (match[7] === '-' ? -1 : 1)

  return local / 1000 - offset
}

/** A decimal string as thousandths, so two of them compare exactly; `null` when it is not one. */
function milli(value: unknown): bigint | null {
  if (!isStr(value)) {
    return null
  }

  const match = DECIMAL.exec(value)

  if (!match) {
    return null
  }

  const whole = BigInt(match[2] ?? '0') * 1000n
  const fraction = BigInt((match[3] ?? '').padEnd(3, '0') || '0')
  const total = whole + fraction

  return match[1] === '-' ? -total : total
}

/** The decimals an ISO 4217 currency has (EUR 2, JPY 0, KWD 3); three when this runtime does not know it. */
function minorUnits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 3
  } catch {
    return 3
  }
}

/** An IANA zone this runtime knows. */
function isZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })

    return true
  } catch {
    return false
  }
}

const optStr = (value: unknown, check: (text: string) => boolean): string | undefined => {
  if (value === undefined) {
    return undefined
  }

  return isStr(value) && check(value) ? value : refuse()
}

const optNum = (value: unknown): number | undefined =>
  value === undefined ? undefined : isNum(value) ? value : refuse()

const optInt = (value: unknown, min: number, max: number): number | undefined =>
  value === undefined ? undefined : isInt(value) && value >= min && value <= max ? value : refuse()

const optBool = (value: unknown, fallback: boolean): boolean =>
  value === undefined || value === null ? fallback : typeof value === 'boolean' ? value : refuse()

function readTz(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }

  return isStr(value) && value !== '' && lengthOf(value) <= 64 && isZone(value) ? value : refuse()
}

/** Bounds of a range-checked kind: `inRange(x)` is true when `x` is within `[min, max]` where they exist. */
function bounded<T>(min: T | undefined, max: T | undefined, compare: (a: T, b: T) => number) {
  if (min !== undefined && max !== undefined && compare(min, max) > 0) {
    refuse()
  }

  return (value: T): boolean =>
    (min === undefined || compare(value, min) >= 0) && (max === undefined || compare(value, max) <= 0)
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const byNumber = (a: number, b: number): number => a - b
const byBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0)

/** `value` as `min` plus a whole multiple of `step` (floating point tolerant). */
function onStep(value: number, min: number | undefined, step: number | undefined): boolean {
  if (step === undefined) {
    return true
  }

  const quotient = (value - (min ?? 0)) / step

  return Math.abs(quotient - Math.round(quotient)) < 1e-9
}

function readBase(raw: Rec): Omit<FieldBase, never> {
  const id = raw.id

  if (!isStr(id) || !FIELD_ID.test(id)) {
    refuse()
  }

  const label = displayText(raw.label, LIMITS.fieldLabel)

  if (label === '' || (isStr(raw.label) && lengthOf(raw.label) > LIMITS.fieldLabel)) {
    refuse()
  }

  const hint = raw.hint === undefined ? '' : isStr(raw.hint) ? displayText(raw.hint, LIMITS.fieldHint) : refuse()

  return {
    id: id as string,
    label,
    ...(hint === '' ? {} : { hint }),
    required: optBool(raw.required, false)
  }
}

function readField(value: unknown): FormField {
  if (!isRec(value) || !isStr(value.kind)) {
    return refuse()
  }

  const kind = value.kind

  switch (kind) {
    case 'text':
      return readText(value)
    case 'number':
      return readNumber(value)
    case 'amount':
      return readAmount(value)
    case 'date':
      return readDate(value)
    case 'time':
      return readTime(value)
    case 'datetime':
      return readDatetime(value)
    case 'daterange':
      return readDaterange(value)
    case 'choice':
      return readChoice(value)
    case 'toggle': {
      const base = readBase(value)
      const fallback =
        value.default === undefined ? undefined : typeof value.default === 'boolean' ? value.default : refuse()

      return { ...base, kind: 'toggle', ...(fallback === undefined ? {} : { default: fallback }) }
    }
    default: {
      // A kind a later contract added. Its id and label are kept so the notice can name it; a frame that does
      // not even have those is not one this reader can describe.
      const id = value.id
      const label = displayText(value.label, LIMITS.fieldLabel)

      if (!isStr(id) || !FIELD_ID.test(id)) {
        return refuse()
      }

      return {
        kind: 'unknown',
        rawKind: displayText(kind, 32),
        id,
        label,
        required: value.required === true
      }
    }
  }
}

function readText(raw: Rec): TextField {
  const base = readBase(raw)
  const maxLength = optInt(raw.max_length, 1, LIMITS.textMaxLength) ?? LIMITS.textMaxLength
  const multiline = optBool(raw.multiline, false)
  const input = raw.input === undefined ? 'plain' : raw.input
  let fallback: string | undefined

  if (input !== 'plain' && input !== 'email' && input !== 'phone' && input !== 'url') {
    refuse()
  }

  if (raw.default !== undefined) {
    const text = raw.default

    if (!isStr(text) || text === '' || lengthOf(text) > maxLength || (!multiline && LINE_BREAK.test(text))) {
      refuse()
    }

    // What the person is shown in the field: the same cleaning as every other text.
    const shown = displayText(text, maxLength)

    fallback = shown === '' ? undefined : shown
  }

  return {
    ...base,
    kind: 'text',
    multiline,
    maxLength,
    input: input as TextField['input'],
    ...(fallback === undefined ? {} : { default: fallback })
  }
}

function readNumber(raw: Rec): NumberField {
  const base = readBase(raw)
  const min = optNum(raw.min)
  const max = optNum(raw.max)
  const step = optNum(raw.step)
  const integer = optBool(raw.integer, false)
  const within = bounded(min, max, byNumber)
  const fallback = optNum(raw.default)

  if (step !== undefined && step <= 0) {
    refuse()
  }

  if (
    fallback !== undefined &&
    (!within(fallback) || (integer && !Number.isInteger(fallback)) || !onStep(fallback, min, step))
  ) {
    refuse()
  }

  return {
    ...base,
    kind: 'number',
    integer,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(step === undefined ? {} : { step }),
    ...(fallback === undefined ? {} : { default: fallback })
  }
}

function readAmount(raw: Rec): AmountField {
  const base = readBase(raw)
  const currency = raw.currency

  if (!isStr(currency) || !CURRENCY.test(currency)) {
    refuse()
  }

  const decimals = minorUnits(currency as string)
  const decimal = (value: unknown): string | undefined =>
    optStr(value, text => milli(text) !== null && (DECIMAL.exec(text)?.[3] ?? '').length <= decimals)
  const min = decimal(raw.min)
  const max = decimal(raw.max)
  const within = bounded(
    min === undefined ? undefined : (milli(min) as bigint),
    max === undefined ? undefined : (milli(max) as bigint),
    byBig
  )
  const fallback = decimal(raw.default)

  if (fallback !== undefined && !within(milli(fallback) as bigint)) {
    refuse()
  }

  return {
    ...base,
    kind: 'amount',
    currency: currency as string,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(fallback === undefined ? {} : { default: fallback })
  }
}

function readDate(raw: Rec): DateField {
  const base = readBase(raw)
  const min = optStr(raw.min, isCalendarDate)
  const max = optStr(raw.max, isCalendarDate)
  const within = bounded(min, max, byCode)
  const fallback = optStr(raw.default, isCalendarDate)
  const tz = readTz(raw.tz)

  if (fallback !== undefined && !within(fallback)) {
    refuse()
  }

  return {
    ...base,
    kind: 'date',
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(tz === undefined ? {} : { tz }),
    ...(fallback === undefined ? {} : { default: fallback })
  }
}

function readTime(raw: Rec): TimeField {
  const base = readBase(raw)
  const isTime = (text: string): boolean => TIME.test(text)
  const min = optStr(raw.min, isTime)
  const max = optStr(raw.max, isTime)
  const within = bounded(min, max, byCode)
  const fallback = optStr(raw.default, isTime)
  const tz = readTz(raw.tz)

  if (fallback !== undefined && !within(fallback)) {
    refuse()
  }

  return {
    ...base,
    kind: 'time',
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(tz === undefined ? {} : { tz }),
    ...(fallback === undefined ? {} : { default: fallback })
  }
}

function readDatetime(raw: Rec): DatetimeField {
  const base = readBase(raw)
  const isInstant = (text: string): boolean => instantSeconds(text) !== null
  const min = optStr(raw.min, isInstant)
  const max = optStr(raw.max, isInstant)
  const within = bounded(
    min === undefined ? undefined : (instantSeconds(min) as number),
    max === undefined ? undefined : (instantSeconds(max) as number),
    byNumber
  )
  const fallback = optStr(raw.default, isInstant)
  const tz = readTz(raw.tz)

  if (fallback !== undefined && !within(instantSeconds(fallback) as number)) {
    refuse()
  }

  return {
    ...base,
    kind: 'datetime',
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(tz === undefined ? {} : { tz }),
    ...(fallback === undefined ? {} : { default: fallback })
  }
}

function readDaterange(raw: Rec): DaterangeField {
  const base = readBase(raw)
  const min = optStr(raw.min, isCalendarDate)
  const max = optStr(raw.max, isCalendarDate)
  const within = bounded(min, max, byCode)
  const tz = readTz(raw.tz)
  let fallback: { start: string; end: string } | undefined

  if (raw.default !== undefined) {
    const range = raw.default

    if (!isRec(range) || !isCalendarDate(range.start) || !isCalendarDate(range.end)) {
      refuse()
    }

    const { start, end } = range as { start: string; end: string }

    if (end < start || !within(start) || !within(end)) {
      refuse()
    }

    fallback = { start, end }
  }

  return {
    ...base,
    kind: 'daterange',
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(tz === undefined ? {} : { tz }),
    ...(fallback === undefined ? {} : { default: fallback })
  }
}

function readChoice(raw: Rec): ChoiceField {
  const base = readBase(raw)

  if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > LIMITS.options) {
    refuse()
  }

  const seen = new Set<string>()
  const options = (raw.options as unknown[]).map((entry): ChoiceOption => {
    if (!isRec(entry) || !isStr(entry.value) || entry.value === '' || lengthOf(entry.value) > LIMITS.optionValue) {
      return refuse()
    }

    const label = displayText(entry.label, LIMITS.optionLabel)

    if (label === '' || seen.has(entry.value)) {
      return refuse()
    }

    seen.add(entry.value)

    return { value: entry.value, label }
  })
  const multiple = optBool(raw.multiple, false)
  const minSelected = optInt(raw.min_selected, 0, options.length)
  const maxSelected = optInt(raw.max_selected, 0, options.length)

  if ((minSelected !== undefined || maxSelected !== undefined) && !multiple) {
    refuse()
  }

  if (minSelected !== undefined && maxSelected !== undefined && minSelected > maxSelected) {
    refuse()
  }

  let fallback: string | readonly string[] | undefined

  if (raw.default !== undefined) {
    if (multiple) {
      const list = raw.default

      if (
        !Array.isArray(list) ||
        !list.every(item => isStr(item) && seen.has(item)) ||
        new Set(list).size !== list.length
      ) {
        refuse()
      }

      if (
        (minSelected !== undefined && list.length < minSelected) ||
        (maxSelected !== undefined && list.length > maxSelected)
      ) {
        refuse()
      }

      fallback = list as string[]
    } else {
      fallback = isStr(raw.default) && seen.has(raw.default) ? raw.default : refuse()
    }
  }

  return {
    ...base,
    kind: 'choice',
    options,
    multiple,
    ...(minSelected === undefined ? {} : { minSelected }),
    ...(maxSelected === undefined ? {} : { maxSelected }),
    ...(fallback === undefined ? {} : { default: fallback })
  }
}

function readEnvelope(params: Rec, fallbackOptional: boolean): InteractiveEnvelope {
  if (params.v !== CONTRACT_VERSION) {
    throw new Refused('unsupported_version')
  }

  const title = displayText(params.title, LIMITS.title)
  const summary = displayText(params.summary, LIMITS.summary)

  if (title === '' || summary === '') {
    refuse()
  }

  const detail = params.detail === undefined || params.detail === null ? '' : displayText(params.detail, LIMITS.detail)
  const expiresAt = params.expires_at

  if (!isInt(expiresAt)) {
    refuse()
  }

  const actor = isRec(params.acting_user) ? displayText(params.acting_user.name, LIMITS.actingUser) : ''

  return {
    title,
    summary,
    ...(detail === '' ? {} : { detail }),
    expiresAt: expiresAt as number,
    optional: optBool(params.optional, fallbackOptional),
    ...(actor === '' ? {} : { actingUser: actor })
  }
}

function readForm(params: Rec): FormAsk {
  const envelope = readEnvelope(params, true)

  if (!Array.isArray(params.fields) || params.fields.length < 1 || params.fields.length > LIMITS.fields) {
    refuse()
  }

  const ids = new Set<string>()
  const fields = (params.fields as unknown[]).map(entry => {
    const field = readField(entry)

    if (ids.has(field.id)) {
      refuse()
    }

    ids.add(field.id)

    return field
  })

  return { ...envelope, method: 'input.form', fields }
}

function readFile(params: Rec): FileAsk {
  const envelope = readEnvelope(params, true)
  const { accept } = params

  if (accept !== 'image' && accept !== 'document' && accept !== 'audio' && accept !== 'any') {
    refuse()
  }

  const upload = isRec(params.upload) ? params.upload : (refuse() as never)
  const dir = upload.dir

  if (!isStr(dir) || dir === '' || lengthOf(dir) > LIMITS.uploadDir) {
    refuse()
  }

  const maxBytes = optInt(upload.max_bytes, 1, LIMITS.uploadBytes)
  const maxTotalBytes = optInt(upload.max_total_bytes, 1, LIMITS.uploadBytes)
  const maxFiles = optInt(upload.max_files, 1, LIMITS.uploadFiles)

  if (maxBytes === undefined || maxTotalBytes === undefined || maxFiles === undefined || maxTotalBytes < maxBytes) {
    refuse()
  }

  const capture = params.capture
  const multiple = optBool(params.multiple, false)

  return {
    ...envelope,
    method: 'input.file',
    accept: accept as FileAccept,
    // A preference: one this build does not know is no preference.
    ...(capture === 'photo' || capture === 'scan' || capture === 'audio' ? { capture } : {}),
    multiple,
    upload: {
      dir: dir as string,
      maxBytes: maxBytes as number,
      maxTotalBytes: maxTotalBytes as number,
      maxFiles: maxFiles as number,
      stripMetadata: optBool(upload.strip_metadata, false)
    }
  }
}

function readDraft(params: Rec): DraftAsk {
  const envelope = readEnvelope(params, false)
  const { kind, text } = params

  if (kind !== 'mail' && kind !== 'post' && kind !== 'message' && kind !== 'document') {
    refuse()
  }

  if (!isStr(text) || text === '' || lengthOf(text) > LIMITS.draftText) {
    refuse()
  }

  const subject =
    params.subject === undefined
      ? ''
      : isStr(params.subject)
        ? displayText(params.subject, LIMITS.draftSubject)
        : refuse()
  let recipients: string[] = []

  if (params.recipients !== undefined) {
    if (!Array.isArray(params.recipients) || params.recipients.length > LIMITS.draftRecipients) {
      refuse()
    }

    recipients = (params.recipients as unknown[]).map(entry => {
      const shown = isStr(entry) ? displayText(entry, LIMITS.draftRecipient) : ''

      return shown === '' ? refuse() : shown
    })
  }

  return {
    ...envelope,
    method: 'review.draft',
    kind: kind as DraftKind,
    text: text as string,
    ...(subject === '' ? {} : { subject: subject as string }),
    recipients,
    editable: optBool(params.editable, true)
  }
}

/**
 * The request `params` of `method` as a typed ask, or the reason it is declined with (`4041`): a version this
 * build does not know, or a frame it cannot show (not the shape the contract describes, or contradicting itself).
 * Never throws.
 */
export function readInteractiveParams(method: string, params: unknown): ReadResult {
  try {
    if (!isRec(params)) {
      return { ok: false, reason: 'not_supported_on_device' }
    }

    switch (method) {
      case 'input.form':
        return { ok: true, ask: readForm(params) }
      case 'input.file':
        return { ok: true, ask: readFile(params) }
      case 'review.draft':
        return { ok: true, ask: readDraft(params) }
      default:
        return { ok: false, reason: 'not_supported_on_device' }
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Refused ? error.reason : 'not_supported_on_device' }
  }
}

/** The fields of a form this build cannot draw. */
export const unknownFields = (ask: InteractiveAsk): readonly UnknownField[] =>
  ask.method === 'input.form' ? ask.fields.filter((field): field is UnknownField => field.kind === 'unknown') : []
