/**
 * Which languages exist, and the one the client is speaking now.
 *
 * English is the language the interface is WRITTEN in and the bundled one; Dutch
 * and German are translations loaded on demand (`catalogue.ts`). The active
 * locale changes only after its data is in memory, so a read never sees a
 * language with nothing behind it.
 *
 * Everything that reads the language (the string tree, `format.ts`, the web-only
 * table, a component through `useLocale`) goes through here, and anything that
 * wants to know about a switch subscribes here. See `locale.ts` for how a
 * language is chosen.
 */

/** The languages a reader can pick. English is the source, not a translation. */
export type Locale = 'en' | 'nl' | 'de'

/** The source language. Everything else resolves against it. */
export const SOURCE_LOCALE: Locale = 'en'

export const LOCALES: readonly Locale[] = ['en', 'nl', 'de']

/** The two that are translations of the source. */
export const TRANSLATED_LOCALES: readonly Exclude<Locale, 'en'>[] = ['nl', 'de']

/** The name each language calls itself. Never translated: somebody hunting for their language wants their own word. */
export const LANGUAGE_ENDONYMS: Readonly<Record<Locale, string>> = {
  en: 'English',
  nl: 'Nederlands',
  de: 'Deutsch'
}

let current: Locale = SOURCE_LOCALE

const listeners = new Set<() => void>()

/** The language in use now. */
export function activeLocale(): Locale {
  return current
}

/**
 * Switch to `locale` and tell the subscribers, once, when it differs from the
 * current one. The caller has already loaded the language's data.
 */
export function setActiveLocale(locale: Locale): void {
  if (locale === current) {
    return
  }

  current = locale

  for (const listener of [...listeners]) {
    listener()
  }
}

/** Put English back and tell nobody. For tests. */
export function resetActiveLocale(): void {
  current = SOURCE_LOCALE
}

/** Be told when the language changes. Returns the unsubscribe. */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}
