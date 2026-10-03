/**
 * A chat: open it, read it, watch it stream.
 *
 * This is the wiring and nothing else. What it draws the transcript with is
 * `TranscriptList` (bottom-anchored, the reader's place never moved) and the item
 * views in `items/`; what talks to the gateway is the controller, through the
 * page's `ChatRuntime` context. Nothing here fetches.
 *
 * **Reads through selectors.** The transcript is `visibleItems(chat, view)`,
 * memoised on the chat's `itemsVersion` and the view settings (and on whether the
 * turn runs, because the selectors' status line depends on it and ending a turn
 * changes no item), then `transcriptRows` adds what the screen alone knows: date
 * separators, the status line only while busy, the typing row.
 *
 * **Where scrolling lives.** In the transcript, and nowhere else: while a chat
 * is open the main pane does not scroll (`chat.css`, keyed on `data-screen`
 * which `Layout` sets). One scroller is what keeps `TranscriptList`'s anchoring
 * correct: it measures rows against its own scrollport, and a second scrollport
 * around it would move the rows under the reader without it being told.
 *
 * **Read marking** is the native apps' rule (`core/chats/read-watermark.ts`): a
 * message is read when it arrives in front of the reader, which is when the chat
 * is open, the page is visible and the transcript is at the bottom. Scrolled up,
 * the badge is doing its job (it is the same messages the "jump to latest"
 * button counts); coming back to the bottom reads what arrived meanwhile. It
 * writes under `readKeyFor`, the key of the conversation the bot is ON, so
 * reading one of the reader's own chats never marks the group chat read, and a
 * past conversation opened read-only marks nothing. Opening and leaving mark as
 * well, in the controller (`hydrate`, `closeChat`).
 *
 * **Announcements.** The transcript is `role="log"` and `aria-busy` while a turn
 * streams, so a screen reader is not read every delta; a second, polite region
 * says once when a reply is finished, and who by.
 */
import { plainTextPreview } from '@hermie/markdown/plain-text'
import {
  isBusy,
  itemsVersion,
  lastMessageAt,
  type ChatState,
  visibleItems,
  type VisibilityOptions,
  type VisibleItem
} from '@hermie/transcript'
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { boundConversation, type SettledGroupChat, settleGroupChat } from '../../core/chats/bound-conversation'
import { ownAuthorId as ownAuthorIdOf, ownAuthorStore } from '../../core/chats/own-author'
import { countsAsRead, readWatermark } from '../../core/chats/read-watermark'
import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { Button } from '../../ui/primitives'
import { SecureInputNotice } from '../notices/SecureInputNotice'
import { clipLine } from './chat-format'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { useChatRuntime } from './chat-runtime'
import { ChatItem } from './items/ChatItem'
import { ItemContext, type ItemContextValue } from './items/item-context'
import { JumpToLatest } from './JumpToLatest'
import { transcriptRows } from './rows'
import { TranscriptList, type TranscriptListHandle } from './TranscriptList'
import { useOpenChat } from './use-open-chat'
import { usePageVisible } from './use-page-visible'
import './chat.css'

/**
 * What the chat shows of the transcript until the reader can change it (the
 * verbosity, bot-to-bot and thinking toggles are W-18b's): tool calls as one
 * collapsed line each, notices folded, no reasoning.
 */
export const DEFAULT_CHAT_VIEW: VisibilityOptions = { level: 'normal', showBotToBot: true, showThinking: false }

/** How much of a finished reply is read out. */
const ANNOUNCE_CHARS = 200

export interface ChatScreenProps {
  /** The bot of the route. */
  bot: string
  /** The conversation the route names, when it names one (`#/chat/<bot>/s/<session>`). */
  session?: string
  /** What of the transcript is shown; `DEFAULT_CHAT_VIEW` unless a test or a later setting says otherwise. */
  view?: VisibilityOptions
}

/** Messages the reader would call messages: a finished or streaming reply with words in it. */
function messageCountOf(chat: ChatState | undefined): number {
  if (!chat) {
    return 0
  }

  let count = 0

  for (const id of chat.order) {
    const item = chat.items[id]

    if (item?.kind === 'assistant' && !item.interim && item.text.trim() !== '') {
      count += 1
    }
  }

  return count
}

/** The words of the newest reply that is not an interim note, or an empty string. */
function latestReplyOf(chat: ChatState | undefined): string {
  if (!chat) {
    return ''
  }

  for (let index = chat.order.length - 1; index >= 0; index -= 1) {
    const item = chat.items[chat.order[index] ?? '']

    if (item?.kind === 'assistant' && !item.interim && item.text.trim() !== '' && !item.error) {
      return item.text
    }
  }

  return ''
}

/**
 * Whether the transcript under this key is the group chat, as the roster and the
 * chat store together say (the rule `settleGroupChat` records, here as a hook).
 */
function useGroupChat(bot: string, key: string | undefined): boolean {
  const storedId = useStore(chatsStore, state => (key === undefined ? undefined : state.chats[key]?.storedSessionId))
  const currentId = useStore(botsStore, state => (state.byName[bot]?.current ?? state.currentSessions[bot])?.id)
  const [settled, setSettled] = useState<SettledGroupChat | null>(null)
  // A viewer's key holds a branch or a past conversation: never the group chat.
  const bound = key !== undefined && key !== bot ? undefined : boundConversation(storedId, currentId)
  const result = settleGroupChat(bot, bound, settled)

  // "Information from the previous render": recorded during render, so no frame is drawn with the wrong answer.
  if (result.settled !== settled) {
    setSettled(result.settled)
  }

  return key !== undefined && key !== bot ? false : result.group
}

export function ChatScreen({ bot, session, view = DEFAULT_CHAT_VIEW }: ChatScreenProps): ReactElement {
  useLocale()

  const runtime = useChatRuntime()
  const record = useStore(botsStore, state => state.byName[bot])
  const rosterRead = useStore(botsStore, state => state.refreshedAt !== null || state.bots.length > 0)
  const ready = useStore(connectionStore, state => state.status === 'ready')
  const ownAuthorId = useStore(ownAuthorStore, ownAuthorIdOf)
  const visible = usePageVisible()
  const displayName = record?.displayName ?? bot

  const { key, viewer, error, retry } = useOpenChat({ runtime, record, bot, session, ready })
  const chat = useStore(chatsStore, state => (key === undefined ? undefined : state.chats[key]))
  const groupChat = useGroupChat(bot, key)

  // ── the rows ────────────────────────────────────────────────────────────────
  // `visibleItems` does no caching of its own, by design: this is where the memo
  // it expects lives. `itemsVersion` changes whenever any item mutates.
  const version = chat ? itemsVersion(chat) : 0
  const turnActive = chat?.turn.active ?? false
  const busy = chat ? isBusy(chat) : false
  const shown = useMemo<VisibleItem[]>(
    () => (chat ? visibleItems(chat, view) : []),
    // `chat` itself changes on every commit; what it holds that matters is the version and the turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, key, turnActive, view.level, view.showBotToBot, view.showThinking]
  )
  const rows = useMemo(() => transcriptRows(shown, { busy, turnActive }), [shown, busy, turnActive])

  const itemContext = useMemo<ItemContextValue>(
    () => ({ botName: displayName, gatewayBaseUrl: runtime?.gatewayBaseUrl, ownAuthorId, groupChat }),
    [displayName, runtime?.gatewayBaseUrl, ownAuthorId, groupChat]
  )

  /** Stable, so every row is memoised on its own `(id, version)` and not on this function. */
  const renderItem = useCallback((row: VisibleItem) => <ChatItem row={row} />, [])

  // ── where the reader is ─────────────────────────────────────────────────────
  const listRef = useRef<TranscriptListHandle>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [away, setAway] = useState(false)
  const [arrived, setArrived] = useState(0)
  const awayRef = useRef(false)

  awayRef.current = away

  const onStickChange = useCallback((stuck: boolean) => {
    setAway(!stuck)

    if (stuck) {
      setArrived(0)
    }
  }, [])

  const jumpToLatest = useCallback(() => {
    listRef.current?.jumpToLatest()
    // The button is about to go; the reader's place is the transcript.
    stage.current?.querySelector<HTMLElement>('[role="log"]')?.focus({ preventScroll: true })
  }, [])

  /** The reader sent something: wherever they were reading, they are at the newest row, and follow it. */
  const pinToLatest = useCallback(() => listRef.current?.jumpToLatest(), [])

  // Messages that landed while the reader was further up: the button's count. The
  // delta is taken before the previous count is overwritten.
  const messageCount = useMemo(
    () => messageCountOf(chat),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, key]
  )
  const lastCount = useRef(messageCount)

  useEffect(() => {
    const more = messageCount - lastCount.current

    lastCount.current = messageCount

    if (more > 0 && awayRef.current) {
      setArrived(current => current + more)
    }
  }, [messageCount])

  // ── older history ───────────────────────────────────────────────────────────
  const hydration = chat?.hydration
  const live = hydration === 'live' || hydration === 'stale'
  const [loadingOlder, setLoadingOlder] = useState(false)
  // The reader reached the top before the chat was live (a short chat is "at the top" at once).
  const wantsOlder = useRef(false)

  const loadOlder = useCallback(() => {
    if (!runtime || key === undefined) {
      return
    }

    setLoadingOlder(true)
    void runtime.controller
      .loadOlder(key)
      .catch(() => undefined)
      .finally(() => setLoadingOlder(false))
  }, [runtime, key])

  const onReachTop = useCallback(() => {
    if (live) {
      loadOlder()
    } else {
      wantsOlder.current = true
    }
  }, [live, loadOlder])

  useEffect(() => {
    if (live && wantsOlder.current) {
      wantsOlder.current = false
      loadOlder()
    }
  }, [live, loadOlder])

  // ── read marking ────────────────────────────────────────────────────────────
  const newestMessageAt = useMemo(
    () => (chat ? lastMessageAt(chat) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, key]
  )
  const marking = runtime !== null && !viewer && hydration === 'live'

  useEffect(() => {
    if (!marking || !runtime || !countsAsRead({ away, open: visible })) {
      return
    }

    // Under the key of the conversation the bot is ON: reading one of the
    // reader's own chats must not mark the group chat read. `markSeen` ignores a
    // watermark that is not newer than the one it holds, so the repeats this
    // makes on an unrelated render cost nothing and write nothing.
    botsStore
      .getState()
      .markSeen(runtime.controller.readKeyFor(bot), readWatermark(Math.floor(Date.now() / 1000), newestMessageAt))
  }, [away, bot, marking, newestMessageAt, runtime, visible])

  // ── announcing a finished reply ─────────────────────────────────────────────
  const [announcement, setAnnouncement] = useState('')
  const wasRunning = useRef(false)
  const latestReply = useMemo(
    () => latestReplyOf(chat),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, key]
  )

  useEffect(() => {
    wasRunning.current = false
    setAnnouncement('')
  }, [key])

  useEffect(() => {
    if (wasRunning.current && !turnActive && latestReply) {
      setAnnouncement(
        webStrings.chat.replied({ name: displayName, text: clipLine(plainTextPreview(latestReply), ANNOUNCE_CHARS) })
      )
    }

    wasRunning.current = turnActive
  }, [displayName, latestReply, turnActive])

  // ── what there is to say ────────────────────────────────────────────────────
  const notOnGateway = !record && rosterRead
  const opening = !notOnGateway && rows.length === 0 && !live && !error
  const empty = !notOnGateway && rows.length === 0 && live
  const offlineCopy = !ready && rows.length > 0

  return (
    <div className="hm-chat">
      <ChatHeader bot={bot} chatKey={key} />

      {viewer ? <p className="hm-chat__banner">{webStrings.chat.readOnly}</p> : null}
      {offlineCopy ? <p className="hm-chat__banner">{strings.app.chat.offlineCopy}</p> : null}
      {hydration === 'stale' ? <p className="hm-chat__banner">{strings.app.chat.stale}</p> : null}
      {error ? (
        <div className="hm-chat__banner" data-tone="danger" role="alert">
          <p>{strings.app.chat.failed({ message: error })}</p>
          <Button variant="quiet" onClick={retry}>
            {strings.app.chat.retry}
          </Button>
        </div>
      ) : null}
      {/* A secret, sudo or vault prompt that ended without an answer, or a request only the desktop app can answer. */}
      <SecureInputNotice chatKey={key ?? bot} bot={bot} />

      <div className="hm-chat__stage" ref={stage}>
        {notOnGateway ? <p className="hm-chat__note">{webStrings.chat.notOnGateway}</p> : null}
        {opening ? (
          <p className="hm-chat__note" role="status">
            {strings.app.chat.hydrating}
          </p>
        ) : null}
        {empty ? <p className="hm-chat__note">{strings.app.chat.empty}</p> : null}

        {rows.length > 0 ? (
          <ItemContext.Provider value={itemContext}>
            <TranscriptList
              rows={rows}
              renderItem={renderItem}
              onReachTop={onReachTop}
              onStickChange={onStickChange}
              label={webStrings.chat.transcriptLabel({ name: displayName })}
              busy={turnActive}
              listRef={listRef}
            />
          </ItemContext.Provider>
        ) : null}

        {loadingOlder ? (
          <p className="hm-chat__older" role="status">
            {strings.chat.transcript.loadingEarlier}
          </p>
        ) : null}

        {away && rows.length > 0 ? <JumpToLatest count={arrived} onJump={jumpToLatest} /> : null}
      </div>

      {/* A past conversation or a branch can be read and not answered; a chat the gateway does not list has no one to ask. */}
      {runtime && key !== undefined && !viewer && record ? (
        <Composer key={key} chatKey={key} botName={displayName} onSent={pinToLatest} />
      ) : null}

      {/* A separate, polite region: a finished reply is said once, and a streaming one never is. */}
      <div className="hm-sr hm-chat__announce" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  )
}
