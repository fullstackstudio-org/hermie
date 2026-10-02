/**
 * Numbers, dates, relative times, lists and plurals in the reader's language.
 *
 * All of it through `Intl`, none of it through a table: a hand-rolled
 * `count === 1` would look right for English, Dutch and German and be wrong the
 * moment a fourth language arrives. The strings that carry a count of their own
 * are templates in the catalogue, rendered by `template.ts` with the same
 * `Intl.PluralRules`; this file is for the text the client builds itself.
 *
 * Every entry point is wrapped, so an engine without a locale's data loses a
 * thousands separator rather than the screen.
 */
import { activeLocale, type Locale } from './active-locale'

/** The BCP-47 tag `Intl` is handed. Region-free: Hermie has no regional copy (`asLocale` in `locale.ts`). */
export function intlLocale(locale: Locale = activeLocale()): string {
  return locale
}

/**
 * The plural forms a sentence needs, named the way CLDR names them. `other` is
 * required, the rest are optional.
 */
export interface PluralForms {
  zero?: string
  one?: string
  two?: string
  few?: string
  many?: string
  other: string
}

function pluralCategory(count: number): keyof PluralForms {
  try {
    return new Intl.PluralRules(intlLocale()).select(count) as keyof PluralForms
  } catch {
    return count === 1 ? 'one' : 'other'
  }
}

/** Pick the form `count` takes in the active language. */
export function plural(count: number, forms: PluralForms): string {
  return forms[pluralCategory(count)] ?? forms.other
}

/** A number with the active locale's grouping and decimal marks. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(intlLocale(), options).format(value)
  } catch {
    return String(value)
  }
}

/**
 * `count` in the reader's digits and grouping, with its noun: `#` in the chosen
 * form stands for the formatted number. One call rather than two because the two
 * are never right apart ("1.024 berichten" needs the separator and the form).
 */
export function pluralCount(count: number, forms: PluralForms): string {
  return plural(count, forms).replace('#', formatNumber(count))
}

/** A date in the active locale's order: 22/09/2026 against 9/22/2026. */
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
 * "3 minutes ago", "over 2 dagen", in the active language. Signed milliseconds
 * in, so the caller does not have to decide between past and future.
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
 * A list, joined the way the language joins lists. `disjunction` is the default
 * because most callers offer a choice ("http or https").
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
