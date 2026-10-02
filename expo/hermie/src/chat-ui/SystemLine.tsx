/**
 * A system line: the transcript saying something happened TO the conversation.
 *
 * A model switch, a personality change, an auto-continue, a `[System: …]` note
 * nothing labelled. Every one of them is a sentence about the chat rather than a
 * turn in it, which is the shape iMessage draws as centred grey text under the
 * bubbles ("You named the conversation …") and never as a message.
 *
 * So it is the one notice family that gets no ledger row: no glyph well, no
 * hairline, no card, and — this is the part that matters — no fold chevron. A
 * disclosure promises something underneath, and there is nothing underneath: the
 * whole content is the sentence, so it is shown in full and allowed to wrap
 * rather than clipped to one line behind a control that reveals the same words
 * again.
 *
 * The bigger notice families keep the folded card (`NoticePill`): a fan-out's
 * report, a background process's output and a compaction handoff all carry a
 * payload worth opening, and a payload is exactly what this family has not got.
 *
 * Appear/motion is the list's, not this row's — `TranscriptList` wraps every row
 * in `Appear`, so a system line arrives the way its neighbours do.
 */
import { View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import type { NoticeItem } from './types'

/**
 * The notice kinds drawn as a system line.
 *
 * `model_switch`, `personality_switch` and `auto_continue` are what the gateway
 * labels its own markers; `system_note` is the same `[System: …]` sentence
 * reaching us with no label on it at all (ADR-0018's addendum). One set, so a
 * marker does not change shape depending on which transport carried it.
 */
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
const SENTENCE_END_RE = /[.!?](?=\s|$)/u

/**
 * What the line says: the first sentence of the body.
 *
 * The BODY, because the body is what the gateway wrote and the title is whatever
 * a surface decided to call the family — `Model changed` names the event but does
 * not say which model. A notice that arrived without a body keeps its title,
 * which is then the only thing it has.
 *
 * The FIRST sentence, because these markers are written for two readers and only
 * the opening one is for this one. A model switch says which model is active and
 * then tells the model what to do with that fact ("From this point forward, use
 * this runtime metadata when answering questions about…"), which on a centred
 * grey line is half a paragraph of instructions addressed to somebody else.
 *
 * A text with no sentence boundary in it is kept whole rather than guessed at —
 * a marker that stops punctuating is a marker this trim has nothing to say
 * about, and showing all of it beats showing none.
 *
 * The trim is HERE and never in `unwrapSystemNote`. That function's result is
 * the notice body, and the body is the key two descriptions of one row are
 * paired on; a display-side shortening that reached it would make the live and
 * the persisted projection disagree and paint the row twice.
 */
export function systemLineText(item: NoticeItem): string {
  const full = item.body?.trim() || item.title.trim()
  const end = SENTENCE_END_RE.exec(full)

  return end?.index === undefined ? full : full.slice(0, end.index + 1)
}

export interface SystemLineProps {
  item: NoticeItem
}

export function SystemLine({ item }: SystemLineProps) {
  const theme = useTheme()
  const text = systemLineText(item)

  if (!text) {
    return null
  }

  return (
    <View style={{ paddingHorizontal: theme.space.lg, paddingVertical: theme.space.xs }}>
      <Text color="textMuted" selectable style={{ textAlign: 'center' }} testID={`notice-${item.id}`} variant="meta">
        {text}
      </Text>
    </View>
  )
}
