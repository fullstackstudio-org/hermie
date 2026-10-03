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
 */
import type { ApprovalItem } from '@hermie/transcript'
import { type ReactElement, useEffect, useRef, useState } from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { Button } from '../../ui/primitives'

export interface ApprovalSheetProps {
  item: ApprovalItem
  /** The bot's handle: what the lead line calls it. */
  handle: string
  /** Where the command would run, when the chat knows. */
  directory?: string
  /** The dialog's accessible name is this heading. */
  titleId: string
  /** The line that says what is being asked: the dialog's description. */
  descriptionId: string
  /** `choice` is one of `item.choices`, verbatim. */
  onRespond: (choice: string) => void
  /** Milliseconds before a press is accepted. Tests pass 0. */
  tapGuardMs?: number
}

export const DEFAULT_TAP_GUARD_MS = 400

/** `always` is "Always allow"; a choice the table does not know keeps its own name. */
export function choiceLabel(choice: string): string {
  return strings.chat.approval.choices[choice] ?? choice.replace(/_/gu, ' ')
}

const toneOf = (choice: string): 'primary' | 'danger' | 'plain' =>
  choice === 'deny' ? 'danger' : choice === 'once' ? 'primary' : 'plain'

export function ApprovalSheet({
  item,
  handle,
  directory,
  titleId,
  descriptionId,
  onRespond,
  tapGuardMs = DEFAULT_TAP_GUARD_MS
}: ApprovalSheetProps): ReactElement {
  useLocale()

  const [armed, setArmed] = useState(tapGuardMs <= 0)
  /** One answer per question: the layer takes the sheet away on the next frame, and a second press lands before it. */
  const answered = useRef(false)

  useEffect(() => {
    answered.current = false

    if (tapGuardMs <= 0) {
      setArmed(true)

      return
    }

    setArmed(false)

    const timer = setTimeout(() => setArmed(true), tapGuardMs)

    return () => clearTimeout(timer)
  }, [item.id, tapGuardMs])

  const respond = (choice: string): void => {
    if (answered.current) {
      return
    }

    answered.current = true
    onRespond(choice)
  }

  return (
    <>
      <h2 className="hm-requests__title" id={titleId}>
        {strings.chat.approval.title}
      </h2>

      <p className="hm-requests__lead" id={descriptionId}>
        {strings.chat.approval.lead({ handle, ...(directory ? { directory } : {}) })}
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

      <div className="hm-requests__actions">
        {item.choices.map(choice => (
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

      {item.choices.includes('always') ? <p className="hm-requests__meta">{strings.chat.approval.fine}</p> : null}
    </>
  )
}
