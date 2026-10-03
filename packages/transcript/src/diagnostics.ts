/**
 * What to look at when a chat shows something twice.
 *
 * A duplicate is hard to report from a phone: the evidence is a screenshot of
 * two bubbles, which says nothing about WHICH path put the second one there.
 * This answers that in numbers a developer screen can show and a reader can
 * paste into an issue — how many items the transcript holds, how many the
 * gateway has given a durable row id, and which items are carrying the same
 * text as another.
 *
 * Nothing here reads message text out. A repeated text is reported as a
 * fingerprint — a 32-bit digest and a length — so two items can be shown to
 * hold the same words without the words leaving the device.
 */
import { normalizedItemText } from './rows-to-items'
import type { ChatState, ItemOrigin, TranscriptItem, TranscriptItemKind } from './types'

/** One text that more than one item is carrying. */
export interface RepeatedText {
  kind: TranscriptItemKind
  /** A digest of the normalised text; not reversible, and not a secret either. */
  fingerprint: string
  /** Characters in the normalised text, which is often enough to recognise it. */
  length: number
  items: { id: string; origin: ItemOrigin; rowId?: number; seq: number }[]
}

export interface TranscriptDiagnostics {
  items: number
  /** Items the gateway has given a durable row id. */
  persisted: number
  /**
   * Items with no row id that a re-description could still pair with — the
   * optimistic bubble, the streaming reply, a resume projection. A number that
   * stays above zero while nothing is running is the shape of this bug.
   */
  unpaired: number
  /** Items on screen standing in for an author a tail fetch has not named yet. */
  placeholders: number
  /** Tool-like items carrying the gateway's call identity (`callKey`). */
  withCallKey: number
  /** User items carrying the gateway's turn id (`turnId`). */
  withTurnId: number
  repeated: RepeatedText[]
  highestRowId?: number
  lastSeq: number
  lastSeqSessionId?: string
  epoch?: string
  hydration: ChatState['hydration']
  turnActive: boolean
  turnLocal: boolean
  foreignReconcilePending: boolean
  /** A prompt the gateway parked, if the transcript believes one is waiting. */
  parkedPrompts: number
}

/** Items the backend never persists, so an absent row id means nothing for them. */
const isEphemeral = (item: TranscriptItem): boolean =>
  item.kind === 'approval' || item.kind === 'clarify' || item.kind === 'status'

/**
 * FNV-1a, 32 bits, hex. Deliberately not a cryptographic hash: it is a label
 * that makes two equal strings look equal in a bug report, nothing more.
 */
export function textFingerprint(text: string): string {
  let hash = 0x811c9dc5

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function transcriptDiagnostics(state: ChatState): TranscriptDiagnostics {
  const byText = new Map<string, RepeatedText>()
  let persisted = 0
  let unpaired = 0
  let placeholders = 0
  let withCallKey = 0
  let withTurnId = 0
  let parkedPrompts = 0
  let highestRowId: number | undefined

  for (const id of state.order) {
    const item = state.items[id]

    if (!item) {
      continue
    }

    if (item.rowId !== undefined) {
      persisted += 1
      highestRowId = highestRowId === undefined ? item.rowId : Math.max(highestRowId, item.rowId)
    } else if (!isEphemeral(item)) {
      unpaired += 1
    }

    if (item.kind === 'user' && item.unknownAuthor) {
      placeholders += 1
    }

    if ((item.kind === 'tool' || item.kind === 'bot_dm_out' || item.kind === 'subagent_group') && item.callKey) {
      withCallKey += 1
    }

    if (item.kind === 'user' && item.turnId) {
      withTurnId += 1
    }

    if (item.kind === 'user' && item.origin === 'optimistic' && item.pending === true) {
      parkedPrompts += 1
    }

    const text = normalizedItemText(item)

    if (!text) {
      continue
    }

    const key = `${item.kind}\n${text}`
    const entry = byText.get(key) ?? {
      kind: item.kind,
      fingerprint: textFingerprint(text),
      length: text.length,
      items: []
    }

    entry.items.push({
      id: item.id,
      origin: item.origin,
      ...(item.rowId !== undefined ? { rowId: item.rowId } : {}),
      seq: item.seq
    })
    byText.set(key, entry)
  }

  return {
    items: state.order.length,
    persisted,
    unpaired,
    placeholders,
    withCallKey,
    withTurnId,
    repeated: [...byText.values()].filter(entry => entry.items.length > 1),
    ...(highestRowId !== undefined ? { highestRowId } : {}),
    lastSeq: state.lastSeq,
    ...(state.lastSeqSessionId !== undefined ? { lastSeqSessionId: state.lastSeqSessionId } : {}),
    ...(state.epoch !== undefined ? { epoch: state.epoch } : {}),
    hydration: state.hydration,
    turnActive: state.turn.active,
    turnLocal: state.turn.local,
    foreignReconcilePending: state.turn.foreignReconcilePending === true,
    parkedPrompts
  }
}

/**
 * One line per finding, for a screen that has no room for a table.
 *
 * Written to be pasteable into a bug report as-is: it names the paths rather
 * than the content, so "two user items, one with a row id and one without,
 * same fingerprint" reads as a diagnosis.
 */
export function formatTranscriptDiagnostics(botName: string, state: ChatState): string[] {
  const report = transcriptDiagnostics(state)
  const lines = [
    `${botName}: ${report.items} items, ${report.persisted} persisted, ${report.unpaired} unpaired`,
    `${botName}: ${report.hydration}, turn ${report.turnActive ? 'running' : 'idle'}` +
      `${report.turnLocal ? ' (ours)' : ''}` +
      `${report.foreignReconcilePending ? ', tail pending' : ''}` +
      `${report.parkedPrompts ? `, ${report.parkedPrompts} parked` : ''}` +
      `${report.placeholders ? `, ${report.placeholders} unnamed` : ''}`,
    `${botName}: ${report.withCallKey} with call key, ${report.withTurnId} with turn id`
  ]

  for (const entry of report.repeated) {
    const where = entry.items
      .map(item => `${item.origin}${item.rowId !== undefined ? `#${item.rowId}` : ''}`)
      .join(' + ')

    lines.push(`${botName}: ${entry.items.length}x ${entry.kind} ${entry.fingerprint}/${entry.length} — ${where}`)
  }

  return lines
}
