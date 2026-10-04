/**
 * What the reader has decided about voice, in this browser (`features/voice/voice-settings.ts` in the Expo
 * app, and `VoiceSettings` in the native apps).
 *
 * Device-local, like the scheme and the tint: one blob under `device.voice` of the base-path namespace
 * (`platform/key-value-store.ts`), kept across a sign-out and never sent to a gateway. A speaking rate and a
 * dictation language are facts about one browser on one machine (its speaker, its keyboard, whether it has a
 * microphone at all), and taking them to another would take the wrong answer with them. Whether a chat reads
 * its replies aloud is per chat and per browser for the same reason: a laptop in a meeting and a laptop on a
 * desk want different answers for the same chat.
 *
 * Reads are per field and forgiving: a stored rate is clamped, not thrown away; anything that is not a
 * language is the browser's own. A blob this build cannot parse is left where it is and the defaults are used
 * for the page.
 *
 * Not loaded with the first screen. It is read by the chat screen's chunk and the Settings page, hydrated
 * from the store the page already opened (`ensureVoiceSettings`), so the entry carries none of it.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { WebKeyValueStore } from '../platform/key-value-store'
import { settingsStore } from './settings'

/** The blob's key: device-local, so a sign-out keeps it. */
export const VOICE_KEY = 'device.voice'

/** The five stops on the rate control: the engine's own normal is 1. A slider would promise a precision no engine has. */
export const RATE_STEPS = [0.5, 0.75, 1, 1.25, 1.5] as const

export const DEFAULT_RATE = 1

/** `auto` follows the browser; anything else is a BCP-47 tag the recogniser takes. */
export const DICTATION_AUTO = 'auto'

export interface VoiceSettingsState {
  /** Speaking rate, 1 being the engine's own normal. */
  rate: number
  /** The language dictation listens for. A different thing from the voice a reply is read in: that is guessed per reply. */
  dictationLanguage: string
  /** Stop reading when the tab goes to the background. */
  stopOnBackground: boolean
  /**
   * Show what voice mode heard before it sends it. Stored with the rest so a voice mode finds it; nothing in
   * dictation reads it, because dictation never sends by itself.
   */
  confirmBeforeSending: boolean
  /** The bots whose chats read each finished reply without being asked. Off unless present. */
  autoReadByChat: Readonly<Record<string, true>>
  /** Where the choices are written; null before the page's store is known (nothing is persisted then). */
  storage: WebKeyValueStore | null
  loaded: boolean

  hydrate: (storage: WebKeyValueStore) => void
  setRate: (rate: number) => void
  setDictationLanguage: (language: string) => void
  setStopOnBackground: (value: boolean) => void
  setConfirmBeforeSending: (value: boolean) => void
  setAutoRead: (bot: string, value: boolean) => void
  /** Back to the defaults, and forget the store (tests). A stored choice stays stored. */
  reset: () => void
}

interface Persisted {
  rate?: unknown
  dictationLanguage?: unknown
  stopOnBackground?: unknown
  confirmBeforeSending?: unknown
  autoReadByChat?: unknown
}

/**
 * A stored rate, clamped and defaulted: a value from an older build or a hand-edited file is a value somebody
 * meant, and 3 spoken at 1.5 is closer to the intention than 3 thrown away. Not a number is no rate at all.
 */
export function asRate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1.5, Math.max(0.5, value)) : undefined
}

/** `auto`, or something shaped like a BCP-47 tag. Anything else is not a language. */
export function asLanguage(value: unknown): string | undefined {
  if (value === DICTATION_AUTO) {
    return DICTATION_AUTO
  }

  return typeof value === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value) ? value : undefined
}

/** Only the ones are kept: off is the default, and a map with an entry for every chat ever opened would grow for nothing. */
function asAutoRead(value: unknown): Record<string, true> {
  const out: Record<string, true> = {}

  if (typeof value === 'object' && value !== null) {
    for (const [bot, flag] of Object.entries(value)) {
      if (flag === true && bot !== '') {
        out[bot] = true
      }
    }
  }

  return out
}

function read(storage: WebKeyValueStore): Persisted | null {
  const text = storage.getSync(VOICE_KEY)

  if (text === null) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(text)

    return typeof parsed === 'object' && parsed !== null ? (parsed as Persisted) : null
  } catch {
    return null
  }
}

export function createVoiceSettingsStore(): StoreApi<VoiceSettingsState> {
  return createStore<VoiceSettingsState>((set, get) => {
    const save = (): void => {
      const { autoReadByChat, confirmBeforeSending, dictationLanguage, rate, stopOnBackground, storage } = get()

      storage?.setSync(
        VOICE_KEY,
        JSON.stringify({ rate, dictationLanguage, stopOnBackground, confirmBeforeSending, autoReadByChat })
      )
    }

    return {
      rate: DEFAULT_RATE,
      dictationLanguage: DICTATION_AUTO,
      stopOnBackground: true,
      confirmBeforeSending: true,
      autoReadByChat: {},
      storage: null,
      loaded: false,

      hydrate(storage) {
        const stored = read(storage)

        set({
          storage,
          loaded: true,
          rate: asRate(stored?.rate) ?? DEFAULT_RATE,
          dictationLanguage: asLanguage(stored?.dictationLanguage) ?? DICTATION_AUTO,
          stopOnBackground: stored?.stopOnBackground !== false,
          confirmBeforeSending: stored?.confirmBeforeSending !== false,
          autoReadByChat: asAutoRead(stored?.autoReadByChat)
        })
      },

      setRate(rate) {
        set({ rate: asRate(rate) ?? DEFAULT_RATE })
        save()
      },

      setDictationLanguage(language) {
        set({ dictationLanguage: asLanguage(language) ?? DICTATION_AUTO })
        save()
      },

      setStopOnBackground(stopOnBackground) {
        set({ stopOnBackground })
        save()
      },

      setConfirmBeforeSending(confirmBeforeSending) {
        set({ confirmBeforeSending })
        save()
      },

      setAutoRead(bot, value) {
        const next: Record<string, true> = { ...get().autoReadByChat }

        if (value) {
          next[bot] = true
        } else {
          delete next[bot]
        }

        set({ autoReadByChat: next })
        save()
      },

      reset() {
        set({
          rate: DEFAULT_RATE,
          dictationLanguage: DICTATION_AUTO,
          stopOnBackground: true,
          confirmBeforeSending: true,
          autoReadByChat: {},
          storage: null,
          loaded: false
        })
      }
    }
  })
}

/** The page's store. */
export const voiceSettingsStore: StoreApi<VoiceSettingsState> = createVoiceSettingsStore()

/**
 * Read what this browser kept, once, from the store the page already opened for its other device settings.
 * Called by whatever first needs a voice choice; a page with no store (a test of a screen, a gallery) keeps the
 * defaults and holds its choices for as long as it is open.
 */
export function ensureVoiceSettings(
  store: StoreApi<VoiceSettingsState> = voiceSettingsStore,
  storage: WebKeyValueStore | null = settingsStore.getState().storage
): void {
  if (!store.getState().loaded && storage) {
    store.getState().hydrate(storage)
  }
}

/** Whether this chat reads its replies aloud without being asked. */
export const autoReadFor = (state: Pick<VoiceSettingsState, 'autoReadByChat'>, bot: string): boolean =>
  state.autoReadByChat[bot] === true
