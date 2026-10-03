/**
 * The item kinds that have no view of their own yet: a teammate bot's message
 * and the dispatch to one, a cron delivery, a fan-out of subagents, and the two
 * requests (approval, clarify).
 *
 * Their real views are W-18a's; until then every one of them is a plain line of
 * text saying what it is, so a conversation that holds one is not silently
 * missing a row. The requests are answered in the app's own layer (W-11), never
 * inside the transcript, so what is drawn here is only the record that one was
 * asked and how it ended. All of the text is the gateway's or an agent's and is
 * shown as characters.
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
    case 'bot_dm_in':
      return {
        eyebrow: strings.chat.botDm.asideFrom({ handle: item.senderHandle ?? item.senderName }),
        text: item.text
      }

    case 'bot_dm_out':
      return {
        eyebrow: strings.chat.botDm.asideTo({ handle: item.targetHandle || item.target }),
        text: item.reply?.text
          ? `${item.message}\n\n${strings.chat.botDm.replied({ name: item.target })}: ${item.reply.text}`
          : item.message
      }

    case 'cron_delivery':
      return {
        eyebrow: `${strings.chat.cron.eyebrow} · ${item.nameRedacted ? strings.chat.cron.unnamed : item.jobName}`,
        text: item.body || strings.chat.cron.emptyBody
      }

    case 'subagent_group':
      return { eyebrow: strings.app.activity.groupStatus[item.status] ?? item.status, text: item.goals.join('\n') }

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
