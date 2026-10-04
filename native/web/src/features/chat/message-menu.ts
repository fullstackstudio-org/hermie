/**
 * What a message's menu offers, as data: the decisions without the drawing.
 *
 * Ported from the Expo app's `chat-ui/message-menu.ts`, cut to the lines the web
 * client has: Copy text, Copy as Markdown, Edit and resend, Regenerate, Branch
 * from here and the links a message holds (HERM-255). Select text, Read aloud,
 * Open chat and Show details are the native apps' (a pointer selects text in a
 * browser, and the web client has no speech or card disclosure of its own). The
 * rules that came with the lines are unchanged:
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
 *  - **Edit and resend** is on the reader's newest turn only, and puts its words
 *    (and the references of its attachments) back in the composer: it starts a
 *    NEW turn from them and leaves the one in the conversation exactly where it
 *    is. Disabled while a turn runs, like Regenerate.
 *  - **Branch from here** is on a turn and on a reply, and on nothing else (a
 *    tool card is structure, not a fork in the road). It does not start a turn,
 *    so a running one does not disable it.
 *  - **Links are enumerated**, not collapsed into one line: one link is one
 *    `Copy link`, several are a `Copy links` submenu of them, capped.
 *  - **The text is read off the item when the line is chosen**, not when the
 *    menu was built: a reply can still be growing while its menu is open, and a
 *    copy of the version the menu saw would quietly cut it short.
 */
import { plainTextBlock } from '@hermie/markdown/plain-text'
import type { TranscriptItem } from '@hermie/transcript'

/** A line of the menu, or one link of the `Copy links` submenu (`copyLink:<index into the message's links>`). */
export type MessageMenuId =
  'copyText' | 'copyMarkdown' | 'editResend' | 'regenerate' | 'branch' | 'copyLinks' | `copyLink:${number}`

export interface MessageMenuEntry {
  id: MessageMenuId
  /** Shown, but not now (a turn is running). */
  disabled: boolean
  /** The `Copy links` line only: what its submenu lists, each as the id that chooses it and the address it copies. */
  links?: readonly { id: MessageMenuId; href: string }[]
}

export type MessageMenuAction =
  | { kind: 'copyText'; text: string }
  | { kind: 'copyMarkdown'; text: string }
  | { kind: 'copyLink'; href: string }
  /** The words and the attachment references of the turn, for the composer. */
  | { kind: 'editResend'; text: string; attachments: string[] }
  | { kind: 'regenerate' }
  /** The words the branch is named after; the host knows where the row sits. */
  | { kind: 'branch'; text: string }

/** How many links one message's submenu lists. A menu taller than the window is not a menu. */
export const MAX_LINK_ITEMS = 8

/** `[text](href)` and `<https://…>`: the two forms a model writes a link in. */
const LINK_RE = /\[[^\]]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)|<((?:https?|mailto):[^>\s]+)>/gu

/** A bare URL a model wrote without any syntax around it. */
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()[\]"']+/gu

/**
 * Every link in a message, in the order it appears, without duplicates.
 *
 * A regular expression rather than the Markdown parser, on purpose: this runs
 * when a menu opens, on one message, and the parser's job is to produce
 * something to render. A link the parser would find and this one misses costs a
 * menu line; a parser run per right-click costs the gesture its responsiveness.
 * Only addresses a browser could open are kept (`http`, `https`, `mailto`), so a
 * relative or script link a model wrote is never offered.
 */
export function messageLinks(text: string): string[] {
  if (!text) {
    return []
  }

  const found: { at: number; href: string }[] = []

  for (const match of text.matchAll(LINK_RE)) {
    found.push({ at: match.index, href: (match[1] ?? match[2] ?? '').trim() })
  }

  for (const match of text.matchAll(BARE_URL_RE)) {
    // A sentence's own full stop is not part of the address.
    found.push({ at: match.index, href: match[0].replace(/[.,;:!?]+$/u, '') })
  }

  // Where each one first appears in the message, not the order the two patterns happened to find them in.
  found.sort((a, b) => a.at - b.at)

  const seen = new Set<string>()
  const out: string[] = []

  for (const { href } of found) {
    if (href && !seen.has(href) && /^(?:https?:|mailto:)/iu.test(href)) {
      seen.add(href)
      out.push(href)
    }
  }

  return out.slice(0, MAX_LINK_ITEMS)
}

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
  /** This row is the reader's newest turn, and the composer is there to take it (`ItemHost.editTarget`). */
  canEditResend?: boolean
  /** This chat can be forked at all: not a viewer, not blocked by a request (`ItemHost.canBranch`). */
  canBranch?: boolean
  /** A turn runs on this chat right now. */
  turnActive: boolean
}

export function messageMenuEntries({
  item,
  canRegenerate,
  canEditResend = false,
  canBranch = false,
  turnActive
}: MessageMenuModel): MessageMenuEntry[] {
  const text = messageText(item)
  const entries: MessageMenuEntry[] = []

  if (text.trim()) {
    entries.push({ id: 'copyText', disabled: false })

    if (MARKUP.test(text) && plainTextBlock(text) !== text) {
      entries.push({ id: 'copyMarkdown', disabled: false })
    }
  }

  // Directly under the copies, because both are about the message itself, and above the links, which are about
  // something it merely contains.
  if (canEditResend && item.kind === 'user' && text.trim()) {
    entries.push({ id: 'editResend', disabled: turnActive })
  }

  if (canRegenerate && item.kind === 'assistant') {
    entries.push({ id: 'regenerate', disabled: turnActive })
  }

  // Not disabled by a running turn: `session.branch` forks the history so far into a new stored child and touches
  // nothing of this session, so there is nothing for a running turn to collide with.
  if (canBranch && (item.kind === 'user' || item.kind === 'assistant')) {
    entries.push({ id: 'branch', disabled: false })
  }

  const links = messageLinks(text)

  if (links.length === 1) {
    entries.push({ id: 'copyLink:0', disabled: false })
  } else if (links.length > 1) {
    entries.push({
      id: 'copyLinks',
      disabled: false,
      links: links.map((href, index) => ({ id: `copyLink:${index}` as const, href }))
    })
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
    case 'editResend':
      return item.kind === 'user' && item.text.trim()
        ? { kind: 'editResend', text: item.text, attachments: item.attachments ?? [] }
        : null
    case 'regenerate':
      return item.kind === 'assistant' ? { kind: 'regenerate' } : null
    case 'branch':
      return item.kind === 'user' || item.kind === 'assistant' ? { kind: 'branch', text } : null
    case 'copyLinks':
      return null
    default: {
      // `copyLink:<n>`: the n-th link of the message as it is now.
      const href = id.startsWith('copyLink:') ? messageLinks(text)[Number(id.slice('copyLink:'.length))] : undefined

      return href ? { kind: 'copyLink', href } : null
    }
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
