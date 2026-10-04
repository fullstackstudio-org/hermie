/**
 * Whether the microphone is open: the one fact the composer's dictation and the chat's reading share.
 *
 * A person is either talking or listening, so the two never use the audio at once: starting to dictate silences
 * what is being read, and nothing is read while the microphone is open. The composer's dictation sets it, and the
 * chat screen reads it for the menu (no "Read aloud" while it is open) and for the reader.
 *
 * A store of its own and not a field of the voice settings: this is a fact about the moment, never kept, and it
 * has to be cheap to import because the chat screen reads it on every chat.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

export interface VoiceActivityState {
  dictating: boolean
  setDictating: (dictating: boolean) => void
}

export function createVoiceActivityStore(): StoreApi<VoiceActivityState> {
  return createStore<VoiceActivityState>(set => ({
    dictating: false,
    setDictating: dictating => set({ dictating })
  }))
}

export const voiceActivityStore: StoreApi<VoiceActivityState> = createVoiceActivityStore()
