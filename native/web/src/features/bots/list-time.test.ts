import { afterEach, describe, expect, it } from 'vitest'

import { resetActiveLocale, setActiveLocale } from '../../i18n/active-locale'
import { formatListTime } from './list-time'

afterEach(() => {
  resetActiveLocale()
})

/** A local time, so the test does not depend on the machine's zone. */
const at = (year: number, month: number, day: number, hour = 12, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute).getTime() / 1000

const NOW = at(2026, 9, 24, 14, 30)

describe('formatListTime', () => {
  it('is empty for no time', () => {
    expect(formatListTime(undefined, NOW)).toBe('')
    expect(formatListTime(0, NOW)).toBe('')
    expect(formatListTime(-5, NOW)).toBe('')
    expect(formatListTime(Number.NaN, NOW)).toBe('')
  })

  it('says Now inside a minute, in the active language', () => {
    expect(formatListTime(NOW - 30, NOW)).toBe('Now')

    setActiveLocale('nl')
    expect(formatListTime(NOW - 30, NOW)).toBe('Nu')

    setActiveLocale('de')
    expect(formatListTime(NOW - 30, NOW)).toBe('Jetzt')
  })

  it('is the clock for earlier today', () => {
    expect(formatListTime(at(2026, 9, 24, 9, 5), NOW)).toMatch(/9:05|09:05/)
  })

  it('is the weekday inside the past week, and the day and month beyond', () => {
    expect(formatListTime(at(2026, 9, 22), NOW)).toBe('Tue')
    expect(formatListTime(at(2026, 8, 30), NOW)).toBe('Aug 30')
  })

  it('writes the weekday and the month in the reader’s language and order', () => {
    setActiveLocale('de')

    expect(formatListTime(at(2026, 9, 22), NOW)).toBe('Di')
    expect(formatListTime(at(2026, 8, 30), NOW)).toMatch(/^30\. Aug/)

    setActiveLocale('nl')

    expect(formatListTime(at(2026, 8, 30), NOW)).toBe('30 aug')
  })
})
