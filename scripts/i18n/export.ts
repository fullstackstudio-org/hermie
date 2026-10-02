/**
 * The Expo app's three string catalogues as one data file:
 * `contract/i18n/catalogue.json`.
 *
 * Every key is read the way a screen reads it — through the `localised` proxy
 * with the active locale switched — so a Dutch key that has no translation yet
 * exports as the English sentence the app would paint, and nothing here
 * re-implements the fallback rule.
 *
 *   text      a plain string per language
 *   list      an array of strings per language (weekday names and the like)
 *   template  a string function, as a template per language (see template.ts),
 *             with its parameters as the TypeScript declares them
 */
import { resetActiveLocale, setActiveLocale } from '../../expo/hermie/src/i18n/active-locale'
import { LOCALES, SOURCE_LOCALE, type Locale } from '../../expo/hermie/src/i18n/locales'
import { ENGLISH_TREES } from '../../expo/hermie/src/i18n/trees'
import { convert, verify, type StringFunction } from './convert'
import { OVERRIDES } from './overrides'
import { readSignatures } from './signatures'
import { paramsRead, type Param, type Template } from './template'

export type Entry =
  | { kind: 'text'; values: Record<Locale, string> }
  | { kind: 'list'; values: Record<Locale, string[]> }
  | {
      kind: 'template'
      params: Param[]
      values: Record<Locale, Template>
      /** Present when at least one language's template is hand-written in `overrides.ts`. */
      override?: { locales: Locale[]; reason: string }
    }

export interface Catalogue {
  format: 1
  sourceLocale: Locale
  locales: Locale[]
  /** Branches a screen indexes with a runtime value (`Record<string, string>` in TypeScript). */
  keyed: string[]
  entries: Record<string, Entry>
}

export interface ExportStats {
  keys: number
  text: number
  lists: number
  functions: number
  perLocale: Record<Locale, { mechanical: number; override: number }>
}

const isBranch = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Every leaf of the English tables, as a dotted key, in table order. */
function leafKeys(): string[] {
  const out: string[] = []

  const walk = (node: Record<string, unknown>, path: string): void => {
    for (const [key, value] of Object.entries(node)) {
      if (isBranch(value)) {
        walk(value, `${path}.${key}`)
      } else {
        out.push(`${path}.${key}`)
      }
    }
  }

  resetActiveLocale()

  for (const [tree, table] of Object.entries(ENGLISH_TREES)) {
    walk(table as Record<string, unknown>, tree)
  }

  return out
}

/** The value a screen reads at `key` in the active locale. */
function read(key: string): unknown {
  const [tree, ...path] = key.split('.')
  let node: unknown = ENGLISH_TREES[tree as keyof typeof ENGLISH_TREES]

  for (const step of path) {
    node = (node as Record<string, unknown>)[step]
  }

  return node
}

/** Build the catalogue. Throws, listing every problem, when a function cannot be exported faithfully. */
export function buildCatalogue(): { catalogue: Catalogue; stats: ExportStats } {
  const { functions, keyed } = readSignatures()
  const entries: Record<string, Entry> = {}
  const problems: string[] = []
  const stats: ExportStats = {
    keys: 0,
    text: 0,
    lists: 0,
    functions: 0,
    perLocale: {
      en: { mechanical: 0, override: 0 },
      nl: { mechanical: 0, override: 0 },
      de: { mechanical: 0, override: 0 }
    }
  }

  for (const key of Object.keys(OVERRIDES)) {
    if (!functions.has(key)) {
      problems.push(`${key}: overrides.ts has an entry, but the English table has no function there`)
    }
  }

  try {
    for (const key of leafKeys()) {
      const params = functions.get(key)
      const perLocale = new Map<Locale, unknown>()

      for (const locale of LOCALES) {
        setActiveLocale(locale)
        perLocale.set(locale, read(key))
      }

      resetActiveLocale()

      const source = perLocale.get(SOURCE_LOCALE)

      if (typeof source === 'string') {
        entries[key] = { kind: 'text', values: Object.fromEntries(perLocale) as Record<Locale, string> }
        stats.text += 1
        continue
      }

      if (Array.isArray(source)) {
        const values = Object.fromEntries(perLocale) as Record<Locale, unknown[]>

        if (Object.values(values).some(list => !list.every(item => typeof item === 'string'))) {
          problems.push(`${key}: a list must hold strings only`)
          continue
        }

        entries[key] = { kind: 'list', values: values as Record<Locale, string[]> }
        stats.lists += 1
        continue
      }

      if (typeof source !== 'function' || !params) {
        problems.push(`${key}: neither a string, a list of strings nor a typed function`)
        continue
      }

      stats.functions += 1

      const override = OVERRIDES[key]
      const values = {} as Record<Locale, Template>
      const overridden: Locale[] = []

      for (const locale of LOCALES) {
        const fn = perLocale.get(locale) as StringFunction

        setActiveLocale(locale)

        const mechanical = convert(fn, params, locale)
        const handWritten = override?.templates[locale]

        if (handWritten !== undefined) {
          if (mechanical.ok) {
            problems.push(`${key} [${locale}]: overrides.ts is stale — the probes convert this one by themselves now`)
          }

          const problem = verify(fn, params, handWritten, locale)

          if (problem) {
            problems.push(`${key} [${locale}]: the override does not match the TypeScript: ${problem}`)
          }

          values[locale] = handWritten
          overridden.push(locale)
          stats.perLocale[locale].override += 1
        } else if (mechanical.ok) {
          values[locale] = mechanical.template
          stats.perLocale[locale].mechanical += 1
        } else {
          problems.push(
            `${key} [${locale}]: cannot convert (${mechanical.reason}); add it to scripts/i18n/overrides.ts`
          )
        }

        const unknown =
          values[locale] === undefined
            ? []
            : [...paramsRead(values[locale])].filter(name => !params.some(p => p.name === name))

        if (unknown.length) {
          problems.push(
            `${key} [${locale}]: the template reads ${unknown.join(', ')}, which the function does not take`
          )
        }
      }

      resetActiveLocale()

      entries[key] = {
        kind: 'template',
        params,
        values,
        ...(overridden.length && override ? { override: { locales: overridden, reason: override.reason } } : {})
      }
    }
  } finally {
    resetActiveLocale()
  }

  if (problems.length) {
    throw new Error(`The string catalogue cannot be exported:\n  ${problems.join('\n  ')}`)
  }

  stats.keys = Object.keys(entries).length

  for (const path of keyed) {
    if (!Object.keys(entries).some(key => key.startsWith(`${path}.`))) {
      throw new Error(`${path}: a keyed table with no keys`)
    }
  }

  return {
    catalogue: {
      format: 1,
      sourceLocale: SOURCE_LOCALE,
      locales: [...LOCALES],
      keyed: [...keyed].sort(),
      entries
    },
    stats
  }
}
