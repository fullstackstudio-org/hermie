import { afterEach, describe, expect, it } from 'vitest'

import { resetActiveLocale, setActiveLocale } from './active-locale'
import { formatList, formatNumber, formatRelative, intlLocale, plural, pluralCount } from './format'

afterEach(() => {
  resetActiveLocale()
})

describe('format', () => {
  it('hands Intl the bare language tag', () => {
    expect(intlLocale()).toBe('en')
    setActiveLocale('de')
    expect(intlLocale()).toBe('de')
  })

  it('picks a plural form and puts the grouped number in', () => {
    const forms = { one: '# message', other: '# messages' }

    expect(plural(1, forms)).toBe('# message')
    expect(pluralCount(1024, forms)).toBe('1,024 messages')

    setActiveLocale('nl')
    expect(pluralCount(1024, { one: '# bericht', other: '# berichten' })).toBe('1.024 berichten')
    expect(pluralCount(1, { one: '# bericht', other: '# berichten' })).toBe('1 bericht')
  })

  it('falls back to other for a form the language needs and the caller did not write', () => {
    expect(plural(5, { other: 'many' })).toBe('many')
    expect(plural(1, { other: 'any' })).toBe('any')
  })

  it('formats numbers the way the language groups them', () => {
    expect(formatNumber(1234567.5)).toBe('1,234,567.5')

    setActiveLocale('de')
    expect(formatNumber(1234567.5)).toBe('1.234.567,5')
  })

  it('says a relative time in the language, with the sign choosing past or future', () => {
    expect(formatRelative(-3 * 60 * 1000)).toBe('3 minutes ago')

    setActiveLocale('de')
    expect(formatRelative(-3 * 60 * 1000)).toBe('vor 3 Minuten')
    expect(formatRelative(2 * 60 * 1000)).toBe('in 2 Minuten')
  })

  it('joins a list the way the language does', () => {
    expect(formatList(['a', 'b', 'c'])).toBe('a, b, or c')
    expect(formatList(['a'])).toBe('a')
    expect(formatList([])).toBe('')

    setActiveLocale('nl')
    expect(formatList(['a', 'b', 'c'], 'conjunction')).toBe('a, b en c')
  })
})
