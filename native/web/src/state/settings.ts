/**
 * The reader's device settings: the colour scheme, the one tint and whether this
 * browser keeps transcripts.
 *
 * Both belong to the browser profile, like the language (`i18n/locale.ts`): they
 * are stored under `device.*` keys of the base-path namespace
 * (`platform/key-value-store.ts`), so two gateways on one host keep their own
 * and a sign-out keeps them (a person's dark mode is not part of who they are).
 * Neither is ever sent to a gateway.
 *
 * What the store holds is a choice, not a colour. `system` follows
 * `prefers-color-scheme`, and the stylesheet does the following itself
 * (`ui/theme.css`); `light` and `dark` pin it. The page applies the choice to
 * the document element (`platform/theme-target.ts`), and `bindTheme` is the one
 * line that connects the two. Settings, Appearance (`features/settings`) is the screen
 * that changes them, through `setScheme` and `setTint`.
 *
 * **The transcript cache.** Whether this browser keeps a copy of the conversations it
 * has read (IndexedDB, `platform/chat-cache.ts`) is a choice about the browser, not about a
 * person, so it is stored the same way (`device.transcriptCache`, kept on sign-out, never sent
 * to a gateway). Absent means on: only an explicit `off` is stored. The cache honours it
 * through `GatedChatCache`; this store only holds the choice.
 *
 * A vanilla zustand store (`settingsStore`, and `createSettingsStore` for
 * tests), read by `features/` through `useStore`.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { WebKeyValueStore } from '../platform/key-value-store'
import { type AppliedTheme, applyTheme } from '../platform/theme-target'

export type SchemeChoice = 'system' | 'light' | 'dark'

/** The tints, in the order a picker will list them. `blue` is the default. */
export const TINTS = ['blue', 'indigo', 'violet', 'magenta', 'red', 'orange', 'teal', 'green', 'graphite'] as const

export type Tint = (typeof TINTS)[number]

export const DEFAULT_SCHEME: SchemeChoice = 'system'
export const DEFAULT_TINT: Tint = 'blue'

/** Device-local keys (the `device.` prefix survives a sign-out). */
export const SCHEME_KEY = 'device.scheme'
export const TINT_KEY = 'device.tint'
export const TRANSCRIPT_CACHE_KEY = 'device.transcriptCache'

const SCHEMES: readonly SchemeChoice[] = ['system', 'light', 'dark']

/** A stored scheme, defensively: anything unknown is "follow the browser". */
export function asSchemeChoice(value: unknown): SchemeChoice {
  return SCHEMES.includes(value as SchemeChoice) ? (value as SchemeChoice) : DEFAULT_SCHEME
}

/** A stored tint, defensively: anything unknown is the default. */
export function asTint(value: unknown): Tint {
  return TINTS.includes(value as Tint) ? (value as Tint) : DEFAULT_TINT
}

export interface SettingsState {
  scheme: SchemeChoice
  tint: Tint
  /** Whether this browser keeps the transcripts it has read. On unless the reader switched it off. */
  transcriptCache: boolean
  /** Where the choices are written; null before the page's store is known (nothing is persisted then). */
  storage: WebKeyValueStore | null

  /** Read this browser's choices from `storage` and write future ones to it. */
  hydrate: (storage: WebKeyValueStore) => void
  setScheme: (scheme: SchemeChoice) => void
  setTint: (tint: Tint) => void
  setTranscriptCache: (enabled: boolean) => void
  /** Back to the defaults, and forget the store (tests). A stored choice stays stored. */
  reset: () => void
}

export function createSettingsStore(): StoreApi<SettingsState> {
  return createStore<SettingsState>((set, get) => ({
    scheme: DEFAULT_SCHEME,
    tint: DEFAULT_TINT,
    transcriptCache: true,
    storage: null,

    hydrate(storage) {
      set({
        storage,
        scheme: asSchemeChoice(storage.getSync(SCHEME_KEY)),
        tint: asTint(storage.getSync(TINT_KEY)),
        transcriptCache: storage.getSync(TRANSCRIPT_CACHE_KEY) !== 'off'
      })
    },

    setScheme(scheme) {
      if (scheme === get().scheme) {
        return
      }

      set({ scheme })
      get().storage?.setSync(SCHEME_KEY, scheme)
    },

    setTint(tint) {
      if (tint === get().tint) {
        return
      }

      set({ tint })
      get().storage?.setSync(TINT_KEY, tint)
    },

    setTranscriptCache(enabled) {
      if (enabled === get().transcriptCache) {
        return
      }

      set({ transcriptCache: enabled })

      // Only the departure from the default is stored, so a later change of the default reaches everybody who never chose.
      if (enabled) {
        get().storage?.deleteSync(TRANSCRIPT_CACHE_KEY)
      } else {
        get().storage?.setSync(TRANSCRIPT_CACHE_KEY, 'off')
      }
    },

    reset() {
      set({ scheme: DEFAULT_SCHEME, tint: DEFAULT_TINT, transcriptCache: true, storage: null })
    }
  }))
}

/** The page's store. */
export const settingsStore: StoreApi<SettingsState> = createSettingsStore()

/**
 * Keep the document's theme attributes in step with the store: applied now and
 * on every change. Returns the unsubscribe. `apply` is `applyTheme` unless a
 * test hands in its own.
 */
export function bindTheme(
  store: StoreApi<SettingsState> = settingsStore,
  apply: (theme: AppliedTheme) => void = theme => applyTheme(theme)
): () => void {
  apply({ scheme: store.getState().scheme, tint: store.getState().tint })

  return store.subscribe((state, previous) => {
    if (state.scheme !== previous.scheme || state.tint !== previous.tint) {
      apply({ scheme: state.scheme, tint: state.tint })
    }
  })
}
