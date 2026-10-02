/**
 * Which languages this device can recognise offline.
 *
 * Asked once per mount and never refreshed, which is the right cadence for what
 * it is: a reader who downloads a new keyboard language mid-session is welcome
 * to reopen the sheet, and polling the platform for a list that changes once a
 * year would be a promise about freshness nothing else here makes.
 *
 * An empty array is the ordinary answer on most devices, not a failure — the
 * platform either cannot say (Android below API 31, and the web) or has nothing
 * installed. The picker then offers the device's own language alone, which is
 * what `DICTATION_AUTO` means and what the recognizer would have used anyway.
 */
import { useEffect, useState } from 'react'

import { speechRecognition } from '../../platform/speech-recognition'
import type { RecognitionEngine } from '../../platform/platform-contracts'

/** One array for every device that answers nothing, so the sheet's props settle. */
const NONE: readonly string[] = []

export function useDictationLanguages(engine: RecognitionEngine = speechRecognition): readonly string[] {
  const [languages, setLanguages] = useState<readonly string[]>(NONE)

  useEffect(() => {
    if (!engine.available) {
      return
    }

    let live = true

    void engine
      .supportedLanguages()
      .then(tags => {
        // Sorted, because the platform's order is the order the models were
        // installed in and a picker sorted by download date is a picker nobody
        // can find anything in.
        if (live && tags.length) {
          setLanguages([...tags].sort())
        }
      })
      .catch(() => undefined)

    return () => {
      live = false
    }
  }, [engine])

  return languages
}
