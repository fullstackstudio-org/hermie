/**
 * The structured fields of a `confirm` (`contract/confirm-passkey` §4.1): the key facts of an action (an amount, a
 * recipient, a model, ...) the gateway builds and the sheet shows apart from the summary.
 *
 * **What the reader promises.** A frame whose `fields` break the contract (the count, a key, an `id`, a `kind`, a length,
 * a `currency` on anything but an `amount`, a refused character) is REFUSED as a whole: the caller answers 4040 and the
 * sheet shows none of it, never part of it. A string that passes is returned EXACTLY as it came: no trimming, cleaning
 * or normalising, because the passkey challenge commits to those very strings and the sheet draws them. Nothing here
 * parses, rounds, localises or links a value.
 */
import { lineCharProblem } from '../requests/interactive-types'
import type { ConfirmField, ConfirmFieldKind } from './challenge'

/** The kinds of §4.1, which decide how a field is drawn. */
export const CONFIRM_FIELD_KINDS: readonly ConfirmFieldKind[] = [
  'amount',
  'text',
  'recipient',
  'domain',
  'model',
  'count',
  'date'
]

/** §4.1's limits, in code points. */
export const CONFIRM_FIELD_LIMITS = Object.freeze({ fields: 8, label: 40, value: 200, currency: 16, spaceRun: 16 })

const FIELD_ID = /^[a-z][a-z0-9_]{0,31}$/u
const KEYS: ReadonlySet<string> = new Set(['id', 'kind', 'label', 'value', 'currency'])

/** `fields` read, or refused. `fields` is undefined for a frame that has none. */
export type ConfirmFieldsRead = { ok: true; fields: readonly ConfirmField[] | undefined } | { ok: false }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * One line of §4.1 text: `max` code points at most, at least one, and the verbatim character rules of
 * `contract/requests` §6.2 (no line break of any kind, no control, format or invisible character, no whitespace but
 * U+0020, at most four combining marks in a row) plus no space at either end and no run of more than 16 spaces.
 */
function oneLine(value: unknown, max: number): value is string {
  if (typeof value !== 'string') {
    return false
  }

  const length = Array.from(value).length

  return (
    length >= 1 &&
    length <= max &&
    !value.startsWith(' ') &&
    !value.endsWith(' ') &&
    !new RegExp(` {${CONFIRM_FIELD_LIMITS.spaceRun + 1},}`, 'u').test(value) &&
    !lineCharProblem(value)
  )
}

/** The fields of a `confirm` frame's params: absent, or 1 to 8 objects the contract describes (`null` is not absent). */
export function readConfirmFields(raw: unknown): ConfirmFieldsRead {
  if (raw === undefined) {
    return { ok: true, fields: undefined }
  }

  if (!Array.isArray(raw) || raw.length < 1 || raw.length > CONFIRM_FIELD_LIMITS.fields) {
    return { ok: false }
  }

  const ids = new Set<string>()
  const fields: ConfirmField[] = []

  for (const entry of raw as unknown[]) {
    if (!isRecord(entry) || Object.keys(entry).some(key => !KEYS.has(key))) {
      return { ok: false }
    }

    const { id, kind, label, value, currency } = entry

    if (
      typeof id !== 'string' ||
      !FIELD_ID.test(id) ||
      ids.has(id) ||
      !CONFIRM_FIELD_KINDS.includes(kind as ConfirmFieldKind) ||
      !oneLine(label, CONFIRM_FIELD_LIMITS.label) ||
      !oneLine(value, CONFIRM_FIELD_LIMITS.value)
    ) {
      return { ok: false }
    }

    // A currency belongs to an amount and to nothing else; when it is there it is a line like the rest.
    if (currency !== undefined && (kind !== 'amount' || !oneLine(currency, CONFIRM_FIELD_LIMITS.currency))) {
      return { ok: false }
    }

    ids.add(id)
    fields.push({
      id,
      kind: kind as ConfirmFieldKind,
      label,
      value,
      ...(currency === undefined ? {} : { currency: currency as string })
    })
  }

  return { ok: true, fields }
}
