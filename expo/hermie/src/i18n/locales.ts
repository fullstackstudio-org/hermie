/**
 * Which languages exist, and how a device's own tag is folded into one.
 *
 * English is not one option among three: it is the language the app is WRITTEN
 * in, and every other locale is a layer over it. That asymmetry is the whole
 * design — a key with no Dutch falls back to the English sentence rather than
 * to a placeholder, so a round can add copy in English and translate it later
 * without ever shipping a screen with a hole in it.
 */

/** The languages a reader can pick. English is the source, not a translation. */
export type Locale = 'en' | 'nl' | 'de'

/** The source language. Everything else resolves against it. */
export const SOURCE_LOCALE: Locale = 'en'

export const LOCALES: readonly Locale[] = ['en', 'nl', 'de']

/** The two that are translations of the source, which is what a coverage test walks. */
export const TRANSLATED_LOCALES: readonly Exclude<Locale, 'en'>[] = ['nl', 'de']

/**
 * What the reader chose, which is not the same as what they get.
 *
 * `system` follows the device and re-resolves every launch; the other three pin
 * the app regardless of it. The same shape as `Appearance` in
 * `store/settings.ts`, and for the same reason: "follow the device" is a
 * standing instruction, not a value that was copied once.
 */
export type LanguageChoice = 'system' | Locale

export const DEFAULT_LANGUAGE_CHOICE: LanguageChoice = 'system'

/** The name each language calls itself. Never translated — that is the point. */
export const LANGUAGE_ENDONYMS: Record<Locale, string> = {
  en: 'English',
  nl: 'Nederlands',
  de: 'Deutsch'
}

const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale)

/** A stored or device tag, as a `Locale`, or undefined when it is none of ours. */
export function asLocale(value: unknown): Locale | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  // `nl-NL`, `nl_BE`, `de-AT` and bare `de` all land on their language. Region
  // is deliberately dropped: Hermie has no Flemish or Austrian copy, and
  // pretending otherwise would mean three catalogues that are 99% the same.
  const primary = value.trim().toLowerCase().split(/[-_]/u)[0] ?? ''

  return isLocale(primary) ? primary : undefined
}

/** A stored choice, defensively. An unknown value reads as "follow the device". */
export function asLanguageChoice(value: unknown): LanguageChoice | undefined {
  if (value === 'system') {
    return 'system'
  }

  return isLocale(value) ? value : undefined
}

/**
 * The language a device tag asks for, falling back to English.
 *
 * Separate from `asLocale` because the caller here has no third answer to give:
 * a phone set to Spanish gets English, which is the app's own language and not
 * a failure.
 */
export function localeForDevice(tag: string | null | undefined): Locale {
  return asLocale(tag) ?? SOURCE_LOCALE
}

/** Resolve a choice against the device's tag. `system` is the only one that reads it. */
export function resolveLanguage(choice: LanguageChoice, deviceTag: string | null | undefined): Locale {
  return choice === 'system' ? localeForDevice(deviceTag) : choice
}
