/**
 * A bot's conversations as the list now shows them: one group chat, and as
 * many of the reader's own as they care to start.
 *
 * ## What this replaces
 *
 * ADR-0007's amendment gave a bot two chats and a switch between them — the
 * shared `Bot Chat` everybody is in, and one private `Chat · <name>`. The
 * switch made the conversation you were not in the other half of a toggle:
 * you could not have two threads going at once, and you could not name
 * either of them.
 *
 * A LIST takes its place. Per bot:
 *
 *  - **the group chat**, one row, always first — the shared hidden session
 *    titled exactly `Bot Chat`;
 *  - **the reader's own chats**, any number of them, each with a title they
 *    can change and a preview of its last message, most recently used first;
 *  - **and a way to start another one**.
 *
 * The title family itself (`TITLE_SEPARATOR`, `ownChatTitle`,
 * `isOwnChatTitle`, `ownChatLabel`) lives in `session-model.ts`, next to
 * `classifyConversations`, which needs it too — a row labelled
 * `Chat · Ada · Trip planning` must be excluded from the Conversations page's
 * `past` group exactly as the bare `Chat · Ada` already was. This module
 * re-exports the three for callers who think of them as part of the list.
 *
 * Pure. Every rule here is testable without a socket.
 */
import type { SessionListRow } from '@hermes/shared/gateway-contract'

import { CANONICAL_CHAT_TITLE } from '../bots/bots-controller'
import {
  type Conversation,
  type ConversationKind,
  cutToWords,
  isOwnChatTitle,
  ownChatTitle,
  sortConversations
} from './session-model'

export { ownChatLabel, ownChatTitle, isOwnChatTitle, TITLE_SEPARATOR } from './session-model'

const collapse = (value: unknown): string => (typeof value === 'string' ? value : '').replace(/\s+/gu, ' ').trim()

/**
 * A bot's conversations, grouped the way both the column and the sheet draw
 * them.
 */
export interface ConversationList {
  /**
   * The shared chat everybody on the gateway is in. Always drawn first.
   *
   * Null only where the listing carried no canonical row at all — a bot whose
   * `Bot Chat` has never been resolved. Surfaces draw the group row from the
   * roster in that case rather than showing a hole.
   */
  group: Conversation | null
  /**
   * This reader's own chats on this bot, most recently used first (Owner
   * Decision, 2026-09-22) — see `BuildConversationListInput.lastOpenedAt`.
   */
  own: Conversation[]
  /**
   * Whether this gateway can offer a chat of the reader's own at all.
   *
   * False on a deployment that named nobody, where there is exactly one
   * conversation per bot and always was (ADR-0007). Surfaces then draw the
   * group row and no "New chat" entry.
   */
  canCreate: boolean
}

export interface BuildConversationListInput {
  rows: readonly SessionListRow[]
  /**
   * The lead this reader's chats carry — `Chat · <their name>`.
   *
   * Empty on a gateway that named nobody, which is what makes `own` empty and
   * `canCreate` false there rather than matching some other reader's chats.
   */
  lead: string
  /**
   * The stored id the roster resolved as this bot's shared chat.
   *
   * Preferred over the title wherever it is known: an id cannot be typed by
   * hand into the wrong row, so a reader who names one of their own chats
   * `Bot Chat` cannot move the one row that may never be deleted into their
   * own list.
   */
  canonicalId?: string
  /** The lineage tip of the same row, which a listing may report instead. */
  canonicalResolvedId?: string
  /**
   * This device's own memory of when each of the reader's chats was last
   * opened or sent to — unix seconds, keyed by stored id (Owner Decision,
   * 2026-09-22: "keep a local last-opened timestamp per conversation, per
   * device, not synced").
   *
   * A chat missing here — never opened on this device, or just arrived from
   * another one — falls back to its creation time (`started_at`), which is
   * the only timestamp the listing itself carries. Task 4 stamps this map
   * when a conversation is opened or sent to; this module only reads it.
   */
  lastOpenedAt?: Readonly<Record<string, number>>
}

/**
 * Turn one `session.list` answer into the two groups.
 *
 * The group chat is tested FIRST and taken out before anything else, so a
 * gateway whose canonical id happens to sit on a row titled like one of this
 * reader's own chats cannot list the shared transcript under their chats,
 * where rename and delete are offered. Own-chat membership is then the title
 * family (`isOwnChatTitle`). Rows with no id are dropped: there is nothing a
 * reader could do with one.
 */
export function buildConversationList({
  canonicalId,
  canonicalResolvedId,
  lastOpenedAt,
  lead,
  rows
}: BuildConversationListInput): ConversationList {
  const canonicalIds = new Set([canonicalId, canonicalResolvedId].filter((id): id is string => Boolean(id)))
  const head = collapse(lead)
  let group: Conversation | null = null
  const own: Conversation[] = []

  for (const row of rows) {
    const id = collapse(row.id)

    if (!id) {
      continue
    }

    const title = collapse(row.title)
    const resolvedId = collapse(row.resolved_id) || id
    const createdAt = typeof row.started_at === 'number' && Number.isFinite(row.started_at) ? row.started_at : 0

    const isGroup = canonicalIds.size
      ? canonicalIds.has(id) || canonicalIds.has(resolvedId)
      : title === CANONICAL_CHAT_TITLE

    if (isGroup) {
      // First one wins. Two rows both answering to the canonical id is a
      // gateway state this app cannot fix, and picking one beats drawing the
      // chat twice.
      group ??= conversationFrom(row, id, resolvedId, title, 'canonical', createdAt)
      continue
    }

    if (isOwnChatTitle(title, head)) {
      // Most recently used first: the local last-opened stamp when this
      // device has one, the row's own creation time otherwise.
      own.push(conversationFrom(row, id, resolvedId, title, 'mine', lastOpenedAt?.[id] ?? createdAt))
    }
  }

  return { group, own: sortConversations(own), canCreate: head.length > 0 }
}

function conversationFrom(
  row: SessionListRow,
  id: string,
  resolvedId: string,
  title: string,
  kind: ConversationKind,
  lastActive: number
): Conversation {
  return {
    id,
    resolvedId,
    // A session upstream never got around to titling lists as an empty
    // string, and a row with no name at all is one a reader cannot pick out
    // of five others.
    title: title || id,
    preview: typeof row.preview === 'string' ? row.preview : '',
    messageCount: typeof row.message_count === 'number' && Number.isFinite(row.message_count) ? row.message_count : 0,
    lastActive,
    kind
  }
}

/**
 * What a reader may do with one row of this list.
 *
 * The group chat answers an EMPTY list — ADR-0007's guard as a type rather
 * than a check, for the same reason `conversationActions` makes it one: a
 * surface that renders whatever this returns cannot draw Delete on the
 * shared transcript, because there is no branch of code in which it is
 * offered.
 *
 * An own chat answers `open`, `rename` and `delete`. Rename only ever touches
 * the label after the lead (`renameOwnChat`, Task 4) — the lead is what finds
 * the chat on every device, the label is what the reader calls it — so this
 * is not the single private chat's `['open']` any more: with the lead and
 * label kept apart, a rename cannot orphan the chat the way it would have
 * before ADR-0007's amendment generalised to more than one.
 */
export type OwnChatAction = 'open' | 'rename' | 'delete'

export function ownChatActions(conversation: Conversation): OwnChatAction[] {
  if (conversation.kind === 'canonical') {
    return []
  }

  return ['open', 'rename', 'delete']
}

/**
 * How much of a first message survives into an auto-relabelled own chat's
 * name — the same budget `branchTitle` cuts a branch's name to, kept as its
 * own constant because the two budgets are free to diverge even though they
 * currently agree.
 */
export const OWN_CHAT_LABEL_MAX = 48

/** How many words of a first message survive into an auto-relabelled name. */
const OWN_CHAT_LABEL_WORDS = 6

/**
 * The label an own chat is auto-relabelled to, from the first words of the
 * reader's first message in it (Architecture Decisions, "New chats are
 * always `lead · <label>`").
 *
 * Reuses `branchTitle`'s cutter (`cutToWords`) so a chat's auto-label and a
 * branch's auto-title read as one family of generated names rather than two
 * conventions that happen to agree today. Unlike `branchTitle`, a message
 * with no words at all answers `''` rather than a bare prefix — there is no
 * `Chat · ` equivalent of `Branch` to fall back to; the caller (Task 4) then
 * leaves the stamp label alone rather than relabelling to nothing.
 */
export function labelFromText(text: string): string {
  return cutToWords(text, OWN_CHAT_LABEL_WORDS, OWN_CHAT_LABEL_MAX)
}

/**
 * The title a newly minted own chat is given.
 *
 * Always `lead · <stamp>` — never the bare lead. Creation used to mint the
 * bare lead for a reader's very first chat (the switch's "My chat"), and a
 * chat already wearing that title is still found and still listed, labelled
 * "My chat" by the surface (`ownChatLabel` answering `''`). But minting it
 * again would make a SECOND own chat indistinguishable from the first the
 * moment a client looked it up by lead alone, so creation now always carries
 * a label, starting as a local timestamp until the first message relabels it
 * (`labelFromText`, `isStampLabel`).
 */
export function newOwnChatTitle(lead: string, stamp: string): string {
  return ownChatTitle(lead, stamp)
}

/**
 * The shape a local stamp label is born with: `YYYY-MM-DD HH:mm`, optionally
 * with `:ss` (the one-shot retry after a `session.title` clash on the same
 * minute mints a seconds-precise stamp instead of failing the whole chat).
 */
const STAMP_LABEL_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/

/**
 * Is this label still the stamp a new chat is born with, rather than
 * something the reader typed or a first message relabelled it to?
 *
 * Read before an auto-relabel (Task 4): a chat is only ever relabelled from
 * its BORN name, never over a name the reader chose or one it already grew
 * out of its own first message. Matching the exact stamp shape, rather than
 * "looks like a date", keeps a reader who genuinely names a chat
 * `2026-09-22 09:00` from having that name silently replaced later.
 */
export function isStampLabel(label: unknown): boolean {
  return typeof label === 'string' && STAMP_LABEL_PATTERN.test(label)
}
