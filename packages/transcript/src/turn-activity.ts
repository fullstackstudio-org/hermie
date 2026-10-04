/**
 * What the bot is doing right now, in one word.
 *
 * The header used to say `Working…` for the whole of a turn, which is true and
 * says nothing: a turn is the model thinking, then writing, then running a
 * command, then waiting on the reader, and the one line under the bot's name is
 * the only place a reader can see which. So this reads the same `ChatState` the
 * transcript renders and answers with the narrowest thing it can prove.
 *
 * It is derived from STATE, not from the event that just arrived. A selector
 * that latched on events would have to be told when to let go, and the thing it
 * would have to let go on — `message.complete` — is exactly the event a dropped
 * socket loses. Reading the state back means a chat that reconnects mid-turn
 * says the right thing without anything having to remember.
 */
import { type ChatState, isRequestLikeItem } from './types'

export type TurnActivity =
  /** Nothing running: the header falls back to the connection's own label. */
  | { kind: 'idle' }
  /** A turn is running and has not yet said what it is. */
  | { kind: 'working' }
  /** Reasoning is arriving and no words have. */
  | { kind: 'thinking' }
  /** Words are arriving, or a preview of them has. */
  | { kind: 'typing' }
  /** A tool call is running, or one has been announced by name. */
  | { kind: 'tool'; tool: string }
  /** An approval, a clarify or an interactive request is open: the turn is blocked on a person. */
  | { kind: 'waiting' }
  /** A `delegate_task` fan-out has children still going. */
  | { kind: 'delegating' }

/**
 * The one thing this chat's turn is doing, by the order of how badly each
 * answer wants the reader.
 *
 * `waiting` is first and is the only one that survives an inactive turn. An
 * approval parked with "Later" leaves the agent blocked while the turn itself is
 * over, and a header that goes back to `Online` over a question nobody has
 * answered is the app forgetting on the reader's behalf. Everything below it is
 * a statement about a RUNNING turn and is read newest-first, because what the
 * bot is doing is whatever it started most recently.
 */
export function turnActivity(chat: ChatState): TurnActivity {
  for (const id of chat.order) {
    const item = chat.items[id]

    if (isRequestLikeItem(item) && item.state === 'open') {
      return { kind: 'waiting' }
    }
  }

  if (!chat.turn.active) {
    return { kind: 'idle' }
  }

  // Announced by `tool.generating` before the call has an id — so before there
  // is a row to find below. It is the earliest moment the name is knowable.
  if (chat.turn.draftingTool) {
    return { kind: 'tool', tool: chat.turn.draftingTool }
  }

  for (const child of Object.values(chat.subagents)) {
    if (child.status === 'queued' || child.status === 'running') {
      return { kind: 'delegating' }
    }
  }

  for (let index = chat.order.length - 1; index >= 0; index -= 1) {
    const item = chat.items[chat.order[index]!]

    if (!item) {
      continue
    }

    if (item.kind === 'tool' && (item.status === 'running' || item.status === 'generating')) {
      return { kind: 'tool', tool: item.name }
    }

    if (item.kind === 'assistant' && (item.streaming || item.interim)) {
      // An interim counts as typing: the preview is the reply so far, and the
      // rest of it is still coming.
      return item.text.trim() ? { kind: 'typing' } : { kind: 'thinking' }
    }
  }

  // `message.start` has landed and nothing else has. Honest rather than a guess
  // at which of the two comes next.
  return { kind: 'working' }
}
