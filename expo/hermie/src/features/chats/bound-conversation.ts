/**
 * Which conversation is actually bound under a bot's key — and therefore
 * whether the transcript under that key is the GROUP chat (HERM-83, D6, gate 1).
 *
 * One derivation for everything that asks. `ChatController.boundOwnId` answers
 * with it, and so do the two surfaces that draw a sender's name: the transcript
 * (`ChatScreen`) and the chat-list preview (`row-preview.ts`). Both used to
 * guess instead — the transcript from the reader's remembered CHOICE
 * (`useCurrentConversation`, which is `undefined` for a legacy title-only
 * `myChats` entry and moves before a switch has happened, or even when it is
 * then refused), the preview from a constant. Either guess drew colleagues'
 * names in a chat that was the reader's own.
 *
 * What is bound is read off the two stores together, the chat under the key
 * and the roster's `current`: `current` is moved only together with the chat
 * (`ChatController.switchTo`) or while nothing is bound (`placeCurrentChats`),
 * so the pair says which conversation's rows are on screen.
 */
import { useState } from 'react'

import type { BotsState } from '../../store/bots'
import { useBotsStore } from '../../store/bots'
import type { ChatsState } from '../../store/chats'
import { useChatsStore } from '../../store/chats'

/**
 * An own chat's stored id, `null` for the group chat, `undefined` when nothing
 * is bound under the key (a cold open, or a switch in flight).
 *
 * `chatStoredId` is the stored session id of the chat under the key, or
 * `undefined` when there is no chat there; `currentId` is the roster's
 * `current` for the bot.
 */
export function boundConversation(
  chatStoredId: string | undefined,
  currentId: string | undefined
): string | null | undefined {
  if (chatStoredId === undefined) {
    return undefined
  }

  return currentId && chatStoredId === currentId ? currentId : null
}

/** `boundConversation` over the stores' own state, for a caller that holds both. */
export function boundConversationOf(
  chats: Pick<ChatsState, 'chats'>,
  bots: Pick<BotsState, 'byName' | 'currentSessions'>,
  botName: string
): string | null | undefined {
  const chat = chats.chats[botName]
  const current = bots.byName[botName]?.current ?? bots.currentSessions[botName]

  return boundConversation(chat ? chat.storedSessionId : undefined, current?.id)
}

/**
 * Whether the transcript under `botName`'s key is the group chat.
 *
 * Two primitive selectors rather than one derived object, so a streamed delta
 * in the chat does not re-render the caller. While nothing is bound — a switch
 * in flight, a switch that failed and is putting the old chat back, a cold open
 * — the last SETTLED answer for this bot is kept rather than flipping: the
 * transcript on screen has not changed conversation, so its names must not
 * change either. Before anything has ever settled the answer is `false`, the
 * safe default that draws every row exactly as it did before `author` existed
 * (and with no chat bound there are no rows to draw anyway).
 */
export function useGroupChat(botName: string): boolean {
  const chatStoredId = useChatsStore(state => state.chats[botName]?.storedSessionId)
  const currentId = useBotsStore(state => (state.byName[botName]?.current ?? state.currentSessions[botName])?.id)
  const bound = boundConversation(chatStoredId, currentId)
  const [settled, setSettled] = useState<{ botName: string; group: boolean } | null>(null)

  if (bound !== undefined) {
    const group = bound === null

    // React's "information from the previous render" pattern: recorded during
    // render, which re-renders at once and settles, rather than in an effect
    // that would paint one frame with the wrong answer first.
    if (settled?.botName !== botName || settled.group !== group) {
      setSettled({ botName, group })
    }

    return group
  }

  return settled?.botName === botName ? settled.group : false
}
