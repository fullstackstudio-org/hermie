/**
 * A `confirm` at level `passkey`: the gateway asks the person to confirm one
 * action, and verifies the answer itself (plan P15, contract §8).
 *
 * The rules, the native apps' (`HermieUI/Requests`, plan P8 and P15):
 *
 *  1. **The frame is the page's, the text is the gateway's.** Everything but the
 *     title, the summary and the detail is fixed wording: who asks (the gateway's
 *     host), which passkey the browser will ask for (this page's host), the
 *     buttons. Nothing from the agent reaches a button or the chrome.
 *  2. **Verbatim.** Title, summary and detail are shown exactly as the frame
 *     carried them, as characters, never as Markdown. The detail is monospaced
 *     with every space and line break kept (`white-space: pre`) and scrolls
 *     sideways rather than wrapping, so a line break is never hidden and a
 *     command reads as the command that runs. The challenge the browser signs is
 *     computed from these same values (`PasskeyConfirmation`), and nothing else.
 *  3. **Only an explicit press answers.** Escape does not dismiss (the layer
 *     keeps it), and the buttons wake `tapGuardMs` after the sheet appears, so a
 *     click or a Return already on its way answers nothing.
 *  4. **`received` is not "confirmed".** After the gateway said `ok` the sheet
 *     says the answer arrived and that the gateway checks it; if the gateway's
 *     commit fails it says that nothing was confirmed.
 */
import { type ReactElement, useEffect, useId, useState } from 'react'

import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { type ConfirmPhase, isActionablePhase, isOpenPhase, type PasskeyConfirmation } from '../../state/passkeys'
import { Button } from '../../ui/primitives'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'

export interface ConfirmSheetProps {
  confirmation: PasskeyConfirmation
  /** The RP the browser's sheet will name: this page's hostname. */
  rpId: string
  /** The dialog's accessible name is this heading. */
  titleId: string
  /** The line that says who asks: the dialog's description. */
  descriptionId: string
  onConfirm: () => void
  onDecline: () => void
  /** Close the sheet of a finished confirmation. */
  onClose: () => void
  /** Milliseconds before a press is accepted. Tests pass 0. */
  tapGuardMs?: number
  /** Unix seconds, for the countdown; the clock unless a test hands in its own. */
  now?: () => number
}

const clockSeconds = (): number => Date.now() / 1000

/** `m:ss`, never negative. */
const countdown = (seconds: number): string => {
  const left = Math.max(0, Math.floor(seconds))

  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** What the sheet says about where the confirmation stands, or nothing while it waits for a press. */
export function phaseText(phase: ConfirmPhase): string {
  switch (phase.kind) {
    case 'waiting':
    case 'declined':
      return ''
    case 'signing':
      return webStrings.passkeys.signing
    case 'sending':
      return webStrings.passkeys.sending
    case 'refused':
      return webStrings.passkeys.refused({ reason: phase.reason || 'refused' })
    case 'not_sent':
      return webStrings.passkeys.notSent({ message: phase.message })
    case 'received':
      return webStrings.passkeys.received
    case 'ended':
      switch (phase.end.kind) {
        case 'verification_failed':
          return webStrings.passkeys.verificationFailed
        case 'too_many_attempts':
          return webStrings.passkeys.tooManyAttempts
        case 'not_allowed':
          return webStrings.passkeys.notAllowed
        case 'unavailable':
          return webStrings.passkeys.unavailable({ reason: phase.end.reason })
        default:
          return ''
      }
  }
}

/** A phase whose words are a failure: drawn in the danger ink. */
const isFailure = (phase: ConfirmPhase): boolean =>
  phase.kind === 'refused' || phase.kind === 'not_sent' || phase.kind === 'ended'

export function ConfirmSheet({
  confirmation,
  rpId,
  titleId,
  descriptionId,
  onConfirm,
  onDecline,
  onClose,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now = clockSeconds
}: ConfirmSheetProps): ReactElement {
  useLocale()

  const detailId = useId()
  const [armed, setArmed] = useState(tapGuardMs <= 0)
  const [clock, setClock] = useState(now)
  const { phase } = confirmation
  const open = isOpenPhase(phase)
  const actionable = armed && isActionablePhase(phase)
  const host = new URL(confirmation.baseUrl).host

  useEffect(() => {
    if (tapGuardMs <= 0) {
      setArmed(true)

      return
    }

    setArmed(false)

    const timer = setTimeout(() => setArmed(true), tapGuardMs)

    return () => clearTimeout(timer)
  }, [confirmation.id, tapGuardMs])

  // The countdown ticks while the confirmation is open; it is text, not a live region.
  useEffect(() => {
    if (!open || confirmation.expiresAt === null) {
      return
    }

    setClock(now())

    const timer = setInterval(() => setClock(now()), 1000)

    return () => clearInterval(timer)
  }, [open, confirmation.expiresAt, now])

  const status = phaseText(phase)

  return (
    <>
      <h2 className="hm-requests__title" id={titleId}>
        {confirmation.title}
      </h2>

      <p className="hm-requests__lead" id={descriptionId}>
        {webStrings.passkeys.sheetLead({ host })}
      </p>

      <p className="hm-requests__summary">{confirmation.summary}</p>

      {confirmation.detail ? (
        <div className="hm-requests__detail-box">
          <p className="hm-requests__label" id={detailId}>
            {webStrings.passkeys.detailLabel}
          </p>
          {/* Scrolls sideways when a line is long, so it takes the keyboard: a scroll region nobody can reach is a trap. */}
          <pre className="hm-requests__detail" tabIndex={0} aria-labelledby={detailId} data-confirm-detail="">
            {confirmation.detail}
          </pre>
        </div>
      ) : null}

      <p className="hm-requests__meta">{webStrings.passkeys.rpLine({ rp: rpId })}</p>

      {open && confirmation.expiresAt !== null ? (
        <p className="hm-requests__meta">
          {webStrings.passkeys.expires({ time: countdown(confirmation.expiresAt - clock) })}
        </p>
      ) : null}

      <p
        className="hm-requests__phase"
        role="status"
        data-phase={phase.kind}
        data-tone={isFailure(phase) ? 'danger' : undefined}
      >
        {status}
      </p>

      <div className="hm-requests__actions">
        {open ? (
          <>
            <Button className="hm-requests__action" variant="primary" disabled={!actionable} onClick={onConfirm}>
              {webStrings.passkeys.confirm}
            </Button>
            <Button
              className="hm-requests__action"
              variant="quiet"
              data-tone="danger"
              disabled={!actionable}
              onClick={onDecline}
            >
              {webStrings.passkeys.decline}
            </Button>
          </>
        ) : (
          <Button className="hm-requests__action" variant="quiet" onClick={onClose}>
            {webStrings.passkeys.close}
          </Button>
        )}
      </div>
    </>
  )
}
