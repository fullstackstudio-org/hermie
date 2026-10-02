/**
 * Which language the app speaks, on this device.
 *
 * A store of its own rather than a field in `store/settings.ts`, for the reason
 * that store gives for pulling the appearance out into its own key and then
 * one step further: the language is not about an account at all, and it is read
 * ABOVE the gateway — the wizard and the lock plate both paint words, and
 * neither has a gateway to key anything by. `settings.ts` already carries one
 * device-level exception and a second would make "per-account store with two
 * holes in it" the design.
 *
 * The store owns the CHOICE. `i18n/active-locale.ts` owns the resolved language
 * and is the thing `strings.*` reads, because that read has to work in modules
 * that run before React and in handlers that are not components. Every write
 * here pushes there; nothing pushes back.
 */
import { create } from 'zustand'

import { setActiveLocale } from '../i18n/active-locale'
import {
  asLanguageChoice,
  DEFAULT_LANGUAGE_CHOICE,
  type LanguageChoice,
  type Locale,
  resolveLanguage
} from '../i18n/locales'
import { deviceLocale } from '../platform/device-facts'
import { keyValueStore } from '../platform/key-value-store'

/**
 * Device-level, like `hermie.appearance` and for the same argument.
 *
 * A reader who switched to their work gateway and found the app in German
 * would have found a bug, not a feature.
 */
export const LANGUAGE_KEY = 'hermie.language'

interface PersistedLanguage {
  language?: LanguageChoice
}

export interface LanguageState {
  /** What the reader picked: `system`, or a language they pinned. */
  choice: LanguageChoice
  /** What that resolved to against this device. Mirrors `activeLocale()`. */
  locale: Locale
  /** False until the first disk read finishes; screens paint English meanwhile. */
  loaded: boolean
  hydrate: () => Promise<void>
  setChoice: (choice: LanguageChoice) => void
}

/**
 * The device's own language tag, defensively.
 *
 * Wrapped because `deviceLocale()` reaches `Intl` on native and `navigator` in
 * the browser, and a runtime that has neither should leave the app in English
 * rather than fail to start.
 */
function deviceTag(): string {
  try {
    return deviceLocale()
  } catch {
    return ''
  }
}

let writeQueue: Promise<void> = Promise.resolve()

function persist(choice: LanguageChoice): void {
  writeQueue = writeQueue
    .then(() => keyValueStore.setJson(LANGUAGE_KEY, { language: choice }))
    .catch(() => {
      // A preference that failed to persist resets on the next launch, which is
      // not worth an error in front of somebody who just picked a language.
    })
}

export const useLanguageStore = create<LanguageState>(set => ({
  choice: DEFAULT_LANGUAGE_CHOICE,
  locale: resolveLanguage(DEFAULT_LANGUAGE_CHOICE, deviceTag()),
  loaded: false,

  async hydrate() {
    const stored = await keyValueStore.getJson<PersistedLanguage>(LANGUAGE_KEY).catch(() => null)
    const choice = asLanguageChoice(stored?.language) ?? DEFAULT_LANGUAGE_CHOICE
    const locale = resolveLanguage(choice, deviceTag())

    set({ choice, locale, loaded: true })
    setActiveLocale(locale)
  },

  setChoice(choice) {
    const locale = resolveLanguage(choice, deviceTag())

    set({ choice, locale })
    setActiveLocale(locale)
    persist(choice)
  }
}))

/*
  The device's language applies from the FIRST frame, not from the first disk
  read.

  `hydrate` runs in an effect, which is after a paint, so without this a phone
  set to Dutch would open on an English screen and flip a moment later — and
  "Follow device" is the default, so that is the common case rather than an edge
  one. The stored choice then either agrees with what is already on screen,
  which is the usual outcome, or corrects it once.

  It also keeps the store and `activeLocale()` from disagreeing. They are two
  places holding the same fact, and a window where one says Dutch and the other
  says English is a bug waiting for somebody to read whichever one is wrong.
*/
setActiveLocale(useLanguageStore.getState().locale)

/**
 * Put the store back where a fresh launch would find it.
 *
 * For tests: the active locale is a module variable, so a test that switched to
 * German leaks into the next file unless something puts it back.
 */
export function resetLanguageStore(): void {
  const choice = DEFAULT_LANGUAGE_CHOICE
  const locale = resolveLanguage(choice, deviceTag())

  useLanguageStore.setState({ choice, locale, loaded: false })
  setActiveLocale(locale)
}
