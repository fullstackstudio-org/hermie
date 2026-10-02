/**
 * The layer that turns an English string table into a localised one.
 *
 * There is no i18n dependency and no key strings. A screen still writes
 * `strings.settings.language.title` and still gets a compile error when it
 * mistypes it; what changed is that the read now goes through a proxy which
 * looks the path up in the active locale's catalogue first and falls back to
 * the English value it is wrapping.
 *
 * Three consequences worth knowing before changing this:
 *
 *  - **A missing key is not an error.** It is the English sentence. That is
 *    what lets a round add copy in English and translate it a week later
 *    without a screen ever painting `settings.language.title` at a reader.
 *  - **Resolution happens on ACCESS, never at import.** A module-level
 *    `const OPTIONS = [{ label: strings.a }]` would freeze whatever language
 *    was active when the bundle loaded, which on a cold start is English. Those
 *    are getters or functions now; see `store/language.ts` for the switch.
 *  - **The proxy is typed as the thing it wraps.** `localised(tree, en)`
 *    returns `T`, so nothing downstream knows this file exists.
 */
import { activeLocale } from './active-locale'
import { de } from './de'
import { nl } from './nl'
import { SOURCE_LOCALE, type Locale } from './locales'

/**
 * One English string table, by the name its catalogue entry uses.
 *
 * The names are short because they are written once per translation file. They
 * deliberately do NOT mirror the source paths: `chat-ui/strings.ts` is `chat`,
 * and where a feature's file moves the tree name does not have to.
 */
export type TreeName =
  'app' | 'chat' | 'botRename' | 'connectors' | 'cron' | 'kanban' | 'mcp' | 'memory' | 'profiles' | 'skills'

/** A branch of a catalogue: whatever shape the English tree has at that path. */
type Branch = Record<string, unknown>

/**
 * A translation of `T`: every key optional, every leaf the same KIND as its
 * source.
 *
 * Optional is the fallback rule expressed in the type system. The kind is not
 * optional: a source key that interpolates is a function, and a translation
 * that answered with a bare string would drop the argument silently. Making the
 * signature match means a translator who forgets `(name: string)` gets a type
 * error rather than a screen reading "Kon niet lezen: ".
 */
export type Translation<T> = {
  [K in keyof T]?: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T[K] extends string
      ? string
      : T[K] extends readonly string[]
        ? readonly string[]
        : T[K] extends object
          ? Translation<T[K]>
          : never
}

/**
 * Every catalogue, by locale.
 *
 * Weakly typed on purpose. The real check lives on each translation file's own
 * `Translation<typeof …>` annotation; typing the registry as well would make
 * `catalogue.ts` depend on the shape of every string table it imports, which is
 * a type cycle for no extra safety.
 */
const CATALOGUES: Record<Locale, Partial<Record<TreeName, Branch>>> = {
  en: {},
  nl,
  de
}

/** Walk one catalogue down a path. Anything that is not an object stops the walk. */
function lookup(locale: Locale, tree: TreeName, path: readonly string[]): unknown {
  let node: unknown = CATALOGUES[locale][tree]

  for (const step of path) {
    if (!node || typeof node !== 'object') {
      return undefined
    }

    node = (node as Branch)[step]
  }

  return node
}

/**
 * Does this override stand in for that source value?
 *
 * A catalogue written by hand can be wrong in ways the type system misses once
 * it has been cast — a string where the source has a function, an object where
 * the source has a sentence. Rather than paint the wrong thing, a mismatch is
 * treated as absent and the English value wins.
 */
function usable(source: unknown, override: unknown): boolean {
  if (override === undefined || override === null) {
    return false
  }

  if (typeof source === 'function') {
    return typeof override === 'function'
  }

  if (typeof source === 'string') {
    return typeof override === 'string'
  }

  if (Array.isArray(source)) {
    return Array.isArray(override)
  }

  return false
}

const isPlainBranch = (value: unknown): value is Branch =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof value !== 'function'

/**
 * The public entry point: wrap an English table so reads follow the locale.
 *
 * Returns `T`, so a caller sees no difference. Under English the handler hands
 * back the raw value without allocating anything, which is the case that runs
 * on most devices and in every test that does not opt in.
 */
export function localised<T extends object>(tree: TreeName, source: T): T {
  return branchProxy(tree, source, []) as T
}

function branchProxy(tree: TreeName, source: object, path: readonly string[]): object {
  // Nested proxies are cached by path rather than by locale: the handler reads
  // the locale on every access, so one proxy per path is correct for all three
  // languages and a screen that re-renders does not allocate a new one.
  const children = new Map<string, object>()

  return new Proxy(source, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)

      if (typeof property === 'symbol') {
        return value
      }

      const locale = activeLocale()

      if (locale === SOURCE_LOCALE) {
        return value
      }

      if (isPlainBranch(value)) {
        const cached = children.get(property)

        if (cached) {
          return cached
        }

        const child = branchProxy(tree, value, [...path, property])

        children.set(property, child)

        return child
      }

      const override = lookup(locale, tree, [...path, property])

      return usable(value, override) ? override : value
    }
  })
}

/** What a coverage test walks: the catalogue as written, with no proxy in the way. */
export function catalogueFor(locale: Locale, tree: TreeName): Branch {
  return CATALOGUES[locale][tree] ?? {}
}

/**
 * Every source key this translation does not answer, as dotted paths.
 *
 * The shape a completeness test asserts on. A branch the translation omits
 * entirely reports each of its leaves rather than the branch, because that is
 * the list somebody has to work through — and because an allow-list entry for
 * a whole branch would quietly cover keys added under it later.
 */
export function missingKeys(source: object, translation: unknown, prefix = ''): string[] {
  const out: string[] = []
  const branch = isPlainBranch(translation) ? translation : {}

  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key

    if (isPlainBranch(value)) {
      out.push(...missingKeys(value, branch[key], path))
      continue
    }

    if (!usable(value, branch[key])) {
      out.push(path)
    }
  }

  return out
}

/**
 * Keys a translation has that the source does not.
 *
 * The other half of completeness, and the half that catches the real-world
 * failure: a key renamed in English leaves its translation behind, where it is
 * dead weight that reads as covered.
 */
export function strayKeys(source: object, translation: unknown, prefix = ''): string[] {
  const out: string[] = []
  const branch = isPlainBranch(translation) ? translation : {}
  const known = source as Branch

  for (const [key, value] of Object.entries(branch)) {
    const path = prefix ? `${prefix}.${key}` : key
    const counterpart = known[key]

    if (counterpart === undefined) {
      out.push(path)
      continue
    }

    if (isPlainBranch(value) && isPlainBranch(counterpart)) {
      out.push(...strayKeys(counterpart, value, path))
    }
  }

  return out
}
