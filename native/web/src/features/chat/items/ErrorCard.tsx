/**
 * A failed turn.
 *
 * Two failures wear different clothes, and conflating them is the bug this card
 * exists to avoid (the Expo app's `ErrorCard`, the Swift `AssistantErrorCard`):
 *
 *  - **recoverable**: the gateway still holds the turn and a resume replays it.
 *    The card says it is reconnecting and offers no button, because a retry
 *    there would run the turn twice.
 *  - otherwise the turn is gone and running it again is the reader's call: a
 *    Retry button, when the screen has something to retry with (`onRetry`).
 *
 * The words that arrived before the failure stay in the bubble above; a partial
 * reply is worth keeping. The message is the gateway's, cleaned and bounded
 * (`displayText`) and shown as characters.
 *
 * Not `role="alert"`: the card is a row of a transcript, and a chat opened on an
 * old failure must not shout it at a screen reader. A failure that happens while
 * the reader watches is announced by the transcript's own live region.
 */
import type { AssistantFailure } from '@hermie/transcript'
import { memo } from 'react'

import { displayText } from '../../../core/requests/secure-input'
import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'

/** How much of an error message the card holds; the rest is a gateway's stack, not a sentence. */
const MESSAGE_CHARS = 2_000

export interface ErrorCardProps {
  error: AssistantFailure
  /** Run the turn again. Offered only when the turn is gone and this is given. */
  onRetry?: () => void
}

function ErrorCardView({ error, onRetry }: ErrorCardProps) {
  useLocale()

  const recoverable = Boolean(error.recoverable)
  const message = displayText(error.message, MESSAGE_CHARS)

  return (
    <div className="hm-failure" data-recoverable={recoverable ? 'true' : 'false'}>
      <p className="hm-failure__title">{strings.chat.assistant.errorTitle}</p>
      {message ? (
        <p className="hm-failure__message" dir="auto">
          {message}
        </p>
      ) : null}
      {recoverable ? <p className="hm-failure__note">{strings.chat.assistant.reconnecting}</p> : null}
      {!recoverable && onRetry ? (
        <button className="hm-failure__retry" type="button" onClick={onRetry}>
          {strings.chat.assistant.retry}
        </button>
      ) : null}
    </div>
  )
}

export const ErrorCard = memo(ErrorCardView)
