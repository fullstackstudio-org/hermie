/**
 * Numbers, dates and plurals in the reader's language.
 *
 * All of it through `Intl`, none of it through a table. English and Dutch both
 * have a one/other split and German agrees with them, so a hand-rolled
 * `count === 1` would look right today and be wrong the moment a fourth
 * language arrives — `Intl.PluralRules` already knows, and it is in every
 * engine this app runs on.
 *
 * Every entry point is wrapped. Hermes-the-engine ships a full ICU, and the
 * browser build has one too, but an old Android build without it should lose a
 * thousands separator rather than the screen.
 */
import { activeLocale } from './active-locale'
import type { Locale } from './locales'

/** The BCP-47 tag `Intl` is handed. Region-free: see `asLocale` in `locales.ts`. */
export function intlLocale(locale: Locale = activeLocale()): string {
  return locale
}

/**
 * The plural forms a string needs, named the way CLDR names them.
 *
 * `other` is required and the rest are not, which is the shape every language
 * this app speaks actually needs — and a language that needs `few` can add it
 * here without every caller growing a branch.
 */
export interface PluralForms {
  zero?: string
  one?: string
  two?: string
  few?: string
  many?: string
  other: string
}

/** Pick the form `count` takes in the active language. */
export function plural(count: number, forms: PluralForms): string {
  const category = pluralCategory(count)

  return forms[category] ?? forms.other
}

function pluralCategory(count: number): keyof PluralForms {
  try {
    return new Intl.PluralRules(intlLocale()).select(count) as keyof PluralForms
  } catch {
    return count === 1 ? 'one' : 'other'
  }
}

/**
 * `count` in the reader's digits and grouping, with its noun.
 *
 * One call rather than two because the two are never right apart: a Dutch
 * "1.024 berichten" needs both the separator and the plural form, and a caller
 * that formatted the number and then picked the word by hand got one of them.
 */
export function pluralCount(count: number, forms: PluralForms): string {
  return plural(count, forms).replace('#', formatNumber(count))
}

/** A number with the active locale's grouping and decimal marks. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(intlLocale(), options).format(value)
  } catch {
    return String(value)
  }
}

/** A date in the active locale's order — 22/09/2026 against 9/22/2026. */
export function formatDate(
  value: Date | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }
): string {
  try {
    return new Intl.DateTimeFormat(intlLocale(), options).format(value)
  } catch {
    return new Date(value).toISOString().slice(0, 10)
  }
}

/** A clock time, which is where the 24-hour languages part company with English. */
export function formatTime(value: Date | number, options: Intl.DateTimeFormatOptions = { timeStyle: 'short' }): string {
  try {
    return new Intl.DateTimeFormat(intlLocale(), options).format(value)
  } catch {
    return new Date(value).toISOString().slice(11, 16)
  }
}

/** Date and time together, for a detail row rather than a list. */
export function formatDateTime(value: Date | number): string {
  return formatDate(value, { dateStyle: 'medium', timeStyle: 'short' })
}

const UNITS: readonly { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
  { unit: 'second', ms: 1000 }
]

/**
 * "3 minutes ago", "over 2 dagen", in the active language.
 *
 * Signed milliseconds in, so the caller does not have to decide between past
 * and future: the sign carries it, and `Intl.RelativeTimeFormat` already knows
 * that German says "vor 3 Minuten" one way and "in 3 Minuten" the other.
 */
export function formatRelative(deltaMs: number): string {
  const magnitude = Math.abs(deltaMs)

  for (const { unit, ms } of UNITS) {
    if (magnitude >= ms || unit === 'second') {
      const value = Math.round(deltaMs / ms)

      try {
        return new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' }).format(value, unit)
      } catch {
        return `${value} ${unit}`
      }
    }
  }

  return ''
}

/**
 * A list, joined the way the language joins lists.
 *
 * `disjunction` because every caller in this app is offering a choice — "http
 * or https", "pdf, spreadsheets or video" — and the Oxford comma question is
 * `Intl`'s to answer rather than ours.
 */
export function formatList(items: readonly string[], type: 'conjunction' | 'disjunction' = 'disjunction'): string {
  if (items.length <= 1) {
    return items[0] ?? ''
  }

  try {
    return new Intl.ListFormat(intlLocale(), { style: 'long', type }).format([...items])
  } catch {
    const head = items.slice(0, -1).join(', ')

    return `${head} ${type === 'conjunction' ? 'and' : 'or'} ${items[items.length - 1]}`
  }
}
