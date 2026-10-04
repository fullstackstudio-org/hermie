/**
 * The Activity timeline's days and the words its rows ask a chat to find.
 */
import type { ActivityEntry } from '@hermie/transcript'
import { afterEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { resetLocale } from '../../i18n/locale'
import { findQueryFor, groupByDay } from './activity-model'

afterEach(() => {
  resetLocale()
  resetActiveLocale()
})

/** Wednesday 1 October 2026, 14:00 in whatever zone the test runs in. */
const NOW = new Date(2026, 9, 1, 14, 0, 0).getTime()
const sec = (date: Date): number => Math.floor(date.getTime() / 1000)

const entry = (id: string, at: number, patch: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id,
  botName: 'researcher',
  itemId: id,
  kind: 'dm_out',
  at,
  fromHandle: 'researcher',
  toHandle: 'writer',
  text: 'hello',
  ...patch
})

describe('groupByDay', () => {
  it('puts the newest day first and the newest row first inside it', () => {
    const entries = [
      entry('old', sec(new Date(2026, 8, 20, 9))),
      entry('yesterday', sec(new Date(2026, 8, 30, 23))),
      entry('morning', sec(new Date(2026, 9, 1, 8))),
      entry('noon', sec(new Date(2026, 9, 1, 12)))
    ]
    const days = groupByDay(entries, NOW)

    expect(days.map(day => day.entries.map(e => e.id))).toEqual([['noon', 'morning'], ['yesterday'], ['old']])
    expect(days.map(day => day.label)).toEqual(['Today', 'Yesterday', expect.stringMatching(/20/)])
  })

  it('names a day by its date in the reader’s calendar, so a row arriving keeps its section', () => {
    const days = groupByDay([entry('a', sec(new Date(2026, 9, 1, 8))), entry('b', sec(new Date(2026, 9, 1, 12)))], NOW)

    expect(days).toHaveLength(1)
    expect(days[0]?.key).toBe('2026-10-01')
  })

  it('keeps an undated row in a section of its own rather than losing it', () => {
    expect(groupByDay([entry('x', 0)], NOW)[0]?.key).toBe('undated')
  })

  it('has nothing to group where there is nothing', () => {
    expect(groupByDay([], NOW)).toEqual([])
  })
})

describe('findQueryFor', () => {
  it('asks for the opening of the message as one quoted phrase', () => {
    expect(findQueryFor({ kind: 'dm_out', text: 'Can you draft the announcement?' })).toBe(
      '"Can you draft the announcement?"'
    )
  })

  it('cuts a long message at a word, and drops the ellipsis the timeline added', () => {
    const query = findQueryFor({
      kind: 'dm_in',
      text: 'Which sources back the retry claim in the long post, and where are the links to them…'
    })

    expect(query.startsWith('"Which sources back')).toBe(true)
    expect(query.endsWith('"')).toBe(true)
    expect(query.length).toBeLessThanOrEqual(50)
    expect(query).not.toContain('…')
    expect(query).not.toMatch(/ "$/u)
  })

  it('removes quotes from the phrase: a quote would end it', () => {
    expect(findQueryFor({ kind: 'dm_reply', text: 'He said "yes" twice' })).toBe('"He said yes twice"')
  })

  it('asks for nothing where a row has no words of its own', () => {
    expect(findQueryFor({ kind: 'delegation', text: 'goal one · goal two' })).toBe('')
    expect(findQueryFor({ kind: 'dm_out', text: ' ok ' })).toBe('')
  })
})
