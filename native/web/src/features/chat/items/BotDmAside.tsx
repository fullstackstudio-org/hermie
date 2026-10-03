/**
 * Bot-to-bot traffic, in either direction, drawn as an ASIDE: the silhouette a
 * reply's thought has.
 *
 * The owner's rule, which the Expo and the Swift apps both draw: bot-to-bot
 * messages are not chat bubbles. A message to another bot and the reply from
 * one sit on the left, closed, and open on a click, the same design as
 * thoughts. So: no bubble and no card, muted text, a rule down the left edge, a
 * chevron. Left always, because side is about who spoke to the reader, and in
 * both directions that is neither the reader nor the bot they are reading.
 *
 * - **Collapsed** (`collapsed`, and `full` if the selectors ever hand one over):
 *   one line that is a button. An arrow for the direction, `To @writer` or
 *   `From @writer`, a preview of the message, the time and, on a dispatch, the
 *   reply marker, which is never absent (replied, waiting or failed): a row
 *   with nothing on its right would read as "delivered and answered", the one
 *   state the reader cannot verify. Waiting is a still hollow dot, not motion.
 * - **Open**: the message as Markdown (the other bot wrote prose), how the
 *   dispatch went, the reply when it landed, and a link to the other bot's chat
 *   when this gateway has that bot. The row itself never navigates.
 * - **Chip** (`showBotToBot: false`): one line, still there. Hiding a DM would
 *   make the bot's own reply unexplainable (ADR-0009).
 *
 * Every name and one-line text here is cleaned and bounded (`displayText`) and
 * isolated (`<bdi>`, `WithName`); the bodies go through the Markdown renderer,
 * which makes no HTML.
 */
import { plainTextPreview } from '@hermie/markdown/plain-text'
import type { BotDmInItem, BotDmOutItem, DispatchStatus } from '@hermie/transcript'
import { memo, useId, useState } from 'react'
import { useStore } from 'zustand'

import { BOT_NAME_LIMIT, displayText } from '../../../core/requests/secure-input'
import { strings } from '../../../generated/strings'
import { useLocale } from '../../../i18n/use-locale'
import { botsStore } from '../../../state/bots'
import { Icon } from '../../../ui/icons'
import { WithName } from '../../requests/with-name'
import { chatHref } from '../../shell/router'
import { clipLine, clockOf, isoOf } from '../chat-format'
import { MessageMarkdown } from './MessageMarkdown'
import { type RowViewProps, sameRowView } from './row-view'

export type BotDmItem = BotDmInItem | BotDmOutItem

/** How much of a message the collapsed line previews. */
const PREVIEW_CHARS = 60

/** The longest error or reason a dispatch carries onto the row. */
const ERROR_CHARS = 600

/**
 * The handle an aside is about, as the gateway spelled it: the target of a
 * dispatch, the sender of an inbound message. Not cleaned; for display, and for
 * looking the bot up in the roster.
 */
export function dmHandleOf(item: BotDmItem): string {
  return item.kind === 'bot_dm_out'
    ? item.targetHandle || item.target
    : (item.senderHandle ?? item.senderName.toLowerCase())
}

/** A reply that actually came back: a `reply` with an `error` on it is a failure, not an answer. */
export function hasReply(item: BotDmOutItem): boolean {
  return Boolean(item.reply && !item.reply.error)
}

export type MarkerTone = 'failed' | 'replied' | 'waiting' | 'answered'

export interface DmMarker {
  tone: MarkerTone
  label: string
}

/** The marker on the right of an aside: always one on a dispatch, `answered` on an inbound answer. */
export function markerFor(item: BotDmItem): DmMarker | undefined {
  if (item.kind === 'bot_dm_in') {
    return item.answersOurDispatch ? { tone: 'answered', label: strings.chat.botDm.answered } : undefined
  }

  if (item.dispatch.status === 'failed' || item.reply?.error) {
    return { tone: 'failed', label: strings.chat.botDm.marker.failed }
  }

  if (hasReply(item)) {
    return { tone: 'replied', label: strings.chat.botDm.marker.replied }
  }

  return { tone: 'waiting', label: strings.chat.botDm.marker.waiting }
}

function dispatchLabel(status: DispatchStatus): string {
  switch (status) {
    case 'sending':
      return strings.chat.botDm.sending
    case 'queued':
      return strings.chat.botDm.queued
    case 'failed':
      return strings.chat.botDm.failed
    case 'ambiguous':
      return strings.chat.botDm.ambiguous
    default:
      return strings.chat.botDm.unknown
  }
}

/** Whether this gateway has a bot under that handle: the only case a link to its chat leads anywhere. */
function useKnownBot(handle: string): boolean {
  return useStore(botsStore, state => handle !== '' && state.byName[handle] !== undefined)
}

function BotDmAsideView({ item, presentation }: RowViewProps<BotDmItem>) {
  useLocale()

  const bodyId = useId()
  const [open, setOpen] = useState(false)
  const rawHandle = dmHandleOf(item)
  const known = useKnownBot(rawHandle)

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const out = item.kind === 'bot_dm_out' ? item : undefined
  const handle = displayText(rawHandle, BOT_NAME_LIMIT)

  if (presentation === 'chip') {
    const name = displayText(item.kind === 'bot_dm_out' ? item.target : item.senderName, BOT_NAME_LIMIT)
    const phrase = out
      ? (target: string) => strings.chat.botDm.chip({ target })
      : (sender: string) => strings.chat.botDm.inChip({ name: sender })
    const content = <WithName phrase={phrase} name={name || handle} />

    return (
      <p className="hm-chip" data-kind={item.kind}>
        {known ? (
          <a className="hm-chip__link" href={chatHref(rawHandle)}>
            {content}
          </a>
        ) : (
          content
        )}
      </p>
    )
  }

  const body = item.kind === 'bot_dm_out' ? item.message : item.text
  // The words, not the Markdown: a preview line cannot render it and should not spend itself on syntax.
  const preview = clipLine(displayText(plainTextPreview(body), PREVIEW_CHARS * 4), PREVIEW_CHARS)
  const marker = markerFor(item)
  const clock = clockOf(item.ts)
  const header = out
    ? (name: string) => strings.chat.botDm.asideTo({ handle: name })
    : (name: string) => strings.chat.botDm.asideFrom({ handle: name })

  return (
    <article className="hm-dm" data-kind={item.kind} data-open={open ? 'true' : 'false'}>
      <button
        className="hm-dm__line"
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen(current => !current)}
      >
        <span className="hm-dm__arrow" aria-hidden="true">
          {out ? '↗' : '↙'}
        </span>
        <span className="hm-dm__header">
          <WithName phrase={header} name={handle} />
        </span>
        {!open && preview ? (
          <span className="hm-dm__preview">
            <bdi>{preview}</bdi>
          </span>
        ) : null}
        {clock ? (
          <time className="hm-dm__time" dateTime={isoOf(item.ts)}>
            {clock}
          </time>
        ) : null}
        {marker ? (
          <span className="hm-dm__marker" data-tone={marker.tone}>
            {marker.tone === 'waiting' ? <span className="hm-dm__dot" aria-hidden="true" /> : null}
            <span className="hm-dm__marker-label">{marker.label}</span>
          </span>
        ) : null}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
      </button>

      {open ? (
        <div className="hm-dm__body" id={bodyId}>
          {body.trim() ? <MessageMarkdown text={body} /> : null}

          {out ? (
            <p className="hm-dm__status" data-tone={out.dispatch.status === 'failed' ? 'danger' : 'neutral'}>
              {dispatchLabel(out.dispatch.status)}
            </p>
          ) : null}

          {out?.dispatch.error ? (
            <p className="hm-dm__status" data-tone="danger" dir="auto">
              {displayText(out.dispatch.error, ERROR_CHARS)}
            </p>
          ) : null}

          {out?.reply ? (
            <section className="hm-dm__reply">
              <p className="hm-dm__reply-label">{strings.chat.botDm.reply}</p>
              {out.reply.error ? (
                <p className="hm-dm__status" data-tone="danger" dir="auto">
                  {displayText(out.reply.error, ERROR_CHARS)}
                </p>
              ) : (
                <MessageMarkdown text={out.reply.text} />
              )}
            </section>
          ) : null}

          {known ? (
            <a className="hm-dm__open" href={chatHref(rawHandle)}>
              <WithName phrase={name => strings.chat.botDm.openChat({ handle: name })} name={handle} />
            </a>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

export const BotDmAside = memo(BotDmAsideView, sameRowView)
