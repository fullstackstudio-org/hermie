import { describe, expect, it } from 'vitest'

import { formatTranscriptDiagnostics, transcriptDiagnostics } from './diagnostics'
import { reconcileTail } from './reconcile'
import { applyResumeSnapshot, beginLocalTurn, confirmSubmit } from './reducer'
import { rowsToItems } from './rows-to-items'
import { createChatState } from './types'

const NOW = 1_700_000_000_000
const fresh = () => createChatState('researcher', 'stored-1', 'resolved-1')

describe('transcriptDiagnostics', () => {
  it('counts what the gateway has given a row id and what it has not', () => {
    const loaded = reconcileTail(fresh(), rowsToItems([{ role: 'user', row_id: 4, text: 'hello' }], 'rest'))
    const sent = confirmSubmit(beginLocalTurn(loaded, 'and this', undefined, NOW), { status: 'streaming' }, NOW)
    const report = transcriptDiagnostics(sent)

    expect(report).toMatchObject({ items: 2, persisted: 1, unpaired: 1, highestRowId: 4, repeated: [] })
  })

  it('names the two items carrying the same text, without carrying the text', () => {
    // The shape of the reported bug, forced by hand: a resume projection beside
    // the row it describes.
    const withRow = reconcileTail(fresh(), rowsToItems([{ role: 'user', row_id: 4, text: 'hello' }], 'rest'))
    const doubled = applyResumeSnapshot(
      { ...withRow, items: { ...withRow.items }, order: [...withRow.order] },
      { inflight: { user: 'elsewhere' } },
      NOW
    )
    const forced = reconcileTail(doubled, rowsToItems([{ role: 'user', row_id: 5, text: 'elsewhere' }], 'rest'))
    const report = transcriptDiagnostics({
      ...forced,
      items: { ...forced.items, dup: { ...forced.items[forced.order[1]!]!, id: 'dup', rowId: undefined } },
      order: [...forced.order, 'dup']
    })

    expect(report.repeated).toHaveLength(1)
    expect(report.repeated[0]?.items).toHaveLength(2)
    expect(JSON.stringify(report)).not.toContain('elsewhere')
  })

  it('formats a line per finding that names paths rather than content', () => {
    const sent = confirmSubmit(beginLocalTurn(fresh(), 'a secret plan', undefined, NOW), { status: 'queued' }, NOW)
    const lines = formatTranscriptDiagnostics('researcher', sent)

    expect(lines[0]).toBe('researcher: 1 items, 0 persisted, 1 unpaired')
    expect(lines[1]).toContain('1 parked')
    expect(lines.join('\n')).not.toContain('secret')
  })

  it('counts the items that carry the gateway identities and prints it on one line', () => {
    const loaded = reconcileTail(
      fresh(),
      rowsToItems(
        [
          { role: 'user', row_id: 1, text: 'hi', display_metadata: { turn_id: 't-1' } },
          { role: 'tool', name: 'read_file', tool_id: 'c0', row_id: 3, call_row_id: 2, call_index: 0 },
          { role: 'tool', name: 'read_file', tool_id: 'c1', row_id: 5 }
        ],
        'rpc'
      )
    )

    expect(transcriptDiagnostics(loaded)).toMatchObject({ withCallKey: 1, withTurnId: 1 })
    expect(formatTranscriptDiagnostics('researcher', loaded)).toContain('researcher: 1 with call key, 1 with turn id')
  })
})
