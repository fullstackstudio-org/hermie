/**
 * How big the words in a transcript are.
 *
 * ## It multiplies the browser's size; it does not replace it
 *
 * The browser already has a text size and the reader has already set it (the
 * default font size, page zoom). What this adds is a factor ON TOP of that, for
 * the case the browser cannot express: a reader who wants the app's chrome the
 * size the browser says and the CONVERSATION bigger, because the conversation
 * is the part they read for minutes at a time. So the scale is applied to the
 * transcript's type and to nothing else.
 *
 * That is also why it is a multiplier rather than four absolute sizes: absolute
 * sizes would be a second, competing accessibility setting.
 *
 * ## It follows the person
 *
 * The size is part of the app-wide `ui_meta` section (`textSize`), so a size
 * picked on a phone arrives here and the other way round; `core/ui-meta-bridge.ts`
 * watches this store and writes it, and puts a gateway's copy back into it with
 * `applyRemote`. The browser also remembers it (`device.textSize`, which survives
 * a sign-out like the scheme and the tint, plan "Stores"), so the first paint
 * after a reload is already the right size.
 *
 * Ported from the Expo app's `src/store/text-size.ts` (the type, the order, the
 * scale and the two readers, unchanged). Deliberate differences:
 *
 *  - **A store of its own.** The Expo app kept the size in its settings store,
 *    which also held the verbosity defaults and the theme. This client's
 *    settings store (`state/settings.ts`) holds the device-local scheme and tint
 *    only and never reaches a gateway, so the one synced setting it would have
 *    held lives here, beside the helpers that read it.
 *  - A vanilla zustand store (`textSizeStore`, and `createTextSizeStore` for
 *    tests), read by `features/` through `useStore`.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { WebKeyValueStore } from '../platform/key-value-store'

export type TextSize = 'small' | 'default' | 'large' | 'xlarge'

/** The order the pickers draw, smallest first. */
export const TEXT_SIZE_ORDER: readonly TextSize[] = ['small', 'default', 'large', 'xlarge']

export const DEFAULT_TEXT_SIZE: TextSize = 'default'

/** What each step multiplies the transcript's type by. */
export const TEXT_SIZE_SCALE: Record<TextSize, number> = {
  small: 0.88,
  default: 1,
  large: 1.15,
  xlarge: 1.3
}

/** Device-local: survives a sign-out, like the scheme and the tint. */
export const TEXT_SIZE_KEY = 'device.textSize'

/**
 * Read one defensively: it arrives from disk AND from a gateway another build
 * wrote, and an unknown value is the reader's own default rather than an error.
 */
export function asTextSize(value: unknown): TextSize | undefined {
  return typeof value === 'string' && (TEXT_SIZE_ORDER as readonly string[]).includes(value)
    ? (value as TextSize)
    : undefined
}

/** The factor for a size, with the default's 1 for anything unrecognised. */
export function textSizeScale(size: TextSize | undefined): number {
  return TEXT_SIZE_SCALE[size ?? DEFAULT_TEXT_SIZE] ?? 1
}

export interface TextSizeState {
  textSize: TextSize
  /** Where the size is remembered; null before the page's store is known (nothing is persisted then). */
  storage: WebKeyValueStore | null

  /** Read this browser's size from `storage` and write future ones to it. */
  hydrate: (storage: WebKeyValueStore) => void
  /** The reader picked a size. The bridge sends it and dates the section. */
  setTextSize: (size: TextSize) => void
  /**
   * A gateway's copy said this size. An unknown value says nothing and changes
   * nothing (a newer build's size is not this build's default).
   */
  applyRemote: (value: unknown) => void
  /** Back to the default, and forget the store (tests). A stored size stays stored. */
  reset: () => void
}

export function createTextSizeStore(): StoreApi<TextSizeState> {
  return createStore<TextSizeState>((set, get) => {
    const write = (textSize: TextSize): void => {
      if (textSize === get().textSize) {
        return
      }

      set({ textSize })
      get().storage?.setSync(TEXT_SIZE_KEY, textSize)
    }

    return {
      textSize: DEFAULT_TEXT_SIZE,
      storage: null,

      hydrate(storage) {
        set({ storage, textSize: asTextSize(storage.getSync(TEXT_SIZE_KEY)) ?? DEFAULT_TEXT_SIZE })
      },

      setTextSize: write,

      applyRemote(value) {
        const size = asTextSize(value)

        if (size) {
          write(size)
        }
      },

      reset() {
        set({ textSize: DEFAULT_TEXT_SIZE, storage: null })
      }
    }
  })
}

/** The page's store. */
export const textSizeStore: StoreApi<TextSizeState> = createTextSizeStore()
