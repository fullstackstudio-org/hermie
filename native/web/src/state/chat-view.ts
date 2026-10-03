/**
 * What a chat shows of its transcript: the verbosity, the bot-to-bot toggle and
 * the thinking toggle.
 *
 * Ported from the chat-view half of the Expo app's `store/settings.ts`. All three
 * are read-time decisions of `@hermie/transcript` (`visibleItems`): nothing here
 * changes what is stored, only what is shown, so a switch is instant and safe in
 * the middle of a turn. There is one default and an optional override per chat,
 * keyed by bot name; a chat without one follows the default as it moves, and a
 * chat with one keeps it until it is reset.
 *
 * Deliberate differences:
 *
 *  - **The default is `normal`, not `quiet`.** It is what this client has shown
 *    since it could show a chat, and Settings (W-20b) is where the default is
 *    chosen and the synced arrangement (W-20a) is where the account's value
 *    arrives; until then a client that silently started hiding every tool call
 *    would be a change nobody asked for.
 *  - **Stored in the page's key-value store** under an identity-bound key
 *    (`chat.view`, no `device.` prefix), so a sign-out clears it: it belongs to
 *    the account, like the Expo app's per-gateway blob. Read synchronously once,
 *    after the cache was claimed for its owner (`main.tsx`).
 *
 * A vanilla zustand store (`chatViewStore`, and `createChatViewStore` for tests),
 * read by `features/` through `useStore`.
 */
import type { Verbosity, VisibilityOptions } from '@hermie/transcript'
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { WebKeyValueStore } from '../platform/key-value-store'

export type ChatView = VisibilityOptions

/** What a chat shows until the reader or the account says otherwise: tool calls as one line each, no reasoning. */
export const DEFAULT_CHAT_VIEW: ChatView = { level: 'normal', showBotToBot: true, showThinking: false }

/** Identity-bound: cleared on sign-out (`platform/key-value-store.ts`). */
export const CHAT_VIEW_KEY = 'chat.view'

export const VERBOSITIES: readonly Verbosity[] = ['quiet', 'normal', 'verbose']

const asVerbosity = (value: unknown): Verbosity | undefined =>
  typeof value === 'string' && (VERBOSITIES as readonly string[]).includes(value) ? (value as Verbosity) : undefined

/** A stored view, defensively: an older build, or another hand, may have written anything. */
export function asViewPatch(value: unknown): Partial<ChatView> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const raw = value as Record<string, unknown>
  const level = asVerbosity(raw.level)

  return {
    ...(level ? { level } : {}),
    ...(typeof raw.showBotToBot === 'boolean' ? { showBotToBot: raw.showBotToBot } : {}),
    ...(typeof raw.showThinking === 'boolean' ? { showThinking: raw.showThinking } : {})
  }
}

interface Persisted {
  defaults?: unknown
  perChat?: unknown
}

export interface ChatViewState {
  defaults: ChatView
  perChat: Record<string, Partial<ChatView>>
  /** Where changes are written; null before the page's store is known (nothing is persisted then). */
  storage: WebKeyValueStore | null

  /** Read the account's choices from `storage`, and write future ones to it. */
  hydrate: (storage: WebKeyValueStore) => void
  setDefaults: (patch: Partial<ChatView>) => void
  /** Pin this chat's own view; what the patch leaves out still follows the default. */
  setChatView: (bot: string, patch: Partial<ChatView>) => void
  /** Back to following the default. */
  resetChatView: (bot: string) => void
  /** Back to the defaults in memory, and forget the store (tests). */
  reset: () => void
}

function read(storage: WebKeyValueStore): Pick<ChatViewState, 'defaults' | 'perChat'> {
  let stored: Persisted | null = null

  try {
    const raw = storage.getSync(CHAT_VIEW_KEY)

    stored = raw ? (JSON.parse(raw) as Persisted) : null
  } catch {
    stored = null
  }

  const perChat: Record<string, Partial<ChatView>> = Object.create(null) as Record<string, Partial<ChatView>>
  const source = stored?.perChat

  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [bot, patch] of Object.entries(source as Record<string, unknown>)) {
      const parsed = asViewPatch(patch)

      if (Object.keys(parsed).length > 0) {
        perChat[bot] = parsed
      }
    }
  }

  return { defaults: { ...DEFAULT_CHAT_VIEW, ...asViewPatch(stored?.defaults) }, perChat }
}

export function createChatViewStore(): StoreApi<ChatViewState> {
  return createStore<ChatViewState>((set, get) => {
    const save = (): void => {
      const { storage, defaults, perChat } = get()

      // A preference that failed to persist resets on the next visit; not worth an error.
      try {
        storage?.setSync(CHAT_VIEW_KEY, JSON.stringify({ defaults, perChat: { ...perChat } }))
      } catch {
        // see above
      }
    }

    return {
      defaults: DEFAULT_CHAT_VIEW,
      perChat: {},
      storage: null,

      hydrate(storage) {
        set({ storage, ...read(storage) })
      },

      setDefaults(patch) {
        set({ defaults: { ...get().defaults, ...asViewPatch(patch) } })
        save()
      },

      setChatView(bot, patch) {
        const merged = { ...get().perChat[bot], ...asViewPatch(patch) }

        set({ perChat: { ...get().perChat, [bot]: merged } })
        save()
      },

      resetChatView(bot) {
        if (!Object.hasOwn(get().perChat, bot)) {
          return
        }

        const perChat = { ...get().perChat }

        delete perChat[bot]
        set({ perChat })
        save()
      },

      reset() {
        set({ defaults: DEFAULT_CHAT_VIEW, perChat: {}, storage: null })
      }
    }
  })
}

/** The page's store. */
export const chatViewStore: StoreApi<ChatViewState> = createChatViewStore()

/** Whether this chat pins its own view rather than following the default. */
export function hasChatViewOverride(state: Pick<ChatViewState, 'perChat'>, bot: string): boolean {
  return Object.keys(state.perChat[bot] ?? {}).length > 0
}

/** The view one chat shows: the default with its override folded in. */
export function chatViewFor(state: Pick<ChatViewState, 'defaults' | 'perChat'>, bot: string): ChatView {
  return { ...state.defaults, ...state.perChat[bot] }
}
