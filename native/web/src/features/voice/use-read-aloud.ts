/**
 * Reading replies aloud, as the one hook a chat screen holds.
 *
 * Small on purpose: everything it needs to speak (the queue, the flattener, the synthesiser, the automatic read's
 * arithmetic) is `read-aloud.ts`, a chunk of its own that this fetches the first time something is to be read. A
 * chat that never reads aloud, in a browser that could not, never loads it.
 *
 * Three things only a hook can decide:
 *
 *  - **One runtime per chat, made on the first need.** The first "Read aloud", or the first change to a transcript
 *    whose chat reads its replies on its own. The import is asynchronous, so what asked for it is kept and done
 *    when it arrives: a reader's tap is not lost to a network round trip.
 *  - **Seeding.** The automatic read's memory is seeded by the first transcript it sees while the chat is live
 *    (`live`), not by a cached copy of it, so switching it on does not read the back catalogue.
 *  - **Leaving stops it.** Leaving the chat (unmounting, or opening another bot's) silences the speaker, and so does
 *    the microphone opening (`voiceActivityStore`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { autoReadFor, ensureVoiceSettings, voiceSettingsStore } from '../../state/voice-settings'
import { voiceActivityStore } from './activity'
import type { ReadableEntry } from './auto-read'
import { canSpeak } from '../../platform/voice-capabilities'
import type { ReadAloud } from './read-aloud'

const NO_READING: readonly string[] = []

export interface ChatReadAloud {
  /** Whether this browser can speak at all: the menu line and the chat option are drawn only where it can. */
  available: boolean
  /** The rows being read or waiting to be, speaking one first. */
  readingIds: readonly string[]
  /** "Read aloud" and "Stop reading" in one. */
  toggle: (id: string, markdown: string) => void
  /** Silence everything, now: the one way to stop a read the reader did not start from a row (an automatic one). */
  stop: () => void
}

export interface UseReadAloudOptions {
  /** Which chat this is: its automatic read is its own, and a change of chat starts a new reader. */
  bot: string
  /** The VISIBLE transcript, already through the view filters. */
  items: readonly ReadableEntry[]
  turnRunning: boolean
  /** The chat is live (a cached copy is not a conversation: what it holds is history). */
  live: boolean
}

export function useReadAloud({ bot, items, live, turnRunning }: UseReadAloudOptions): ChatReadAloud {
  const available = canSpeak()
  const [reading, setReading] = useState<readonly string[]>(NO_READING)

  // Read from the store the page already opened, before the first read of a choice below.
  useState(() => ensureVoiceSettings())

  const autoRead = useStore(voiceSettingsStore, state => autoReadFor(state, bot))

  const runtime = useRef<ReadAloud | null>(null)
  const loading = useRef<Promise<ReadAloud | null> | null>(null)
  const latest = useRef({ items, turnRunning })

  latest.current = { items, turnRunning }

  /** The runtime, fetched and made on first use; `null` once the chat it belongs to is gone. */
  const ensure = useCallback((): Promise<ReadAloud | null> => {
    if (runtime.current) {
      return Promise.resolve(runtime.current)
    }

    loading.current ??= import('./voice-chunk')
      .then(module => {
        const made = module.createReadAloud({ blocked: () => voiceActivityStore.getState().dictating })

        runtime.current = made
        made.subscribe(() => setReading(made.readingIds()))

        return made
      })
      .catch(() => {
        // A chunk that did not arrive is a read that did not start; the next try fetches it again.
        loading.current = null

        return null
      })

    return loading.current
  }, [])

  // A new chat is a new reader: the old one is silenced and forgotten.
  useEffect(
    () => () => {
      const old = runtime.current

      runtime.current = null
      loading.current = null
      old?.dispose()
      setReading(NO_READING)
    },
    [bot]
  )

  // The microphone opening cuts whatever is being read.
  useEffect(
    () =>
      voiceActivityStore.subscribe(state => {
        if (state.dictating) {
          runtime.current?.stop()
        }
      }),
    []
  )

  // The automatic read: offered every transcript while the chat is live and reads on its own; a chat that does not
  // tells a reader that exists to forget where it was.
  useEffect(() => {
    if (!available || !live) {
      return
    }

    const offer = (target: ReadAloud): void =>
      target.autoRead(latest.current.items, { bot, turnRunning: latest.current.turnRunning })

    if (runtime.current) {
      offer(runtime.current)
    } else if (autoRead) {
      void ensure().then(made => {
        if (made) {
          offer(made)
        }
      })
    }
  }, [autoRead, available, bot, ensure, items, live, turnRunning])

  const toggle = useCallback(
    (id: string, markdown: string): void => {
      void ensure().then(made => made?.toggle(id, markdown))
    },
    [ensure]
  )

  const stop = useCallback((): void => runtime.current?.stop(), [])

  return { available, readingIds: reading, toggle, stop }
}
