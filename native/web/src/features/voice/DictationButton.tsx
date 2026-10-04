/**
 * The composer's microphone: one button, a chunk of its own.
 *
 * The composer draws this only where the browser has a recogniser (`canDictate`), and fetches it then, so a browser
 * without one, and a page that never dictates, never loads a byte of it. A press starts a session and a press again
 * stops it. What is heard goes into the field as it is heard, at the caret, and is a draft like any other: nothing is
 * sent until the reader sends it.
 *
 * Three rules that make it safe to leave running:
 *
 *  - **The anchor is taken once, at the start** (`dictation.ts`), so a recogniser revising its last guess replaces
 *    it instead of adding to it.
 *  - **A change to the field that this did not make ends the session.** Typing, a send, words put back after a
 *    failure: the anchor no longer describes the field, and a result written now would overwrite the change. Every
 *    result is the anchor plus the WHOLE transcript, so one that arrived after a send would put the sentence back in
 *    the empty field. The words already written stay.
 *  - **Nothing is written while a modal layer has the page** (`inert`): what is said then is not for this field,
 *    and a secure prompt may be in front of it. The session ends.
 *
 * While it listens the microphone is open and `voiceActivityStore` says so, which silences a reply being read and
 * keeps one from starting. Leaving the screen, and the tab going to the background, close it.
 */
import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { DICTATION_AUTO, ensureVoiceSettings, voiceSettingsStore } from '../../state/voice-settings'
import { Button, VisuallyHidden } from '../../ui/primitives'
import { voiceActivityStore } from './activity'
import { anchorAt, DictationMachine, type DictationAnchor, type DictationSnapshot, withTranscript } from './dictation'
import { webRecognition } from '../../platform/speech-recognition'
import type { RecognitionEngine } from '../../platform/speech-engines'

export interface DictationButtonProps {
  /** The composer's field, whose selection a session starts from. */
  field: RefObject<HTMLTextAreaElement | null>
  /** What the field holds now. */
  value: string
  /** Put the words in the field, as the composer's own setter does. */
  onValue: (next: string) => void
  /** Told about every change of the session, for the composer's line about it. */
  onState: (snapshot: DictationSnapshot) => void
  /** The page's own recogniser unless a test hands in its own. */
  engine?: RecognitionEngine
}

/** The microphone's glyph: a stroke drawing in the colour of its text, like the shell's other icons. */
function MicIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="hm-icon"
    >
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  )
}

export function DictationButton({
  engine = webRecognition,
  field,
  onState,
  onValue,
  value
}: DictationButtonProps): ReactElement {
  useLocale()
  useMemo(() => ensureVoiceSettings(), [])

  const root = useRef<HTMLButtonElement>(null)
  const anchor = useRef<DictationAnchor | null>(null)
  /**
   * What this session has put in the field: a field that holds anything else was changed by someone else. A set
   * and not the last value, because a render between two writes can still show the one before. The draft the
   * session began with counts only until it has written something: after that, finding the field back at it (a
   * send empties it) is a change by someone else.
   */
  const written = useRef<Set<string>>(new Set())
  const base = useRef<string | null>(null)
  /** The field has had the caret in it at some point: only then does its selection mean anything. */
  const touched = useRef(false)
  const caret = useRef<number | null>(null)
  const listening = useRef(false)
  const [on, setOn] = useState(false)
  const props = useRef({ onState, onValue })

  props.current = { onState, onValue }

  const machine = useMemo(
    () =>
      new DictationMachine(engine, {
        onChange: snapshot => {
          listening.current = snapshot.phase === 'listening'
          setOn(listening.current)
          voiceActivityStore.getState().setDictating(listening.current)
          props.current.onState(snapshot)

          if (snapshot.phase !== 'listening') {
            anchor.current = null
            base.current = null
            written.current = new Set()
          }
        },
        onTranscript: text => {
          const at = anchor.current

          if (!at) {
            return
          }

          // A modal layer (a secure prompt, a request) has the page: nothing is for this field now.
          if (root.current?.closest('[inert]')) {
            machine.cancel()

            return
          }

          const next = withTranscript(at, text)

          written.current.add(next.value)
          caret.current = next.caret
          props.current.onValue(next.value)
        }
      }),
    [engine]
  )

  // The words, then the caret after them: set once the field shows them.
  useLayoutEffect(() => {
    const element = field.current

    if (caret.current !== null && element && element.value === value) {
      const at = caret.current

      caret.current = null
      element.setSelectionRange(at, at)
    }
  }, [field, value])

  // Something other than this session changed the field.
  useEffect(() => {
    if (listening.current && !written.current.has(value) && !(written.current.size === 0 && value === base.current)) {
      machine.cancel()
    }
  }, [machine, value])

  // Where the caret is is known only once the reader has been in the field: a browser reports the start of a field
  // that holds a restored draft, and dictating into the front of it would be the surprise.
  useEffect(() => {
    const element = field.current
    const seen = (): void => {
      touched.current = true
    }

    element?.addEventListener('focus', seen)

    return () => element?.removeEventListener('focus', seen)
  }, [field])

  // The tab going to the background closes the microphone, and so does leaving the screen.
  useEffect(() => {
    const doc = root.current?.ownerDocument
    const onVisibility = (): void => {
      if (doc?.visibilityState === 'hidden') {
        machine.cancel()
      }
    }

    doc?.addEventListener('visibilitychange', onVisibility)

    return () => {
      doc?.removeEventListener('visibilitychange', onVisibility)
      machine.cancel()
      voiceActivityStore.getState().setDictating(false)
    }
  }, [machine])

  const press = useCallback(() => {
    machine.clearError()

    if (listening.current) {
      machine.stop()

      return
    }

    const element = field.current
    const text = element?.value ?? value
    const language = voiceSettingsStore.getState().dictationLanguage

    anchor.current = anchorAt(text, {
      start: touched.current ? (element?.selectionStart ?? text.length) : text.length,
      end: touched.current ? (element?.selectionEnd ?? text.length) : text.length
    })
    base.current = text
    written.current = new Set()
    machine.start(language === DICTATION_AUTO ? {} : { language })
  }, [field, machine, value])

  const label = on ? strings.chat.voice.dictateStop : strings.chat.voice.dictate

  return (
    <Button ref={root} variant="quiet" className="hm-composer__mic" aria-pressed={on} title={label} onClick={press}>
      <MicIcon />
      <VisuallyHidden>{label}</VisuallyHidden>
    </Button>
  )
}
