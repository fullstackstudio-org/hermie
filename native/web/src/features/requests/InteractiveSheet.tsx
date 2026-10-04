/**
 * The stand-in for a form, a file request or a draft to review, until their
 * sheets exist (plan `request-types-v2`, task P1-W2).
 *
 * The page advertises the three methods (`core/requests/interactive.ts`), so a
 * request can reach it; this is what a person finds when it does. It says what it
 * is, shows the request's own heading and words as the bot's (plain text, already
 * cleaned by the reader), and offers the two honest ways out: Skip (only when the
 * request is `optional`) and Decline, which tells the gateway the page cannot show
 * it (`4041 cannot_show`: not an answer, and the bot is told so).
 *
 * Nothing is typed here, so nothing has to be kept out of the page's state.
 */
import { type ReactElement, useEffect, useState } from 'react'

import type { AnswerOutcome } from '../../core/requests/interactive'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import type { InteractiveRequest } from '../../state/interactive'
import { Button } from '../../ui/primitives'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import { SecureQuote } from './SecureSheet'

export interface InteractiveSheetProps {
  request: InteractiveRequest
  titleId: string
  descriptionId: string
  onSkip: () => Promise<AnswerOutcome>
  /** Tell the gateway this page cannot show the request. */
  onDecline: () => 'sent' | 'closed' | 'offline'
  tapGuardMs?: number
}

export function InteractiveSheet({
  request,
  titleId,
  descriptionId,
  onSkip,
  onDecline,
  tapGuardMs = DEFAULT_TAP_GUARD_MS
}: InteractiveSheetProps): ReactElement {
  useLocale()

  const [armed, setArmed] = useState(tapGuardMs <= 0)
  const [offline, setOffline] = useState(false)
  const { ask } = request

  // The guard: nothing is taken for a moment after the sheet appears, so a click meant for what was under it
  // does not answer.
  useEffect(() => {
    if (tapGuardMs <= 0) {
      setArmed(true)

      return
    }

    setArmed(false)

    const timer = setTimeout(() => setArmed(true), tapGuardMs)

    return () => clearTimeout(timer)
  }, [request.id, tapGuardMs])

  const canSkip = ask.optional && ask.method !== 'review.draft'

  return (
    <>
      <h2 className="hm-requests__title" id={titleId}>
        {sheetStrings.interactive.unavailableTitle}
      </h2>

      <p className="hm-requests__lead" id={descriptionId}>
        {sheetStrings.interactive.unavailableLead}
      </p>

      <SecureQuote label={sheetStrings.interactive.quoteLabel} text={`${ask.title}\n${ask.summary}`} />

      <p className="hm-requests__phase" role="status" data-tone={offline ? 'danger' : undefined}>
        {offline ? sheetStrings.interactive.offline : ''}
      </p>

      <div className="hm-requests__actions">
        {canSkip ? (
          <Button
            className="hm-requests__action"
            variant="quiet"
            disabled={!armed}
            onClick={() => {
              void onSkip().then(outcome => setOffline(outcome.kind === 'offline'))
            }}
          >
            {sheetStrings.secureInput.skip}
          </Button>
        ) : null}
        <Button
          className="hm-requests__action"
          variant="primary"
          disabled={!armed}
          data-interactive-decline=""
          onClick={() => setOffline(onDecline() === 'offline')}
        >
          {sheetStrings.interactive.decline}
        </Button>
      </div>
    </>
  )
}
