/**
 * What a message in the transcript can do, as data.
 *
 * Same shape as the chat list's row menu and for the same reason: one list of
 * intentions, drawn by the platform where the platform can draw it. The difference
 * is that a transcript row is not one kind of thing — a reply, a human turn, an
 * inbound bot message, a tool card, a delegation, a cron delivery — so the list is
 * assembled per kind rather than being a fixed table.
 *
 * Three decisions worth stating:
 *
 *  - **Copy text and Copy as Markdown are both offered, always, and they differ.**
 *    A model's reply IS markdown. Copying it into a terminal wants the words;
 *    copying it into a document wants the syntax. Offering only one means guessing,
 *    and the guess is wrong half the time.
 *  - **Links are enumerated, not collapsed into one "Copy link".** A reply with
 *    three links has three things a reader might want, and a submenu of them is
 *    what every mail client does. Capped, because a menu taller than the window is
 *    not a menu.
 *  - **Almost nothing here reaches the gateway.** Every action but one is local: a
 *    copy, a disclosure, opening a chat this app already has, or putting text back
 *    in the composer. The exception is `Regenerate`, and it is the shape ADR-0010
 *    asks for rather than an exception to it — the menu line does not answer a
 *    question the agent asked, it repeats a turn the reader started, and the
 *    reader's own tap is what starts it. Nothing here can answer an approval.
 *
 * ## Two of the lines are about a turn rather than about a message
 *
 * `Edit and resend` and `Regenerate` both put a new turn on the gateway, so both
 * are offered ONLY where they would be honest:
 *
 *  - **Never while a turn is running.** They are drawn disabled rather than
 *    removed, which is the difference between "not now" and "not here": a line
 *    that vanishes for the duration of every turn is a line the reader stops
 *    believing exists.
 *  - **`Regenerate` only on the LAST reply.** Regenerating an older one would
 *    either rewrite history or append an answer to a question three turns back;
 *    the gateway's `/retry` does the second, and a menu line that quietly did
 *    that to the middle of a conversation would be worse than no line.
 */
import type { TranscriptItem } from '@hermie/transcript'

import { plainTextBlock } from '../markdown/plain-text'
import { menuItems, type MenuItem } from '../ui/menu'
import { chatStrings } from './strings'

/** How many links one message's submenu will list. */
export const MAX_LINK_ITEMS = 8

export type MessageMenuAction =
  | { kind: 'copyText'; text: string }
  | { kind: 'copyMarkdown'; text: string }
  | { kind: 'copyLink'; href: string }
  | { kind: 'openBot'; handle: string }
  | { kind: 'selectText'; text: string }
  | { kind: 'toggleDetails' }
  /**
   * Put this turn back in the composer.
   *
   * The attachment REFERENCES travel with it, not the files: a reference is what
   * the turn holds and what the gateway understands (`UserItem.attachments`), and
   * the bytes are long gone from this device. The composer decides what to draw
   * for one — see `attachmentName`.
   */
  | { kind: 'editResend'; text: string; attachments: string[] }
  /** Run the last reply again. The screen decides how; see `ChatScreen`. */
  | { kind: 'regenerate' }
  /**
   * Say this reply out loud, or stop saying it.
   *
   * ONE action for two menu lines, because the reader is expressing one
   * intention about one row — "read this" and "stop reading this" are the same
   * switch seen from its two sides, and `SpeechReader.toggle` is what settles
   * which. The MARKDOWN travels, not the flattened text: flattening belongs to
   * the voice feature and a menu that did it here would make the markdown
   * stripper a dependency of the menu.
   */
  | { kind: 'readAloud'; text: string }
  /**
   * Fork the conversation at this row.
   *
   * The TEXT travels and the position does not, which is the same split
   * `regenerate` makes: the menu sees one item and has no idea where it sits in
   * the list, so the host — which does — supplies the index and this supplies
   * the words the branch is named after (`branchTitle`).
   */
  | { kind: 'branch'; text: string }

/** `[text](href)` and `<https://…>`; the two forms a model actually writes. */
const LINK_RE = /\[[^\]]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)|<((?:https?|mailto):[^>\s]+)>/gu

/** A bare URL a model wrote without any syntax around it. */
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()[\]"']+/gu

/**
 * Anything the stripper could possibly act on.
 *
 * Deliberately over-eager: a false positive costs one strip, a false negative
 * would hide `Copy as Markdown` on a message that has markdown in it.
 */
const MARKUP_RE = /[*_`[\]<>|#>~\\]|^\s*[-+]\s|\d\./mu

/**
 * Every link in a message, in the order it appears, without duplicates.
 *
 * Deliberately a regular expression rather than the markdown parser: this runs when
 * a menu opens, on one message, and the parser's job is to produce something to
 * render. A link the parser would find and this one misses costs a menu line; a
 * parser run per right-click costs the gesture's responsiveness.
 */
export function messageLinks(text: string): string[] {
  if (!text) {
    return []
  }

  const seen = new Set<string>()
  const out: string[] = []

  const add = (href: string | undefined): void => {
    const trimmed = href?.trim()

    if (!trimmed || seen.has(trimmed)) {
      return
    }

    seen.add(trimmed)
    out.push(trimmed)
  }

  for (const match of text.matchAll(LINK_RE)) {
    add(match[1] ?? match[2])
  }

  for (const match of text.matchAll(BARE_URL_RE)) {
    add(match[0])
  }

  return out.slice(0, MAX_LINK_ITEMS)
}

/** The markdown source of whatever this row is, or '' for a row that has no words. */
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

/**
 * The other bot this row is about, if it is about one.
 *
 * An outbound DM names its target; an inbound one names its sender. Either way the
 * useful action is "open that conversation", which is the one thing a bot-to-bot
 * line cannot say for itself in the ledger.
 */
function counterpart(item: TranscriptItem): string | undefined {
  if (item.kind === 'bot_dm_out') {
    return item.targetHandle || undefined
  }

  if (item.kind === 'bot_dm_in') {
    return item.senderHandle || undefined
  }

  return undefined
}

export interface MessageMenuModel {
  item: TranscriptItem
  /** Whether this row has a disclosure at all — a tool card, a roll-up, a cron card. */
  hasDetails: boolean
  /** Whether that disclosure is open, so the line can say Hide rather than Show. */
  detailsOpen: boolean
  /** Whether the host can actually open another chat. */
  canOpenBot: boolean
  /**
   * Whether "Select text" is worth offering, which is a question about the
   * POINTER rather than about the platform.
   *
   * The panel it opens works everywhere — on a phone it is a nested `Text`
   * tree — but there it offers nothing the long press does not already give,
   * so the line would be a second door to the same room. It is opt-in for
   * exactly that reason, and `TranscriptList` passes `RUNS_ON_MAC`.
   */
  canSelectText?: boolean
  /**
   * A turn is running on this chat right now.
   *
   * Both turn-starting lines are DISABLED by it rather than dropped. A reader
   * who opens the menu mid-turn should be told the action exists and is not
   * available, which is what a greyed line says and what a missing one does not.
   */
  turnRunning?: boolean
  /** Whether the host can put text back in the composer. */
  canEditResend?: boolean
  /**
   * Whether the host can run a reply again AND this row is the one to run.
   *
   * One flag rather than two because the caller is the only thing that can
   * answer either half: the menu sees one item and has no idea whether it is the
   * last reply in the list.
   */
  canRegenerate?: boolean
  /**
   * Whether this platform can speak at all.
   *
   * A capability rather than a preference: a browser with no `speechSynthesis`
   * has nothing behind the line, and a menu entry that does nothing is worse
   * than one that is absent. Unlike the two turn-starting lines, this one is
   * DROPPED rather than disabled — "not now" is not what a missing synthesiser
   * means, and there is no later in which it becomes available.
   */
  canReadAloud?: boolean
  /**
   * This row is being read, or is waiting its turn to be.
   *
   * One flag for both, because the line it produces is the same: `Stop reading`
   * takes a queued reply back out just as it silences a speaking one. Only the
   * host can answer it — the menu sees one item and knows nothing about a queue.
   */
  reading?: boolean
  /**
   * Whether this host can fork the conversation at all.
   *
   * A capability, not a preference: the developer gallery has no gateway to fork
   * against, and a branch of a conversation that is already a branch is a thing
   * this app does not yet draw a place for. Either way the line is DROPPED
   * rather than disabled — unlike the two turn-starting lines, "not now" is not
   * what its absence means and there is no later in which it appears.
   */
  canBranch?: boolean
}

export function messageMenuItems({
  canBranch = false,
  canEditResend = false,
  canOpenBot,
  canReadAloud = false,
  canRegenerate = false,
  canSelectText = false,
  detailsOpen,
  hasDetails,
  item,
  reading = false,
  turnRunning = false
}: MessageMenuModel): MenuItem[] {
  const text = messageText(item)
  const links = messageLinks(text)
  const handle = counterpart(item)
  // A message whose markdown and whose words are the same string has nothing to
  // offer twice, and two identical Copy lines read as a bug.
  //
  // Guarded by a character test first. The menu is rebuilt on every version bump,
  // which during a streaming reply is once per delta, and stripping the markdown
  // off a long reply to find out it had none is the one avoidable cost in here.
  const markdownDiffers = MARKUP_RE.test(text) && plainTextBlock(text) !== text

  return menuItems(
    Boolean(text) && { id: 'copyText', title: chatStrings.menu.copyText, systemImage: 'doc.on.doc' },
    Boolean(text) &&
      markdownDiffers && {
        id: 'copyMarkdown',
        title: chatStrings.menu.copyMarkdown,
        systemImage: 'chevron.left.forwardslash.chevron.right'
      },
    // Directly under the two Copy lines, because it belongs to the same
    // intention — "I want these words" — and above the links, which are about
    // something the message merely contains.
    Boolean(text) &&
      canSelectText && {
        id: 'selectText',
        title: chatStrings.menu.selectText,
        systemImage: 'selection.pin.in.out'
      },
    /*
      Still the "I want these words" group, one step further along: a Copy takes
      them somewhere else, this one says them here.

      On what a BOT said, and only that. A reply and an inbound message from
      another bot are both somebody else's words arriving, which is the case
      where hearing them instead of reading them is worth a menu line. The
      reader's own turn is not — they wrote it — and a tool card, a delegation
      and a cron card are structure rather than prose, so reading one aloud
      would be reciting a layout.
    */
    canReadAloud &&
      (item.kind === 'assistant' || item.kind === 'bot_dm_in') &&
      Boolean(text.trim()) && {
        id: 'readAloud',
        title: reading ? chatStrings.menu.stopReading : chatStrings.menu.readAloud,
        systemImage: reading ? 'stop.circle' : 'speaker.wave.2'
      },
    // Under the copies and above the links, for the same reason `Select text`
    // is: these are about the message itself rather than about something it
    // happens to contain.
    canEditResend &&
      item.kind === 'user' &&
      Boolean(text.trim()) && {
        id: 'editResend',
        title: chatStrings.menu.editResend,
        systemImage: 'pencil',
        disabled: turnRunning
      },
    canRegenerate &&
      item.kind === 'assistant' && {
        id: 'regenerate',
        title: chatStrings.menu.regenerate,
        systemImage: 'arrow.clockwise',
        disabled: turnRunning
      },
    /*
      Directly under the two lines that start a turn, because it belongs to the
      same family — "do something else from here" — and above the links, which
      are about something the message merely contains.

      On a turn and on a reply, and on nothing else. Those two are the rows a
      reader thinks of as a POINT in the conversation: "what if I had asked
      something different here", "what if it had gone the other way from here".
      A tool card, a delegation and a cron delivery are structure rather than
      forks in the road, and offering to branch from one would ask the reader to
      count rows in their head to find out what they would get.

      Not disabled while a turn runs, unlike the two above it: branching does not
      start a turn on this session or touch it at all — `session.branch` forks
      the history so far into a new stored child — so there is nothing for a
      running turn to collide with.
    */
    canBranch &&
      (item.kind === 'user' || item.kind === 'assistant') && {
        id: 'branch',
        title: chatStrings.sessions.branch,
        systemImage: 'arrow.triangle.branch'
      },
    links.length > 0 && {
      id: 'links',
      title: chatStrings.menu.copyLink,
      systemImage: 'link',
      children: links.map((href, index) => ({ id: `copyLink:${index}`, title: href }))
    },
    Boolean(handle) &&
      canOpenBot && {
        id: 'openBot',
        title: chatStrings.menu.openBotChat(handle ?? ''),
        systemImage: 'bubble.left.and.bubble.right'
      },
    hasDetails && {
      id: 'toggleDetails',
      title: detailsOpen ? chatStrings.menu.hideDetails : chatStrings.menu.showDetails,
      systemImage: detailsOpen ? 'chevron.up' : 'chevron.down'
    }
  )
}

/**
 * Read a selection back, against the message it was built from.
 *
 * The item is passed in again rather than captured, so the text a Copy puts on the
 * pasteboard is the text the row holds NOW. A streaming reply's menu can be open
 * while the reply grows, and copying the version the menu was built from would
 * quietly truncate it.
 */
export function parseMessageMenuAction(id: string, item: TranscriptItem): MessageMenuAction | null {
  const text = messageText(item)

  if (id === 'copyText') {
    return { kind: 'copyText', text: plainTextBlock(text) }
  }

  if (id === 'copyMarkdown') {
    return { kind: 'copyMarkdown', text }
  }

  // The markdown source, not the stripped words: the panel renders it, so it
  // needs what the bubble has rather than what a Copy would put on a clipboard.
  if (id === 'selectText') {
    return text ? { kind: 'selectText', text } : null
  }

  if (id === 'toggleDetails') {
    return { kind: 'toggleDetails' }
  }

  /*
    Read off the item again rather than off the menu, exactly as the copies are
    and for the same reason: the row holds the text NOW. A queued turn that was
    edited between the menu opening and the tap would otherwise be resent as the
    version the menu was built from.
  */
  if (id === 'editResend') {
    return item.kind === 'user' && item.text.trim()
      ? { kind: 'editResend', text: item.text, attachments: item.attachments ?? [] }
      : null
  }

  if (id === 'regenerate') {
    return item.kind === 'assistant' ? { kind: 'regenerate' } : null
  }

  /*
    Read off the item again, exactly as the copies are: a reply can still be
    growing while its menu is open, and the words this carries are what the
    branch gets NAMED after. A title taken from the version the menu was built
    from would name a branch after half a sentence.
  */
  if (id === 'branch') {
    return item.kind === 'user' || item.kind === 'assistant' ? { kind: 'branch', text } : null
  }

  /*
    Read off the item again, exactly as the copies are: a reply can still be
    growing while its menu is open, and reading the version the menu was built
    from would speak a truncated answer and stop mid-sentence.
  */
  if (id === 'readAloud') {
    return (item.kind === 'assistant' || item.kind === 'bot_dm_in') && text.trim() ? { kind: 'readAloud', text } : null
  }

  if (id === 'openBot') {
    const handle = counterpart(item)

    return handle ? { kind: 'openBot', handle } : null
  }

  if (id.startsWith('copyLink:')) {
    const href = messageLinks(text)[Number(id.slice('copyLink:'.length))]

    return href ? { kind: 'copyLink', href } : null
  }

  return null
}
