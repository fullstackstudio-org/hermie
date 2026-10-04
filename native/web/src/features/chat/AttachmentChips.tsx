/**
 * The attachments staged for the next message, as chips over the composer's
 * field.
 *
 * A chip says what it is (the name, a thumbnail of a ready image made from its
 * own bytes, a file glyph otherwise) and where it is: preparing or uploading, its
 * size once it is ready, or why it is not (too large for the road it takes, no
 * workspace to upload into, the gateway's own words when it refused). Its
 * buttons follow: Cancel while it works, Try again when it failed for a reason
 * trying again could change, Remove once it is still. Every button's name
 * carries the file's name, so a list of three is three different buttons to a
 * screen reader.
 *
 * A polite region (always in the document, so the first change is heard) says
 * how many were added, and the name and the reason of a chip that failed.
 *
 * File names are plain text here, never Markdown, and a long one is cut by the
 * layout with the whole name in its title.
 */
import { type ReactElement, useEffect, useRef, useState } from 'react'

import type { AttachmentProblem, AttachmentTray, StagedAttachment } from '../../core/chats/attachments'
import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { sheetStrings } from '../../i18n/sheet-strings'
import { Icon } from '../../ui/icons'
import { formatBytes, megabytesOf } from './chat-format'

export interface AttachmentChipsProps {
  tray: AttachmentTray
  attachments: readonly StagedAttachment[]
  /** The id the waiting note is given, so Send can point at it. */
  waitingId: string
}

/** Why a chip is not ready, in the reader's words. */
export function problemText(problem: AttachmentProblem): string {
  switch (problem.reason) {
    case 'too-large':
      return strings.app.chat.attach.chipTooLarge({ megabytes: megabytesOf(problem.limitBytes) })
    case 'no-workspace':
      return strings.app.chat.attach.chipNoWorkspace
    case 'refused':
      return sheetStrings.attachments.refused({ detail: problem.detail })
    case 'unreadable':
      return sheetStrings.attachments.unreadable
    default:
      return sheetStrings.attachments.failed({ message: problem.message })
  }
}

function statusText(item: StagedAttachment): string {
  if (item.status === 'working') {
    return item.kind === 'image' ? sheetStrings.attachments.preparing : sheetStrings.attachments.uploading
  }

  if (item.status === 'failed') {
    return item.problem ? problemText(item.problem) : strings.app.chat.attach.chipFailed
  }

  return formatBytes(item.size)
}

/** What changed between two snapshots that is worth saying. */
function announcementFor(previous: ReadonlyMap<string, StagedAttachment>, next: readonly StagedAttachment[]): string {
  const said: string[] = []
  const added = next.filter(item => !previous.has(item.id)).length

  if (added > 0) {
    said.push(sheetStrings.attachments.added({ count: added }))
  }

  for (const item of next) {
    if (item.status === 'failed' && item.problem && previous.get(item.id)?.status !== 'failed') {
      said.push(sheetStrings.attachments.problemAnnounced({ name: item.name, problem: problemText(item.problem) }))
    }
  }

  return said.join(' ')
}

export function AttachmentChips({ tray, attachments, waitingId }: AttachmentChipsProps): ReactElement {
  useLocale()

  const [announcement, setAnnouncement] = useState('')
  const seen = useRef<ReadonlyMap<string, StagedAttachment>>(new Map())

  useEffect(() => {
    const said = announcementFor(seen.current, attachments)

    seen.current = new Map(attachments.map(item => [item.id, item]))

    if (said) {
      setAnnouncement(said)
    }
  }, [attachments])

  const blocked = attachments.some(item => item.status !== 'ready')

  return (
    <div className="hm-attach">
      {attachments.length > 0 ? (
        <ul className="hm-attach__list" aria-label={sheetStrings.attachments.trayLabel}>
          {attachments.map(item => (
            <li className="hm-attach__chip" key={item.id} data-status={item.status} data-kind={item.kind}>
              {item.previewUrl ? (
                <img className="hm-attach__thumb" src={item.previewUrl} alt="" />
              ) : (
                <span className="hm-attach__glyph">
                  <Icon name="file" />
                </span>
              )}
              <span className="hm-attach__text">
                <span className="hm-attach__name" title={item.name}>
                  {item.name}
                </span>
                <span className="hm-attach__status">{statusText(item)}</span>
              </span>
              <span className="hm-attach__actions">
                {item.status === 'working' ? (
                  <button
                    className="hm-attach__action"
                    type="button"
                    aria-label={sheetStrings.attachments.cancelNamed({ name: item.name })}
                    onClick={() => tray.remove(item.id)}
                  >
                    {strings.app.chat.attach.cancel}
                  </button>
                ) : null}
                {item.status === 'failed' && item.problem?.reason !== 'too-large' ? (
                  <button
                    className="hm-attach__action"
                    type="button"
                    aria-label={sheetStrings.attachments.retryNamed({ name: item.name })}
                    onClick={() => tray.retry(item.id)}
                  >
                    {sheetStrings.attachments.retry}
                  </button>
                ) : null}
                {item.status !== 'working' ? (
                  <button
                    className="hm-attach__action hm-attach__remove"
                    type="button"
                    aria-label={sheetStrings.attachments.removeNamed({ name: item.name })}
                    title={strings.chat.composer.removeAttachment}
                    onClick={() => tray.remove(item.id)}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {blocked ? (
        <p className="hm-attach__waiting" id={waitingId}>
          {sheetStrings.attachments.waiting}
        </p>
      ) : null}

      <div className="hm-sr" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  )
}
