/**
 * A notice: a model switch, an auto-continue, a background process that
 * finished, the answer to a command the reader typed, an error.
 *
 * Gateway-injected rows are notices and never the reader's own bubble: a row the
 * reader did not write must not look as if they did. They are centred and quiet.
 * What carries a body is a disclosure; a sentence on its own is just a line,
 * because a fold would open on what the line already says.
 *
 * Two kinds are exceptions to the quiet. An error keeps a danger tint, because
 * it is the kind a reader must not skim past and it survives every verbosity
 * level. A command's answer opens by itself, because it is the payload of
 * something the reader asked for: a disclosure they would have to find and press
 * is indistinguishable from a command that did nothing.
 *
 * Title and body are the gateway's and are shown as characters.
 */
import type { NoticeItem } from '@hermie/transcript'
import { memo, useId, useState } from 'react'

import { Icon } from '../../../ui/icons'
import { type RowViewProps, sameRowView } from './row-view'

function NoticeRowView({ item, presentation }: RowViewProps<NoticeItem>) {
  const bodyId = useId()
  const error = item.noticeKind === 'error'
  const command = item.noticeKind === 'command'
  const body = item.body?.trim() ? item.body : ''
  // `null`: the reader has not decided, so a command opens and the rest stay closed.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? (command || (error && presentation === 'full'))

  if (presentation === 'hidden-placeholder') {
    return null
  }

  // A chip is a title and nothing more, except for the two kinds that may not be folded away.
  if (presentation === 'chip' && !error && !command) {
    return (
      <p className="hm-chip" data-kind="notice">
        {item.title}
      </p>
    )
  }

  if (!body) {
    return (
      <p className="hm-note-line" data-tone={error ? 'danger' : 'neutral'} data-kind={item.noticeKind}>
        {item.title}
      </p>
    )
  }

  return (
    <article className="hm-notice" data-tone={error ? 'danger' : 'neutral'} data-kind={item.noticeKind}>
      <button
        className="hm-notice__line"
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setChosen(!open)}
      >
        <span className="hm-notice__title">{item.title}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
      </button>
      {open ? (
        <pre className="hm-notice__body" id={bodyId}>
          {body}
        </pre>
      ) : null}
    </article>
  )
}

export const NoticeRow = memo(NoticeRowView, sameRowView)
