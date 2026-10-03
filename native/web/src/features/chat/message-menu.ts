/**
 * What a message's menu offers, as data: the decisions without the drawing.
 *
 * Ported from the Expo app's `chat-ui/message-menu.ts`, cut to the three lines
 * the web client has (W-18b): Copy text, Copy as Markdown and Regenerate. The
 * rules that came with them are unchanged:
 *
 *  - **Copy text and Copy as Markdown differ, and both are offered** when they
 *    differ: a reply IS Markdown, and copying it into a terminal wants the
 *    words while copying it into a document wants the syntax. When the two
 *    would be the same string only Copy text is shown; two identical lines read
 *    as a bug.
 *  - **Regenerate only on the last reply**, and only where the screen says it
 *    is honest (`regenerateTargetIsOwn`: not after a colleague's turn in the
 *    group chat). While a turn runs it is drawn disabled rather than removed:
 *    "not now" and "not here" are different answers.
 *  - **The text is read off the item when the line is chosen**, not when the
 *    menu was built: a reply can still be growing while its menu is open, and a
 *    copy of the version the menu saw would quietly cut it short.
 */
import { plainTextBlock } from '@hermie/markdown/plain-text'
import type { TranscriptItem } from '@hermie/transcript'

export type MessageMenuId = 'copyText' | 'copyMarkdown' | 'regenerate'

export interface MessageMenuEntry {
  id: MessageMenuId
  /** Shown, but not now (a turn is running). */
  disabled: boolean
}

export type MessageMenuAction =
  { kind: 'copyText'; text: string } | { kind: 'copyMarkdown'; text: string } | { kind: 'regenerate' }

/**
 * Anything the Markdown stripper could act on. Over-eager on purpose: a false
 * positive costs one strip, a false negative hides Copy as Markdown on a message
 * that has Markdown in it.
 */
const MARKUP = /[*_`[\]<>|#~\\]|^\s*[-+]\s|\d\./mu

/** The Markdown source of a row that has words, or an empty string. */
export function messageText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'assistant':
    case 'user':
    case 'bot_dm_in':
      return item.text
    case 'bot_dm_out':
      return item.message
    case 'cron_delivery':
      return item.body
    default:
      return ''
  }
}

export interface MessageMenuModel {
  item: TranscriptItem
  /** This row is the one reply that may be regenerated (`ItemHost.regenerateTarget`). */
  canRegenerate: boolean
  /** A turn runs on this chat right now. */
  turnActive: boolean
}

export function messageMenuEntries({ item, canRegenerate, turnActive }: MessageMenuModel): MessageMenuEntry[] {
  const text = messageText(item)
  const entries: MessageMenuEntry[] = []

  if (text.trim()) {
    entries.push({ id: 'copyText', disabled: false })

    if (MARKUP.test(text) && plainTextBlock(text) !== text) {
      entries.push({ id: 'copyMarkdown', disabled: false })
    }
  }

  if (canRegenerate && item.kind === 'assistant') {
    entries.push({ id: 'regenerate', disabled: turnActive })
  }

  return entries
}

/** The action a chosen line stands for, read against the item as it is now. */
export function messageMenuAction(id: MessageMenuId, item: TranscriptItem): MessageMenuAction | null {
  const text = messageText(item)

  switch (id) {
    case 'copyText':
      return text.trim() ? { kind: 'copyText', text: plainTextBlock(text) } : null
    case 'copyMarkdown':
      return text.trim() ? { kind: 'copyMarkdown', text } : null
    case 'regenerate':
      return item.kind === 'assistant' ? { kind: 'regenerate' } : null
  }
}

/** The attribute that marks a message the shared menu and the keyboard can reach; its value is the item id. */
export const MESSAGE_ID_ATTRIBUTE = 'data-message-id'

/** The keys that open a focused message's actions (`MessageMenuLayer`), as `aria-keyshortcuts` spells them. */
export const MESSAGE_MENU_KEYS = 'Enter Shift+F10 ContextMenu'

/**
 * What a message's own element carries so the shared menu can find it: the item
 * id, and the keys that open its actions. Two attributes and no element: a
 * control of its own in every message is what slowed a long history down.
 */
export function messageTargetProps(id: string): Record<string, string> {
  return { [MESSAGE_ID_ATTRIBUTE]: id, 'aria-keyshortcuts': MESSAGE_MENU_KEYS }
}
