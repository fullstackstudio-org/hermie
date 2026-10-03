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
 *     with every line break kept (`white-space: pre`) and scrolls both ways
 *     rather than wrapping, so a line break is never hidden and a command reads
 *     as the command that runs. Its whitespace is DRAWN visibly
 *     (`markVerbatimDetail`: space runs, tabs, runs of blank lines), so 300
 *     spaces or 80 empty lines cannot push a second command out of sight; "Copy
 *     details" copies the verbatim text. The challenge the browser signs is
 *     computed from the frame's values (`PasskeyConfirmation`), never from the
 *     drawing.
 *  3. **Only an explicit press answers.** Escape does not dismiss (the layer
 *     keeps it), and the buttons wake `tapGuardMs` after the sheet appears, so a
 *     click or a Return already on its way answers nothing. A detail too big for
 *     its box must have been scrolled to its end in each direction it overflows
 *     before Confirm wakes (latched per confirmation); Decline never waits.
 *  4. **The deadline is the page's clock too.** The gateway's `request.cancel` is
 *     the first word, but a socket that dropped misses it: at `expires_at` the
 *     sheet asks for the confirmation to end (`onExpire`), and from then on its
 *     buttons are off, so a dead request is never answered with a ceremony.
 *  5. **`received` is not "confirmed".** After the gateway said `ok` the sheet
 *     says the answer arrived and that the gateway checks it; if the gateway's
 *     commit fails it says that nothing was confirmed.
 *  6. **An answer that may have arrived is never "not confirmed".** Once a
 *     passkey answer got no reply (`answerMayHaveArrived`), the retry state says
 *     it may have reached the gateway, and an end without the gateway's verdict
 *     is `outcome_unknown`: check whether the action ran.
 */
import { type ReactElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import {
  type ConfirmPhase,
  isActionablePhase,
  isExpired,
  isOpenPhase,
  type PasskeyConfirmation
} from '../../state/passkeys'
import { writeClipboard } from '../../platform/clipboard'
import { layoutClock } from '../../platform/layout'
import { Button } from '../../ui/primitives'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import { markVerbatimDetail } from './verbatim-detail'

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
  /** The deadline (`expiresAt`) passed on this page's clock while the confirmation was still open. */
  onExpire?: () => void
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

/**
 * What the sheet says about where the confirmation stands, or nothing while it waits for a press.
 * `mayHaveArrived`: an answer carrying the passkey got no reply (`answerMayHaveArrived`).
 */
export function phaseText(phase: ConfirmPhase, mayHaveArrived = false): string {
  switch (phase.kind) {
    case 'waiting':
    case 'declined':
      return ''
    case 'signing':
      return sheetStrings.passkeys.signing
    case 'sending':
      return sheetStrings.passkeys.sending
    case 'refused':
      return sheetStrings.passkeys.refused({ reason: phase.reason || 'refused' })
    case 'not_sent':
      return mayHaveArrived
        ? sheetStrings.passkeys.mayHaveArrived
        : sheetStrings.passkeys.notSent({ message: phase.message })
    case 'received':
      return sheetStrings.passkeys.received
    case 'ended':
      switch (phase.end.kind) {
        case 'verification_failed':
          return sheetStrings.passkeys.verificationFailed
        case 'too_many_attempts':
          return sheetStrings.passkeys.tooManyAttempts
        case 'not_allowed':
          return sheetStrings.passkeys.notAllowed
        case 'unavailable':
          return sheetStrings.passkeys.unavailable({ reason: phase.end.reason })
        case 'outcome_unknown':
          return sheetStrings.passkeys.outcomeUnknown
        default:
          return ''
      }
  }
}

/** A phase whose words are a failure: drawn in the danger ink. */
const isFailure = (phase: ConfirmPhase): boolean =>
  phase.kind === 'refused' || phase.kind === 'not_sent' || phase.kind === 'ended'

/** Which ways the detail is bigger than its box, and which of those were scrolled to their end. */
interface Extent {
  x: boolean
  y: boolean
}

const NONE: Extent = { x: false, y: false }

/**
 * Copy `text` exactly: the async clipboard, or, where that is missing or refused, a hidden text area inside the
 * dialog (the focus trap allows it there) and `execCommand('copy')`. Focus goes back where it was.
 */
async function copyVerbatim(text: string, host: HTMLElement | null): Promise<boolean> {
  if (await writeClipboard(text)) {
    return true
  }

  if (!host || typeof document.execCommand !== 'function') {
    return false
  }

  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const area = document.createElement('textarea')

  area.value = text
  area.readOnly = true
  area.tabIndex = -1
  area.setAttribute('aria-hidden', 'true')
  area.className = 'hm-requests__copy-buffer'
  host.appendChild(area)
  area.select()

  let copied = false

  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }

  area.remove()
  previous?.focus()

  return copied
}

export function ConfirmSheet({
  confirmation,
  rpId,
  titleId,
  descriptionId,
  onConfirm,
  onDecline,
  onClose,
  onExpire,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now = clockSeconds
}: ConfirmSheetProps): ReactElement {
  useLocale()

  const detailId = useId()
  const viewportId = useId()
  const captionId = useId()
  const viewport = useRef<HTMLPreElement>(null)
  const detailBox = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState<Extent>(NONE)
  // Latched per confirmation: an entry for another id counts as nothing scrolled yet.
  const [reached, setReached] = useState<Extent & { id: string }>({ id: confirmation.id, ...NONE })
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null)
  const [armed, setArmed] = useState(tapGuardMs <= 0)
  const [clock, setClock] = useState(now)
  const { phase } = confirmation
  const open = isOpenPhase(phase)
  const expired = isExpired(confirmation, clock)
  const actionable = armed && isActionablePhase(phase) && !expired
  const expire = useRef(onExpire)
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
    if (!open) {
      return
    }

    setClock(now())

    const timer = setInterval(() => setClock(now()), 1000)

    return () => clearInterval(timer)
  }, [open, confirmation.expiresAt, now])

  useEffect(() => {
    expire.current = onExpire
  })

  // At the deadline the confirmation ends, whether or not the gateway got to say so (a socket that dropped
  // while it timed out never hears it). A deadline already past fires at once.
  useEffect(() => {
    if (!open) {
      return
    }

    // `setTimeout` takes at most 2^31 - 1 ms; a nearer-than-that deadline is the only one that matters, and
    // the model checks the clock itself before it ends anything.
    const delay = Math.min(Math.max(0, (confirmation.expiresAt - now()) * 1000), 2_147_483_647)
    const timer = setTimeout(() => expire.current?.(), delay)

    return () => clearTimeout(timer)
  }, [open, confirmation.expiresAt, now])

  const marked =
    confirmation.detail === null
      ? null
      : markVerbatimDetail(confirmation.detail, count => sheetStrings.passkeys.emptyLines({ count }))

  // How far the detail is scrolled, measured: it overflows a way when its content is bigger than its box, and
  // that way is reviewed (for good, for this confirmation) once its end has been in view.
  const id = confirmation.id
  const measure = useCallback((): void => {
    const element = viewport.current

    if (!element) {
      setOverflow(previous => (previous.x || previous.y ? NONE : previous))

      return
    }

    const x = element.scrollWidth - element.clientWidth > 1
    const y = element.scrollHeight - element.clientHeight > 1
    const endX = x && element.scrollLeft + element.clientWidth >= element.scrollWidth - 1
    const endY = y && element.scrollTop + element.clientHeight >= element.scrollHeight - 1

    setOverflow(previous => (previous.x === x && previous.y === y ? previous : { x, y }))
    setReached(previous => {
      const base = previous.id === id ? previous : { id, ...NONE }
      const next = { id, x: base.x || endX, y: base.y || endY }

      return next.x === previous.x && next.y === previous.y && previous.id === id ? previous : next
    })
  }, [id])

  const markedText = marked?.text

  useLayoutEffect(() => {
    measure()
  }, [measure, markedText])

  // A box that changes size (a window resized, a phone turned) may start or stop overflowing.
  useEffect(() => {
    const element = viewport.current

    if (!element) {
      return
    }

    const watch = layoutClock.observeResize(measure)

    watch.watch(element)

    return () => watch.disconnect()
  }, [measure, markedText])

  const seen = reached.id === id ? reached : NONE
  const unreviewed = (overflow.x && !seen.x) || (overflow.y && !seen.y)
  const status = phaseText(phase, confirmation.answerMayHaveArrived)
  const oversized = overflow.x || overflow.y

  const copy = (): void => {
    if (confirmation.detail === null) {
      return
    }

    void copyVerbatim(confirmation.detail, detailBox.current).then(ok => setCopied({ id, ok }))
  }

  const copyStatus =
    copied?.id === id ? (copied.ok ? sheetStrings.passkeys.detailCopied : sheetStrings.passkeys.detailNotCopied) : ''

  return (
    <>
      <h2 className="hm-requests__title" id={titleId}>
        {confirmation.title}
      </h2>

      <p className="hm-requests__lead" id={descriptionId}>
        {webStrings.passkeys.sheetLead({ host })}
      </p>

      <p className="hm-requests__summary">{confirmation.summary}</p>

      {confirmation.detail && marked ? (
        <div className="hm-requests__detail-box" ref={detailBox}>
          <p className="hm-requests__label" id={detailId}>
            {sheetStrings.passkeys.detailLabel}
          </p>
          {/*
           * Scrolls both ways when it is big, so it takes the keyboard (arrows, End, Page Down): a scroll region
           * nobody can reach is a trap. Its name is the label and the drawn text, markers included.
           */}
          <pre
            ref={viewport}
            id={viewportId}
            className="hm-requests__detail"
            role="region"
            tabIndex={0}
            aria-labelledby={`${detailId} ${viewportId}`}
            aria-describedby={oversized ? captionId : undefined}
            data-confirm-detail=""
            data-overflow={oversized ? [overflow.x ? 'x' : '', overflow.y ? 'y' : ''].join('') : undefined}
            onScroll={measure}
          >
            {marked.text}
          </pre>
          <div className="hm-requests__detail-foot">
            {oversized ? (
              <p className="hm-requests__meta" id={captionId} data-detail-size="">
                {sheetStrings.passkeys.detailSize({ lines: marked.lines, longest: marked.longestLine })}
              </p>
            ) : null}
            <Button className="hm-requests__copy" variant="quiet" onClick={copy}>
              {sheetStrings.passkeys.copyDetail}
            </Button>
            <span className="hm-requests__meta" aria-live="polite">
              {copyStatus}
            </span>
          </div>
        </div>
      ) : null}

      <p className="hm-requests__meta">{sheetStrings.passkeys.rpLine({ rp: rpId })}</p>

      {open ? (
        <p className="hm-requests__meta">
          {sheetStrings.passkeys.expires({ time: countdown(confirmation.expiresAt - clock) })}
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
            <Button
              className="hm-requests__action"
              variant="primary"
              disabled={!actionable || unreviewed}
              onClick={onConfirm}
            >
              {sheetStrings.passkeys.confirm}
            </Button>
            <Button
              className="hm-requests__action"
              variant="quiet"
              data-tone="danger"
              disabled={!actionable}
              onClick={onDecline}
            >
              {sheetStrings.passkeys.decline}
            </Button>
          </>
        ) : (
          <Button className="hm-requests__action" variant="quiet" onClick={onClose}>
            {webStrings.passkeys.close}
          </Button>
        )}
      </div>

      {open && isActionablePhase(phase) && !expired && unreviewed ? (
        <p className="hm-requests__meta" data-scroll-hint="">
          {sheetStrings.passkeys.scrollToConfirm}
        </p>
      ) : null}
    </>
  )
}
