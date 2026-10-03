/**
 * Which bot-to-bot rows roll up: more than three in a row, either direction,
 * a placeholder between them not counting and anything visible breaking the run.
 */
import type { VisibleItem } from '@hermie/transcript'
import { describe, expect, it } from 'vitest'

import { botDmInItem, botDmOutItem, toolItem, userItem } from '../../test-support/chat-fixtures'
import { type DmRollupItem, isRollupRow, ROLLUP_THRESHOLD, rollupDmRuns } from './dm-rollup'
import { transcriptRows } from './rows'

const visible = (item: VisibleItem['item'], presentation: VisibleItem['presentation'] = 'collapsed'): VisibleItem => ({
  item,
  presentation
})

const asides = (count: number, prefix = 'dm'): VisibleItem[] =>
  Array.from({ length: count }, (_, index) =>
    visible(
      index % 2
        ? botDmInItem(`in ${index}`, {}, `${prefix}-${index}`)
        : botDmOutItem(`out ${index}`, {}, `${prefix}-${index}`)
    )
  )

describe('rolling up bot-to-bot asides', () => {
  it('leaves a run of three alone and hands the same list back', () => {
    const rows = [visible(userItem('hi')), ...asides(ROLLUP_THRESHOLD)]

    expect(rollupDmRuns(rows)).toBe(rows)
  })

  it('rolls a run of four, both directions, into one row keyed on the first, carrying its members', () => {
    const rows = [visible(userItem('hi', {}, 'u')), ...asides(4), visible(userItem('bye', {}, 'v'))]
    const out = rollupDmRuns(rows)

    expect(out.map(row => row.item.id)).toEqual(['u', 'rollup:dm-0', 'v'])

    const rollup = out[1]?.item as DmRollupItem

    expect(isRollupRow(rollup)).toBe(true)
    expect(rollup.members.map(member => member.item.id)).toEqual(['dm-0', 'dm-1', 'dm-2', 'dm-3'])
    expect(rollup.handle).toBe('writer')
    expect(out[1]?.presentation).toBe('collapsed')
  })

  it('counts answered dispatches only, and names no teammate when the run touched two', () => {
    const rows = [
      visible(botDmOutItem('a', { reply: { text: 'ok' } }, 'a')),
      visible(botDmOutItem('b', { reply: { text: '', error: 'timed out' } }, 'b')),
      visible(botDmInItem('c', {}, 'c')),
      visible(botDmOutItem('d', { targetHandle: 'editor', target: '@editor' }, 'd'))
    ]
    const rollup = rollupDmRuns(rows)[0]?.item as DmRollupItem

    expect(rollup.replies).toBe(1)
    expect(rollup.handle).toBeUndefined()
  })

  it('does not let a placeholder break a run, and lets a visible row break it', () => {
    const quiet = [...asides(2, 'a'), visible(toolItem('shell', {}, 't'), 'hidden-placeholder'), ...asides(2, 'b')]

    expect(rollupDmRuns(quiet).map(row => row.item.id)).toEqual(['rollup:a-0'])

    const broken = [...asides(2, 'a'), visible(toolItem('shell', {}, 't')), ...asides(2, 'b')]

    expect(rollupDmRuns(broken)).toBe(broken)
  })

  it('changes the roll-up’s version when a member changes, and keeps it when nothing did', () => {
    const rows = asides(4)
    const first = rollupDmRuns(rows)[0]?.item
    const again = rollupDmRuns(asides(4))[0]?.item

    expect(again?.version).toBe(first?.version)

    const changed = rows.map((row, index) =>
      index === 2 ? { ...row, item: { ...row.item, version: row.item.version + 1 } } : row
    )

    expect(rollupDmRuns(changed)[0]?.item.version).not.toBe(first?.version)

    const demoted = rows.map(row => ({ ...row, presentation: 'chip' as const }))

    expect(rollupDmRuns(demoted)[0]?.item.version).not.toBe(first?.version)
  })

  it('runs before the date separators, so a roll-up opens its day like the aside it starts with', () => {
    const rows = transcriptRows([visible(userItem('hi', {}, 'u')), ...asides(5)], { busy: false, turnActive: false })

    expect(rows.map(row => row.item.id)).toEqual([expect.stringMatching(/^date:/u), 'u', 'rollup:dm-0'])
  })
})
