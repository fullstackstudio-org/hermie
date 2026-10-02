/**
 * The hook that makes a language switch visible without a restart.
 *
 * `strings.x.y` resolves on access, so a component that re-renders already
 * paints the new language — the only missing piece is a reason to re-render.
 * This is that reason, and it is deliberately not a context: a provider would
 * only re-render the components that consume it, and `App` subscribing at the
 * root re-renders the tree under it in one pass.
 *
 * Call it in a component that must follow a switch and whose ancestors might
 * not: a screen mounted through a navigator's `component` prop, for instance,
 * where the element is created by the navigator rather than by its parent.
 */
import { useSyncExternalStore } from 'react'

import { activeLocale, subscribeToLocale } from './active-locale'
import type { Locale } from './locales'

/** The active language, re-read whenever it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeToLocale, activeLocale, activeLocale)
}

/**
 * The same subscription, for a component that only wants to be re-rendered.
 *
 * Same call, named for what the caller means: `useLocale()` with its result
 * thrown away reads like a mistake, and the lint rule that catches unused
 * values would agree.
 */
export function useFollowsLocale(): void {
  useSyncExternalStore(subscribeToLocale, activeLocale, activeLocale)
}
