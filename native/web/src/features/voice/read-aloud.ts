/**
 * Reading replies aloud, for one chat screen: the queue (`reader.ts`), the words flattened for the ear
 * (`speech-text.ts`), the reader's settings, and what stops it.
 *
 * A module of its own, fetched the first time something is read (`use-read-aloud.ts`): a reader who never asks for
 * a reply to be read aloud, and has no chat that reads its replies, never loads a byte of it.
 *
 * Three decisions that only a runtime can make:
 *
 *  - **One reader per screen, built once.** A queue made in a render would be a new queue on every keystroke.
 *  - **Seeding on arrival.** The automatic read's memory is filled with whatever is on screen when it becomes active
 *    for this chat, so switching it on does not read the back catalogue (`auto-read.ts`).
 *  - **Leaving stops it.** Leaving the screen, and putting the tab in the background when the setting says so, both
 *    silence the speaker. A reply that goes on being read after the reader has switched to another tab is the worst
 *    failure this feature has.
 *
 * What it does NOT do is speak over the microphone: while dictation has the audio (`blocked`) nothing is read, and
 * what arrives meanwhile is marked as offered, so the end of dictation does not set the chat reading everything it
 * answered while the reader was talking.
 */
import type { StoreApi } from 'zustand/vanilla'

import { autoReadFor, voiceSettingsStore, type VoiceSettingsState } from '../../state/voice-settings'
import { autoReadCandidates, freshMemory, seed, type ReadableEntry } from './auto-read'
import type { SpeechEngine } from '../../platform/speech-engines'
import { SpeechReader } from './reader'
import { guessSpeechLanguage, speechText } from './speech-text'
import { webSynthesis } from '../../platform/speech-synthesis'

export interface ReadAloud {
  /** False where the browser has no synthesiser: nothing is queued, and the menu line is not drawn. */
  readonly available: boolean
  /** Every row being read or waiting to be, speaking one first. A new array only when it changed. */
  readingIds: () => readonly string[]
  subscribe: (listener: () => void) => () => void
  /** "Read aloud" and "Stop reading" in one: the menu sends both here. */
  toggle: (id: string, markdown: string) => void
  /** Offer what has arrived since the last call to the reader, if this chat reads aloud. */
  autoRead: (entries: readonly ReadableEntry[], options: { bot: string; turnRunning: boolean }) => void
  /** Silence everything, now. */
  stop: () => void
  /** The screen is going: silence, and let go of the page. */
  dispose: () => void
}

export interface ReadAloudOptions {
  engine?: SpeechEngine
  settings?: StoreApi<VoiceSettingsState>
  doc?: Document
  /** Dictation has the audio: nothing is spoken until it lets go. */
  blocked?: () => boolean
}

const NONE: readonly string[] = []

/** Turn a reply's Markdown into something to say. The language is guessed per reply: a bot switches mid-chat. */
function requestFor(id: string, markdown: string): { id: string; text: string; language?: string } {
  const text = speechText(markdown)
  const language = guessSpeechLanguage(text)

  return { id, text, ...(language ? { language } : {}) }
}

export function createReadAloud({
  blocked = () => false,
  doc = typeof document === 'undefined' ? undefined : document,
  engine = webSynthesis,
  settings = voiceSettingsStore
}: ReadAloudOptions = {}): ReadAloud {
  const listeners = new Set<() => void>()
  let reading: readonly string[] = NONE
  let memory = freshMemory()

  const reader = new SpeechReader(engine, {
    // Read when an utterance starts, so a rate moved mid-read applies to the next one without dropping the queue.
    rate: () => settings.getState().rate,
    onChange: state => {
      const ids = state.speakingId === null ? state.queuedIds : [state.speakingId, ...state.queuedIds]

      reading = ids.length === 0 ? NONE : ids

      for (const listener of listeners) {
        listener()
      }
    }
  })

  const onVisibility = (): void => {
    if (doc?.visibilityState === 'hidden' && settings.getState().stopOnBackground) {
      reader.stop()
    }
  }

  doc?.addEventListener('visibilitychange', onVisibility)

  return {
    get available(): boolean {
      return engine.available
    },

    readingIds: () => reading,

    subscribe: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },

    toggle: (id, markdown) => {
      if (!blocked()) {
        reader.toggle(requestFor(id, markdown))
      }
    },

    autoRead: (entries, { bot, turnRunning }) => {
      if (!autoReadFor(settings.getState(), bot)) {
        // Off: forget where we were, so switching it on later seeds afresh rather than reading what arrived while
        // it was off.
        memory = freshMemory()

        return
      }

      if (!memory.seeded) {
        seed(entries, memory)

        return
      }

      for (const candidate of autoReadCandidates(entries, memory, turnRunning)) {
        memory.offered.add(candidate.id)
        memory.frontier = candidate.id

        if (!blocked()) {
          reader.enqueue(requestFor(candidate.id, candidate.text))
        }
      }
    },

    stop: () => reader.stop(),

    dispose: () => {
      doc?.removeEventListener('visibilitychange', onVisibility)
      reader.stop()
      listeners.clear()
    }
  }
}
