/**
 * The preview line one chat-list row shows, wired to the transcript store.
 *
 * `chatRowPreview` holds the decision (see `packages/transcript/src/preview.ts`);
 * this is the subscription around it. It lives beside the row rather than in the
 * list because the row is what needs it, and the list hands every row the same
 * handler identities on purpose — threading a per-bot preview down from there
 * would cost that.
 *
 * Two selectors, each returning a PRIMITIVE. A selector that returned the derived
 * object would hand back a fresh identity on every store notification, and a chat
 * store notifies on every streamed delta: forty rows would re-render for one
 * token arriving in one of them. A string and a boolean compare by value, so a
 * row re-renders when its line actually changes and not before. The derivation
 * runs twice for that, which is a backwards walk that stops at the first message
 * — cheaper than the render it avoids.
 */
import { chatRowPreview, type ChatPreviewOptions } from '@hermie/transcript'
import { useMemo } from 'react'

import { formatChatPreview, senderLabel } from '../../chat-ui'
import { useChatsStore } from '../../store/chats'
import { useGroupChat } from '../chats/bound-conversation'
import { useOwnAuthorId } from '../chats/own-author'

export interface RowPreview {
  text: string
  /** The words are scaffolding, not speech: the row draws them more quietly. */
  system: boolean
}

export function useRowPreview(botName: string, gatewayPreview: string): RowPreview {
  /*
    HERM-83, D6, gate 1: whether the chat under this bot's key is the GROUP
    chat. `state.chats[botName]` is keyed by the bare bot name, but that key
    holds whichever conversation the bot is ON — the group chat, or one of the
    reader's own when they have switched to it (a legacy title-only `myChats`
    entry included). So it is read off what is actually bound, with the same
    derivation the transcript uses (`useGroupChat`), never assumed.
  */
  const groupChat = useGroupChat(botName)
  // The reader's own identity — D3's own/foreign gate — the same stamp-shaped
  // id `ChatScreen` reads for the transcript itself.
  const ownAuthorId = useOwnAuthorId()
  const options: ChatPreviewOptions = {
    groupChat,
    ownAuthorId,
    // The one resolver every surface names a sender through, which cleans the
    // name on read (D4). Only rungs 2 and 3 exist today (Task 4 is not built).
    resolveSenderName: senderLabel
  }

  const text = useChatsStore(state => formatChatPreview(chatRowPreview(state.chats[botName], gatewayPreview, options)))
  const system = useChatsStore(state => chatRowPreview(state.chats[botName], gatewayPreview, options)?.system === true)

  return useMemo(() => ({ text, system }), [text, system])
}
