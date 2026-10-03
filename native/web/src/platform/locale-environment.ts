/**
 * Where the language choice is kept: the page's key-value store, under
 * `device.language`.
 *
 * Like the colour scheme it belongs to the browser profile, not to whoever is
 * signed in, so it is a `device.*` key (`platform/key-value-store.ts`): it lives
 * in the base path's namespace and survives a sign-out. `i18n/locale.ts` reads and
 * writes it through the `LocaleEnvironment` this builds; it touches no storage of
 * its own.
 *
 * **Migration.** Earlier builds wrote the choice to a bare `hermie.language` key,
 * outside every namespace. The first read that finds no `device.language` takes
 * that value over (when it is a language choice), writes it under the new key and
 * removes the old one, once. The old key was shared by every gateway on the
 * origin, so only the first base path to start up inherits it; the others begin
 * at "follow the browser", which is also where a reader who never chose begins.
 */
import { asLanguageChoice, LANGUAGE_KEY, type LanguageChoice, type LocaleEnvironment } from '../i18n/locale'
import { browserLanguages } from './browser-languages'
import type { WebKeyValueStore } from './key-value-store'

/** The key earlier builds used, in the page's own `localStorage`, outside the namespace. */
export const LEGACY_LANGUAGE_KEY = 'hermie.language'

type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem'>

/** `localStorage`, or null when this browser refuses it. Reading the property is what throws. */
function pageLocalStorage(): LegacyStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export interface LocaleEnvironmentOptions {
  /** Where the old key is looked for; the page's own `localStorage` unless a test hands in its own. */
  legacy?: LegacyStorage | null
  /** The browser's language list; `navigator`'s own unless a test hands in its own. */
  languages?: () => readonly string[]
}

export function localeEnvironmentFor(
  store: WebKeyValueStore,
  options: LocaleEnvironmentOptions = {}
): LocaleEnvironment {
  const legacy = options.legacy === undefined ? pageLocalStorage() : options.legacy

  /** The old value, taken out of the old place when it is a language choice. */
  const migrated = (): LanguageChoice | undefined => {
    let old: string | null = null

    try {
      old = legacy?.getItem(LEGACY_LANGUAGE_KEY) ?? null
    } catch {
      return undefined
    }

    const choice = asLanguageChoice(old)

    if (choice) {
      store.setSync(LANGUAGE_KEY, choice)
    }

    // Whatever it held, it is not read again: an unusable value is not worth keeping either.
    if (old !== null) {
      try {
        legacy?.removeItem(LEGACY_LANGUAGE_KEY)
      } catch {
        // A store that refuses a removal keeps the key; the new one wins from here on, if it was written.
      }
    }

    return choice
  }

  return {
    readChoice: () => store.getSync(LANGUAGE_KEY) ?? migrated(),
    writeChoice: choice => store.setSync(LANGUAGE_KEY, choice),
    languages: options.languages ?? browserLanguages
  }
}
