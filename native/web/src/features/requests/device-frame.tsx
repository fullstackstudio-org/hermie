/**
 * What the sheets that reach for the device (`SignatureSheet`, `LocationSheet`, `ContactSheet`, `ScanSheet`,
 * `VoiceSheet`) have in common beyond the interactive frame: their props, the buttons every one of them has, and a
 * way to know that the sheet is still on screen when the browser answers.
 *
 * The rules are the frame's (`interactive-frame.tsx`) and the contract's (`contract/requests/README.md` sections 8 to
 * 12, and D10 of the plan):
 *
 *  1. **Consent on the sheet first.** The browser's own prompt (location, camera, microphone, contacts) comes only
 *     after the person pressed the sheet's button for it, never instead of it and never on opening.
 *  2. **The person chooses how much.** The sheet shows what would be sent and lets them leave things out before it
 *     goes; `Skip` is offered only when the request is `optional`, and `Don't share` always.
 *  3. **Nothing of what is read is kept.** A position, a contact, a code, a recording and a drawing live in the
 *     sheet's own state and in the one answer, and are let go with the sheet.
 */
import { type ReactElement, type ReactNode, useEffect, useRef } from 'react'

import type { AnswerOutcome } from '../../core/requests/interactive'
import type { InteractiveAnswer } from '../../core/requests/interactive-types'
import { sheetStrings } from '../../i18n/sheet-strings'
import type { InteractiveRequest } from '../../state/interactive'
import { Button } from '../../ui/primitives'
import type { FileUploader } from './FileSheet'
import type { Sending } from './interactive-frame'
import './device-sheets.css'

/** What every device sheet is given by the request layer. */
export interface DeviceSheetProps<Ask extends InteractiveRequest['ask']> {
  request: InteractiveRequest & { ask: Ask }
  /** The gateway's host. */
  gateway: string
  titleId: string
  descriptionId: string
  onAnswer: (result: InteractiveAnswer) => Promise<AnswerOutcome>
  onSkip: () => Promise<AnswerOutcome>
  /** Put the sheet away without answering (the camera and the microphone stop while it is away). */
  onLater: () => void
  /** Tell the gateway the page cannot show the request, or the person will not share it (`4041`). */
  onCannotShow: (reason: string) => 'sent' | 'closed' | 'offline' | 'busy'
  /** Put a file on the gateway; absent, an upload fails. */
  onUpload?: FileUploader | undefined
  /** Whether the sheet is the one on screen: its tap guard runs from the moment it is (default: it is). */
  shown?: boolean
  /** Milliseconds before a control takes anything. Tests pass 0. */
  tapGuardMs?: number
  /** Epoch milliseconds, for the countdown; the clock unless a test hands in its own. */
  now?: () => number
}

/** A ref that is true while the sheet is mounted: what a browser's callback checks before it touches state. */
export function useAlive(): { readonly current: boolean } {
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true

    return () => {
      alive.current = false
    }
  }, [])

  return alive
}

export interface ShareActionsProps {
  optional: boolean
  /** The controls are off: a press is not taken now. */
  busy: boolean
  sending: Sending
  onLater: () => void
  onSkip: () => Promise<AnswerOutcome>
  onCannotShow: (reason: string) => 'sent' | 'closed' | 'offline' | 'busy'
  /** The sheet's own buttons, after the common ones. */
  children?: ReactNode
}

/** Later, Don't share and (when the request allows it) Skip, then the sheet's own buttons. */
export function ShareActions({
  optional,
  busy,
  sending,
  onLater,
  onSkip,
  onCannotShow,
  children
}: ShareActionsProps): ReactElement {
  return (
    <>
      <Button className="hm-requests__action" variant="quiet" onClick={onLater}>
        {sheetStrings.interactive.later}
      </Button>
      <Button
        className="hm-requests__action"
        variant="quiet"
        disabled={busy}
        data-interactive-dont-share=""
        onClick={() => sending.declined(onCannotShow('declined'))}
      >
        {sheetStrings.interactive.dontShare}
      </Button>
      {optional ? (
        <Button
          className="hm-requests__action"
          variant="quiet"
          disabled={busy}
          onClick={() => void sending.run(onSkip)}
        >
          {sheetStrings.secureInput.skip}
        </Button>
      ) : null}
      {children}
    </>
  )
}

/** The contract's reason a refused answer names, in words, or the generic line. */
export function refusalIn(reason: string | null, known: Readonly<Record<string, string>>): string | null {
  if (reason === null) {
    return null
  }

  return known[reason] ?? sheetStrings.interactive.refusedOther({ reason })
}
