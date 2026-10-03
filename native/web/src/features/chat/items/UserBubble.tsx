/**
 * A human turn.
 *
 * The reader's own is on the right in the tint; somebody else's in the group
 * chat, when the gateway stamped who (HERM-83), is on the left like a reply,
 * with their name over it. A row the page cannot prove is somebody else's is
 * the reader's own: that is the honest default, and the only one that cannot
 * put the reader's words under a stranger's name.
 *
 * The text is Markdown, the same as the reply beside it: a person who typed
 * `**done**` was writing markup, and showing the asterisks on one side and bold
 * on the other would be the page disagreeing with itself. An attachment is its
 * file name, as text: what the gateway holds is a path on its own disk, which
 * the page cannot open.
 */
import type { UserItem } from '@hermie/transcript'
import { memo } from 'react'

import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'
import { webStrings } from '../../../i18n/web-strings'
import { senderName } from '../../bots/preview'
import { clockOf, isoOf } from '../chat-format'
import { useItemContext } from './item-context'
import { MessageMarkdown } from './MessageMarkdown'
import { type RowViewProps, sameRowView } from './row-view'

/** `@file:/srv/x/report.pdf` is `report.pdf`; a backticked path loses its quotes. */
export function attachmentName(reference: string): string {
  const raw = reference.replace(/^@(?:file|image):/u, '').replace(/^[`"']|[`"']$/gu, '')

  return raw.split(/[/\\]/).pop() || raw
}

function UserBubbleView({ item, presentation }: RowViewProps<UserItem>) {
  useLocale()

  const { ownAuthorId, groupChat } = useItemContext()

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const foreign = groupChat && ownAuthorId !== undefined && item.author !== undefined && item.author.id !== ownAuthorId
  const name = foreign ? (item.author ? senderName(item.author) : '') : strings.chat.export.self
  const clock = clockOf(item.ts)
  const attachments = item.attachments ?? []

  return (
    <article
      className="hm-msg"
      data-side={foreign ? 'other' : 'own'}
      data-pending={item.pending ? 'true' : 'false'}
      aria-label={name ? (clock ? webStrings.chat.messageFrom({ name, time: clock }) : name) : undefined}
    >
      {foreign && name ? <p className="hm-msg__sender">{name}</p> : null}

      <div className="hm-bubble" data-kind="user">
        {item.text.trim() ? <MessageMarkdown text={item.text} /> : null}

        {attachments.length > 0 ? (
          <ul className="hm-bubble__files" aria-label={webStrings.chat.attachments}>
            {attachments.map(reference => (
              <li key={reference}>{attachmentName(reference)}</li>
            ))}
          </ul>
        ) : null}

        <p className="hm-bubble__meta">
          {item.displayKind === 'steer' ? <span>{strings.chat.queue.steeredMarker}</span> : null}
          {item.pending ? <span>{strings.chat.receipt.sending}</span> : null}
          {clock ? <time dateTime={isoOf(item.ts)}>{clock}</time> : null}
        </p>
      </div>
    </article>
  )
}

export const UserBubble = memo(UserBubbleView, sameRowView)
