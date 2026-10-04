/**
 * The interactive requests (`input.form`, `input.file`, `review.draft`, `review.diff`) as the page
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

/** The methods this page can read: the contract's three of phase 1 and `review.diff` of phase 2. */
export const INTERACTIVE_METHODS = ['input.form', 'input.file', 'review.draft', 'review.diff'] as const

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
  /**
   * `^[a-z][a-z0-9_]{0,31}$`, unique within the form: the answer's key. An identifier, never rendered: a sheet that
   * needs words shows the label.
   */
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
  /** A keyboard hint, not a check: one this build does not know is `plain`. */
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
  /**
   * The identifier the answer gives back, as the gateway wrote it: NOT cleaned, so it is never rendered (not as text,
   * not as an accessible name); the sheet shows `label`.
   */
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
   * change what the person approves). The gateway only builds a draft from text it can show as it is, and the reader
   * declines one that holds what the gateway's verbatim rule refuses (`verbatimProblem`), so what is shown is all there
   * is; the sheet still marks what the eye cannot see.
   */
  text: string
  subject?: string
  recipients: readonly string[]
  /** The person may change the text before approving. */
  editable: boolean
}

export type InteractiveAsk = FormAsk | FileAsk | DraftAsk | DiffAsk

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

/** What the person decided about one hunk. */
export type HunkDecision = 'approved' | 'rejected'

/**
 * A diff review's answer (README §7.2): the decision, and one entry for EVERY hunk of the request. `approved` means
 * "apply what I approved" (some or all), `rejected` "apply nothing". It carries no text and no line.
 */
export interface DiffAnswer {
  decision: 'approved' | 'rejected'
  hunks: Readonly<Record<string, HunkDecision>>
}

export type InteractiveAnswer = FormAnswer | FileAnswer | DraftAnswer | DiffAnswer

/**
 * The answer for `decisions` (a hunk id to what the person decided), or `null` while a hunk of `ask` is still undecided
 * (a hunk is never answered for the person). The entries follow the request's order, ids the request does not have are
 * left out, and the decision follows from them: `approved` when at least one hunk is approved, else `rejected`.
 */
export function composeDiffAnswer(
  ask: Pick<DiffAsk, 'hunks'>,
  decisions: Readonly<Record<string, HunkDecision | undefined>>
): DiffAnswer | null {
  const hunks: Record<string, HunkDecision> = {}

  for (const hunk of ask.hunks) {
    const decision = decisions[hunk.id]

    if (decision !== 'approved' && decision !== 'rejected') {
      return null
    }

    hunks[hunk.id] = decision
  }

  return {
    decision: Object.values(hunks).includes('approved') ? 'approved' : 'rejected',
    hunks
  }
}

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
const CONTROL = /\p{Cc}/u
/**
 * What the gateway's verbatim rule refuses in a draft (`text:not_verbatim`, contract §6): a control character other
 * than LF (a tab too), a format, surrogate or private-use character, a line or paragraph separator, a space other
 * than U+0020, an unassigned code point.
 */
const NOT_VERBATIM = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Cn}]|[^\P{Zs} ]/u
/**
 * The default-ignorable code points (rendered as nothing), as the gateway's table holds them (`request_text.py`
 * `DEFAULT_IGNORABLE`), as inclusive ranges.
 */
const IGNORABLE: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff]
]
/** Letters that render as blank space (the gateway's `_INVISIBLE_LETTERS`). */
const INVISIBLE_LETTERS: ReadonlySet<number> = new Set([0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x1d159])
/** What Python's `str.isspace()` is true for: the gateway strips it from the end of each line of an approved draft. */
const PYTHON_SPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000
])
const COMBINING = /^[\p{Mn}\p{Me}]$/u
/** At most this many combining marks on one character (the gateway's `MAX_COMBINING_MARKS`). */
const MAX_COMBINING_MARKS = 4

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
export function isCalendarDate(value: unknown): value is string {
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
export function milli(value: unknown): bigint | null {
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

/**
 * ISO 4217 minor units, as the gateway's table has them (`tui_gateway/currency_units.py`: the active currency codes,
 * funds codes with a minor unit included, the precious-metal and testing codes, which have none, left out). Not read from
 * the browser's own locale data, which disagrees on some (HUF, IDR, COP, IQD, ...): the gateway is what an answer is
 * checked by.
 */
const MINOR_UNITS: ReadonlyMap<string, number> = new Map(
  (
    [
      [0, 'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF'],
      [3, 'BHD IQD JOD KWD LYD OMR TND'],
      [4, 'CLF UYW'],
      [
        2,
        'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE ' +
          'CHF CHW CNY COP COU CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL ' +
          'HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR ' +
          'MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK ' +
          'SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XCD ' +
          'YER ZAR ZMW ZWG'
      ]
    ] as const
  ).flatMap(([digits, codes]) => codes.split(' ').map((code): [string, number] => [code, digits]))
)

/** The most decimals any amount carries, whatever the currency (the contract's decimal string). */
const MAX_DECIMALS = 3

/**
 * The decimals an amount in `currency` may carry: its ISO 4217 minor unit, at most three (the contract's decimal
 * string has no more); two for a code the table does not list, as the gateway's answer check assumes.
 */
export function minorUnits(currency: string): number {
  return Math.min(MAX_DECIMALS, MINOR_UNITS.get(currency) ?? 2)
}

/** An IANA zone this runtime knows. */
export function isZone(value: string): boolean {
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

/** A decimal number (a JSON number, or the text a person typed) as an integer and the digits after the point it has. */
function decimalParts(value: number | string): { digits: bigint; scale: number } | null {
  const text = typeof value === 'number' ? String(value) : value.trim()
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(text)

  if (!match || ((match[2] ?? '') === '' && (match[3] ?? '') === '')) {
    return null
  }

  const fraction = match[3] ?? ''
  const exponent = Number(match[4] ?? 0)
  let digits = BigInt(`${match[2] || '0'}${fraction}`)
  let scale = fraction.length - exponent

  // A negative scale is a number of tens: bring it to a whole number so the scales can be compared.
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale)
    scale = 0
  }

  return { digits: match[1] === '-' ? -digits : digits, scale }
}

/**
 * `value` as `min` (else 0) plus a whole multiple of `step`, in exact decimal arithmetic: no floating point, so
 * `0.3` is on a step of `0.1` and `0.30000000000000004` is not. `value` is a JSON number or the text typed.
 */
export function onStep(value: number | string, min: number | undefined, step: number | undefined): boolean {
  if (step === undefined) {
    return true
  }

  const v = decimalParts(value)
  const base = decimalParts(min ?? 0)
  const unit = decimalParts(step)

  if (!v || !base || !unit || unit.digits === 0n) {
    return false
  }

  const scale = Math.max(v.scale, base.scale, unit.scale)
  const lift = (part: { digits: bigint; scale: number }): bigint => part.digits * 10n ** BigInt(scale - part.scale)

  return (lift(v) - lift(base)) % lift(unit) === 0n
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
  // A hint, not a check: one a later contract added is no hint (an answer is never refused for it).
  const input = raw.input === 'email' || raw.input === 'phone' || raw.input === 'url' ? raw.input : 'plain'
  let fallback: string | undefined

  if (raw.default !== undefined) {
    const text = raw.default

    if (!isStr(text) || text === '' || lengthOf(text) > maxLength || (!multiline && LINE_BREAK.test(text))) {
      refuse()
    }

    // The value the field starts with, and what goes back unless the person changes it. A multi-line field takes it
    // as it came (cleaning would fold its blank lines and send something else), so it must be text that shows as it
    // is: one with a control, format, bidi or invisible character the field would hide is not shown at all (a tab is
    // a tab in a field). A one-line field shows it cleaned, like every other text.
    if (multiline && verbatimProblem(text as string, { tab: true, layout: false })) {
      refuse()
    }

    const shown = multiline ? (text as string) : displayText(text, maxLength)

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

  // Absolute, without `..` and without control characters: the directory the files go to and the answer's paths
  // start with. Anything else is not a directory this page uploads to.
  if (
    !isStr(dir) ||
    !dir.startsWith('/') ||
    lengthOf(dir) > LIMITS.uploadDir ||
    dir.split('/').includes('..') ||
    CONTROL.test(dir)
  ) {
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

/**
 * The text as the gateway sees an approved draft: whitespace at the end of each line (split on LF only; every
 * character Python's `str.isspace()` is true for) and at the end of the whole text is gone, which also drops
 * trailing blank lines. Leading whitespace stays (`strip_line_ends`, contract §6).
 */
export function stripLineEnds(text: string): string {
  const stripEnd = (line: string): string => {
    const chars = Array.from(line)
    let end = chars.length

    while (end > 0 && PYTHON_SPACE.has(chars[end - 1]?.codePointAt(0) ?? 0)) {
      end -= 1
    }

    return chars.slice(0, end).join('')
  }

  return stripEnd(text.split('\n').map(stripEnd).join('\n'))
}

/** The spacing limits of the gateway's layout rule (`request_text.py`): spacing that could push part of a text out of view. */
export const LAYOUT_LIMITS = Object.freeze({ spaceRun: 16, indent: 32, blankLines: 3, lineChars: 2_000 })

/** Which rule of the gateway's verbatim check a text breaks, with where. */
export type VerbatimIssue =
  /** A character that cannot be shown as it is (hidden, a tab, a control, a separator, ...). */
  | { rule: 'character'; codePoint: number }
  | { rule: 'marks' }
  /** Line `line` (1-based) holds `size` spaces in a row. */
  | { rule: 'space_run'; line: number; size: number }
  | { rule: 'indent'; line: number; size: number }
  /** More than `LAYOUT_LIMITS.blankLines` blank lines in a row start at line `line`. */
  | { rule: 'blank_lines'; line: number }
  | { rule: 'line_length'; line: number; size: number }

/**
 * The first rule of the gateway's verbatim check (`verbatim_problem`, contract §6) that `text` breaks, or `null`:
 * a character it cannot show as it is, too many combining marks on one, or spacing that could hide part of it (a
 * run of more than 16 spaces, an indent of more than 32, more than 3 blank lines in a row, a line of more than
 * 2,000 characters). Whitespace at the end of a line or of the text does not count (the gateway strips it from an
 * approved text first). `allow.tab` lets a tab through and `allow.layout: false` skips the spacing rules, for a
 * field's default (a tab shows as one there, and no layout rule is stated for a default).
 */
export function verbatimIssue(text: string, allow: { tab?: boolean; layout?: boolean } = {}): VerbatimIssue | null {
  const body = stripLineEnds(text)
  let marks = 0

  for (const char of body) {
    // The only whitespace a draft may hold.
    if (char === '\n' || char === ' ') {
      marks = 0

      continue
    }

    const code = char.codePointAt(0) ?? 0

    if (
      (NOT_VERBATIM.test(char) && !(allow.tab === true && char === '\t')) ||
      INVISIBLE_LETTERS.has(code) ||
      IGNORABLE.some(([low, high]) => code >= low && code <= high)
    ) {
      return { rule: 'character', codePoint: code }
    }

    marks = COMBINING.test(char) ? marks + 1 : 0

    if (marks > MAX_COMBINING_MARKS) {
      return { rule: 'marks' }
    }
  }

  if (allow.layout === false) {
    return null
  }

  let blank = 0

  for (const [index, line] of body.split('\n').entries()) {
    const number = index + 1
    const chars = Array.from(line)

    if (line.replace(/ +/gu, '') === '') {
      blank += 1

      if (blank > LAYOUT_LIMITS.blankLines) {
        return { rule: 'blank_lines', line: number - blank + 1 }
      }

      continue
    }

    blank = 0

    if (chars.length > LAYOUT_LIMITS.lineChars) {
      return { rule: 'line_length', line: number, size: chars.length }
    }

    const bodyOfLine = line.replace(/^ +/u, '')
    const indent = chars.length - Array.from(bodyOfLine).length

    if (indent > LAYOUT_LIMITS.indent) {
      return { rule: 'indent', line: number, size: indent }
    }

    for (const run of bodyOfLine.matchAll(/ +/gu)) {
      if (run[0].length > LAYOUT_LIMITS.spaceRun) {
        return { rule: 'space_run', line: number, size: run[0].length }
      }
    }
  }

  return null
}

/** Whether a draft's `text` breaks the gateway's verbatim rule: an approval of it could not be taken (`verbatimIssue`). */
export const verbatimProblem = (text: string, allow: { tab?: boolean; layout?: boolean } = {}): boolean =>
  verbatimIssue(text, allow) !== null

/**
 * Whether ONE line of text breaks the gateway's character rule (`contract/requests` §6.2) exactly as it is: nothing is
 * stripped first, so a space or a no-break space at its end counts. A line break of any kind, a control, format,
 * surrogate, private-use or unassigned character, a space other than U+0020, a blank letter, a default-ignorable code
 * point, and more than four combining marks in a row all break it. `tab` lets U+0009 through (a diff line and a hunk
 * header's section text); `blankMarks` also refuses a combining mark at the start or right after a space or a tab (a
 * diff's rule, because it would only keep two runs of whitespace apart).
 */
export function lineCharProblem(text: string, { tab = false, blankMarks = false } = {}): boolean {
  let marks = 0
  let blank = true

  for (const char of text) {
    if (char === ' ' || (tab && char === '\t')) {
      marks = 0
      blank = true

      continue
    }

    const code = char.codePointAt(0) ?? 0

    if (
      NOT_VERBATIM.test(char) ||
      INVISIBLE_LETTERS.has(code) ||
      IGNORABLE.some(([low, high]) => code >= low && code <= high)
    ) {
      return true
    }

    const mark = COMBINING.test(char)

    if (mark && blank && blankMarks) {
      return true
    }

    marks = mark ? marks + 1 : 0

    if (marks > MAX_COMBINING_MARKS) {
      return true
    }

    blank = false
  }

  return false
}

// ── review.diff (README §7) ──────────────────────────────────────────────────────────────────────

/** The limits of a diff (README §7, §7.1). */
export const DIFF_LIMITS = Object.freeze({
  hunks: 200,
  hunkLines: 400,
  lineChars: 500,
  header: 200,
  path: 300,
  /** Columns of indent (twelve tab levels), of any other run of spaces and tabs, and of all of them in a line. */
  indent: 96,
  spaceRun: 32,
  whitespace: 160,
  /** A tab advances to the next multiple of this many columns. */
  tabStop: 8
})

export type DiffKind = 'modify' | 'new' | 'delete' | 'rename'

/** Where `git apply` is guaranteed to put a hunk, whatever its header says (README §7). */
export type DiffAnchor = 'start' | 'end' | 'both'

/** One line of a hunk. A `note` is git's "\ No newline at end of file", which belongs to the line before it. */
export type DiffLine = { type: 'context' | 'added' | 'removed'; text: string } | { type: 'note' }

export interface DiffHunk {
  /** `h1`, `h2`, …: the answer's key. */
  id: string
  /** `@@ -a,b +c,d @@`, optionally followed by a space and the section text; one line. */
  header: string
  lines: readonly DiffLine[]
  /** What the gateway pinned it to, together with what the lines themselves pin (`hunkAnchor`). */
  anchor?: DiffAnchor
}

export interface DiffAsk extends InteractiveEnvelope {
  method: 'review.diff'
  kind: DiffKind
  /** The file's relative path (the new one for a rename), display only. */
  path: string
  /** A rename's previous path. */
  oldPath?: string
  hunks: readonly DiffHunk[]
}

const HUNK_ID = /^h[1-9][0-9]{0,2}$/u
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.+))?$/u
const NO_NEWLINE_NOTE = '\\ No newline at end of file'

/** The numbers and the section text of a hunk header; `null` for text that is not one. A count left out is 1. */
export function parseHunkHeader(
  header: string
): { oldStart: number; oldCount: number; newStart: number; newCount: number; section: string } | null {
  const match = HUNK_HEADER.exec(header)

  if (!match) {
    return null
  }

  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    section: match[5] ?? ''
  }
}

/**
 * Whether the layout of a diff line's text (after its marker) breaks the contract's limits (README §7.1), counted in
 * COLUMNS: a space advances one, a tab to the next multiple of 8, every other character one. An indent above 96
 * columns, any other run of spaces and tabs above 32, or all of them together above 160 would push text out of view.
 */
export function diffLayoutProblem(text: string): boolean {
  let column = 0
  let total = 0
  let runStart = -1
  let leading = true

  const endRun = (): boolean => {
    if (runStart < 0) {
      return false
    }

    const width = column - runStart

    runStart = -1

    return width > (leading ? DIFF_LIMITS.indent : DIFF_LIMITS.spaceRun)
  }

  for (const char of text) {
    if (char === ' ' || char === '\t') {
      const next = char === ' ' ? column + 1 : column + DIFF_LIMITS.tabStop - (column % DIFF_LIMITS.tabStop)

      if (runStart < 0) {
        runStart = column
      }

      total += next - column
      column = next

      continue
    }

    if (endRun()) {
      return true
    }

    leading = false
    column += 1
  }

  return endRun() || total > DIFF_LIMITS.whitespace
}

/** A diff line's text, or a header, that is not shown as it is: a hidden character, bad layout, whitespace at its end. */
const diffTextProblem = (text: string): boolean =>
  lineCharProblem(text, { tab: true, blankMarks: true }) ||
  diffLayoutProblem(text) ||
  text.endsWith(' ') ||
  text.endsWith('\t')

/**
 * Where a hunk is pinned by what it says, whatever the gateway reported: `start` when its old side starts at line 0 or 1,
 * `end` when no context line follows its last change (the no-newline note aside; `git apply` then requires it to match
 * at the END of the file, wherever the header's line number points), `both` when both. `undefined` for a hunk that is
 * not pinned.
 */
export function hunkAnchor(hunk: Pick<DiffHunk, 'header' | 'lines'>): DiffAnchor | undefined {
  const numbers = parseHunkHeader(hunk.header)
  const start = numbers !== null && numbers.oldStart <= 1
  let lastChange = -1
  let lastContext = -1

  hunk.lines.forEach((line, index) => {
    if (line.type === 'added' || line.type === 'removed') {
      lastChange = index
    } else if (line.type === 'context') {
      lastContext = index
    }
  })

  const end = lastChange >= 0 && lastContext < lastChange

  return start && end ? 'both' : start ? 'start' : end ? 'end' : undefined
}

function readDiffLine(raw: unknown): DiffLine {
  if (!isStr(raw) || raw === '' || lengthOf(raw) > DIFF_LIMITS.lineChars) {
    return refuse()
  }

  if (raw === NO_NEWLINE_NOTE) {
    return { type: 'note' }
  }

  const marker = raw.charAt(0)
  const text = raw.slice(1)

  if ((marker !== ' ' && marker !== '+' && marker !== '-') || diffTextProblem(text)) {
    return refuse()
  }

  return { type: marker === '+' ? 'added' : marker === '-' ? 'removed' : 'context', text }
}

function readHunk(raw: unknown, last: boolean): DiffHunk {
  if (
    !isRec(raw) ||
    Object.keys(raw).some(key => key !== 'id' && key !== 'header' && key !== 'lines' && key !== 'anchor')
  ) {
    return refuse()
  }

  const { id, header, lines, anchor } = raw

  if (!isStr(id) || !HUNK_ID.test(id) || !isStr(header) || lengthOf(header) > DIFF_LIMITS.header) {
    return refuse()
  }

  const numbers = parseHunkHeader(header)

  if (numbers === null || diffTextProblem(header)) {
    return refuse()
  }

  if (anchor !== undefined && anchor !== 'start' && anchor !== 'end' && anchor !== 'both') {
    return refuse()
  }

  if (!Array.isArray(lines) || lines.length < 1 || lines.length > DIFF_LIMITS.hunkLines) {
    return refuse()
  }

  const read = (lines as unknown[]).map(readDiffLine)

  // The note belongs to a `+` or `-` line before it, and only the last hunk of a request can end a file.
  read.forEach((line, index) => {
    if (
      line.type === 'note' &&
      (!last || index === 0 || read[index - 1]?.type === 'context' || read[index - 1]?.type === 'note')
    ) {
      refuse()
    }
  })

  // The header's counts say how many old and new lines the hunk has: a hunk that disagrees is not one the gateway built.
  const old = read.filter(line => line.type === 'context' || line.type === 'removed').length
  const added = read.filter(line => line.type === 'context' || line.type === 'added').length

  if (old !== numbers.oldCount || added !== numbers.newCount) {
    return refuse()
  }

  const hunk: DiffHunk = { id, header, lines: read }
  // What the frame says is checked against what the lines say, so a label never claims more than the hunk does; and
  // what the lines pin is shown whether or not the gateway said so.
  const computed = hunkAnchor(hunk)
  const declared = anchor as DiffAnchor | undefined
  const holds = (name: 'start' | 'end'): boolean => computed === name || computed === 'both'

  if (
    (declared === 'start' && !holds('start')) ||
    (declared === 'end' && !holds('end')) ||
    (declared === 'both' && computed !== 'both') ||
    (!last && (holds('end') || declared === 'end' || declared === 'both'))
  ) {
    return refuse()
  }

  return { ...hunk, ...(computed === undefined ? {} : { anchor: computed }) }
}

const PATH_PROBLEM = (path: string): boolean =>
  path === '' ||
  lengthOf(path) > DIFF_LIMITS.path ||
  path.startsWith('/') ||
  path.split('/').some(segment => segment === '..' || segment === '.git') ||
  lineCharProblem(path)

function readDiff(params: Rec): DiffAsk {
  const envelope = readEnvelope(params, false)
  const { kind, path, old_path: oldPath, hunks } = params

  if (kind !== 'modify' && kind !== 'new' && kind !== 'delete' && kind !== 'rename') {
    refuse()
  }

  if (!isStr(path) || PATH_PROBLEM(path)) {
    refuse()
  }

  // `old_path` is a rename's previous path and only that.
  if (kind === 'rename' ? !isStr(oldPath) || PATH_PROBLEM(oldPath) : oldPath !== undefined) {
    refuse()
  }

  if (!Array.isArray(hunks) || hunks.length < 1 || hunks.length > DIFF_LIMITS.hunks) {
    refuse()
  }

  const ids = new Set<string>()
  const read = (hunks as unknown[]).map((entry, index) => {
    const hunk = readHunk(entry, index === hunks.length - 1)

    if (ids.has(hunk.id)) {
      refuse()
    }

    ids.add(hunk.id)

    return hunk
  })

  // A new file's hunks hold only added lines and a deleted file's only removed ones: nothing else could be true of them.
  const foreign = kind === 'new' ? 'removed' : kind === 'delete' ? 'added' : null

  if (
    foreign !== null &&
    read.some(hunk => hunk.lines.some(line => line.type === foreign || line.type === 'context'))
  ) {
    refuse()
  }

  return {
    ...envelope,
    method: 'review.diff',
    kind: kind as DiffKind,
    path: path as string,
    ...(kind === 'rename' ? { oldPath: oldPath as string } : {}),
    hunks: read
  }
}

function readDraft(params: Rec): DraftAsk {
  const envelope = readEnvelope(params, false)
  const { kind, text } = params

  if (kind !== 'mail' && kind !== 'post' && kind !== 'message' && kind !== 'document') {
    refuse()
  }

  if (!isStr(text) || text === '' || lengthOf(text) > LIMITS.draftText || verbatimProblem(text)) {
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
      case 'review.diff':
        return { ok: true, ask: readDiff(params) }
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
