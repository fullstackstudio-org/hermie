/**
 * What the three interactive sheets (`FormSheet`, `FileSheet`, `DraftSheet`) have in common: the frame they are
 * drawn in, the guard that keeps a stray press from answering, the countdown, and what an answer's outcome says.
 *
 * The rules, the same as the secure input sheets' (`SecureSheet.tsx`):
 *
 *  1. **The chrome is the app's.** The heading, the gateway's host, the labels, who receives the answer and the
 *     buttons are fixed words. The request's own words (its heading, its summary, its detail, the name of the person
 *     it acts for) are plain text in a quoted box under a label that says they are the bot's: never Markdown, never a
 *     link, already cleaned and bounded by the reader (`interactive-types.ts`).
 *  2. **What is entered is never state outside the sheet.** The sheet holds it in its own component state for as long
 *     as it is on screen, and hands it to `InteractiveModel.answer` once; no store, cache, draft or log sees it.
 *  3. **Nothing takes a stray press.** For `tapGuardMs` after the sheet appears its controls are off, so a click or a
 *     keystroke meant for what was under it never answers (Escape and the scrim do nothing: the layer keeps them).
 *  4. **A countdown to the gateway's deadline.** The model ends the request at the deadline on its own clock.
 *  5. **Offline, busy and failed are said, never swallowed:** nothing was sent, and what was entered stays.
 */
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import type { AnswerOutcome } from '../../core/requests/interactive'
import { sheetStrings } from '../../i18n/sheet-strings'
import type { InteractiveRequest } from '../../state/interactive'
import { SecureQuote } from './SecureSheet'
import './interactive-sheets.css'

const clock = (): number => Date.now()

/** `m:ss`, never negative. */
const countdown = (ms: number): string => {
  const left = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** Whether the sheet takes presses yet: false for `tapGuardMs` after it appears (and again for a new request). */
export function useTapGuard(tapGuardMs: number, key: unknown): boolean {
  const [armed, setArmed] = useState(tapGuardMs <= 0)

  useEffect(() => {
    if (tapGuardMs <= 0) {
      setArmed(true)

      return
    }

    setArmed(false)

    const timer = setTimeout(() => setArmed(true), tapGuardMs)

    return () => clearTimeout(timer)
  }, [key, tapGuardMs])

  return armed
}

/** What a failed try says, apart from the gateway's refusal (which the sheet reads from the request). */
export type SendNotice = 'offline' | 'busy' | 'failed'

export interface Sending {
  /** An answer is on its way. */
  pending: boolean
  /** The request is answered or gone: nothing more is taken. */
  finished: boolean
  /** What the last try came to, when it did not get through. */
  notice: SendNotice | null
  /** Run one answer or Skip; a second press while one is on its way (or after it was taken) does nothing. */
  run(send: () => Promise<AnswerOutcome>): Promise<AnswerOutcome | null>
  clearNotice(): void
  /** Say what became of a Don't share (`cannotShow`): nothing went out while offline or while an answer is on its way. */
  declined(result: 'sent' | 'closed' | 'offline' | 'busy'): void
}

/**
 * One answer at a time: the press that sends is the only one until the model's outcome is known, so a double press
 * cannot answer twice, and a press after the request is taken does nothing.
 */
export function useSending(): Sending {
  const [pending, setPending] = useState(false)
  const [finished, setFinished] = useState(false)
  const [notice, setNotice] = useState<SendNotice | null>(null)
  const inFlight = useRef(false)
  const done = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true

    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(async (send: () => Promise<AnswerOutcome>): Promise<AnswerOutcome | null> => {
    if (inFlight.current || done.current) {
      return null
    }

    inFlight.current = true
    setPending(true)
    setNotice(null)

    let outcome: AnswerOutcome

    try {
      outcome = await send()
    } catch {
      outcome = { kind: 'failed', message: '' }
    }

    inFlight.current = false

    if (outcome.kind === 'sent' || outcome.kind === 'closed' || outcome.kind === 'ended') {
      done.current = true
    }

    if (alive.current) {
      setPending(false)
      setFinished(done.current)
      setNotice(
        outcome.kind === 'offline'
          ? 'offline'
          : outcome.kind === 'busy'
            ? 'busy'
            : outcome.kind === 'failed'
              ? 'failed'
              : null
      )
    }

    return outcome
  }, [])

  const declined = useCallback((result: 'sent' | 'closed' | 'offline' | 'busy'): void => {
    setNotice(result === 'offline' ? 'offline' : result === 'busy' ? 'busy' : null)
  }, [])

  return { pending, finished, notice, run, clearNotice: () => setNotice(null), declined }
}

/** The line under the sheet that says a try did not get through. */
export function SendStatus({ notice }: { notice: SendNotice | null }): ReactElement {
  return (
    <p className="hm-requests__phase" role="status" data-tone={notice === null ? undefined : 'danger'}>
      {notice === null ? '' : sheetStrings.interactive[notice]}
    </p>
  )
}

/** The gateway's refusal of the last answer, in words, over the sheet's own controls. */
export function RefusalAlert({ text }: { text: string | null }): ReactElement | null {
  if (text === null || text === '') {
    return null
  }

  return (
    <p className="hm-requests__phase hm-interactive__refusal" role="alert" data-tone="danger">
      {text}
    </p>
  )
}

/** The countdown to the deadline, as text (not a live region: it would read out every second). */
export function Countdown({ deadline, now = clock }: { deadline: number; now?: () => number }): ReactElement {
  const [time, setTime] = useState(now)

  useEffect(() => {
    setTime(now())

    const timer = setInterval(() => setTime(now()), 1000)

    return () => clearInterval(timer)
  }, [deadline, now])

  return (
    <p className="hm-requests__meta" data-tone={deadline - time <= 10_000 ? 'danger' : undefined}>
      {sheetStrings.secureInput.expiresIn({ time: countdown(deadline - time) })}
    </p>
  )
}

export interface InteractiveFrameProps {
  request: InteractiveRequest
  /** The gateway's host. */
  gateway: string
  /** The heading: fixed words. */
  title: string
  titleId: string
  descriptionId: string
  /** Who receives the answer, and what becomes of it. */
  receiver: string
  /** What the sheet asks for: its fields, its picker, its editor. */
  children: ReactNode
  /** Between the body and the receiver's line: what the sheet has to say about a try (its refusal, a notice). */
  status?: ReactNode
  /** The buttons. */
  actions: ReactNode
  now?: () => number
}

/** The frame: heading, the bot's own words, the body the sheet draws, the deadline, who receives it, the buttons. */
export function InteractiveFrame({
  request,
  gateway,
  title,
  titleId,
  descriptionId,
  receiver,
  children,
  status,
  actions,
  now
}: InteractiveFrameProps): ReactElement {
  const { ask } = request

  return (
    <>
      <h2 className="hm-requests__title" id={titleId}>
        {title}
      </h2>

      <p className="hm-requests__lead" id={descriptionId}>
        {sheetStrings.secureInput.gateway({ host: gateway })}
      </p>

      {request.earlierLost ? (
        <p className="hm-requests__phase" data-tone="danger">
          {request.earlierLost === 'skip'
            ? sheetStrings.secureInput.earlierSkipLost
            : sheetStrings.secureInput.earlierAnswerLost}
        </p>
      ) : null}

      <SecureQuote label={sheetStrings.interactive.quoteLabel} text={`${ask.title}\n${ask.summary}`} />

      {ask.detail ? <SecureQuote label={sheetStrings.interactive.detailLabel} text={ask.detail} monospaced /> : null}

      {ask.actingUser ? (
        <p className="hm-requests__meta">
          {sheetStrings.interactive.actingFor}: <span data-agent-text="">{ask.actingUser}</span>
        </p>
      ) : null}

      {children}

      <Countdown deadline={request.deadline} {...(now ? { now } : {})} />

      {status}

      <p className="hm-secure__receiver">{receiver}</p>

      <div className="hm-requests__actions">{actions}</div>
    </>
  )
}
