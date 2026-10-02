/**
 * The generated string tree, built over the locale files.
 *
 * `src/generated/strings.ts` is types plus one call to `createStrings`; what a
 * read returns comes from `src/generated/locales/<tag>.json`, looked up when the
 * read is made. English is imported statically, so the first frame is always
 * readable. Dutch and German are separate chunks, fetched by `loadCatalogue`
 * when a reader asks for them, and `locale.ts` switches the language only after
 * that has resolved.
 *
 * The three kinds of value follow the locale files (scripts/i18n/web.ts):
 *
 *   a string              `strings.app.common.cancel`                 a getter
 *   an array of strings   `strings.app.settings.weekdays`             a getter
 *   { template }          `strings.app.onboarding.stepCounter({...})` a function
 *
 * A key a language does not have reads as the English one. The catalogue is
 * exported with that rule already applied, so today this only matters for a
 * locale file that is half written, which the tests do not allow.
 */
import enFile from '../generated/locales/en.json'
import { activeLocale, SOURCE_LOCALE, type Locale } from './active-locale'
import { renderTemplate, type ArgValue, type Template } from './template'

/** What a locale file holds at one key. */
export type CatalogueValue = string | readonly string[] | { readonly template: Template }

/** One language, flat, under the dotted keys. */
export type CatalogueData = Readonly<Record<string, CatalogueValue>>

const english = enFile as unknown as CatalogueData

const bundled = new Map<Locale, CatalogueData>([[SOURCE_LOCALE, english]])

const pending = new Map<Locale, Promise<CatalogueData>>()

/** Where the translated files are fetched from: one chunk each, never part of the first load. */
const LOADERS: Readonly<Record<Exclude<Locale, 'en'>, () => Promise<{ default: unknown }>>> = {
  nl: () => import('../generated/locales/nl.json'),
  de: () => import('../generated/locales/de.json')
}

/** Is `locale`'s data in memory? */
export const isLoaded = (locale: Locale): boolean => bundled.has(locale)

/** The data of a language that is loaded, or undefined. */
export const loadedCatalogue = (locale: Locale): CatalogueData | undefined => bundled.get(locale)

/** Every key, in English file order. */
export const catalogueKeys = (): string[] => Object.keys(english)

/**
 * Bring `locale`'s data into memory. Resolves at once for English and for a
 * language that was loaded before; concurrent calls share one fetch; a failed
 * fetch is forgotten, so asking again tries again.
 */
export function loadCatalogue(locale: Locale): Promise<CatalogueData> {
  const have = bundled.get(locale)

  if (have) {
    return Promise.resolve(have)
  }

  let promise = pending.get(locale)

  if (!promise) {
    const load = LOADERS[locale as Exclude<Locale, 'en'>]

    promise = load().then(
      module => {
        const data = module.default as CatalogueData

        bundled.set(locale, data)
        pending.delete(locale)

        return data
      },
      (error: unknown) => {
        pending.delete(locale)
        throw error
      }
    )
    pending.set(locale, promise)
  }

  return promise
}

const isTemplate = (value: CatalogueValue | undefined): value is { template: Template } =>
  typeof value === 'object' && !Array.isArray(value)

/** The value at `key` in the active language, or the English one when that language has none of this kind. */
function lookup(key: string, kind: 'text' | 'list' | 'template'): CatalogueValue {
  const value = (bundled.get(activeLocale()) ?? english)[key]

  if (
    value !== undefined &&
    (kind === 'text' ? typeof value === 'string' : kind === 'list' ? Array.isArray(value) : isTemplate(value))
  ) {
    return value
  }

  return english[key]!
}

type Branch = Record<string, unknown>

/**
 * The tree over the English keys. Branches have no prototype, so a table
 * indexed with a key that arrives at run time (`strings.chat.approval.choices[id]`)
 * answers `undefined` for one it does not have, and never `constructor`.
 */
export function createStrings<T>(): T {
  const root: Branch = Object.create(null) as Branch

  for (const [key, value] of Object.entries(english)) {
    const path = key.split('.')
    const name = path.pop()!
    let node = root

    for (const segment of path) {
      node = (node[segment] ??= Object.create(null)) as Branch
    }

    if (typeof value === 'string') {
      Object.defineProperty(node, name, { enumerable: true, get: () => lookup(key, 'text') })
    } else if (Array.isArray(value)) {
      Object.defineProperty(node, name, { enumerable: true, get: () => lookup(key, 'list') })
    } else {
      node[name] = (args: Readonly<Record<string, ArgValue>> = {}): string =>
        renderTemplate((lookup(key, 'template') as { template: Template }).template, args, activeLocale())
    }
  }

  return root as T
}
