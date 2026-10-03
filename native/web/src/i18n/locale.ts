/**
 * Which language the client speaks, and how that is decided.
 *
 * A browser has no per-site language setting, so the rule has two layers:
 *
 *   1. the reader's stored choice: `system`, or one of `en`, `nl`, `de`;
 *   2. when the choice is `system` (the default, and what an empty or
 *      unreadable store means), the browser's own preference list.
 *
 * The list is read in order and the first entry that is one of ours wins, with
 * its region dropped: `nl-BE`, `nl_NL` and bare `nl` all land on Dutch, because
 * Hermie has no Flemish copy. A list that names no language of ours gives
 * English, which is the language the interface is written in and not a failure
 * (docs/i18n.md, "Web client").
 *
 * The choice belongs to the browser profile, like the colour scheme: it is
 * stored locally and never sent to a gateway. It lives in the page's key-value
 * store under `device.language`, so it survives a sign-out, and this file reads
 * and writes it only through a `LocaleEnvironment` (`platform/locale-environment.ts`
 * builds the page's); it touches no browser object itself.
 *
 * Switching does not remount anything. `setLanguageChoice` loads the language,
 * then makes it active, and subscribers (`useLocale`, or `subscribeLocale`
 * directly) re-render where they stand. The language never changes before its
 * data is in memory, so a screen is never half in one language and half in
 * another.
 */
import { activeLocale, LOCALES, resetActiveLocale, setActiveLocale, SOURCE_LOCALE, type Locale } from './active-locale'
import { browserLanguages } from '../platform/browser-languages'
import { loadCatalogue } from './catalogue'

export {
  activeLocale,
  LANGUAGE_ENDONYMS,
  LOCALES,
  SOURCE_LOCALE,
  subscribeLocale,
  TRANSLATED_LOCALES,
  type Locale
} from './active-locale'

/**
 * What the reader chose, which is not the same as what they get. `system`
 * follows the browser and is re-resolved on every load; the other three pin the
 * client regardless of it.
 */
export type LanguageChoice = 'system' | Locale

export const DEFAULT_LANGUAGE_CHOICE: LanguageChoice = 'system'

/** The key of the stored choice in the page's key-value store: device-local, so a sign-out keeps it. */
export const LANGUAGE_KEY = 'device.language'

const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale)

/**
 * A browser tag as a `Locale`, or undefined when it is none of ours. The region
 * and any script or extension are dropped: `nl-BE`, `nl_NL`, `de-AT`, `de-Latn`.
 */
export function asLocale(value: unknown): Locale | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const primary = value.trim().toLowerCase().split(/[-_]/u)[0] ?? ''

  return isLocale(primary) ? primary : undefined
}

/** A stored choice, defensively. An unknown value reads as undefined, which means "follow the browser". */
export function asLanguageChoice(value: unknown): LanguageChoice | undefined {
  return value === 'system' ? 'system' : isLocale(value) ? value : undefined
}

/**
 * The language the browser's preference list asks for: the first entry that is
 * one of ours, else English.
 */
export function localeForBrowser(languages: readonly (string | null | undefined)[]): Locale {
  for (const tag of languages) {
    const locale = asLocale(tag)

    if (locale) {
      return locale
    }
  }

  return SOURCE_LOCALE
}

/** Resolve a choice against the browser's list. `system` is the only choice that reads it. */
export function resolveLanguage(choice: LanguageChoice, languages: readonly (string | null | undefined)[]): Locale {
  return choice === 'system' ? localeForBrowser(languages) : choice
}

/**
 * What the language rules read and write. The page's own is
 * `localeEnvironmentFor(store)` (`platform/locale-environment.ts`), handed to
 * `configureLocale` by the entry module before the first `initLocale`; tests hand
 * in their own.
 */
export interface LocaleEnvironment {
  /** The stored choice as it was written, or null/undefined when there is none or the store cannot be read. */
  readChoice(): string | null | undefined
  /** Store the choice. A store that cannot be written is not an error: the choice then lasts until the page closes. */
  writeChoice(choice: LanguageChoice): void
  /** The browser's preference list, most preferred first. */
  languages(): readonly string[]
}

/**
 * Until a store is configured: nothing stored and nothing to store into (a
 * choice then lasts until the page closes), and the browser's own list.
 */
const browserEnvironment: LocaleEnvironment = {
  readChoice: () => undefined,
  writeChoice: () => undefined,
  languages: () => browserLanguages()
}

let environment: LocaleEnvironment = browserEnvironment

let choice: LanguageChoice = DEFAULT_LANGUAGE_CHOICE

/** The latest request; an older one that resolves after it is dropped. */
let generation = 0

/** Replace what the rules read and write. Pass nothing to go back to the default: nothing stored, the browser's list. */
export function configureLocale(next?: LocaleEnvironment): void {
  environment = next ?? browserEnvironment
}

/** The reader's choice, which may be `system`. */
export function languageChoice(): LanguageChoice {
  return choice
}

function applyToDocument(locale: Locale): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
}

async function activate(locale: Locale, token: number): Promise<Locale> {
  try {
    await loadCatalogue(locale)
  } catch {
    // The chunk did not arrive (offline, a stale deploy). The language in use
    // stays, and picking again tries again.
    return activeLocale()
  }

  if (token === generation) {
    setActiveLocale(locale)
    applyToDocument(locale)
  }

  return activeLocale()
}

/**
 * Read the stored choice, resolve it against the browser and make the result
 * active. Await it before the first render: a reader whose language is Dutch is
 * then in Dutch from the first frame. Resolves to the language now in use,
 * which is English when the Dutch or German chunk could not be fetched.
 */
export function initLocale(): Promise<Locale> {
  choice = asLanguageChoice(environment.readChoice()) ?? DEFAULT_LANGUAGE_CHOICE
  generation += 1

  return activate(resolveLanguage(choice, environment.languages()), generation)
}

/**
 * Pick a language, persist the pick and switch to it where the reader stands.
 * Resolves to the language now in use.
 */
export function setLanguageChoice(next: LanguageChoice): Promise<Locale> {
  choice = next
  environment.writeChoice(next)
  generation += 1

  return activate(resolveLanguage(next, environment.languages()), generation)
}

/** English, no stored choice, the browser's own environment. For tests. */
export function resetLocale(): void {
  environment = browserEnvironment
  choice = DEFAULT_LANGUAGE_CHOICE
  generation += 1
  resetActiveLocale()
}
