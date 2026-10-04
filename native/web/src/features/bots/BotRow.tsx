/**
 * One conversation in the list.
 *
 * Everything the row says about state is derived rather than stored twice, by
 * the rules the native apps use (Expo `BotRow` and `BotsScreen`): `working` comes
 * from the roster's running poll or a turn that is streaming, "needs input" from
 * the open requests the chat store already holds, unread from the canonical
 * chat's `last_active` against a per-bot watermark (or from a count of the
 * transcript's messages past it), and `presenceOf` turns all of it into one of
 * four beads. The preview is the last real message (`preview.ts`).
 *
 * What the reader's arrangement says about the chat is props, drawn and not decided here: its colour
 * (a stripe on the row's edge), a pin and a mute (small marks after the name, spoken in the row's name).
 *
 * The row is a link (`#/chat/<bot>`), so it opens in a new tab on a middle
 * click, and Enter and a click are the same thing. Its accessible name is its
 * visible words plus the two things the eye reads from shapes: the bot's
 * presence and what is unread.
 *
 * The row subscribes to the stores itself, with selectors that return
 * primitives (and a shallow-compared object of them), so a streamed token in one
 * chat re-renders that chat's row and no other: the parent hands every row the
 * same props whatever else moved.
 */
import { hasOpenRequest, unreadCountSince } from '@hermie/transcript'
import { memo } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { type Bot, botsStore } from '../../state/bots'
import { type ChatsState, chatsStore } from '../../state/chats'
import type { AccentName } from '../../state/folders'
import { layoutStore } from '../../state/layout'
import { Icon } from '../../ui/icons'
import { Avatar, PresenceBead, UnreadBadge, VisuallyHidden } from '../../ui/primitives'
import { botLabel } from './bot-label'
import { chatHref } from '../shell/router'
import { formatListTime } from './list-time'
import { presenceOf } from './presence'
import { rowPreview } from './preview'
import './bots.css'
import './row-more.css'

export interface BotRowProps {
  bot: Bot
  /** The bot's picture as a `data:` URL, when the roster has read one. */
  avatarUri?: string | undefined
  /** This bot's chat is the open route. */
  selected: boolean
  /** Whether this row is the one a Tab lands on (the list is one tab stop). */
  tabbable: boolean
  /** The gateway socket is up (`status === 'ready'`). */
  gatewayReady: boolean
  /** The reader's own author id, so their own turns carry no sender name. */
  ownAuthorId: string | undefined
  /** The colour the reader gave this chat (`default` is none): a stripe on the row's edge. */
  accent?: AccentName
  /** The chat is silenced right now (the arrangement's mute, read against the clock by the list). */
  muted?: boolean
  /** The chat is held at the top of its group. */
  pinned?: boolean
}

/** What a row reads out of the chat store: primitives only, so a shallow compare settles it. */
function liveStateOf(
  chat: ChatsState['chats'][string] | undefined,
  bot: Bot,
  ownAuthorId: string | undefined,
  lastSeen: number
) {
  // The group chat is bound under this key unless the bot is on one of the
  // reader's own chats; with nothing bound there is no transcript to name a sender in.
  const groupChat = Boolean(chat) && !(bot.current && chat?.storedSessionId === bot.current.id)
  const preview = rowPreview(chat, bot.canonical?.preview ?? '', { groupChat, ownAuthorId })

  return {
    previewText: preview.text,
    previewSystem: preview.system,
    needsInput: chat ? hasOpenRequest(chat) : false,
    streaming: chat?.turn.active ?? false,
    unreadMessages: chat ? unreadCountSince(chat, lastSeen) : 0
  }
}

export const BotRow = memo(function BotRow({
  bot,
  avatarUri,
  selected,
  tabbable,
  gatewayReady,
  ownAuthorId,
  accent = 'default',
  muted = false,
  pinned = false
}: BotRowProps) {
  // A memo boundary does not follow the root's re-render: the words in a row
  // (its state, its stamp) change with the language, nothing in its props does.
  useLocale()

  // What the reader calls this bot beats what the bot calls itself (Edit profile, Settings).
  const given = useStore(layoutStore, state => state.labels[bot.name])
  const lastSeen = useStore(botsStore, state => state.lastSeen[bot.name] ?? 0)
  const running = useStore(botsStore, state => state.running[bot.name] === true)
  const live = useStore(
    chatsStore,
    useShallow(state => liveStateOf(state.chats[bot.name], bot, ownAuthorId, lastSeen))
  )

  const lastActive = bot.canonical?.lastActive ?? 0
  const presence = presenceOf({
    gatewayReady,
    needsInput: live.needsInput,
    sessionAttached: Boolean(bot.canonical?.id),
    working: running || live.streaming,
    ...(lastActive ? { lastActive } : {})
  })

  // Unread by the watermark, or by what the transcript counts past it.
  const unread = (lastActive > 0 && lastActive > lastSeen) || live.unreadMessages > 0
  const offlineSince = presence.state === 'offline' && presence.lastSeenAt ? presence.lastSeenAt : undefined

  // Offline replaces the preview with when the bot was last heard from: a stale
  // last message under a dead connection reads as if it had just arrived.
  const preview =
    offlineSince !== undefined
      ? strings.app.presence.offlineSince({ time: formatListTime(offlineSince) })
      : live.previewText || bot.description || strings.app.bots.noPreview
  const systemLine = offlineSince === undefined && live.previewSystem && Boolean(live.previewText)
  const stamp = formatListTime(offlineSince ?? lastActive)
  // The bot's own words: cleaned and bounded, and isolated where it stands in a line of its own.
  const name = botLabel(given || bot.displayName, bot.name)

  return (
    <li className="hm-row-item">
      <a
        className="hm-row"
        href={chatHref(bot.name)}
        tabIndex={tabbable ? 0 : -1}
        aria-current={selected ? 'page' : undefined}
        data-bot={bot.name}
        data-selected={selected ? 'true' : 'false'}
        data-unread={unread ? 'true' : 'false'}
        data-accent={accent === 'default' ? undefined : accent}
        data-muted={muted ? 'true' : undefined}
        data-pinned={pinned ? 'true' : undefined}
      >
        <span className="hm-row__avatar">
          <Avatar name={name} uri={avatarUri} />
          <span className="hm-row__bead">
            <PresenceBead state={presence.state} />
          </span>
        </span>

        <span className="hm-row__body">
          <span className="hm-row__top">
            <span className="hm-row__name">
              <bdi>{name}</bdi>
            </span>
            <VisuallyHidden>
              {`, ${strings.app.presence[presence.state]}`}
              {pinned ? `, ${strings.app.layout.pinnedRow}` : ''}
              {muted ? `, ${strings.app.layout.mutedRow}` : ''}
              {live.unreadMessages > 0
                ? `, ${strings.app.bots.unreadLabel({ count: live.unreadMessages })}`
                : unread
                  ? `, ${strings.app.bots.unread}`
                  : ''}
            </VisuallyHidden>
            {pinned || muted ? (
              <span className="hm-row__marks" aria-hidden="true">
                {pinned ? <Icon name="pin" size={14} /> : null}
                {muted ? <Icon name="bellOff" size={14} /> : null}
              </span>
            ) : null}
            {stamp ? <span className="hm-row__time">{stamp}</span> : null}
          </span>
          <span className="hm-row__preview" data-system={systemLine ? 'true' : 'false'}>
            {preview}
          </span>
        </span>

        {unread ? (
          <span className="hm-row__unread">
            <UnreadBadge count={live.unreadMessages} />
          </span>
        ) : null}
      </a>

      {/* Its menu is the list's (`RowMenuLayer`, a chunk of its own, which listens for it): out of the tab order, reached by Right from the row. */}
      <button
        type="button"
        className="hm-row__more"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label={strings.app.layout.rowActions({ name })}
      />
    </li>
  )
})
