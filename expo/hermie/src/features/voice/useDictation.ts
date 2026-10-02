/**
 * The dictation machine, with a React lifetime around it.
 *
 * Thin on purpose: everything that could be wrong is in `dictation.ts` and has
 * a test. What is here is the three things a hook has to own — one machine per
 * mount, a snapshot to render from, and a cancel on the way out, because a
 * recognizer left listening after its screen has gone is a microphone nobody
 * can see is on.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { speechRecognition } from '../../platform/speech-recognition'
import type { RecognitionEngine } from '../../platform/platform-contracts'
import { DICTATION_IDLE, DictationMachine, type DictationSnapshot, type StartOptions } from './dictation'

export interface UseDictationOptions {
  /** Every result, partial and final. The caller puts it where it belongs. */
  onTranscript: (text: string, final: boolean) => void
  /** A session is beginning: the caller takes its anchor here. */
  onStart?: () => void
  /** Swappable for tests; the default is the platform seam. */
  engine?: RecognitionEngine
}

export interface UseDictationResult {
  /** False where there is no recognizer: the mic button is not drawn at all. */
  available: boolean
  state: DictationSnapshot
  listening: boolean
  start: (options?: StartOptions) => void
  stop: () => void
  cancel: () => void
  clearError: () => void
}

export function useDictation({
  engine = speechRecognition,
  onStart,
  onTranscript
}: UseDictationOptions): UseDictationResult {
  const [state, setState] = useState<DictationSnapshot>(DICTATION_IDLE)

  /*
    The callbacks are read through a box rather than closed over, so a parent
    that re-renders — which a composer does on every keystroke — does not rebuild
    the machine and cancel the session the reader is in the middle of.
  */
  const [handlers] = useState(() => ({ onStart, onTranscript }))

  handlers.onStart = onStart
  handlers.onTranscript = onTranscript

  const machine = useMemo(
    () =>
      new DictationMachine(engine, {
        onChange: setState,
        onTranscript: (text, final) => handlers.onTranscript(text, final)
      }),
    [engine, handlers]
  )

  useEffect(() => () => machine.cancel(), [machine])

  const start = useCallback(
    (options?: StartOptions) => {
      handlers.onStart?.()
      void machine.start(options)
    },
    [handlers, machine]
  )

  return {
    available: machine.available,
    state,
    listening: state.phase === 'listening' || state.phase === 'starting',
    start,
    stop: useCallback(() => machine.stop(), [machine]),
    cancel: useCallback(() => machine.cancel(), [machine]),
    clearError: useCallback(() => machine.clearError(), [machine])
  }
}
