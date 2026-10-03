/**
 * The bot's reply.
 *
 * Its thought first, when the reader's view settings show thinking: one quiet
 * line that opens (`ReasoningDisclosure`). A reply that so far holds only a
 * thought is that line and nothing else.
 *
 * One bubble from start to finish: while the turn has said nothing yet the
 * bubble holds three dots, and the words replace them in the same bubble (the
 * Expo app's rule, which exists because a bubble of dots under an empty box was
 * the bug it was written after). A reply with nothing to say and nothing wrong
 * is not drawn at all.
 *
 * A failed turn is a card under whatever words arrived (`ErrorCard`). A partial
 * reply is worth keeping, so the words stay; "the gateway still holds the turn"
 * says so instead of offering a retry that would run it twice.
 *
 * The footer says how long it took, what it cost and on what, only when the
 * gateway reported usage: a duration alone is a number with nothing to attach it
 * to.
 */
import { type AssistantItem, prettyModelName } from '@hermie/transcript'
import { memo } from 'react'

import { strings } from '../../../generated/strings'
import { formatNumber } from '../../../i18n/format'
import { useLocale } from '../../../i18n/use-locale'
import { webStrings } from '../../../i18n/web-strings'
import { clockOf, formatDuration, isoOf } from '../chat-format'
import { ErrorCard } from './ErrorCard'
import { useItemContext } from './item-context'
import { MessageMarkdown } from './MessageMarkdown'
import { ReasoningDisclosure } from './ReasoningDisclosure'
import { type RowViewProps, sameRowView } from './row-view'

/** Three dots. Decoration with a name: the reader of the page is told a reply is coming. */
export function TypingDots() {
  useLocale()

  return (
    <span className="hm-dots" role="img" aria-label={strings.chat.replying}>
      <span aria-hidden="true" className="hm-dots__dot" />
      <span aria-hidden="true" className="hm-dots__dot" />
      <span aria-hidden="true" className="hm-dots__dot" />
    </span>
  )
}

function footerParts(item: AssistantItem): string[] {
  const input = item.usage?.input
  const output = item.usage?.output
  const parts: string[] = []

  if (typeof input === 'number' || typeof output === 'number') {
    parts.push(strings.chat.assistant.tokens({ input: formatNumber(input ?? 0), output: formatNumber(output ?? 0) }))
  }

  if (item.usage?.model) {
    parts.push(prettyModelName(item.usage.model))
  }

  if (!parts.length) {
    return parts
  }

  const duration = formatDuration(item.durationS)

  return duration ? [duration, ...parts] : parts
}

function AssistantBubbleView({ item, presentation }: RowViewProps<AssistantItem>) {
  useLocale()

  const { botName } = useItemContext()

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const hasText = item.text.trim() !== ''
  const waiting = item.streaming && !hasText
  const clock = clockOf(item.ts)
  const footer = item.interim ? [] : footerParts(item)
  // The selectors take the thought away when the reader's settings hide thinking.
  const thought = item.reasoning ?? ''
  const hasThought = thought.trim() !== ''

  // Nothing said, nothing thought, nothing wrong, nothing coming: a row that is not a message.
  if (!hasText && !waiting && !item.error && !hasThought) {
    return null
  }

  return (
    <article
      className="hm-msg"
      data-side="bot"
      data-interim={item.interim ? 'true' : 'false'}
      aria-label={clock ? webStrings.chat.messageFrom({ name: botName, time: clock }) : botName || undefined}
    >
      {item.replyToBotHandle ? (
        <p className="hm-msg__sender">{strings.chat.assistant.replyTo({ handle: item.replyToBotHandle })}</p>
      ) : null}
      {item.interim ? <p className="hm-msg__sender">{strings.chat.assistant.interim}</p> : null}

      {hasThought ? (
        <ReasoningDisclosure text={thought} durationS={item.durationS} streaming={item.streaming && !hasText} />
      ) : null}

      {hasText || waiting ? (
        <div className="hm-bubble" data-kind="assistant" data-waiting={waiting ? 'true' : 'false'}>
          {hasText ? <MessageMarkdown text={item.text} /> : <TypingDots />}

          {hasText && clock ? (
            <p className="hm-bubble__meta">
              <time dateTime={isoOf(item.ts)}>{clock}</time>
            </p>
          ) : null}
        </div>
      ) : null}

      {item.error ? <ErrorCard error={item.error} /> : null}

      {footer.length > 0 ? <p className="hm-msg__footer">{strings.chat.assistant.footer({ parts: footer })}</p> : null}
    </article>
  )
}

export const AssistantBubble = memo(AssistantBubbleView, sameRowView)
