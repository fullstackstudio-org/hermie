/**
 * A connector authorisation a bot waits on (`ConnectionCard`): the services it
 * wants connected, each with its state and its way forward, and a countdown to the
 * gateway's deadline. Drawn by the request layer, one card at a time, like any
 * question that stops a bot.
 *
 *  - **Links are opened by the person, and say where they go.** A row's link has
 *    passed `authorisationLink` (plain `https`, a named host, no user name or
 *    password before it); the button names the host in its label and beside it, and
 *    opens it in a new tab with no opener and no referrer, only when pressed. A link
 *    the gateway sent that did not pass is not drawn as anything to press: the row
 *    says so.
 *  - **Every text is the gateway's, and plain.** A service's name, its detail and
 *    the gateway's instructions are cleaned by the model (`displayText`), shown as
 *    text (never Markdown, never a link), the name isolated in `<bdi>`, the
 *    instructions in a labelled box of their own.
 *  - **Answers** are "Not now" for one row and "Stop waiting" for the whole card
 *    (`ConnectionsModel.skip`, `cancel`); the card moves when the gateway's update
 *    comes back. An answer that did not go out says why. Nothing here confirms or
 *    connects anything: that happens on the service's own page.
 *  - The buttons take nothing for a moment after the sheet appears (the tap
 *    guard), so a click meant for what was under it does not answer.
 */
import { type ReactElement, useEffect, useId, useState } from 'react'

import { isTargetOpen } from '../../core/connections'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import type { ConnectionCard, ConnectionTarget } from '../../state/connections'
import { Button } from '../../ui/primitives'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import { SecureQuote } from './SecureSheet'
import { WithName } from './with-name'

export interface ConnectionSheetProps {
  card: ConnectionCard
  /** The bot's name, cleaned for display. */
  name: string
  /** The gateway's host. */
  gateway: string
  titleId: string
  descriptionId: string
  /** The person pressed a row's link: open it (a new tab, no opener) and remember that it was. */
  onOpen: (target: ConnectionTarget) => void
  onSkip: (target: ConnectionTarget) => void
  onCancel: () => void
  tapGuardMs?: number
  /** Epoch milliseconds, for the countdown; the clock unless a test hands in its own. */
  now?: () => number
}

const clock = (): number => Date.now()

/** `m:ss`, never negative. */
export const countdown = (ms: number): string => {
  const left = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** A row's state in words; one this build has no word for is the gateway's own. */
export function targetStateText(state: string): string {
  const words = sheetStrings.connections.state

  switch (state) {
    case 'pending':
      return words.pending
    case 'initiated':
      return words.initiated
    case 'connected':
      return words.connected
    case 'skipped':
      return words.skipped
    case 'failed':
      return words.failed
    case 'expired':
      return words.expired
    case 'unavailable':
      return words.unavailable
    case 'not_connected':
      return words.notConnected
    default:
      return words.other({ status: state.slice(0, 40) })
  }
}

function TargetRow({
  target,
  armed,
  busy,
  onOpen,
  onSkip
}: {
  target: ConnectionTarget
  armed: boolean
  busy: boolean
  onOpen: () => void
  onSkip: () => void
}): ReactElement {
  const open = isTargetOpen(target)

  return (
    <li className="hm-connection__target" data-state={target.state}>
      <p className="hm-connection__name">
        <bdi>{target.label}</bdi>
      </p>
      <p className="hm-connection__state">{targetStateText(target.state)}</p>
      {target.detail ? <p className="hm-connection__detail">{target.detail}</p> : null}
      {target.instructions ? (
        <SecureQuote text={target.instructions} label={sheetStrings.connections.instructions} />
      ) : null}
      {open && target.link ? (
        <div className="hm-connection__link">
          <Button
            disabled={!armed}
            aria-label={sheetStrings.connections.openLabel({ name: target.label, host: target.link.host })}
            onClick={onOpen}
          >
            {sheetStrings.connections.open}
          </Button>
          <span className="hm-connection__host">{sheetStrings.connections.opensAt({ host: target.link.host })}</span>
        </div>
      ) : null}
      {open && target.opened ? <p className="hm-connection__note">{sheetStrings.connections.opened}</p> : null}
      {open && target.linkRefused ? (
        <p className="hm-connection__note" data-tone="danger">
          {sheetStrings.connections.linkRefused}
        </p>
      ) : null}
      {open ? (
        <Button
          variant="quiet"
          disabled={!armed || busy}
          aria-label={sheetStrings.connections.skipLabel({ name: target.label })}
          onClick={onSkip}
        >
          {sheetStrings.connections.skip}
        </Button>
      ) : null}
    </li>
  )
}

export function ConnectionSheet({
  card,
  name,
  gateway,
  titleId,
  descriptionId,
  onOpen,
  onSkip,
  onCancel,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now = clock
}: ConnectionSheetProps): ReactElement {
  useLocale()

  const listId = useId()
  const [armed, setArmed] = useState(tapGuardMs <= 0)
  const [time, setTime] = useState(now)

  useEffect(() => {
    if (tapGuardMs <= 0) {
      setArmed(true)

      return
    }

    setArmed(false)

    const timer = setTimeout(() => setArmed(true), tapGuardMs)

    return () => clearTimeout(timer)
  }, [tapGuardMs, card.opId])

  // The countdown ticks while the card is open; it is text, not a live region.
  useEffect(() => {
    setTime(now())

    const timer = setInterval(() => setTime(now()), 1000)

    return () => clearInterval(timer)
  }, [now])

  const busy = card.answer.kind === 'sending'
  const left = card.deadline - time

  return (
    <>
      <h2 className="hm-requests__title" id={titleId}>
        <WithName phrase={shown => sheetStrings.connections.title({ name: shown })} name={name} />
      </h2>

      <p className="hm-requests__lead" id={descriptionId}>
        {sheetStrings.connections.lead({ host: gateway })}
      </p>

      <p className="hm-requests__label" id={listId}>
        {sheetStrings.connections.targets}
      </p>
      <ul className="hm-connection__targets" aria-labelledby={listId}>
        {card.targets.map(target => (
          <TargetRow
            key={target.name}
            target={target}
            armed={armed}
            busy={busy}
            onOpen={() => onOpen(target)}
            onSkip={() => onSkip(target)}
          />
        ))}
      </ul>

      <p className="hm-requests__meta" data-tone={left <= 10_000 ? 'danger' : undefined}>
        {sheetStrings.connections.timeLeft({ time: countdown(left) })}
      </p>

      <p className="hm-requests__phase" role="status" data-tone={card.answer.kind === 'failed' ? 'danger' : undefined}>
        {card.answer.kind === 'sending'
          ? sheetStrings.connections.sending
          : card.answer.kind === 'failed'
            ? sheetStrings.connections.failed({ message: card.answer.message })
            : ''}
      </p>

      <div className="hm-requests__actions">
        <Button className="hm-requests__action" variant="quiet" disabled={!armed || busy} onClick={onCancel}>
          {sheetStrings.connections.cancel}
        </Button>
      </div>
    </>
  )
}
