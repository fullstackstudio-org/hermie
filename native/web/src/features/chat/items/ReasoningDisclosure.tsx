/**
 * `Thought for 4s`: one quiet line above a reply, and the thought under it.
 *
 * Thinking is context for the answer, not the answer, so it is closed until the
 * reader opens it, and the default view settings hide it altogether. It is not a
 * bubble and not a card: a panel the width of a bubble, where a bubble sits,
 * reads as a second message the bot sent (the Expo app's lesson). It is muted
 * secondary text with a chevron, the same silhouette a bot-to-bot aside has.
 *
 * While the turn is still thinking and nothing of the reply has arrived, the
 * line says `Thinking` and no duration. The duration is the turn's: the gateway
 * reports no separate one for the thought, and the native apps say the same.
 *
 * The thought is the model's text and is shown as characters, line breaks kept.
 * The row that holds it is memoised on the item, and the reader's choice lives
 * in this component's state, which every row keeps for as long as it is in the
 * transcript.
 */
import { memo, useId, useState } from 'react'

import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'
import { Icon } from '../../../ui/icons'

export interface ReasoningDisclosureProps {
  /** The thought itself. */
  text: string
  /** Wall-clock seconds of the turn, when the gateway sent one. */
  durationS?: number
  /** Still thinking: the line says `Thinking` and shows no duration. */
  streaming?: boolean
}

function ReasoningDisclosureView({ text, durationS, streaming = false }: ReasoningDisclosureProps) {
  useLocale()

  const bodyId = useId()
  const [open, setOpen] = useState(false)
  const openable = text.trim() !== ''

  if (!openable && !streaming) {
    return null
  }

  const label = streaming
    ? strings.chat.assistant.thinking
    : strings.chat.assistant.thoughtFor({ seconds: Math.max(1, Math.round(durationS ?? 0)) })

  if (!openable) {
    return (
      <div className="hm-thought">
        <p className="hm-thought__line">{label}</p>
      </div>
    )
  }

  return (
    <div className="hm-thought">
      <button
        className="hm-thought__line"
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen(current => !current)}
      >
        <span>{label}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
      </button>
      {open ? (
        <p className="hm-thought__text" id={bodyId} dir="auto">
          {text}
        </p>
      ) : null}
    </div>
  )
}

export const ReasoningDisclosure = memo(ReasoningDisclosureView)
