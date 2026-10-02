/**
 * Numbers, dates, plurals and statuses in the reader's language.
 *
 * All of this is `Intl`, which is the point: a hand-rolled `count === 1` and a
 * hand-rolled `DD/MM` both look right in the two languages somebody tested and
 * are wrong in the third. What is worth testing is not that `Intl` works but
 * that the app HANDS IT the active locale — the failure these guard against is
 * a formatter built once, at import, against whatever locale was live then.
 */
import { resetActiveLocale, setActiveLocale } from '../src/i18n/active-locale'
import { formatDate, formatList, formatNumber, formatRelative, plural, pluralCount } from '../src/i18n/format'
import { humaniseStatus } from '../src/i18n/humanise'

afterEach(() => {
  resetActiveLocale()
})

/** A fixed instant, so the assertions are about locale rather than about today. */
const MOMENT = Date.UTC(2026, 8, 22, 14, 30)

describe('numbers', () => {
  it('follows the locale into the separators', () => {
    expect(formatNumber(1234567.5)).toBe('1,234,567.5')

    setActiveLocale('nl')

    expect(formatNumber(1234567.5)).toBe('1.234.567,5')

    setActiveLocale('de')

    expect(formatNumber(1234567.5)).toBe('1.234.567,5')
  })
})

describe('dates', () => {
  it('follows the locale into the order of the parts', () => {
    const english = formatDate(MOMENT, { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' })

    setActiveLocale('nl')

    const dutch = formatDate(MOMENT, { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' })

    // American month-first against European day-first. Asserting they DIFFER
    // rather than asserting two exact strings keeps this about the locale
    // reaching the formatter and not about one ICU version's punctuation.
    expect(dutch).not.toBe(english)
    expect(dutch.startsWith('22')).toBe(true)
  })
})

describe('plurals', () => {
  it('picks the form the language uses', () => {
    const forms = { one: '# line', other: '# lines' }

    expect(pluralCount(1, forms)).toBe('1 line')
    expect(pluralCount(2, forms)).toBe('2 lines')
    // Grouping and the plural form in one call, which is the pair a caller that
    // formatted the number separately gets wrong.
    expect(pluralCount(1234, forms)).toBe('1,234 lines')
  })

  it("uses the active locale's rules rather than a count check", () => {
    setActiveLocale('nl')

    expect(plural(1, { one: 'regel', other: 'regels' })).toBe('regel')
    expect(plural(0, { one: 'regel', other: 'regels' })).toBe('regels')
  })

  it('falls back to `other` for a form the caller did not write', () => {
    expect(plural(1, { other: 'items' })).toBe('items')
  })
})

describe('relative time', () => {
  it('speaks the active language', () => {
    setActiveLocale('de')

    const german = formatRelative(-3 * 60 * 1000)

    resetActiveLocale()

    expect(formatRelative(-3 * 60 * 1000)).toMatch(/minutes ago/u)
    expect(german).not.toBe(formatRelative(-3 * 60 * 1000))
  })
})

describe('lists', () => {
  it('joins the way the language joins', () => {
    expect(formatList(['a'])).toBe('a')
    expect(formatList(['http', 'https'])).toMatch(/or/u)

    setActiveLocale('nl')

    expect(formatList(['http', 'https'])).toMatch(/of/u)
  })
})

describe('gateway statuses', () => {
  it("uses the reader's word where there is one", () => {
    expect(humaniseStatus('ok')).toBe('Success')

    setActiveLocale('nl')

    expect(humaniseStatus('ok')).toBe('Gelukt')
    expect(humaniseStatus('success')).toBe('Gelukt')

    setActiveLocale('de')

    expect(humaniseStatus('timed_out')).toBe('Zeitüberschreitung')
  })

  it('falls back to the English label rather than to the raw value', () => {
    setActiveLocale('nl')

    // A status the app knows in English and the catalogue has no word for is
    // still a status the app knows. Printing `rate_limited` at a Dutch reader
    // would be worse than printing an English label.
    expect(humaniseStatus('rate_limited')).toBe('Rate limited')
  })

  it('still answers nothing for nothing', () => {
    setActiveLocale('de')

    expect(humaniseStatus('')).toBeNull()
    expect(humaniseStatus(null)).toBeNull()
  })
})
