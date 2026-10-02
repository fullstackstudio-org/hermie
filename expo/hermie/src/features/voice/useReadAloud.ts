/**
 * Reading replies aloud, as one hook a chat screen holds.
 *
 * All three of the moving parts are elsewhere and testable without React — the
 * flattener (`speech-text.ts`), the queue (`reader.ts`) and the "which replies
 * are new" arithmetic (`auto-read.ts`). What is left here is the wiring, and
 * three decisions that only a hook can make:
 *
 *  - **One reader per screen, built once.** A `SpeechReader` created in a render
 *    body would be a new queue on every keystroke, so it lives in a ref. The
 *    engine is a parameter with a default so a test can hand in its own.
 *  - **Seeding on arrival.** The auto-read set is filled with whatever is
 *    already on screen the moment the feature becomes active for this chat, so
 *    switching it on does not read the back catalogue. Changing chat re-seeds.
 *  - **Leaving stops it.** Unmounting the screen, and backgrounding the app when
 *    the setting says so, both silence the speaker. A reply that goes on being
 *    read after the reader has put the phone away is the single worst failure
 *    mode this feature has.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

import { speechEngine } from '../../platform/speech'
import type { SpeechEngine } from '../../platform/platform-contracts'
import { autoReadCandidates, seenIds, type ReadableEntry } from './auto-read'
import { IDLE, SpeechReader, type ReaderState } from './reader'
import { guessSpeechLanguage, speechText } from './speech-text'
import { useVoiceSettingsStore } from './voice-settings'

export interface UseReadAloudOptions {
  /** Which chat this is, so a change of chat re-seeds the auto-read set. */
  botName: string
  /** The VISIBLE transcript — already through the view filters. */
  items: readonly ReadableEntry[]
  turnRunning: boolean
  /**
   * Something else owns the speaker — voice mode is running.
   *
   * The automatic read keeps BOOKKEEPING while suspended and simply does not
   * speak: every reply that arrives is marked as offered, so leaving voice mode
   * does not set the chat reading aloud everything it answered while the reader
   * was talking to it. Two speakers on one device is the failure this prevents,
   * and it is not hypothetical — voice mode reads every reply by design, and a
   * chat with "Read replies aloud" on would read the same one again underneath.
   */
  suspended?: boolean
  /** Swappable for tests; the default is the platform seam. */
  engine?: SpeechEngine
}

export interface UseReadAloudResult {
  /** False on a platform with no synthesiser: the menu line is not drawn. */
  available: boolean
  /**
   * Every row being read or waiting to be, speaking one first.
   *
   * An array rather than a predicate because it is a memo key for the transcript
   * list: a function would be a new identity on every render of this screen and
   * would rebuild every row's menu with it. It is `EMPTY` while nothing is being
   * read, so the common case is one stable reference.
   */
  readingIds: readonly string[]
  /** Speaking now, or waiting to be. Drives the menu's two labels. */
  isReading: (id: string) => boolean
  /** Whether anything at all is being read, for the overlay and the header. */
  reading: boolean
  /** `Read aloud` and `Stop reading` in one: the menu sends both here. */
  toggle: (id: string, markdown: string) => void
  /** Silence everything, now. */
  stop: () => void
  /** Say this text, outside the transcript. Voice mode's reply beat uses it. */
  speak: (id: string, markdown: string) => void
}

/**
 * Turn a reply's markdown into something to say.
 *
 * The language guess is per UTTERANCE rather than per chat, because a bot that
 * answers in the language it was asked in will switch mid-conversation and a
 * chat-level guess would be stale from that message on. Where the heuristic
 * declines — which is most short replies — nothing is passed and the engine uses
 * the device's own voice, which is the right answer by construction.
 */
function utteranceFor(id: string, markdown: string): { id: string; text: string; language?: string } {
  const text = speechText(markdown)
  const language = guessSpeechLanguage(text)

  return { id, text, ...(language ? { language } : {}) }
}

export function useReadAloud({
  botName,
  engine = speechEngine,
  items,
  suspended = false,
  turnRunning
}: UseReadAloudOptions): UseReadAloudResult {
  const [state, setState] = useState<ReaderState>(IDLE)
  const rate = useVoiceSettingsStore(store => store.rate)
  const stopOnBackground = useVoiceSettingsStore(store => store.stopOnBackground)
  const autoRead = useVoiceSettingsStore(store => store.autoReadByChat[botName] === true)

  /*
    The rate is read through a ref rather than closed over, so an utterance that
    starts after the reader moved the control uses the NEW value without the
    reader itself being rebuilt — rebuilding it would drop the queue.
  */
  const rateRef = useRef(rate)

  rateRef.current = rate

  const reader = useMemo(() => new SpeechReader(engine, { rate: () => rateRef.current, onChange: setState }), [engine])

  /** Ids that have already been offered to the automatic read. */
  const offered = useRef<Set<string>>(new Set())
  /** Which chat, and whether auto-read was on, the set was seeded for. */
  const seededFor = useRef<string | null>(null)

  useEffect(
    () => () => {
      // Leaving the screen silences the speaker. `reader.stop()` rather than
      // `engine.stop()` so the queue goes with it.
      reader.stop()
    },
    [reader]
  )

  useEffect(() => {
    if (!stopOnBackground) {
      return
    }

    const onChange = (status: AppStateStatus): void => {
      if (status !== 'active') {
        reader.stop()
      }
    }

    const subscription = AppState.addEventListener('change', onChange)

    return () => subscription.remove()
  }, [reader, stopOnBackground])

  useEffect(() => {
    if (!autoRead) {
      // Switched off: forget where we were, so switching it back on later seeds
      // afresh rather than reading everything that arrived while it was off.
      seededFor.current = null
      offered.current = new Set()

      return
    }

    // The FIRST pass for this chat is a seed and nothing else, which is what
    // keeps switching the toggle on from reading the back catalogue.
    if (seededFor.current !== botName) {
      seededFor.current = botName
      offered.current = seenIds(items)

      return
    }

    for (const candidate of autoReadCandidates(items, offered.current, turnRunning)) {
      offered.current.add(candidate.id)

      if (!suspended) {
        reader.enqueue(utteranceFor(candidate.id, candidate.text))
      }
    }
  }, [autoRead, botName, items, reader, suspended, turnRunning])

  /*
    Anything already in flight goes when voice mode takes over.

    The bookkeeping above stops the NEXT reply; this stops the one that was
    being read when the reader opened the overlay, which would otherwise carry
    on talking underneath it.
  */
  useEffect(() => {
    if (suspended) {
      reader.stop()
    }
  }, [reader, suspended])

  const toggle = useCallback(
    (id: string, markdown: string) => {
      reader.toggle(utteranceFor(id, markdown))
    },
    [reader]
  )

  const speak = useCallback(
    (id: string, markdown: string) => {
      reader.enqueue(utteranceFor(id, markdown))
    },
    [reader]
  )

  const stop = useCallback(() => reader.stop(), [reader])

  const readingIds = useMemo(
    () =>
      state.speakingId === null && state.queuedIds.length === 0
        ? EMPTY
        : [state.speakingId, ...state.queuedIds].filter((id): id is string => id !== null),
    [state]
  )

  const isReading = useCallback((id: string) => readingIds.includes(id), [readingIds])

  return {
    available: engine.available,
    readingIds,
    isReading,
    reading: state.speakingId !== null,
    toggle,
    stop,
    speak
  }
}

/** One array for every idle reader, so the list's memo key settles. */
const EMPTY: readonly string[] = []
