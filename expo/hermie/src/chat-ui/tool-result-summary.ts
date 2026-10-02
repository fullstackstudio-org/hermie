/**
 * Heuristic JSON → human summary for tool results, ported from
 * `apps/desktop/src/lib/tool-result-summary.ts`.
 *
 * A tool result is whatever shape the tool felt like returning. The card shows
 * this rendering by default; the raw payload stays one tap away.
 */

const WRAPPER_KEYS = ['data', 'result', 'output', 'response', 'payload'] as const

const PRIORITY_KEYS = [
  'title',
  'name',
  'path',
  'file',
  'filepath',
  'url',
  'href',
  'link',
  'status',
  'id',
  'message',
  'summary',
  'description'
] as const

const ERROR_KEYS = ['error', 'errors', 'failure', 'exception'] as const

// `stderr` is deliberately excluded: plenty of CLIs write informational lines
// there (progress bars, `hint:`, `In file included from`), and treating those
// as error signal flips a healthy command's card into its destructive styling.
const ERROR_MSG_KEYS = ['message', 'reason', 'detail'] as const
const NON_ERROR_TEXT = new Set(['', '0', 'false', 'none', 'null', 'nil', 'ok', 'success', 'n/a', 'na'])

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value))

const normalizeText = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()

const capitalize = (value: string): string => (value ? value[0]?.toUpperCase() + value.slice(1) : value)

function tryJson(value: string): unknown {
  const trimmed = value.trim()

  if (!trimmed) {
    return ''
  }

  if (!/^[{[]|^"/.test(trimmed)) {
    return value
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

const norm = (value: unknown): unknown => (typeof value === 'string' ? tryJson(value) : value)

const titleCase = (key: string) =>
  key
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ')

const pluralize = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

function clipInline(value: string, max = 180): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()

  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

function clipBlock(value: string, maxChars = 1800, maxLines = 18): string {
  const trimmed = value.trim()

  if (!trimmed) {
    return ''
  }

  const lines = trimmed.split('\n')
  let text = lines.slice(0, maxLines).join('\n')
  const clipped = lines.length > maxLines || text.length > maxChars

  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 1).trimEnd()
  }

  return clipped && !text.endsWith('…') ? `${text}…` : text
}

function firstString(record: Json, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return ''
}

function orderedKeys(keys: string[]): string[] {
  const priority = PRIORITY_KEYS.filter(key => keys.includes(key))
  const rest = keys.filter(key => !priority.includes(key as never))

  return [...priority, ...rest]
}

const isWrapperKey = (key: string) => (WRAPPER_KEYS as readonly string[]).includes(key)
const skipField = (key: string, value: unknown) =>
  isWrapperKey(key) || ((key === 'success' || key === 'ok') && value === true)

function summarizeScalar(value: unknown): string {
  if (typeof value === 'string') {
    return clipInline(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  return ''
}

function summarizeRecordInline(record: Json, depth: number): string {
  if (depth > 3) {
    return pluralize(Object.keys(record).length, 'field')
  }

  const title = firstString(record, ['title', 'name', 'path', 'file', 'filepath', 'url', 'href', 'link', 'id'])
  const status = firstString(record, ['status', 'category', 'type'])
  const message = firstString(record, ['snippet', 'summary', 'description', 'message'])

  if (title && status) {
    return `${clipInline(title, 110)} (${clipInline(status, 54)})`
  }

  if (title && message && title !== message) {
    return `${clipInline(title, 90)} - ${clipInline(message, 84)}`
  }

  if (title) {
    return clipInline(title, 150)
  }

  const pairs = orderedKeys(Object.keys(record))
    .filter(key => !skipField(key, record[key]))
    .map(key => {
      const scalar = summarizeScalar(record[key])

      return scalar ? `${titleCase(key)}: ${scalar}` : ''
    })
    .filter(Boolean)
    .slice(0, 2)

  return pairs.length ? pairs.join(' · ') : pluralize(Object.keys(record).length, 'field')
}

function summarizeListItem(item: unknown, depth: number): string {
  const value = norm(item)

  if (typeof value === 'string') {
    return clipInline(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (value == null) {
    return ''
  }

  if (Array.isArray(value)) {
    return pluralize(value.length, 'item')
  }

  if (isRecord(value)) {
    return summarizeRecordInline(value, depth + 1)
  }

  return clipInline(String(value))
}

function formatFieldValue(input: unknown, depth: number): string {
  const value = norm(input)
  const scalar = summarizeScalar(value)

  if (scalar) {
    return scalar
  }

  if (value == null) {
    return ''
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      return ''
    }

    const scalars = value.map(summarizeScalar).filter(Boolean)

    if (scalars.length === value.length && value.length <= 4) {
      return clipInline(scalars.join(', '))
    }

    const first = summarizeListItem(value[0], depth + 1)

    return first ? `${pluralize(value.length, 'item')} (${first})` : pluralize(value.length, 'item')
  }

  if (isRecord(value)) {
    return summarizeRecordInline(value, depth + 1)
  }

  return clipInline(String(value))
}

// "Returned N items" / "0 items" / "Returned an empty object" are all noise —
// better to render nothing and let the tool's own title carry the signal.
function formatArraySummary(value: unknown[], depth: number): string {
  if (!value.length) {
    return ''
  }

  const max = 6

  const lines = value
    .slice(0, max)
    .map(item => summarizeListItem(item, depth + 1))
    .filter(Boolean)
    .map(line => `- ${line}`)

  if (!lines.length) {
    return ''
  }

  if (value.length > max) {
    const remaining = value.length - max

    lines.push(`- … ${remaining} more ${remaining === 1 ? 'item' : 'items'}`)
  }

  return lines.join('\n')
}

function formatRecordSummary(record: Json, depth: number): string {
  const keys = Object.keys(record)

  if (!keys.length) {
    return ''
  }

  if (depth <= 2) {
    const direct = firstString(record, ['message', 'summary', 'description', 'preview', 'text', 'content'])
    const meaningful = keys.filter(key => !skipField(key, record[key]) && !isWrapperKey(key))

    if (direct && meaningful.length <= 1) {
      return clipBlock(direct)
    }
  }

  const candidates = orderedKeys(keys).filter(key => !skipField(key, record[key]))
  const max = 8
  const lines: string[] = []

  for (const key of candidates) {
    const value = formatFieldValue(record[key], depth + 1)

    if (!value) {
      continue
    }

    lines.push(`- ${titleCase(key)}: ${value}`)

    if (lines.length >= max) {
      break
    }
  }

  if (!lines.length) {
    return ''
  }

  if (candidates.length > lines.length) {
    const remaining = candidates.length - lines.length

    lines.push(`- … ${remaining} more ${remaining === 1 ? 'field' : 'fields'}`)
  }

  return lines.join('\n')
}

function formatSummaryValue(input: unknown, depth: number): string {
  if (depth > 4) {
    return ''
  }

  const value = norm(input)

  if (typeof value === 'string') {
    return clipBlock(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (value == null) {
    return ''
  }

  if (Array.isArray(value)) {
    return formatArraySummary(value, depth + 1)
  }

  if (isRecord(value)) {
    return formatRecordSummary(value, depth + 1)
  }

  return clipInline(String(value))
}

function unwrapPayload(value: unknown): unknown {
  let current: unknown = norm(value)

  for (let round = 0; round < 4; round += 1) {
    if (!isRecord(current)) {
      return current
    }

    const record = current
    const key = WRAPPER_KEYS.find(candidate => record[candidate] != null)

    if (!key) {
      return record
    }

    current = norm(record[key])
  }

  return current
}

function hasMeaningfulErrorValue(input: unknown): boolean {
  const value = norm(input)

  if (value == null) {
    return false
  }

  if (typeof value === 'string') {
    return !NON_ERROR_TEXT.has(normalizeText(value))
  }

  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    return value !== 0
  }

  if (Array.isArray(value)) {
    return value.some(hasMeaningfulErrorValue)
  }

  if (isRecord(value)) {
    return Object.keys(value).length > 0
  }

  return true
}

function hasErrorSignal(record: Json): boolean {
  const status = typeof record.status === 'string' ? record.status : ''

  return (
    record.success === false ||
    record.ok === false ||
    /^(error|failed|failure|fatal|exception)$/i.test(status.trim()) ||
    ERROR_KEYS.some(key => hasMeaningfulErrorValue(record[key]))
  )
}

function valueErrorText(input: unknown): string {
  const value = norm(input)

  if (typeof value === 'string') {
    return hasMeaningfulErrorValue(value) ? clipBlock(value, 700, 12) : ''
  }

  if (Array.isArray(value)) {
    return clipBlock(value.map(valueErrorText).filter(Boolean).slice(0, 3).join('; '), 700, 12)
  }

  if (isRecord(value)) {
    const direct = firstString(value, ERROR_MSG_KEYS)

    if (direct) {
      return clipBlock(direct, 700, 12)
    }
  }

  return ''
}

function findNestedError(input: unknown, depth: number, seen: Set<unknown>, failed = false): string {
  if (depth > 5) {
    return ''
  }

  const value = norm(input)

  if (!value || typeof value !== 'object' || seen.has(value)) {
    return ''
  }

  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findNestedError(item, depth + 1, seen, failed)

      if (nested) {
        return nested
      }
    }

    return ''
  }

  const record = value as Json

  if (record.success === true || record.ok === true) {
    return ''
  }

  for (const key of ERROR_KEYS) {
    if (!hasMeaningfulErrorValue(record[key])) {
      continue
    }

    const text = valueErrorText(record[key])

    if (text) {
      return text
    }
  }

  if (hasErrorSignal(record)) {
    const direct = firstString(record, ERROR_MSG_KEYS)

    if (direct) {
      return clipBlock(direct, 700, 12)
    }
  }

  // Returned data and stdout can describe a failure without the tool having
  // failed. Only unwrap them to explain a failure the envelope already declared.
  const failureDeclared = failed || hasErrorSignal(record)
  const nestedKeys = failureDeclared ? [...ERROR_KEYS, ...WRAPPER_KEYS, 'details'] : ERROR_KEYS

  for (const key of nestedKeys) {
    const nested = findNestedError(record[key], depth + 1, seen, failureDeclared)

    if (nested) {
      return nested
    }
  }

  return ''
}

export function formatToolResultSummary(value: unknown): string {
  return formatSummaryValue(unwrapPayload(value), 0) || formatSummaryValue(value, 0)
}

export function extractToolErrorMessage(value: unknown): string {
  return findNestedError(value, 0, new Set())
}

/** `{ query: "release changelog" }` → readable key/value rows for the card. */
export function argumentRows(args: Record<string, unknown> | undefined): { key: string; value: string }[] {
  if (!args) {
    return []
  }

  return Object.entries(args).map(([key, value]) => ({
    key: titleCase(key),
    value: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }))
}
