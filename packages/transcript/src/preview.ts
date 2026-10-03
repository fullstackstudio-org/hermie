/**
 * The one line a chat-list row shows under the bot's name.
 *
 * There are two sources for it and they are not equally good:
 *
 *  - the TRANSCRIPT, when this client has one for that bot — cached from a
 *    previous run, or live because the chat is attached. It is the full item
 *    model, so "the last thing somebody said" is a question it can actually
 *    answer;
 *  - the gateway's own `canonical_session.preview` string, which is the raw text
 *    of the last row and nothing else. No kind, no author, no metadata.
 *
 * The second is why a row read `[System: The active model for th…`. The gateway
 * had written a model-switch marker on the `user` role, that row was the newest,
 * and its text went into the preview verbatim — forty characters of a wrapper
 * addressed to the model, in the place where the reader looks for what the
 * conversation is about.
 *
 * So: prefer the transcript, and take the last REAL message from it — a bubble
 * the owner typed, a reply the bot gave, a teammate's DM, a cron report. A
 * notice is not a message and is walked past. When only the gateway's string is
 * available, run it through the same recognisers the transcript uses and, if it
 * turns out to be scaffolding, show the scaffolding's own words with the wrapper
 * taken off — marked `system: true`, so the row can draw it in a quieter style
 * than speech rather than pretending somebody said it.
 *
 * What is deliberately NOT done here: showing the row as empty when the only
 * thing in the chat is scaffolding. A chat whose last row is a model switch has
 * had something happen in it, and a blank line says less than the switch does.
 */
import { authorLabel } from './author'
import { parseInjectedRow } from './injected'
import type { ChatState, MessageAuthor, TranscriptItem } from './types'

export interface ChatPreview {
  /** The words to show. Never carries a `[System: …]` or other wrapper. */
  text: string
  /**
   * A teammate bot said it; the row prefixes their handle the way the DM bubble
   * does. Absent for everything else, the owner's own turns included.
   */
  fromHandle?: string
  /**
   * Somebody else's turn in the group chat: the resolved name to lead the row
   * with (HERM-83, D6). Absent for the reader's own turns, an unattributed
   * row, anywhere the caller has not said is the group chat, and every kind
   * but `user` — the same gate `TranscriptContext`/`UserBubble` draw a name
   * from, restated here because a chat-list row has no bubble to ask.
   */
  senderName?: string
  /**
   * The words are the machine's scaffolding rather than anybody speaking. A row
   * may draw them more quietly; it must not attribute them.
   */
  system: boolean
}

/**
 * What a caller has to hand over before a `user` row can be attributed here.
 *
 * The engine holds `MessageAuthor` but not who is reading or how a name gets
 * sanitised — both are the app's own state (`ChatRuntime`'s identity, the chat
 * kit's `fallbackSenderName`) — so, exactly like `TranscriptContext.groupChat`
 * / `ownAuthorId` / `resolveSenderName`, they arrive as options rather than
 * being read from anywhere global. Every field absent is the safe default:
 * every `user` row previews exactly as it did before `author` existed.
 */
export interface ChatPreviewOptions {
  /** D6 gate 1: only the canonical GROUP chat leads a row with a sender. */
  groupChat?: boolean
  /** The reader's own identity — D3's own/foreign gate, against `author.id`. */
  ownAuthorId?: string
  /**
   * Names a foreign author — D4's rungs 2 and 3, or rung 1 when the host has
   * one. This package cannot sanitise a name itself; a caller with nothing to
   * resolve leaves every row unattributed rather than showing a raw id.
   */
  resolveSenderName?: (author: MessageAuthor) => string
}

/**
 * The newest item in a chat that a reader would call a message.
 *
 * The same four kinds the transcript draws as speech or as a report somebody
 * asked for: the owner's turn, the bot's reply, an inbound teammate DM, a cron
 * delivery's body. Deliberately NOT the same predicate as `countsAsMessage` in
 * `selectors.ts` — that one answers "is this unread mail", which the owner's own
 * turn is not, while a preview showing what the owner last said is exactly right
 * and is what every messenger does.
 *
 * Read backwards: the answer is nearly always the last row, and a chat can be
 * thousands of them.
 */
export function previewFromChat(state: ChatState | undefined, options: ChatPreviewOptions = {}): ChatPreview | null {
  if (!state) {
    return null
  }

  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const found = previewOfItem(state.items[state.order[index] ?? ''], options)

    if (found) {
      return found
    }
  }

  return null
}

/**
 * The sender to lead a `user` row's preview with, or `undefined`.
 *
 * `undefined` for every case D6/D3 already rule out elsewhere: not the group
 * chat, the reader's own identity not known, no author on the row, the row's
 * own author, or a caller with no resolver at all. A row an agent sent on
 * somebody's behalf (`author.via`) is the exception: it is labelled
 * `<name> via <client>` whoever's it is, wherever it is.
 */
function attributedSenderName(author: MessageAuthor | undefined, options: ChatPreviewOptions): string | undefined {
  // An agent's turn is never drawn as the person's own, in a group chat or out of it, so the marker
  // passes both gates: the line leads with `<name> via <client>`. It still needs a resolver for the
  // name (this package cannot sanitise one), and without one the row stays unattributed.
  if (author?.via) {
    const name = options.resolveSenderName?.(author)

    return name ? authorLabel(author, name) : undefined
  }

  if (!options.groupChat || !options.ownAuthorId || !options.resolveSenderName || !author) {
    return undefined
  }

  if (author.id === options.ownAuthorId) {
    return undefined
  }

  return options.resolveSenderName(author) || undefined
}

function previewOfItem(item: TranscriptItem | undefined, options: ChatPreviewOptions): ChatPreview | null {
  if (!item) {
    return null
  }

  switch (item.kind) {
    case 'user': {
      // A placeholder for a turn whose author is not known yet says nothing, and
      // neither does a bubble that carried only an attachment.
      if (item.unknownAuthor) {
        return null
      }

      const found = text(item.text)
      const senderName = found ? attributedSenderName(item.author, options) : undefined

      return found && senderName ? { ...found, senderName } : found
    }

    case 'assistant':
      // An empty bubble is the turn in progress; there is nothing to preview
      // until the first token lands.
      return text(item.text)

    case 'bot_dm_in': {
      const body = item.text.trim()
      const handle = (item.senderHandle ?? item.senderName).trim()

      return body ? { text: body, ...(handle ? { fromHandle: handle } : {}), system: false } : null
    }

    case 'cron_delivery':
      // The report, never the header: the job's name is in the card, and a
      // preview of a header is a preview of plumbing.
      return text(item.body)

    default:
      return null
  }
}

const text = (value: string): ChatPreview | null => {
  const trimmed = value.trim()

  return trimmed ? { text: trimmed, system: false } : null
}

/**
 * The gateway's `preview` string, with any scaffolding wrapper taken off.
 *
 * `null` for an empty string, so a caller can fall through to the bot's
 * description the way it always has.
 */
export function previewFromGatewayText(raw: unknown): ChatPreview | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null
  }

  const injected = parseInjectedRow(raw)

  if (!injected) {
    const opener = truncatedInjectedOpener(raw)

    return opener ? { text: opener, system: true } : { text: raw.trim(), system: false }
  }

  /*
    The scaffolding's own words, and the narrowest of them.

    `title` rather than `body` on purpose: a fan-out report's body is the whole
    row, headers and payload, which on one line of a list row is worse than the
    header alone. For a `[System: …]` note the two are the same sentence anyway,
    because `parseInjectedRow` already took the wrapper off both.
  */
  return { text: injected.title.trim() || injected.body.trim(), system: true }
}

/**
 * What a chat-list row should show: the transcript's last real message when
 * there is one, the gateway's string otherwise.
 *
 * The transcript wins even when the gateway's string is newer, and that is the
 * intended trade. The string is only ever the LAST row, so a chat whose last row
 * is scaffolding has no real message in it to offer; the transcript has the one
 * before it. A stale-by-one-row preview of something somebody said beats a fresh
 * preview of a marker nobody wrote.
 */
export function chatRowPreview(
  state: ChatState | undefined,
  gatewayPreview: unknown,
  options: ChatPreviewOptions = {}
): ChatPreview | null {
  return previewFromChat(state, options) ?? previewFromGatewayText(gatewayPreview)
}

/**
 * A `[System: …]` or `[IMPORTANT: …]` row the gateway has already cut down for
 * a list.
 *
 * The roster's preview is the newest user or assistant row squashed onto one
 * line and cut at eighty characters, so an injected wrapper arrives with its
 * newlines gone and, past eighty characters, its closing bracket gone too —
 * which is exactly what `parseInjectedRow` reads for: a header line, a body
 * under it, a bracket at the end. None of that survives the cut, and the raw
 * text with its opening bracket was what reached the chat list. So a preview
 * that OPENS like scaffolding is read as scaffolding: the first sentence after
 * the marker, with the ellipsis the gateway appended and any bracket it left
 * taken off. It is a lookup on the opener only; a message that merely starts
 * with a bracket (`[link](…)`) does not match.
 */
function truncatedInjectedOpener(raw: string): string | null {
  const match = /^\s*\[(?:System|IMPORTANT):\s*([^\r\n]+)/u.exec(raw)

  if (!match) {
    return null
  }

  const rest = match[1]!.replace(/(?:\.\.\.|…)\s*$/u, '').replace(/\]\s*$/u, '')
  const stop = rest.search(/[.;](?=\s|$)/u)
  const sentence = (stop === -1 ? rest : rest.slice(0, stop)).trim()

  return sentence || null
}
