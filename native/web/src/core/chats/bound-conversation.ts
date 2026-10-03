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
 *
 * Ported from the Expo app's `src/features/chats/bound-conversation.ts`. One
 * deliberate difference: the hook `useGroupChat` is the pure `settleGroupChat`,
 * because `core/` is React-free; the chat screen (W-10b) wraps it in a hook.
 */
import type { BotsState } from '../../state/bots'
import type { ChatsState } from '../../state/chats'

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
export interface SettledGroupChat {
  botName: string
  group: boolean
}

/**
 * The decision inside the Expo app's `useGroupChat` hook, without the hook.
 *
 * `bound` is `boundConversation(...)` for `botName` now; `settled` is what the
 * caller recorded the last time this answered. Returns the answer and what to
 * record next (the same object when nothing changed, so a component that keeps
 * it in state re-renders only on a real change). A component reads the two ids
 * with two primitive selectors (`state.chats[botName]?.storedSessionId`, and
 * the roster's `current` or `currentSessions` id) and records `settled` during
 * render, React's "information from the previous render" pattern, rather than
 * in an effect that would paint one frame with the wrong answer first.
 */
export function settleGroupChat(
  botName: string,
  bound: string | null | undefined,
  settled: SettledGroupChat | null
): { group: boolean; settled: SettledGroupChat | null } {
  if (bound !== undefined) {
    const group = bound === null
    const same = settled?.botName === botName && settled.group === group

    return { group, settled: same ? settled : { botName, group } }
  }

  return { group: settled?.botName === botName ? settled.group : false, settled }
}
