/**
 * A human turn.
 *
 * The reader's own is on the right in the tint; somebody else's in the group
 * chat, when the gateway stamped who (HERM-83), is on the left like a reply,
 * with their name over it. A row the page cannot prove is somebody else's is
 * the reader's own: that is the honest default, and the only one that cannot
 * put the reader's words under a stranger's name.
 *
 * A row an agent sent on somebody's behalf (`author.via`, `contract/gateway/mcp.md`) is the
 * exception to both: it carries one label over it, `<name> via <client>`
 * (`authorLabel`), whoever's it is and in every chat, so it is never drawn as the
 * person typing. The name in it is the person's: `You` for the reader's own.
 *
 * The text is Markdown, the same as the reply beside it: a person who typed
 * `**done**` was writing markup, and showing the asterisks on one side and bold
 * on the other would be the page disagreeing with itself. The attachments are
 * the gallery's (`AttachmentGallery`): a picture where the host has one to load
 * (an image the reader sent from this page), otherwise the file's name as a
 * chip, because what the gateway holds is a path on its own disk that the page
 * cannot open. The message is one the transcript's shared menu reaches
 * (`messageTargetProps`).
 */
import { authorLabel, type UserItem } from '@hermie/transcript'
import { memo } from 'react'

import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'
import { webStrings } from '../../../i18n/web-strings'
import { senderName } from '../../bots/preview'
import { clockOf, isoOf } from '../chat-format'
import { messageTargetProps } from '../message-menu'
import { PersonAvatar } from '../PersonAvatar'
import { AttachmentGallery } from './AttachmentGallery'
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
  const person = foreign ? (item.author ? senderName(item.author) : '') : strings.chat.export.self
  // A row an agent sent for somebody is never drawn as that person alone, in any chat: `<name> via <client>`.
  const viaAgent = item.author?.via !== undefined
  const name = viaAgent ? authorLabel(item.author, person) : person
  // The name over the bubble: somebody else's, or any agent's. The reader's own turn is not captioned.
  const caption = foreign || viaAgent
  const clock = clockOf(item.ts)
  const attachments = item.attachments ?? []

  const bubble = (
    <div className="hm-bubble" data-kind="user">
      {item.text.trim() ? <MessageMarkdown text={item.text} /> : null}

      {attachments.length > 0 ? (
        <AttachmentGallery
          attachments={attachments.map(reference => ({ reference, name: attachmentName(reference) }))}
          onAccent={!foreign}
        />
      ) : null}

      <p className="hm-bubble__meta">
        {item.displayKind === 'steer' ? <span>{strings.chat.queue.steeredMarker}</span> : null}
        {item.pending ? <span>{strings.chat.receipt.sending}</span> : null}
        {clock ? <time dateTime={isoOf(item.ts)}>{clock}</time> : null}
      </p>
    </div>
  )

  return (
    <article
      className="hm-msg"
      data-side={foreign ? 'other' : 'own'}
      data-pending={item.pending ? 'true' : 'false'}
      {...messageTargetProps(item.id)}
      aria-label={name ? (clock ? webStrings.chat.messageFrom({ name, time: clock }) : name) : undefined}
    >
      {caption && name ? <p className="hm-msg__sender">{name}</p> : null}

      {foreign && item.author ? (
        <div className="hm-msg__row">
          {/* Beside the name above it, so the picture is decoration: the avatar hides itself from readers. */}
          <PersonAvatar id={item.author.id} name={person} />
          {bubble}
        </div>
      ) : (
        bubble
      )}
    </article>
  )
}

export const UserBubble = memo(UserBubbleView, sameRowView)
