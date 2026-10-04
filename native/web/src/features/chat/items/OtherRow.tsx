/**
 * The record of a request in the transcript: an approval, a clarify question, or a form, a file request or a draft
 * to review (`RequestItem`: that it was asked and how it ended, never what was answered).
 *
 * They are answered in the app's own layer (W-11, `RequestLayer`), never inside
 * the transcript, so what is drawn here is only the record that one was asked
 * and how it ended: a plain line of text saying what it is. All of the text is
 * the gateway's or an agent's and is shown as characters.
 */
import type { RequestItem, TranscriptItem } from '@hermie/transcript'
import { memo } from 'react'

import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'
import { webStrings } from '../../../i18n/web-strings'
import { clipLine } from '../chat-format'
import { type RowViewProps, sameRowView } from './row-view'

interface Plain {
  /** The small line above the text. */
  eyebrow: string
  /** The text itself; may be empty. */
  text: string
}

const BODY_CHARS = 1_200

/** How a form, a file request or a draft stands, in words: waiting, answered (how), or ended without an answer. */
function requestState(item: RequestItem): string {
  const words = webStrings.chat.request

  if (item.state === 'open') {
    return words.open
  }

  if (item.state === 'cancelled') {
    return item.cancelReason === 'timeout'
      ? words.timedOut
      : item.cancelReason === 'cannot_show'
        ? words.cannotShow
        : words.withdrawn
  }

  const summary = item.answerSummary

  if (summary?.status === 'skipped') {
    return words.skipped
  }

  if (summary?.decision === 'approved') {
    return summary.edited ? words.approvedEdited : words.approved
  }

  if (summary?.decision === 'rejected') {
    return words.rejected
  }

  return summary?.count !== undefined && summary.count > 0 ? words.files({ count: summary.count }) : words.answered
}

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

    case 'request':
      return {
        eyebrow:
          item.method === 'input.file'
            ? webStrings.chat.request.kindFile
            : item.method === 'review.draft'
              ? webStrings.chat.request.kindDraft
              : webStrings.chat.request.kindForm,
        text: `${item.title}\n${requestState(item)}`
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
