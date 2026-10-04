/**
 * The line under the bot's name: its presence bead and what it is doing.
 *
 * The name itself is the page's `h1` (`Layout` owns it, and moves focus to it
 * when the route changes), so this is the rest of a messenger's header. The
 * bead and the word come from the same rules as the chat list's row
 * (`presenceOf`, `turnActivity`): a list that says "Working" above a header that
 * says "Online" is two bugs that look like one. The bead is decoration; the
 * words carry the state.
 *
 * It reads the stores itself with selectors that return primitives, so a streamed
 * token re-renders the transcript and not this line.
 *
 * At its end, the way to the bot's profile (`#/chat/<bot>/profile`, `features/profile`: its photo, name,
 * description, colour and capabilities) and to its other conversations (`#/chat/<bot>/conversations`,
 * `features/sessions`): its past ones, its branches and a new one.
 */
import { hasOpenRequest, turnActivity, type TurnActivity } from '@hermie/transcript'
import { type ReactElement } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { Avatar, PresenceBead } from '../../ui/primitives'
import { useBotNames } from '../bots/bot-names'
import { presenceOf } from '../bots/presence'
import { conversationsHref, profileHref } from '../shell/router'
import { shortToolName } from './items/tool-text'

export interface ChatHeaderProps {
  /** The bot of the route. */
  bot: string
  /** Where its chat is held in the chat store; `undefined` before it has been opened. */
  chatKey: string | undefined
}

/** The word under the name: the connection when it is why nothing is happening, else the bot's own activity. */
function subtitleOf(ready: boolean, status: string, activity: TurnActivity): string {
  if (!ready) {
    switch (status) {
      case 'connecting':
      case 'authenticating':
      case 'probing':
        return strings.app.chat.subtitle.connecting
      case 'reconnecting':
        return strings.app.chat.subtitle.reconnecting
      case 'needs_signin':
        return strings.app.chat.subtitle.signedOut
      default:
        return strings.app.chat.subtitle.offline
    }
  }

  switch (activity.kind) {
    case 'waiting':
      return strings.app.chat.subtitle.waiting
    case 'thinking':
      return strings.app.chat.subtitle.thinking
    case 'typing':
      return strings.app.chat.subtitle.typing
    case 'tool':
      return strings.app.chat.subtitle.running({ tool: shortToolName(activity.tool) })
    case 'delegating':
      return strings.app.chat.subtitle.delegating
    case 'working':
      return strings.app.chat.subtitle.working
    default:
      return strings.app.chat.subtitle.idle
  }
}

export function ChatHeader({ bot, chatKey }: ChatHeaderProps): ReactElement {
  useLocale()

  const record = useStore(botsStore, state => state.byName[bot])
  const avatar = useStore(botsStore, state => state.avatars[bot])
  const { primary, secondary } = useBotNames(bot, record?.displayName)
  const running = useStore(botsStore, state => state.running[bot] === true)
  const status = useStore(connectionStore, state => state.status)
  const live = useStore(
    chatsStore,
    useShallow(state => {
      const chat = chatKey === undefined ? undefined : state.chats[chatKey]
      const activity = chat ? turnActivity(chat) : ({ kind: 'idle' } as const)

      return {
        // The activity is a small object; its two fields are what a streamed delta can change.
        activityKind: activity.kind,
        tool: activity.kind === 'tool' ? activity.tool : '',
        needsInput: chat ? hasOpenRequest(chat) : false,
        streaming: chat?.turn.active ?? false
      }
    })
  )

  const ready = status === 'ready'
  const activity: TurnActivity =
    live.activityKind === 'tool'
      ? { kind: 'tool', tool: live.tool }
      : ({ kind: live.activityKind } as Exclude<TurnActivity, { kind: 'tool' }>)
  const presence = presenceOf({
    gatewayReady: ready,
    needsInput: live.needsInput,
    sessionAttached: Boolean(record?.canonical?.id),
    working: running || live.streaming
  })

  return (
    <p className="hm-chat-header">
      <span className="hm-chat-header__avatar" aria-hidden="true">
        <Avatar name={primary} uri={avatar} />
      </span>
      <PresenceBead state={presence.state} size="inline" />
      <span className="hm-chat-header__status">{subtitleOf(ready, status, activity)}</span>
      {/* The bot's other name, where the reader's setting asks for both: the handle an @mention names it by. */}
      {secondary ? (
        <span className="hm-chat-header__alt">
          <bdi>{secondary}</bdi>
        </span>
      ) : null}
      <span className="hm-chat-header__links">
        <a className="hm-chat-header__link" href={profileHref(bot)}>
          {sheetStrings.botProfile.profileLink}
        </a>
        <a className="hm-chat-header__link" href={conversationsHref(bot)}>
          {strings.chat.sessions.conversations}
        </a>
      </span>
    </p>
  )
}
