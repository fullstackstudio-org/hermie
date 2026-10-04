/**
 * The messages the reader sent while a reply was still running, as a strip over
 * the composer.
 *
 * Not rows of the transcript: a parked message has not happened yet, and a
 * bubble says it has. The strip is the part of the screen that is already about
 * what is being said rather than what was. Each message is one line (its text,
 * and the attachments named in it) with the three things the reader can do with
 * it: Steer (hand it to the reply that is running, now), Edit (take it back into
 * the field) and Delete.
 *
 * Three are drawn and the rest are a count, because six strips stacked over the
 * field would take most of a small window and the number says how many.
 *
 * Plain text throughout: it is what the reader typed, a moment ago, and it is
 * never Markdown here.
 */
import type { ReactElement } from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { sheetStrings } from '../../i18n/sheet-strings'
import type { QueuedMessage } from '../../state/chats'
import { clipLine } from './chat-format'

/** How many strips are drawn before the rest become a number. */
export const QUEUE_STRIP_LIMIT = 3

/** How much of a message the strip's one line, and a button's name, can carry. */
const LINE_CHARS = 160
const NAME_CHARS = 40

export interface QueuedStripProps {
  /** Oldest first: the order they will go out in. */
  queued: readonly QueuedMessage[]
  /** Hand it to the running reply now. */
  onSteer: (id: string) => void
  /**
   * Put it back in the field. Not offered for a message with attachments: their
   * bytes travel with the message and the field cannot be handed them back, so
   * such a message offers Steer and Delete and nothing that would drop a file.
   */
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

/** The last path segment of an attachment reference (`@file:/srv/a.pdf` is `a.pdf`). */
function attachmentName(reference: string): string {
  const path = reference.replace(/^@(?:file|image):/u, '').replace(/^`|`$/gu, '')

  return path.split('/').filter(Boolean).at(-1) ?? path
}

export function QueuedStrip({ queued, onSteer, onEdit, onDelete }: QueuedStripProps): ReactElement | null {
  useLocale()

  if (queued.length === 0) {
    return null
  }

  const shown = queued.slice(0, QUEUE_STRIP_LIMIT)
  const hidden = queued.length - shown.length

  return (
    <ul className="hm-queue" aria-label={sheetStrings.composer.queueLabel}>
      {shown.map(entry => {
        const line = [entry.text.trim(), ...(entry.attachments ?? []).map(attachmentName)].filter(Boolean).join(' · ')
        const name = clipLine(line, NAME_CHARS)

        return (
          <li className="hm-queue__item" key={entry.id}>
            <span className="hm-queue__label">{strings.chat.queue.label}</span>
            <span className="hm-queue__text" title={clipLine(line, LINE_CHARS)}>
              {line}
            </span>
            <span className="hm-queue__actions">
              <button
                className="hm-queue__action"
                type="button"
                aria-label={`${strings.chat.queue.steer}: ${name}`}
                onClick={() => onSteer(entry.id)}
              >
                {strings.chat.queue.steer}
              </button>
              {entry.attachments?.length ? null : (
                <button
                  className="hm-queue__action"
                  type="button"
                  aria-label={`${strings.chat.queue.edit}: ${name}`}
                  onClick={() => onEdit(entry.id)}
                >
                  {strings.chat.queue.edit}
                </button>
              )}
              <button
                className="hm-queue__action"
                type="button"
                aria-label={`${strings.chat.queue.delete}: ${name}`}
                onClick={() => onDelete(entry.id)}
              >
                {strings.chat.queue.delete}
              </button>
            </span>
          </li>
        )
      })}
      {hidden > 0 ? <li className="hm-queue__more">{strings.chat.queue.more({ count: hidden })}</li> : null}
    </ul>
  )
}
