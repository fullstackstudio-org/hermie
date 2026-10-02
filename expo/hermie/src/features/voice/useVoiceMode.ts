/**
 * Voice mode, wired to one chat.
 *
 * The loop itself is `voice-loop.ts` and has no React, no gateway and no
 * speaker in it. What this adds is the three bindings only a screen can make:
 *
 *  - **Sending** goes through the chat's own `send`, so a spoken message is a
 *    message: it is queued behind a running turn like any other, it lands in the
 *    transcript, and it is subject to every rule the composer's send is.
 *  - **The reply** is the first assistant row that arrives after the turn this
 *    loop started has FINISHED. Never while streaming, for the reason the
 *    automatic read gives: a reply being written is a reply whose text will be
 *    different in 200ms.
 *  - **Speaking** is the same flattener and the same rate the menu's Read aloud
 *    uses, so a reply sounds the same however it was asked for.
 *
 * ## Haptics
 *
 * On the two edges of listening and nowhere else. `choice` rather than a new
 * moment: `platform/haptics.ts` keeps a deliberately closed set of three, and a
 * microphone opening is the same class of event as committing an answer — a
 * light selection tick confirming something the reader just caused. Widening
 * that set would be a decision about the app's haptic vocabulary, which this
 * feature has no business making on its own.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { haptic } from '../../platform/haptics'
import { speechEngine } from '../../platform/speech'
import { speechRecognition } from '../../platform/speech-recognition'
import type { RecognitionEngine, SpeechEngine } from '../../platform/platform-contracts'
import { seenIds, type ReadableEntry } from './auto-read'
import { guessSpeechLanguage, speechText } from './speech-text'
import { DICTATION_AUTO, useVoiceSettingsStore } from './voice-settings'
import { VOICE_IDLE, VoiceLoop, type VoiceLoopState } from './voice-loop'

export interface UseVoiceModeOptions {
  /** The VISIBLE transcript, so a hidden reply is not read either. */
  items: readonly ReadableEntry[]
  turnRunning: boolean
  /** The chat's own send. Resolving means accepted, not answered. */
  send: (text: string) => Promise<unknown>
  engine?: RecognitionEngine
  speech?: SpeechEngine
}

export interface UseVoiceModeResult {
  /** False unless the platform can both listen and speak. */
  available: boolean
  /** The overlay is up. */
  active: boolean
  state: VoiceLoopState
  open: () => void
  leave: () => void
  interrupt: () => void
  cancel: () => void
}

export function useVoiceMode({
  engine = speechRecognition,
  items,
  send,
  speech = speechEngine,
  turnRunning
}: UseVoiceModeOptions): UseVoiceModeResult {
  const [state, setState] = useState<VoiceLoopState>(VOICE_IDLE)
  const [active, setActive] = useState(false)
  const language = useVoiceSettingsStore(store => store.dictationLanguage)
  const confirm = useVoiceSettingsStore(store => store.confirmBeforeSending)
  const rate = useVoiceSettingsStore(store => store.rate)

  /*
    Everything that changes per render reaches the loop through this box.

    The loop is built once — rebuilding it would abandon a session mid-sentence —
    so the rate, the send and the reply bookkeeping are read from here rather
    than closed over.
  */
  const live = useRef({ rate, send })

  live.current = { rate, send }

  /** Ids present when the loop's turn was sent; anything new after it is the reply. */
  const before = useRef<Set<string> | null>(null)

  const loop = useMemo(
    () =>
      new VoiceLoop({
        engine,
        confirm,
        ...(language === DICTATION_AUTO ? {} : { language }),
        onChange: setState,
        onListeningChange: () => haptic('choice'),
        send: async text => {
          // Snapshot BEFORE the send, so the reply is told apart from anything
          // that happened to arrive while the reader was speaking.
          before.current = seenIds(itemsRef.current)
          await live.current.send(text)
        },
        speak: (markdown, done) => {
          const text = speechText(markdown)
          const guessed = guessSpeechLanguage(text)

          if (!text.trim()) {
            done()

            return
          }

          speech.speak({
            text,
            ...(guessed ? { language: guessed } : {}),
            rate: live.current.rate,
            onDone: done,
            // A reply that could not be spoken must not strand the loop in
            // `speaking` with a silent overlay: it listens again instead.
            onError: done
          })
        },
        stopSpeaking: () => speech.stop()
      }),
    [confirm, engine, language, speech]
  )

  /** The list as it is now, for the snapshot above. */
  const itemsRef = useRef(items)

  itemsRef.current = items

  /*
    The reply, once the turn has finished.

    `before` is cleared as soon as one is handed over, so a second turn the
    reader did not start — a cron delivery, a bot-to-bot reply — is not mistaken
    for an answer to what they said.
  */
  useEffect(() => {
    if (!active || turnRunning || !before.current || state.phase !== 'waiting') {
      return
    }

    const fresh = items.find(entry => entry.item.kind === 'assistant' && !before.current?.has(entry.item.id))

    if (!fresh) {
      return
    }

    before.current = null
    loop.replied(fresh.item.text ?? '')
  }, [active, items, loop, state.phase, turnRunning])

  // Leaving the screen, or the loop being rebuilt, closes the microphone.
  useEffect(() => () => loop.leave(), [loop])

  const leave = useCallback(() => {
    before.current = null
    loop.leave()
    setActive(false)
  }, [loop])

  return {
    // Both halves: a loop that can listen but not answer aloud is a loop that
    // leaves the reader holding a phone waiting for a voice that never comes.
    available: engine.available && speech.available,
    active,
    state,
    open: useCallback(() => {
      setActive(true)
      loop.start()
    }, [loop]),
    leave,
    interrupt: useCallback(() => loop.interrupt(), [loop]),
    cancel: useCallback(() => loop.cancel(), [loop])
  }
}
