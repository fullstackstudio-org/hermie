/**
 * Forking a conversation at one row of its transcript.
 *
 * The controller's `branchFrom` takes a COUNT and a TITLE, not a row: the method
 * has no row id or index (`ChatController.branchFrom`), so something has to turn
 * "this message" into "how many messages the branch starts with" and "what it is
 * called". That is this: the count off the WHOLE ordered transcript the chat
 * store holds (`branchCountFor`, which counts persisted rows and so is not
 * fooled by the several items one row projects onto), and the title off the words
 * of the row (`branchTitle`).
 *
 * Deliberately off the whole transcript and not the visible rows the screen
 * draws: the visibility filter hides reasoning, tool lines and bot-to-bot
 * asides, and the branch must hold what the gateway holds, not what the reader
 * was shown.
 *
 * Where the branch is read is the screen's: it opens at the address the
 * Conversations page's Open links to.
 */
import type { ChatState } from '@hermie/transcript'

import { branchCountFor, branchTitle, type Conversation } from '../sessions/session-model'

/** The slice of the controller this needs, so a test hands in one function. */
export interface BranchSource {
  branchFrom(botName: string, options: { messageCount: number; title: string }): Promise<Conversation>
}

/**
 * Fork `bot`'s chat at `itemId`, named after `text`, and return the branch the
 * gateway made. A refusal (no runtime session, a gateway that answers without
 * an id) is thrown for the caller to show: nothing here swallows it.
 */
export function branchChatAt(
  controller: BranchSource,
  bot: string,
  chat: Pick<ChatState, 'order' | 'items'> | undefined,
  itemId: string,
  text: string
): Promise<Conversation> {
  const ordered = (chat?.order ?? []).flatMap(id => {
    const item = chat?.items[id]

    return item ? [item] : []
  })

  return controller.branchFrom(bot, { messageCount: branchCountFor(ordered, itemId), title: branchTitle(text) })
}
