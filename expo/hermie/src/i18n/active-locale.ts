/**
 * The one language the app is speaking right now.
 *
 * A plain module variable rather than a store, and deliberately: `strings.x.y`
 * is read from render bodies, from event handlers and from modules that run
 * before React exists, so the read has to be synchronous and free of hooks. The
 * store that OWNS the choice (`store/language.ts`) pushes into here; nothing
 * pushes the other way.
 *
 * The listener set is what makes a switch visible without a restart. React
 * subscribes through `useLocale` in `use-locale.ts`; this module holds no React
 * import of its own so the catalogue can be tested without a renderer.
 */
import { SOURCE_LOCALE, type Locale } from './locales'

let active: Locale = SOURCE_LOCALE

const listeners = new Set<() => void>()

/** The language every `strings.*` read resolves against, right now. */
export function activeLocale(): Locale {
  return active
}

/**
 * Switch the app's language.
 *
 * Idempotent on purpose: `hydrate` and the picker can both land on `nl`, and a
 * notification for a change that did not happen is a re-render of the whole
 * tree for nothing.
 */
export function setActiveLocale(next: Locale): void {
  if (next === active) {
    return
  }

  active = next

  for (const listener of [...listeners]) {
    listener()
  }
}

/** Subscribe to switches. Returns the unsubscribe, as `useSyncExternalStore` wants. */
export function subscribeToLocale(listener: () => void): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

/** Back to English, for a test that must not leak its locale into the next one. */
export function resetActiveLocale(): void {
  setActiveLocale(SOURCE_LOCALE)
}
