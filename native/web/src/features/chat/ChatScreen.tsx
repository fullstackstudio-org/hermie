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
 *
 * **Attachments.** The chat owns its attachment tray (`useAttachmentTray`) and
 * hands it to the composer and to the drop zone that is the whole chat, so a
 * file picked, pasted or dropped ends in the same place. Only a chat that has a
 * composer and is attached to its session takes files: a file is uploaded into
 * that session's workspace.
 *
 * **A search hit** (`features/search`) opens the bot's chat with a `FindRequest`
 * waiting: once the rows are there, the newest row with the words is scrolled
 * into view and marked, paging back through older history where it has to
 * (`useFindInChat`); where the words are not in the visible text, a line says so.
 *
 * **A past conversation or a branch** (`#/chat/<bot>/s/<id>`, `features/sessions`)
 * opens read-only: a line says what it is, with the ways back to the chat and to
 * the bot's conversations, and there is no composer.
 *
 * **What it shows** is the reader's choice for this chat (`ChatOptions`, kept in
 * `state/chat-view.ts`), unless a test hands in a `view`.
 *
 * **A message's actions** (copy, copy as Markdown, edit and resend, regenerate,
 * branch from here, copy link) are one menu for the whole transcript (`MessageMenuLayer`), reached by pointer, long press and
 * the keyboard's roving focus over messages; no message holds a control of its
 * own. What a row and that menu ask the screen for (a message by id, a picture
 * for an attachment, the image viewer, a copy, the last reply again, a turn put
 * back in the composer, a fork of the conversation) goes through one host object whose identity never changes (`items/item-host.ts`),
 * so asking never re-renders a settled row. A third polite region says what a
 * menu line did. The image viewer is drawn here, outside the list, and loaded
 * the first time a picture is opened.
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
import { lazy, type ReactElement, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import { boundConversation, type SettledGroupChat, settleGroupChat } from '../../core/chats/bound-conversation'
import { countsAsRead, readWatermark } from '../../core/chats/read-watermark'
import { branchChatAt } from '../../core/chats/branch-here'
import { editResendTarget, editResendText } from '../../core/chats/edit-resend'
import { regenerateLastTurn, regenerateTargetIsOwn } from '../../core/chats/regenerate'
import { sentPreviewFor } from '../../core/chats/sent-previews'
import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { writeClipboard } from '../../platform/clipboard'
import { type HashRouter, pageHashRouter } from '../../platform/hash-router'
import { botsStore } from '../../state/bots'
import { chatViewFor, chatViewStore, DEFAULT_CHAT_VIEW } from '../../state/chat-view'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { layoutStore } from '../../state/layout'
import { requestsStore } from '../../state/requests'
import { Button } from '../../ui/primitives'
import { botLabel } from '../bots/bot-label'
import { ResumeProgressLine } from '../notices/ResumeProgressLine'
import { InteractiveNotice } from '../notices/InteractiveNotice'
import { SecureInputNotice } from '../notices/SecureInputNotice'
import { useFindRequest } from '../search/find-request'
import { useFindInChat } from '../search/use-find-in-chat'
import { chatHref, conversationHref, conversationsHref } from '../shell/router'
import { clipLine } from './chat-format'
import { ChatHeader } from './ChatHeader'
import { ChatOptions } from './ChatOptions'
import { Composer, type ComposerPrefill } from './Composer'
import { useChatRuntime } from './chat-runtime'
import { DropZone } from './DropZone'
import { ChatItem } from './items/ChatItem'
import { ItemContext, type ItemContextValue } from './items/item-context'
import { type ItemHost, ItemHostContext, type ViewedImage } from './items/item-host'
import { TodoList } from './items/TodoList'
import { attachmentName } from './items/UserBubble'
import { JumpToLatest } from './JumpToLatest'
import { MessageMenuLayer } from './MessageMenu'
import { transcriptRows } from './rows'
import { TranscriptList, type TranscriptListHandle } from './TranscriptList'
import { useAttachmentTray } from './use-attachment-tray'
import { useOpenChat } from './use-open-chat'
import { useOwnAuthorId } from './use-own-author'
import { usePageVisible } from './use-page-visible'
import type { ExportFormat } from './chat-export'
import { useYolo } from './use-yolo'
import { YoloBadge } from './YoloBadge'
import './chat.css'

/** What a chat shows until the reader changes it (`state/chat-view.ts`). */
export { DEFAULT_CHAT_VIEW }

/** The image viewer: a chunk of its own, fetched the first time a picture is opened. */
const ImageViewer = lazy(() => import('./ImageViewer').then(module => ({ default: module.ImageViewer })))

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** How much of a finished reply is read out. */
const ANNOUNCE_CHARS = 200

export interface ChatScreenProps {
  /** The bot of the route. */
  bot: string
  /** The conversation the route names, when it names one (`#/chat/<bot>/s/<session>`). */
  session?: string
  /** What of the transcript is shown; the reader's choice for this chat (`ChatOptions`) unless a test pins it. */
  view?: VisibilityOptions
  /** Where a branch is opened once it is made; the page's address by default. */
  router?: HashRouter
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

export function ChatScreen({ bot, session, view: pinned, router = pageHashRouter }: ChatScreenProps): ReactElement {
  useLocale()

  const runtime = useChatRuntime()
  const record = useStore(botsStore, state => state.byName[bot])
  const rosterRead = useStore(botsStore, state => state.refreshedAt !== null || state.bots.length > 0)
  const ready = useStore(connectionStore, state => state.status === 'ready')
  const ownAuthorId = useOwnAuthorId()
  const visible = usePageVisible()
  const given = useStore(layoutStore, state => state.labels[bot])
  const displayName = botLabel(given || record?.displayName, bot)

  const { key, viewer, error, retry } = useOpenChat({ runtime, record, bot, session, ready })
  const { yolo, error: yoloError, dismissError: dismissYoloError } = useYolo(bot, runtime, viewer)
  const chat = useStore(chatsStore, state => (key === undefined ? undefined : state.chats[key]))
  const groupChat = useGroupChat(bot, key)
  const chosen = useStore(
    chatViewStore,
    useShallow(state => chatViewFor(state, bot))
  )
  const view = pinned ?? chosen

  // ── the rows ────────────────────────────────────────────────────────────────
  // `visibleItems` does no caching of its own, by design: this is where the memo
  // it expects lives. `itemsVersion` changes whenever any item mutates.
  const version = chat ? itemsVersion(chat) : 0
  const turnActive = chat?.turn.active ?? false
  const busy = chat ? isBusy(chat) : false
  /** The tool the bot named before its call exists: a turn field, so no item's version moves with it. */
  const draftingTool = chat?.turn.draftingTool
  const shown = useMemo<VisibleItem[]>(
    () => (chat ? visibleItems(chat, view) : []),
    // `chat` itself changes on every commit; what it holds that matters is the version and the turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, key, turnActive, view.level, view.showBotToBot, view.showThinking]
  )
  const rows = useMemo(
    () => transcriptRows(shown, { busy, turnActive, draftingTool }),
    [shown, busy, turnActive, draftingTool]
  )

  const itemContext = useMemo<ItemContextValue>(
    () => ({ botName: displayName, gatewayBaseUrl: runtime?.gatewayBaseUrl, ownAuthorId, groupChat, chatKey: key }),
    [displayName, runtime?.gatewayBaseUrl, ownAuthorId, groupChat, key]
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

  // ── what a row and the message menu can ask for ─────────────────────────────
  const hintId = useId()
  const [viewing, setViewing] = useState<{ image: ViewedImage; opener: HTMLElement | null } | null>(null)
  const [menuNotice, setMenuNotice] = useState({ text: '', serial: 0 })
  const shownRef = useRef(shown)
  const [exportFailed, setExportFailed] = useState(false)
  const keyRef = useRef(key)
  const menuLive = useRef({
    turnActive: false,
    target: null as string | null,
    edit: null as string | null,
    branch: false,
    listeners: new Set<() => void>()
  })
  // What the host's stable methods call: replaced every render, read when they run.
  const act = useRef<{
    regenerate: () => void
    editResend: (text: string, attachments: readonly string[]) => void
    branch: (id: string, text: string) => void
  }>({
    regenerate: () => undefined,
    editResend: () => undefined,
    branch: () => undefined
  })
  const [prefill, setPrefill] = useState<ComposerPrefill | null>(null)
  const [branchFailure, setBranchFailure] = useState<string | null>(null)
  /** An interactive request of this chat is open: it has the reader's answer, and the menu offers nothing meanwhile. */
  const requestOpen = useStore(requestsStore, state => state.queue.some(entry => entry.bot === bot))

  shownRef.current = shown
  keyRef.current = key

  const host = useMemo<ItemHost>(
    () => ({
      // The pictures the reader sent from this page (`sent-previews.ts`); everything else is a chip.
      attachmentSrc: reference => sentPreviewFor(keyRef.current, attachmentName(reference)),
      itemById: id => {
        const current = keyRef.current

        return current === undefined ? undefined : chatsStore.getState().chats[current]?.items[id]
      },
      openImage: (image, opener) => setViewing({ image, opener }),
      copy: text => writeClipboard(text),
      // A new node each time, so the same words twice are still said twice.
      announce: text => setMenuNotice(current => ({ text, serial: current.serial + 1 })),
      regenerate: () => act.current.regenerate(),
      editResend: (text, attachments) => act.current.editResend(text, attachments),
      branch: (id, text) => act.current.branch(id, text),
      subscribe: listener => {
        menuLive.current.listeners.add(listener)

        return () => menuLive.current.listeners.delete(listener)
      },
      turnActive: () => menuLive.current.turnActive,
      regenerateTarget: () => menuLive.current.target,
      editTarget: () => menuLive.current.edit,
      canBranch: () => menuLive.current.branch
    }),
    []
  )

  // The one reply that may be asked for again: the newest, in a chat that can be answered, after the reader's own turn.
  const regenerateTarget = useMemo(() => {
    if (
      !runtime ||
      key === undefined ||
      viewer ||
      !record ||
      requestOpen ||
      !regenerateTargetIsOwn(shown, { groupChat, ownAuthorId })
    ) {
      return null
    }

    for (let index = shown.length - 1; index >= 0; index -= 1) {
      const item = shown[index]?.item

      if (item?.kind === 'assistant' && !item.interim) {
        return item.id
      }
    }

    return null
  }, [groupChat, key, ownAuthorId, record, requestOpen, runtime, shown, viewer])

  // The reader's newest turn, where the composer is there to take it back; nothing while a request is open.
  const editTarget = useMemo(
    () =>
      !runtime || key === undefined || viewer || !record || requestOpen
        ? null
        : editResendTarget(shown, { groupChat, ownAuthorId }),
    [groupChat, key, ownAuthorId, record, requestOpen, runtime, shown, viewer]
  )

  // Whether the chat can be forked: this is the bot's own chat (not a past conversation or a branch), it is attached to
  // a session on the gateway, and no request is waiting for an answer.
  const attachedToSession = chat?.runtimeSessionId !== undefined
  const branchable = Boolean(runtime) && key !== undefined && !viewer && attachedToSession && !requestOpen

  useEffect(() => {
    const state = menuLive.current

    if (
      state.turnActive === turnActive &&
      state.target === regenerateTarget &&
      state.edit === editTarget &&
      state.branch === branchable
    ) {
      return
    }

    state.turnActive = turnActive
    state.target = regenerateTarget
    state.edit = editTarget
    state.branch = branchable

    for (const listener of state.listeners) {
      listener()
    }
  }, [branchable, editTarget, regenerateTarget, turnActive])

  act.current.regenerate = () => {
    if (!runtime || key === undefined) {
      return
    }

    const { controller } = runtime

    void regenerateLastTurn({
      turnActive: chatsStore.getState().chats[key]?.turn.active ?? false,
      items: shownRef.current,
      knowsSlashCommand: name => controller.slashRouteFor(key, name) !== null,
      runSlash: command => {
        pinToLatest()

        return controller.runSlash(key, command)
      },
      send: async text => {
        pinToLatest()
        await controller.send(key, text)
      },
      groupChat,
      ...(ownAuthorId ? { ownAuthorId } : {})
    })
      .then(outcome => {
        if (outcome.kind === 'busy') {
          host.announce(strings.chat.menu.turnRunning)
        } else if (outcome.kind === 'nothing') {
          host.announce(strings.chat.menu.nothingToRegenerate)
        }
      })
      .catch((error: unknown) => host.announce(webStrings.composer.sendFailed({ message: messageOf(error) })))
  }

  act.current.editResend = (text, attachments) => {
    setPrefill(current => ({ text: editResendText(text, attachments), serial: (current?.serial ?? 0) + 1 }))
    host.announce(webStrings.chat.menu.editResendReady)
  }

  act.current.branch = (id, text) => {
    if (!runtime || key === undefined) {
      return
    }

    setBranchFailure(null)
    void branchChatAt(runtime.controller, bot, chatsStore.getState().chats[key], id, text)
      .then(branch => {
        // The way the Conversations page opens one: the read-only viewer at the branch's own address. The screen is
        // drawn again for that route (`App`), so the new page's own banner is what says where the reader is.
        router.navigate(conversationHref(bot, branch.id))
      })
      .catch((error: unknown) => setBranchFailure(webStrings.chat.menu.branchFailed({ message: messageOf(error) })))
  }

  // The conversation as a file, from the rows on screen. The writer is fetched when it is first asked for.
  const exportChat = useCallback(
    (format: ExportFormat): void => {
      setExportFailed(false)
      void import('./chat-export')
        .then(({ exportConversation }) =>
          exportConversation({
            items: shownRef.current,
            botName: displayName,
            groupChat,
            ownAuthorId,
            format,
            now: new Date()
          })
        )
        .catch(() => setExportFailed(true))
    },
    [displayName, groupChat, ownAuthorId]
  )

  // A failure belongs to the chat it happened in.
  useEffect(() => setExportFailed(false), [key])

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

  // ── a search hit's words ────────────────────────────────────────────────────
  const findRequest = useFindRequest(bot)
  const loadOlderPage = useCallback(
    (): Promise<'grew' | 'start' | 'unavailable'> =>
      runtime && key !== undefined ? runtime.controller.loadOlder(key) : Promise.resolve('unavailable'),
    [runtime, key]
  )
  // Only the bot's own chat: a hit is always in it (`message-search.ts` drops the rest).
  const find = useFindInChat({
    request: session === undefined && key === bot ? findRequest : null,
    rows: shown,
    loaded: live,
    list: listRef,
    loadOlder: loadOlderPage
  })

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

  // ── attachments ─────────────────────────────────────────────────────────────
  const composing = runtime !== null && key !== undefined && !viewer && record !== undefined
  const tray = useAttachmentTray(composing ? key : undefined, runtime?.controller)
  const attached = attachedToSession
  const dropFiles = useCallback((files: File[]) => void tray?.add(files), [tray])

  // ── what there is to say ────────────────────────────────────────────────────
  const notOnGateway = !record && rosterRead
  const opening = !notOnGateway && rows.length === 0 && !live && !error
  const empty = !notOnGateway && rows.length === 0 && live
  const offlineCopy = !ready && rows.length > 0

  return (
    <DropZone className="hm-chat" enabled={tray !== null && attached} onFiles={dropFiles}>
      <div className="hm-chat__head">
        <ChatHeader bot={bot} chatKey={key} />
        <div className="hm-chat__tools">
          <YoloBadge yolo={yolo} />
          <ChatOptions
            bot={bot}
            yolo={viewer ? undefined : yolo}
            runtime={runtime}
            viewer={viewer}
            exportChat={shown.length > 0 ? exportChat : undefined}
          />
        </div>
      </div>

      {viewer ? (
        <div className="hm-chat__banner">
          <p>{webStrings.chat.readOnly}</p>
          <p className="hm-chat__banner-links">
            <a href={chatHref(bot)}>{webStrings.sessions.backToChat}</a>
            <a href={conversationsHref(bot)}>{strings.chat.sessions.conversations}</a>
          </p>
        </div>
      ) : null}
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
      {yoloError ? (
        <div className="hm-chat__banner" data-tone="danger" role="alert">
          <p>{webStrings.chat.yolo.failed({ message: yoloError })}</p>
          <Button variant="quiet" onClick={dismissYoloError}>
            {webStrings.chat.yolo.dismiss}
          </Button>
        </div>
      ) : null}
      {branchFailure ? (
        <div className="hm-chat__banner" data-tone="danger" role="alert">
          <p>{branchFailure}</p>
          <Button variant="quiet" onClick={() => setBranchFailure(null)}>
            {strings.app.common.dismiss}
          </Button>
        </div>
      ) : null}
      {exportFailed ? (
        <div className="hm-chat__banner" data-tone="danger" role="alert">
          <p>{strings.chat.export.failed}</p>
          <Button variant="quiet" onClick={() => setExportFailed(false)}>
            {strings.app.common.dismiss}
          </Button>
        </div>
      ) : null}
      {find.missed ? <p className="hm-chat__banner">{find.status}</p> : null}
      {/* A secret, sudo or vault prompt that ended without an answer, or a request only the desktop app can answer. */}
      <SecureInputNotice chatKey={key ?? bot} bot={bot} />
      {/* A form, a file request or a draft that ended without an answer, or that this page could not show. */}
      <InteractiveNotice chatKey={key ?? bot} bot={bot} />
      <ResumeProgressLine chatKey={key ?? bot} />

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
            <ItemHostContext.Provider value={host}>
              <TranscriptList
                rows={rows}
                renderItem={renderItem}
                onReachTop={onReachTop}
                onStickChange={onStickChange}
                label={webStrings.chat.transcriptLabel({ name: displayName })}
                describedBy={hintId}
                busy={turnActive}
                listRef={listRef}
              />
            </ItemHostContext.Provider>
          </ItemContext.Provider>
        ) : null}
        <p className="hm-sr" id={hintId}>
          {webStrings.itemViews.keyboardHint}
        </p>
        {rows.length > 0 ? <MessageMenuLayer container={stage} host={host} /> : null}

        {loadingOlder ? (
          <p className="hm-chat__older" role="status">
            {strings.chat.transcript.loadingEarlier}
          </p>
        ) : null}

        {away && rows.length > 0 ? <JumpToLatest count={arrived} onJump={jumpToLatest} /> : null}
      </div>

      {/* The bot's task list: about now, so over the field rather than in the transcript. */}
      <TodoList key={`todo:${key ?? bot}`} todo={chat?.todo} turnActive={turnActive} />

      {/* A past conversation or a branch can be read and not answered; a chat the gateway does not list has no one to ask. */}
      {runtime && key !== undefined && !viewer && record ? (
        <Composer key={key} chatKey={key} botName={displayName} onSent={pinToLatest} tray={tray} prefill={prefill} />
      ) : null}

      {/* A separate, polite region: a finished reply is said once, and a streaming one never is. */}
      <div className="hm-sr hm-chat__announce" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {/* And one for a search hit's row, found or not. */}
      <div className="hm-sr" role="status" aria-live="polite" aria-atomic="true">
        {find.status}
      </div>
      {/* And one for what a message's menu did: copied, or why nothing was sent again. */}
      <div className="hm-sr" role="status" aria-live="polite" aria-atomic="true" data-modal-keep="">
        {menuNotice.text ? <span key={menuNotice.serial}>{menuNotice.text}</span> : null}
      </div>

      {viewing ? (
        <Suspense fallback={null}>
          <ImageViewer
            image={viewing.image}
            opener={viewing.opener}
            gatewayBaseUrl={runtime?.gatewayBaseUrl}
            onClose={() => setViewing(null)}
          />
        </Suspense>
      ) : null}
    </DropZone>
  )
}
