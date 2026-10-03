/**
 * The dots before there is any reply to hold them: the turn is running and the
 * last thing on screen is the reader's own message. Once the reply exists its
 * own bubble holds the dots (`AssistantBubble`), so the two are never drawn at
 * once (`rows.ts`).
 */
import { memo } from 'react'

import { TypingDots } from './AssistantBubble'

function TypingRowView() {
  return (
    <div className="hm-msg" data-side="bot">
      <div className="hm-bubble" data-kind="assistant" data-waiting="true">
        <TypingDots />
      </div>
    </div>
  )
}

export const TypingRow = memo(TypingRowView)
