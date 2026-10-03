/**
 * The approval: a bot wants to run one command, and the reader says yes or no.
 *
 * Rules, the native apps' (`expo/hermie/src/ui/sheets/ApprovalSheet.tsx`, ADR-0010):
 *
 *  1. The buttons are exactly the gateway's `choices`, in the gateway's order. A
 *     set of our own would offer an "always allow" the gateway did not, and send
 *     a choice it will refuse. (With none sent the engine falls back to once and
 *     deny.)
 *  2. Only an explicit press answers. Nothing else, Escape included, is an
 *     answer: the question stays open.
 *  3. A guard after the sheet appears. A sheet that shows up while the reader is
 *     typing, or under a click already on its way, must not answer a question
 *     the reader has not read; the buttons wake after `tapGuardMs`. The focus
 *     sits on the dialog itself, not on a button, for the same reason: a Return
 *     meant for the field must find nothing to press.
 *
 * The command, the description and the tool's name are the gateway's and an
 * agent's words. They are shown as characters, never as Markdown: a command that
 * contains `**` or a link is a command, not formatting.
 *
 * **What the request offers** (PG-3). The gateway says, besides `choices`,
 * whether a request may be allowed for the session (`allow_session`) and for
 * good (`allow_permanent`), and whether its own safety check already refused the
 * command (`smart_denied`, which leaves the reader as the only override). A
 * choice the flags rule out is not drawn even when `choices` names it
 * (`offeredChoices`): the engine's fallback set names all four when a gateway
 * sent none, and a smart-denied command must never be allowed for longer than
 * once from here. "Allow for this session" and "Always allow" each get a line
 * that says what they mean, shown only when that choice is on screen; a
 * smart-denied command says so in the dialog's description, in fixed words.
 *
 * **One answer for several** (the gateway's `/approve all`). When the same bot
 * has other approvals waiting, a box (off, and asleep behind the same guard)
 * gives them the same answer, and while it is ticked their commands are listed:
 * nothing is allowed that was not on screen. It is answered request by request
 * (`onRespond`'s `others`, exactly the ids drawn), not with the wire's
 * `all: true`, because the gateway resolves `all` against its whole queue,
 * which can hold an approval this page has not been shown yet. A smart-denied
 * request is never part of it, on either side: it asks on its own, and so does
 * one that does not offer the choice pressed. A change in
 * that list while the box is ticked puts the buttons back to sleep, so a press
 * already on its way cannot answer a command that just arrived.
 */
import type { ApprovalItem } from '@hermie/transcript'
import { type ReactElement, useEffect, useId, useRef, useState } from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { Button } from '../../ui/primitives'
import { WithName } from './with-name'

export interface ApprovalSheetProps {
  item: ApprovalItem
  /** The bot's handle: what the lead line calls it. */
  handle: string
  /** The bot's display name, cleaned and bounded (`displayText`): what the box for several answers calls it. */
  name?: string
  /**
   * The same bot's other open approvals one answer may also go to, oldest first. The caller leaves out the
   * smart-denied ones; the box is drawn only when there is one and this request is not smart-denied itself.
   */
  others?: readonly ApprovalItem[]
  /** Where the command would run, when the chat knows. */
  directory?: string
  /** The dialog's accessible name is this heading. */
  titleId: string
  /** The line that says what is being asked: the dialog's description. */
  descriptionId: string
  /**
   * `choice` is one of `offeredChoices(item)`, verbatim. `others` is the request ids the same answer goes to:
   * of the ones the box listed when it was pressed, those that offer `choice`; empty when it was not ticked.
   */
  onRespond: (choice: string, others: readonly string[]) => void
  /** Milliseconds before a press is accepted. Tests pass 0. */
  tapGuardMs?: number
}

export const DEFAULT_TAP_GUARD_MS = 400

/** `always` is "Always allow"; a choice the table does not know keeps its own name. */
export function choiceLabel(choice: string): string {
  return strings.chat.approval.choices[choice] ?? choice.replace(/_/gu, ' ')
}

/** What the engine falls back on when a gateway sends no choices; the two every gateway accepts. */
const BASE_CHOICES = ['once', 'deny'] as const

/**
 * The choices to draw, in the gateway's order: `choices` less what the request's flags rule out. "Allow for
 * this session" needs `allow_session`, "Always allow" needs `allow_permanent`, and neither is offered for a
 * command the gateway's own check refused. A list the flags would empty is the two every gateway accepts.
 */
export function offeredChoices(
  item: Pick<ApprovalItem, 'choices' | 'allowSession' | 'allowPermanent' | 'smartDenied'>
): string[] {
  const offered = item.choices.filter(choice => {
    if (choice === 'session') {
      return item.allowSession !== false && item.smartDenied !== true
    }

    if (choice === 'always') {
      return item.allowPermanent !== false && item.smartDenied !== true
    }

    return true
  })

  return offered.length > 0 ? offered : [...BASE_CHOICES]
}

const toneOf = (choice: string): 'primary' | 'danger' | 'plain' =>
  choice === 'deny' ? 'danger' : choice === 'once' ? 'primary' : 'plain'

export function ApprovalSheet({
  item,
  handle,
  name = handle,
  others = [],
  directory,
  titleId,
  descriptionId,
  onRespond,
  tapGuardMs = DEFAULT_TAP_GUARD_MS
}: ApprovalSheetProps): ReactElement {
  useLocale()

  const [armed, setArmed] = useState(tapGuardMs <= 0)
  const [forAll, setForAll] = useState(false)
  /** The buttons sleep again for a moment: what the ticked box covers just changed under the reader. */
  const [holding, setHolding] = useState(false)
  /** One answer per question: the layer takes the sheet away on the next frame, and a second press lands before it. */
  const answered = useRef(false)
  const listId = useId()

  const choices = offeredChoices(item)
  const smartDenied = item.smartDenied === true
  const covered = smartDenied ? [] : others.filter(other => other.smartDenied !== true)
  const bulk = forAll && covered.length > 0
  /** Changes when the requests the box would cover change. */
  const coveredKey = covered.map(other => other.requestId).join('\u0000')
  const forAllNow = useRef(forAll)
  const lastCovered = useRef(coveredKey)

  forAllNow.current = forAll

  useEffect(() => {
    answered.current = false
  }, [item.id])

  useEffect(() => {
    if (tapGuardMs <= 0) {
      setArmed(true)

      return
    }

    setArmed(false)

    const timer = setTimeout(() => setArmed(true), tapGuardMs)

    return () => clearTimeout(timer)
  }, [item.id, tapGuardMs])

  // A request joined or left what the ticked box covers: a press already on its way must not answer it.
  // Ticking the box is the reader's own act and holds nothing back.
  useEffect(() => {
    if (lastCovered.current === coveredKey) {
      return
    }

    lastCovered.current = coveredKey

    if (!forAllNow.current || tapGuardMs <= 0) {
      return
    }

    setHolding(true)

    const timer = setTimeout(() => setHolding(false), tapGuardMs)

    return () => {
      clearTimeout(timer)
      setHolding(false)
    }
  }, [coveredKey, tapGuardMs])

  const respond = (choice: string): void => {
    if (answered.current || !armed || holding) {
      return
    }

    answered.current = true
    // A request that does not offer this choice (no "always" for it) is not given it: it asks on its own next.
    onRespond(
      choice,
      bulk ? covered.filter(other => offeredChoices(other).includes(choice)).map(other => other.requestId) : []
    )
  }

  return (
    <>
      <h2 className="hm-requests__title" id={titleId}>
        {strings.chat.approval.title}
      </h2>

      <p className="hm-requests__lead" id={descriptionId}>
        {strings.chat.approval.lead({ handle, ...(directory ? { directory } : {}) })}
        {/* In the description, so a screen reader says it with the question, before any button. */}
        {smartDenied ? (
          <span className="hm-requests__warning" data-smart-denied="">
            {webStrings.requests.smartDenied}
          </span>
        ) : null}
      </p>

      {/* Scrolls when the command is long, so it takes the keyboard: a scroll region nobody can reach is a trap. */}
      <pre className="hm-requests__command" tabIndex={0}>
        {item.command}
      </pre>

      {item.description ? <p className="hm-requests__text">{item.description}</p> : null}

      {item.toolName ? (
        <p className="hm-requests__meta">
          {strings.chat.approval.runsOn} · {item.toolName}
        </p>
      ) : null}

      {covered.length > 0 ? (
        <>
          <label className="hm-requests__choice" data-for-all="">
            <input
              type="checkbox"
              checked={forAll}
              disabled={!armed}
              aria-controls={forAll ? listId : undefined}
              onChange={event => setForAll(event.target.checked)}
            />
            <span>
              <WithName
                phrase={shown => webStrings.requests.sameForAll({ count: covered.length, name: shown })}
                name={name}
              />
            </span>
          </label>

          {forAll ? (
            <div className="hm-requests__others" id={listId}>
              <p className="hm-requests__meta">{webStrings.requests.othersLabel}</p>
              <ul className="hm-requests__others-list">
                {covered.map(other => (
                  <li key={other.id}>
                    <pre className="hm-requests__command" data-size="small" tabIndex={0}>
                      {other.command}
                    </pre>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="hm-requests__actions">
        {choices.map(choice => (
          <Button
            key={choice}
            className="hm-requests__action"
            variant={toneOf(choice) === 'primary' ? 'primary' : 'quiet'}
            data-choice={choice}
            data-tone={toneOf(choice)}
            disabled={!armed || holding}
            onClick={() => respond(choice)}
          >
            {choiceLabel(choice)}
          </Button>
        ))}
      </div>

      {choices.includes('session') ? <p className="hm-requests__meta">{webStrings.requests.sessionHint}</p> : null}
      {choices.includes('always') ? <p className="hm-requests__meta">{strings.chat.approval.fine}</p> : null}
    </>
  )
}
