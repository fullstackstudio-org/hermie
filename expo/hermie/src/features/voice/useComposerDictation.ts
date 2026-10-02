/**
 * What the composer's microphone button is bound to.
 *
 * The one place the four pieces meet: the recognizer (`useDictation`), the press
 * rule (`press-to-talk.ts`), the caret arithmetic (`dictation.ts`) and the
 * reader's language choice. It produces a `ComposerDictation`, which is plain
 * data — the chat kit draws it and never learns that a microphone exists.
 *
 * ## The anchor is taken once, at the start
 *
 * Not per result. A result is computed from the draft **as it stood when the
 * reader tapped the mic**, so a recognizer revising "recognise" to "recognise
 * their" replaces its own last guess rather than appending to it. The draft is
 * read through a box rather than from a dependency, because it changes on every
 * result this hook itself causes and closing over it would anchor to the
 * previous result.
 *
 * ## What a failure says
 *
 * One line, and only where there is something to say. A refused microphone is
 * the only one with an action, and only on a platform that has a settings screen
 * to send the reader to — see `CAN_OPEN_SETTINGS`. `no-speech` says so and
 * leaves the draft untouched, because a tap that heard nothing is not an error
 * and a composer that silently did nothing would read as a broken button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking } from 'react-native'

import { chatStrings } from '../../chat-ui/strings'
import type { ComposerDictation } from '../../chat-ui/types'
import { CAN_OPEN_SETTINGS } from '../../platform/speech-recognition'
import type { RecognitionEngine, RecognitionFailure } from '../../platform/platform-contracts'
import { anchorAt, withTranscript, type DictationAnchor } from './dictation'
import { PRESS_IDLE, pressIn, pressOut, type PressState } from './press-to-talk'
import { useDictation } from './useDictation'
import { DICTATION_AUTO, useVoiceSettingsStore } from './voice-settings'

export interface UseComposerDictationOptions {
  /** The draft, as the chat store holds it. */
  value: string
  /** Replace the draft. The same setter the composer's own typing uses. */
  onChangeText: (text: string) => void
  /** Open voice mode, where the host offers it. */
  onOpenVoiceMode?: () => void
  engine?: RecognitionEngine
}

/** The one line a failure gets, or nothing at all. */
export function noticeFor(failure: RecognitionFailure | null): string | null {
  if (failure === 'permission') {
    return chatStrings.voice.permissionDenied
  }

  if (failure === 'no-speech') {
    return chatStrings.voice.noSpeech
  }

  if (failure === 'unavailable') {
    return chatStrings.voice.unavailable
  }

  return failure ? chatStrings.voice.failed : null
}

export function useComposerDictation({
  engine,
  onChangeText,
  onOpenVoiceMode,
  value
}: UseComposerDictationOptions): ComposerDictation {
  const language = useVoiceSettingsStore(store => store.dictationLanguage)

  /** The draft and the setter as they are NOW; see the note above about the box. */
  const field = useRef({ onChangeText, value })

  field.current = { onChangeText, value }

  const selection = useRef({ start: value.length, end: value.length })
  const anchor = useRef<DictationAnchor | null>(null)
  const press = useRef<PressState>(PRESS_IDLE)
  const [caret, setCaretRequest] = useState<{ start: number; end: number } | null>(null)

  const onTranscript = useCallback((text: string) => {
    const at = anchor.current

    if (!at) {
      return
    }

    const next = withTranscript(at, text)

    field.current.onChangeText(next.value)
    // A NEW object per result, even when the position repeats: the composer
    // applies this on identity, which is what makes two identical positions two
    // events rather than one. See `ComposerDictation.caret`.
    setCaretRequest({ start: next.caret, end: next.caret })
  }, [])

  const onStart = useCallback(() => {
    anchor.current = anchorAt(field.current.value, selection.current)
  }, [])

  const dictation = useDictation({
    onStart,
    onTranscript,
    ...(engine ? { engine } : {})
  })

  const { cancel, clearError, listening, start, state, stop } = dictation

  /*
    The draft this session was anchored to has been sent.

    Every result is the anchor plus the WHOLE transcript, so one that arrives
    now would not add to the empty field — it would put the sent sentence back
    in it. That is not a corner: tapping the mic off asks the recognizer for
    its final result, which comes a moment later, and a Return inside that
    moment is enough. So the anchor goes, and a session still running (or still
    owing that final result — it is `listening` until the recognizer ends) is
    cancelled rather than stopped: `cancel` disowns anything it has yet to
    deliver, where `stop` would ask for exactly the result this is avoiding.
  */
  const onSent = useCallback(() => {
    anchor.current = null

    if (listening) {
      cancel()
    }
  }, [cancel, listening])

  /*
    An explanation that outlives its moment is clutter, so the next press clears
    the last one. It is an effect on `listening` rather than a call inside the
    press handler because a session can also be started by voice mode, and the
    line should go the moment anything starts listening.
  */
  useEffect(() => {
    if (listening) {
      setCaretRequest(null)
    }
  }, [listening])

  const onPressIn = useCallback(() => {
    clearError()

    const outcome = pressIn(press.current, listening, Date.now())

    press.current = outcome.state

    if (outcome.do === 'start') {
      start(language === DICTATION_AUTO ? {} : { language })
    } else if (outcome.do === 'stop') {
      stop()
    }
  }, [clearError, language, listening, start, stop])

  const onPressOut = useCallback(() => {
    const outcome = pressOut(press.current, Date.now())

    press.current = outcome.state

    if (outcome.do === 'stop') {
      stop()
    }
  }, [stop])

  const message = noticeFor(state.phase === 'error' ? state.failure : null)

  return useMemo<ComposerDictation>(
    () => ({
      available: dictation.available,
      listening,
      notice: message
        ? {
            message,
            // Only where there is somewhere to go, and only for the one failure
            // a settings screen can undo.
            ...(state.failure === 'permission' && CAN_OPEN_SETTINGS
              ? {
                  actionLabel: chatStrings.voice.openSettings,
                  onAction: () => void Linking.openSettings().catch(() => undefined)
                }
              : {})
          }
        : null,
      onPressIn,
      onPressOut,
      ...(onOpenVoiceMode ? { onOpenVoiceMode } : {}),
      caret,
      onSelection: (start_: number, end: number) => {
        selection.current = { start: start_, end }
      },
      onSent
    }),
    [caret, dictation.available, listening, message, onOpenVoiceMode, onPressIn, onPressOut, onSent, state.failure]
  )
}
