/**
 * The one sheet a chat has on screen.
 *
 * Four sibling sheets used to decide their own visibility, which on iOS means
 * four sibling `Modal`s: the first one presented wins and the rest are never
 * shown. A permission request arriving while the options sheet was open was
 * therefore silently dropped, and the agent sat waiting on a question the user
 * was never offered.
 *
 * This component mounts at most ONE of them. `sheet-host.ts` decides which —
 * priority and the close-then-open swap live there, with no React in them, so
 * the ordering is testable on its own.
 *
 * It also owns the one thing the chat screen could not: a question that has
 * stopped being open while its sheet is up. `chat.requests` is `openRequests`,
 * so the moment a question resolves it vanishes from under the sheet. The host
 * holds the item it is showing by id instead, which is what makes the sheet's
 * own "Answered elsewhere" / "Timed out" branch reachable at all.
 *
 * That branch is for a question resolved SOMEWHERE ELSE. One answered here
 * leaves on the tap: the reader has just said what should happen, and a sheet
 * that stays up for a round trip and then for two seconds of "Answered: Allow
 * once" is two seconds of telling them what they just did.
 */
import type { ApprovalItem, ClarifyItem } from '@hermie/transcript'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { AgentsSheet, type AgentsSheetProps } from '../../chat-ui'
import { BotProfileSheet, type BotProfileSheetProps } from '../bot-profile'
import { ApprovalSheet, ChatOptionsSheet, ClarifySheet, type ChatOptionsSheetProps } from '../../ui/sheets'
import { SHEET_ANIMATION_MS } from '../../ui/BottomSheet'
import { ConversationSheet, type ConversationSheetProps } from '../sessions/ConversationSheet'
import { initialSheetHostState, isSheetVisible, sheetHostReducer, targetSheet, type ManualSheet } from './sheet-host'

export type RequestItem = ApprovalItem | ClarifyItem

export interface ChatSheetHostProps {
  /** The sheet the reader opened themselves. */
  manual: ManualSheet
  /** The reader dismissed the agents or options sheet. */
  onCloseManual: () => void

  /** The oldest question still waiting and not put aside, from `chat.requests`. */
  request?: RequestItem
  /**
   * The current version of a question by id.
   *
   * The host holds an answered question by id, and `chat.requests` no longer
   * lists it, so the item has to come from the full transcript instead.
   */
  findRequest: (id: string) => RequestItem | undefined
  botHandle: string
  /** Called once per question, the first time it reaches the screen. */
  onShowRequest?: (item: RequestItem) => void
  onRespondApproval: (item: ApprovalItem, choice: string) => void
  onSubmitClarify: (item: ClarifyItem, answers: Record<string, string>) => void
  onLockClarify: (item: ClarifyItem, qid: string, answer: string) => void
  /**
   * Take the question off the screen. An OPEN one stays open in the transcript,
   * as an item with an `Answer` button that brings the sheet back.
   *
   * Called for an ANSWERED question too, and that is the whole of the change
   * behind "the sheet closes on the tap": the answer travels as an RPC that may
   * take a round trip, and the question is only off the SCREEN until the
   * gateway says what became of it. If the RPC fails it is still open, still in
   * the transcript, and the error is on the banner.
   */
  onCloseRequest: (item: RequestItem) => void
  /**
   * Questions the reader has already dealt with somewhere else in this chat.
   *
   * The host holds a question by id so it can still show the outcome of one
   * that resolved on another device. An answer given INLINE, on the card in
   * the transcript, is not that: the reader has just answered it, here, and a
   * sheet that stays up to tell them so is the same two seconds of "Answered:
   * Allow once" the sheet already stopped doing. So a held id that appears in
   * this list is let go of.
   */
  dismissedIds?: readonly string[]

  agents: Omit<AgentsSheetProps, 'visible' | 'onClose' | 'onClosed'>
  options: Omit<ChatOptionsSheetProps, 'visible' | 'onClose' | 'onClosed'>
  /**
   * The bot profile editor, or absent where there is no bot to edit.
   *
   * Optional because the roster may not have this chat yet — a deep link opens
   * a chat before `profiles.list` has answered — and a sheet with no bot would
   * be a sheet full of blanks. `targetSheet` still routes to it; this renders
   * nothing until there is something to show.
   */
  profile?: Omit<BotProfileSheetProps, 'visible' | 'onClose' | 'onClosed'>

  /**
   * The bot's conversations, or absent where the caller offers no entry point
   * to them — a gateway that named nobody (`canCreate === false`). `targetSheet`
   * still routes to `'conversations'` on request, but nothing here ever sets
   * `manual` to it without this also being present, so the missing-render guard
   * below is defence rather than a path any caller takes.
   */
  conversations?: Omit<ConversationSheetProps, 'visible' | 'onClose' | 'onClosed'>

  /** Forwarded to the approval sheet; tests pass 0. */
  tapGuardMs?: number
}

/**
 * A slide-out that never reports finishing would strand the next sheet.
 *
 * `Animated` on the JS driver stops ticking while the app is in the background,
 * so the completion callback genuinely can be late by minutes. This is the
 * ceiling after which the host swaps anyway.
 */
const SETTLE_FALLBACK_MS = SHEET_ANIMATION_MS * 4

export function ChatSheetHost({
  manual,
  onCloseManual,
  request,
  findRequest,
  botHandle,
  onShowRequest,
  onRespondApproval,
  onSubmitClarify,
  onLockClarify,
  onCloseRequest,
  agents,
  options,
  profile,
  conversations,
  tapGuardMs,
  dismissedIds
}: ChatSheetHostProps) {
  const [held, setHeld] = useState<string | null>(() => request?.id ?? null)
  const [state, dispatch] = useReducer(sheetHostReducer, initialSheetHostState)

  // Which question is on screen, derived rather than stored: a held question
  // stays while it is open, and keeps its place afterwards so its outcome can
  // be read — but a NEW question waiting on the agent takes over at once.
  const heldItem = held ? findRequest(held) : undefined
  const letGo = Boolean(held && dismissedIds?.includes(held))
  const keepHeld = !letGo && Boolean(heldItem) && (heldItem?.state === 'open' || !request)
  const shownId = keepHeld ? held : (request?.id ?? null)
  const shown = shownId ? findRequest(shownId) : undefined

  // The outgoing sheet still has to render while it slides out, after the item
  // it was showing has gone.
  const lastShown = useRef<RequestItem | undefined>(undefined)

  if (shown) {
    lastShown.current = shown
  }

  useEffect(() => {
    if (shownId !== held) {
      setHeld(shownId)
    }
  }, [held, shownId])

  const announced = useRef<string | null>(null)

  useEffect(() => {
    if (!shown || announced.current === shown.id) {
      return
    }

    announced.current = shown.id
    onShowRequest?.(shown)
  }, [onShowRequest, shown])

  // ── the swap ────────────────────────────────────────────────────────────
  const target = targetSheet(manual, Boolean(shownId))

  useEffect(() => {
    dispatch({ type: 'target', target })
  }, [target])

  const settling = state.presented !== state.target

  useEffect(() => {
    if (!settling) {
      return
    }

    const timer = setTimeout(() => dispatch({ type: 'settled' }), SETTLE_FALLBACK_MS)

    return () => clearTimeout(timer)
  }, [settling, state.presented, state.target])

  const visible = isSheetVisible(state)

  const closeRequest = useMemo(
    () => (item: RequestItem) => {
      setHeld(null)
      onCloseRequest(item)
    },
    [onCloseRequest]
  )

  const settled = useMemo(() => () => dispatch({ type: 'settled' }), [])

  if (state.presented === 'request') {
    const item = shown ?? lastShown.current

    if (!item) {
      return null
    }

    return item.kind === 'approval' ? (
      <ApprovalSheet
        botHandle={botHandle}
        item={item}
        // Keyed by the question, so a second one gets a fresh tap guard and a
        // fresh stepper rather than inheriting the answers of the first.
        key={item.id}
        onClose={() => closeRequest(item)}
        onClosed={settled}
        onRespond={choice => {
          // The sheet goes on the TAP, not on the answer landing. `closeRequest`
          // first, so the slide-out has started before the RPC is even handed to
          // the socket; the question keeps its place in the transcript until the
          // gateway says what became of it.
          closeRequest(item)
          onRespondApproval(item, choice)
        }}
        visible={visible}
        {...(tapGuardMs === undefined ? {} : { tapGuardMs })}
      />
    ) : (
      <ClarifySheet
        item={item}
        key={item.id}
        onClose={() => closeRequest(item)}
        onClosed={settled}
        onLock={(qid, answer) => onLockClarify(item, qid, answer)}
        onSkip={() => closeRequest(item)}
        onSubmit={answers => {
          closeRequest(item)
          onSubmitClarify(item, answers)
        }}
        visible={visible}
      />
    )
  }

  if (state.presented === 'agents') {
    return <AgentsSheet {...agents} onClose={onCloseManual} onClosed={settled} visible={visible} />
  }

  if (state.presented === 'options') {
    return <ChatOptionsSheet {...options} onClose={onCloseManual} onClosed={settled} visible={visible} />
  }

  if (state.presented === 'profile') {
    return profile ? (
      <BotProfileSheet {...profile} onClose={onCloseManual} onClosed={settled} visible={visible} />
    ) : null
  }

  if (state.presented === 'conversations') {
    return conversations ? (
      <ConversationSheet {...conversations} onClose={onCloseManual} onClosed={settled} visible={visible} />
    ) : null
  }

  return null
}
