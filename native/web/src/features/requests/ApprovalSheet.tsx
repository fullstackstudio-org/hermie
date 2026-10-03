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
 * one that does not offer the choice pressed.
 *
 * The tick belongs to the list it was given for. When a request joins or leaves
 * that list, the box is no longer ticked in the same render (the tick is derived
 * from the list it was made for, so no effect has to win a race for it), and a
 * polite line inside the dialog says why: nothing the reader did not see and hear
 * can be answered, and no button is disabled under their focus. If the box itself
 * goes (nothing left to cover) and takes the focus with it, the focus moves to the
 * command.
 *
 * The bot's handle and the directory in the lead line are the roster's and the
 * session's words: cleaned and bounded (`displayText`) and each in a `<bdi>`.
 */
import type { ApprovalItem } from '@hermie/transcript'
import { Fragment, type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from 'react'

import { BOT_NAME_LIMIT, displayText, TEXT_LIMIT } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
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

/** Where the handle and the directory go in the catalogue's sentence; `displayText` drops both from any name. */
const HANDLE_MARK = '\u0001'
const DIRECTORY_MARK = '\u0002'

/** The lead line, the handle and the directory each isolated: the sentence keeps every language's own order. */
function leadLine(handle: string, directory: string): ReactNode {
  const sentence = strings.chat.approval.lead({
    handle: HANDLE_MARK,
    ...(directory ? { directory: DIRECTORY_MARK } : {})
  })
  const parts: ReactNode[] = []

  sentence.split(HANDLE_MARK).forEach((piece, index) => {
    if (index > 0) {
      parts.push(<bdi key={`h${index}`}>{handle}</bdi>)
    }

    piece.split(DIRECTORY_MARK).forEach((text, inner) => {
      if (inner > 0) {
        parts.push(<bdi key={`d${index}-${inner}`}>{directory}</bdi>)
      }

      parts.push(<Fragment key={`t${index}-${inner}`}>{text}</Fragment>)
    })
  })

  return parts
}

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
  /** The list the box was ticked for (`coveredKey` then), or `null`: a tick holds for that list and no other. */
  const [tickedFor, setTickedFor] = useState<string | null>(null)
  /** Said politely inside the dialog when a tick was taken back because its list changed. */
  const [notice, setNotice] = useState('')
  /** One answer per question: the layer takes the sheet away on the next frame, and a second press lands before it. */
  const answered = useRef(false)
  const commandRef = useRef<HTMLPreElement>(null)
  const listId = useId()

  const choices = offeredChoices(item)
  const smartDenied = item.smartDenied === true
  const covered = smartDenied ? [] : others.filter(other => other.smartDenied !== true)
  /** Changes when the requests the box would cover change. */
  const coveredKey = covered.map(other => other.requestId).join('\u0000')
  const forAll = tickedFor !== null && tickedFor === coveredKey && covered.length > 0
  const shownHandle = displayText(handle, BOT_NAME_LIMIT)
  const shownDirectory = displayText(directory, TEXT_LIMIT)

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

  // The list a tick was given for changed: the tick is already gone from this render; say so, and keep the focus.
  useEffect(() => {
    if (tickedFor === null || tickedFor === coveredKey) {
      return
    }

    setTickedFor(null)
    setNotice(sheetStrings.requests.othersChanged({ name }))

    const documentOf = commandRef.current?.ownerDocument
    const active = documentOf?.activeElement

    if (documentOf && (!active || active === documentOf.body)) {
      commandRef.current?.focus({ preventScroll: true })
    }
  }, [coveredKey, name, tickedFor])

  const respond = (choice: string): void => {
    if (answered.current || !armed) {
      return
    }

    answered.current = true
    // A request that does not offer this choice (no "always" for it) is not given it: it asks on its own next.
    onRespond(
      choice,
      forAll ? covered.filter(other => offeredChoices(other).includes(choice)).map(other => other.requestId) : []
    )
  }

  return (
    <>
      <h2 className="hm-requests__title" id={titleId}>
        {strings.chat.approval.title}
      </h2>

      <p className="hm-requests__lead" id={descriptionId}>
        {leadLine(shownHandle, shownDirectory)}
        {/* In the description, so a screen reader says it with the question, before any button. */}
        {smartDenied ? (
          <span className="hm-requests__warning" data-smart-denied="">
            {sheetStrings.requests.smartDenied}
          </span>
        ) : null}
      </p>

      {/* Scrolls when the command is long, so it takes the keyboard: a scroll region nobody can reach is a trap. */}
      <pre className="hm-requests__command" tabIndex={0} ref={commandRef}>
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
              onChange={event => {
                setTickedFor(event.target.checked ? coveredKey : null)
                setNotice('')
              }}
            />
            <span>
              <WithName
                phrase={shown => sheetStrings.requests.sameForAll({ count: covered.length, name: shown })}
                name={name}
              />
            </span>
          </label>

          {forAll ? (
            <div className="hm-requests__others" id={listId}>
              <p className="hm-requests__meta">{sheetStrings.requests.othersLabel}</p>
              <ul className="hm-requests__others-list">
                {covered.map(other => (
                  <li key={other.id}>
                    <pre className="hm-requests__command" data-size="small" tabIndex={0}>
                      {other.command}
                    </pre>
                    {other.description ? <p className="hm-requests__text">{other.description}</p> : null}
                    {other.toolName ? (
                      <p className="hm-requests__meta">
                        {strings.chat.approval.runsOn} · {other.toolName}
                      </p>
                    ) : null}
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
            disabled={!armed}
            onClick={() => respond(choice)}
          >
            {choiceLabel(choice)}
          </Button>
        ))}
      </div>

      {/* Always in the document, so a line put into it is announced. */}
      <p className="hm-sr" aria-live="polite" aria-atomic="true" data-others-notice="">
        {notice}
      </p>

      {choices.includes('session') ? <p className="hm-requests__meta">{sheetStrings.requests.sessionHint}</p> : null}
      {choices.includes('always') ? <p className="hm-requests__meta">{strings.chat.approval.fine}</p> : null}
    </>
  )
}
