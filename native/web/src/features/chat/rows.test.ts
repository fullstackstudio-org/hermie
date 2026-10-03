import type { VisibleItem } from '@hermie/transcript'
import { describe, expect, it } from 'vitest'

import {
  assistantItem,
  botDmInItem,
  daysAfter,
  noticeItem,
  statusItem,
  toolItem,
  userItem
} from '../../test-support/chat-fixtures'
import { isRollupRow } from './dm-rollup'
import {
  DATE_ROW_KIND,
  dayKeyOf,
  GENERATING_ROW_KIND,
  isDateRow,
  isGeneratingRow,
  isTypingRow,
  transcriptRows,
  TYPING_ROW_ID
} from './rows'

const full = (item: VisibleItem['item']): VisibleItem => ({ item, presentation: 'full' })
const options = { busy: false, turnActive: false }
const ids = (rows: VisibleItem[]): string[] => rows.map(row => row.item.id)
const kinds = (rows: VisibleItem[]): string[] =>
  rows.map(row => (isDateRow(row.item) ? 'date' : isTypingRow(row.item) ? 'typing' : row.item.kind))

describe('date separators', () => {
  it('opens each day with one row of its own, in front of the day’s first row', () => {
    const rows = transcriptRows(
      [
        full(userItem('a', { ts: daysAfter(0, 3600) }, 'a')),
        full(assistantItem('b', { ts: daysAfter(0, 3700) }, 'b')),
        full(userItem('c', { ts: daysAfter(1, 3600) }, 'c')),
        full(assistantItem('d', { ts: daysAfter(1, 3700) }, 'd'))
      ],
      options
    )

    expect(kinds(rows)).toEqual(['date', 'user', 'assistant', 'date', 'user', 'assistant'])
    expect(rows.filter(row => isDateRow(row.item)).map(row => (row.item as { text: string }).text)).toEqual([
      String(dayKeyOf(new Date(daysAfter(0, 3600) * 1000))),
      String(dayKeyOf(new Date(daysAfter(1, 3600) * 1000)))
    ])
  })

  it('names the row it opens in its key, so a page of older history takes the separator off it', () => {
    const newer = [full(userItem('c', { ts: daysAfter(0, 7200) }, 'c'))]
    const older = [full(userItem('b', { ts: daysAfter(0, 3600) }, 'b'))]

    const before = transcriptRows(newer, options).filter(row => isDateRow(row.item))
    const after = transcriptRows([...older, ...newer], options).filter(row => isDateRow(row.item))

    expect(ids(before)).toEqual([`date:${dayKeyOf(new Date(daysAfter(0, 7200) * 1000))}:c`])
    expect(ids(after)).toEqual([`date:${dayKeyOf(new Date(daysAfter(0, 3600) * 1000))}:b`])
    expect(ids(before)).not.toEqual(ids(after))
  })

  it('does not open a day twice for a row stamped out of order', () => {
    const rows = transcriptRows(
      [
        full(userItem('a', { ts: daysAfter(1, 3600) }, 'a')),
        full(userItem('b', { ts: daysAfter(0, 3600) }, 'b')),
        full(userItem('c', { ts: daysAfter(1, 7200) }, 'c'))
      ],
      options
    )

    // A, then B (a day earlier: a new separator), then C (back on the first day: a third).
    expect(kinds(rows).filter(kind => kind === 'date')).toHaveLength(3)

    const sameDay = transcriptRows(
      [
        full(userItem('a', { ts: daysAfter(0, 7200) }, 'a')),
        full(userItem('b', { ts: daysAfter(0, 3600) }, 'b')),
        full(userItem('c', { ts: daysAfter(0, 9000) }, 'c'))
      ],
      options
    )

    expect(kinds(sameDay).filter(kind => kind === 'date')).toHaveLength(1)
  })

  it('gives a row with no stamp no separator, and a row that draws nothing opens no day', () => {
    const rows = transcriptRows(
      [
        { item: userItem('hidden', { ts: daysAfter(0, 60) }, 'hidden'), presentation: 'hidden-placeholder' },
        full(userItem('plain', { ts: undefined }, 'plain')),
        full(assistantItem('seen', { ts: daysAfter(0, 120) }, 'seen'))
      ],
      options
    )

    expect(kinds(rows)).toEqual(['user', 'user', 'date', 'assistant'])
    expect(ids(rows)).toEqual(['hidden', 'plain', expect.stringMatching(/^date:\d+:seen$/), 'seen'])
  })

  it('uses a status item under a kind the gateway cannot send', () => {
    const [separator] = transcriptRows([full(userItem('a', { ts: daysAfter(0, 60) }, 'a'))], options)

    expect(separator?.item).toMatchObject({ kind: 'status', statusKind: DATE_ROW_KIND, version: 0 })
  })
})

describe('the status line', () => {
  const chip = (text: string): VisibleItem => ({ item: statusItem(text, { ts: undefined }, 's'), presentation: 'chip' })

  it('is kept while something runs, and dropped when nothing does', () => {
    const rows = [full(userItem('a', { ts: undefined }, 'a')), chip('compacting')]

    expect(ids(transcriptRows(rows, { busy: true, turnActive: false }))).toEqual(['a', 's'])
    expect(ids(transcriptRows(rows, { busy: false, turnActive: false }))).toEqual(['a'])
  })

  it('is kept at the verbose level, where the status row is a full row of its own', () => {
    const rows = [{ item: statusItem('x', { ts: undefined }, 's'), presentation: 'full' as const }]

    expect(ids(transcriptRows(rows, options))).toEqual(['s'])
  })
})

describe('the typing row', () => {
  const user = full(userItem('hello', { ts: undefined }, 'u'))

  it('shows after the reader’s own message while the turn runs and nothing has been said back', () => {
    const rows = transcriptRows([user], { busy: true, turnActive: true })

    expect(ids(rows)).toEqual(['u', TYPING_ROW_ID])
    expect(kinds(rows)).toEqual(['user', 'typing'])
  })

  it('is not drawn once there is a reply, which holds the dots itself', () => {
    const reply = full(assistantItem('', { streaming: true, ts: undefined }, 'a'))

    expect(ids(transcriptRows([user, reply], { busy: true, turnActive: true }))).toEqual(['u', 'a'])
  })

  it('is not drawn after a tool or a notice, nor when the turn is not running', () => {
    const tool = full(toolItem('run', { status: 'running', ts: undefined }, 't'))
    const notice = full(noticeItem('Switched model', { ts: undefined }, 'n'))

    expect(ids(transcriptRows([user, tool], { busy: true, turnActive: true }))).toEqual(['u', 't'])
    expect(ids(transcriptRows([user, notice], { busy: true, turnActive: true }))).toEqual(['u', 'n'])
    expect(ids(transcriptRows([user], { busy: false, turnActive: false }))).toEqual(['u'])
  })

  it('shows in an empty chat whose turn has started, and ignores a hidden row at the end', () => {
    expect(ids(transcriptRows([], { busy: true, turnActive: true }))).toEqual([TYPING_ROW_ID])

    const hidden: VisibleItem = { item: userItem('x', { ts: undefined }, 'h'), presentation: 'hidden-placeholder' }

    expect(ids(transcriptRows([user, hidden], { busy: true, turnActive: true }))).toEqual(['u', 'h', TYPING_ROW_ID])
  })
})

describe('the tool being written', () => {
  const user = full(userItem('go', { ts: undefined }, 'u'))
  const reply = full(assistantItem('Let me look.', { ts: undefined, streaming: true }, 'a'))

  it('takes the typing row’s place at the tail while the turn runs, carrying the name', () => {
    const rows = transcriptRows([user], { busy: true, turnActive: true, draftingTool: 'terminal' })
    const last = rows.at(-1)!.item

    expect(ids(rows)).toEqual(['u', `${GENERATING_ROW_KIND}:terminal`])
    expect(isGeneratingRow(last)).toBe(true)
    expect(isTypingRow(last)).toBe(false)
    expect((last as { text: string }).text).toBe('terminal')
  })

  it('follows a reply that is already on screen, where the typing row would not be', () => {
    const rows = transcriptRows([user, reply], { busy: true, turnActive: true, draftingTool: 'read_file' })

    expect(ids(rows)).toEqual(['u', 'a', `${GENERATING_ROW_KIND}:read_file`])
  })

  it('is a new row for a new name, so the list draws it', () => {
    const first = transcriptRows([user], { busy: true, turnActive: true, draftingTool: 'terminal' })
    const second = transcriptRows([user], { busy: true, turnActive: true, draftingTool: 'web_search' })

    expect(first.at(-1)!.item.id).not.toBe(second.at(-1)!.item.id)
  })

  it('is not drawn once the turn has ended, nor for a blank name', () => {
    expect(ids(transcriptRows([user], { busy: false, turnActive: false, draftingTool: 'terminal' }))).toEqual(['u'])
    expect(ids(transcriptRows([user], { busy: true, turnActive: true, draftingTool: '  ' }))).toEqual([
      'u',
      TYPING_ROW_ID
    ])
    // Nothing left once cleaned: the turn still shows its dots.
    expect(ids(transcriptRows([user], { busy: true, turnActive: true, draftingTool: '\u200b\u0007' }))).toEqual([
      'u',
      TYPING_ROW_ID
    ])
  })

  it('stays at the tail after a run of bot-to-bot asides is rolled up', () => {
    const asides = [1, 2, 3, 4].map(index => full(botDmInItem(`aside ${index}`, { ts: undefined }, `dm${index}`)))
    const rows = transcriptRows([user, ...asides], { busy: true, turnActive: true, draftingTool: 'terminal' })

    expect(rows.some(row => isRollupRow(row.item))).toBe(true)
    expect(rows.at(-1)!.item.id).toBe(`${GENERATING_ROW_KIND}:terminal`)
    expect(rows.filter(row => isGeneratingRow(row.item))).toHaveLength(1)
  })

  it('carries the name as the row shows it, cleaned', () => {
    const rows = transcriptRows([user], { busy: true, turnActive: true, draftingTool: 'web\u202esearch ' })

    expect(rows.at(-1)!.item.id).toBe(`${GENERATING_ROW_KIND}:websearch`)
  })
})
