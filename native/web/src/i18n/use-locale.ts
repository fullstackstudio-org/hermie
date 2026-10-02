import { useSyncExternalStore } from 'react'

import { activeLocale, subscribeLocale, type Locale } from './active-locale'

/**
 * The language in use, and a re-render when it changes. Read once near the root
 * (and in any memoised component that reads `strings`): everything under it
 * renders again on a switch, nothing is remounted, so an open sheet stays open.
 *
 * A string table read at import time freezes the language the bundle loaded
 * with. Build text inside a render, not at module level (docs/i18n.md).
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, activeLocale, activeLocale)
}
