/**
 * The three durable identities the gateway can attach to what it sends.
 *
 * - a ROW is `messages.id`, the persisted row itself (`row_id`);
 * - a CALL is the assistant row that holds a `tool_calls` entry plus that
 *   entry's position in it (`call_row_id` + `call_index`), which stays unique
 *   per session however poorly a provider numbers its own `tool_id`;
 * - a TURN is the random id the gateway minted when it started the turn
 *   (`turn_id`), stamped on the user row's `display_metadata`.
 *
 * Every reader here is defensive in the same way: a value of the wrong type is
 * "absent", never half-trusted, because an absent identity sends the engine down
 * the path it had before any of this existed. Nothing here guesses.
 */

import type { TranscriptItem } from './types'

const positiveFinite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

function objectOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return objectOf(JSON.parse(value))
    } catch {
      return null
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The shape `callKeyOf` reads; a history row, a `tool.*` payload or a cached item all fit. */
export interface CallIdentity {
  call_row_id?: unknown
  call_index?: unknown
  [key: string]: unknown
}

/**
 * `"<call_row_id>/<call_index>"`, or `undefined` when either half is missing or
 * malformed. Both halves or nothing: a row id alone names the assistant row, not
 * the call.
 */
export function callKeyOf(record: CallIdentity | null | undefined): string | undefined {
  if (!record) {
    return undefined
  }

  const rowId = positiveFinite(record.call_row_id)
  const index = nonNegativeInteger(record.call_index)

  return rowId !== undefined && index !== undefined ? `${rowId}/${index}` : undefined
}

/**
 * `row_id` of a frame or a history row when it is a positive integer a number
 * can hold exactly. A row id is `messages.id`: a fractional or enormous one is
 * malformed, so it reads as absent (and the Swift port, whose model holds an
 * integer, says the same).
 */
export function rowIdOf(record: { row_id?: unknown } | null | undefined): number | undefined {
  const rowId = record ? positiveFinite(record.row_id) : undefined

  return rowId !== undefined && Number.isSafeInteger(rowId) ? rowId : undefined
}

/**
 * `turn_id` out of a user row's `display_metadata` (an object, or the JSON text
 * of one), when it is a non-empty string.
 */
export function turnIdOfMetadata(value: unknown): string | undefined {
  const turnId = objectOf(value)?.turn_id

  return typeof turnId === 'string' && turnId ? turnId : undefined
}

/**
 * The turn a row opened and the row it was, for each way an item can stand for
 * one: the item's own `turnId` and `rowId`, and, on a dispatch card that a
 * delivery row joined, the `reply`'s. A joined delivery leaves no item of its
 * own, so the card's reply is the only place that row is on screen.
 */
export function promptRowsOf(item: TranscriptItem): { turnId?: string; rowId?: number }[] {
  const rows: { turnId?: string; rowId?: number }[] = [{ turnId: item.turnId, rowId: item.rowId }]

  if (item.kind === 'bot_dm_out' && item.reply) {
    rows.push({ turnId: item.reply.turnId, rowId: item.reply.rowId })
  }

  return rows
}
