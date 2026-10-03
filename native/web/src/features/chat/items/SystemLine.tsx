/**
 * A system line: the transcript saying something happened TO the conversation.
 *
 * A model switch, a personality change, an auto-continue, a `[System: …]` note
 * nothing labelled. Each is a sentence about the chat rather than a turn in it,
 * so it is centred muted text and never a message, a card or a disclosure: a
 * chevron promises something underneath, and there is nothing underneath.
 *
 * What it says is the first sentence of the BODY (the Expo app's
 * `systemLineText`, the Swift `ItemFormat.firstSentence`): the body is what the
 * gateway wrote, the title only names the family, and the sentences after the
 * first are addressed to the model ("From this point forward, use …"). A body
 * with no sentence boundary is kept whole. The trim is a display decision and
 * stays here: the notice body is what two projections of one row are paired on.
 *
 * The text is the gateway's, cleaned and bounded (`displayText`).
 */
import type { NoticeItem } from '@hermie/transcript'
import { memo } from 'react'

import { displayText } from '../../../core/requests/secure-input'
import { type RowViewProps, sameRowView } from './row-view'

/** The notice kinds drawn as a system line; one set, whichever transport carried the marker. */
const SYSTEM_LINE_KINDS: ReadonlySet<NoticeItem['noticeKind']> = new Set([
  'model_switch',
  'personality_switch',
  'auto_continue',
  'system_note'
])

export function isSystemLineNotice(item: NoticeItem): boolean {
  return SYSTEM_LINE_KINDS.has(item.noticeKind)
}

/** A sentence ends at `.`, `!` or `?` with whitespace or the end of the text behind it. */
const SENTENCE_END = /[.!?](?=\s|$)/u

/** What the line says: the first sentence of the body, or the title when there is no body. */
export function systemLineText(item: Pick<NoticeItem, 'body' | 'title'>): string {
  const full = item.body?.trim() || item.title.trim()
  const end = SENTENCE_END.exec(full)

  return end === null ? full : full.slice(0, end.index + 1)
}

/** The longest line a system line holds. */
const LINE_CHARS = 400

function SystemLineView({ item, presentation }: RowViewProps<NoticeItem>) {
  const text = displayText(systemLineText(item), LINE_CHARS)

  if (presentation === 'hidden-placeholder' || !text) {
    return null
  }

  return (
    <p className="hm-system-line" data-kind={item.noticeKind}>
      <bdi>{text}</bdi>
    </p>
  )
}

export const SystemLine = memo(SystemLineView, sameRowView)
