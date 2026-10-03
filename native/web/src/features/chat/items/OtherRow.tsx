/**
 * The record of a request in the transcript: an approval or a clarify question.
 *
 * Both are answered in the app's own layer (W-11, `RequestLayer`), never inside
 * the transcript, so what is drawn here is only the record that one was asked
 * and how it ended: a plain line of text saying what it is. All of the text is
 * the gateway's or an agent's and is shown as characters.
 */
import type { TranscriptItem } from '@hermie/transcript'
import { memo } from 'react'

import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'
import { clipLine } from '../chat-format'
import { type RowViewProps, sameRowView } from './row-view'

interface Plain {
  /** The small line above the text. */
  eyebrow: string
  /** The text itself; may be empty. */
  text: string
}

const BODY_CHARS = 1_200

function plainOf(item: TranscriptItem): Plain | null {
  switch (item.kind) {
    case 'approval':
      return {
        eyebrow: strings.chat.approval.title,
        text:
          item.state === 'open'
            ? item.command
            : `${item.command}\n${item.state === 'answered' ? strings.chat.approval.answered({ choice: item.answer ?? '' }) : strings.app.chat.cancelled}`
      }

    case 'clarify':
      return {
        eyebrow: strings.app.chat.clarifyTitle,
        text: item.questions.map(question => question.question).join('\n')
      }

    default:
      return null
  }
}

function OtherRowView({ item, presentation }: RowViewProps<TranscriptItem>) {
  useLocale()

  const plain = plainOf(item)

  if (!plain || presentation === 'hidden-placeholder') {
    return null
  }

  if (presentation === 'chip') {
    return (
      <p className="hm-chip" data-kind={item.kind}>
        {clipLine(`${plain.eyebrow}: ${plain.text}`, 90)}
      </p>
    )
  }

  return (
    <article className="hm-aside" data-kind={item.kind}>
      <p className="hm-aside__eyebrow">{plain.eyebrow}</p>
      {plain.text ? <p className="hm-aside__text">{plain.text.slice(0, BODY_CHARS)}</p> : null}
    </article>
  )
}

export const OtherRow = memo(OtherRowView, sameRowView)
