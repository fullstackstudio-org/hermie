/**
 * A private conversation per person, beside the shared Bot Chat (ADR-0007,
 * amended 2026-09-22).
 *
 * ADR-0007 gives a bot one forever-chat: the hidden session titled exactly
 * `Bot Chat`, shared by everybody who can reach that bot. On a gateway with one
 * person on it that is the whole story. On a gateway two colleagues share it is
 * still the only story, and it is the wrong one often enough to be worth
 * fixing: two people typing into one transcript read each other's half-finished
 * thoughts and give the bot a memory that belongs to neither of them.
 *
 * So a bot now offers a SECOND chat, and only a second: the reader's own,
 * titled exactly
 *
 *     Chat · <display name, else user id>
 *
 * and resolved the way the canonical one is — by title, on that profile,
 * through `session.list`. The title is the identity rather than a convention,
 * for exactly the reason `Bot Chat` is: it is the only field a listing carries
 * that two clients can agree on without a shadow index.
 *
 * Four things about it are deliberate, and each is a decision somebody could
 * have made differently:
 *
 *  - **It is created with `parent_session_id` = the canonical chat.** Upstream
 *    keeps the parent on the row, so the private chat reads as what it is — a
 *    conversation that grew out of the bot's own — rather than as an unrelated
 *    session that happens to share a profile.
 *  - **It is never hidden.** `hidden` is what marks the ONE canonical row
 *    upstream guards, and a second hidden session under another title would be
 *    an invisible chat no other client could show the reader. Theirs is listed,
 *    on the Conversations page, under its own name.
 *  - **It needs a stable identity and asks for nothing less.** With no user id
 *    there is no title to write, so there is no private chat and no switch to
 *    offer. That is the rule ADR-0016's amendment already follows for the
 *    app-wide settings key: writing somebody's conversation under a name the
 *    gateway never agreed to is worse than writing none.
 *  - **The lookup fails CLOSED.** A `session.list` that errored is not a person
 *    without a chat, and treating it as one is how a private conversation gets
 *    forked in two.
 *
 * Pure except for the two gateway calls, so every rule above is testable
 * without a socket.
 */
import type { SessionListRow } from '@hermes/shared/gateway-contract'

import type { ChatGateway } from '../../gateway/link'
import type { BotCanonicalSession } from '../../store/bots'
import { PROFILE_SESSION_LIST_LIMIT, SESSION_COLUMNS } from '../bots/bots-controller'
import { isOwnChatTitle } from '../sessions/session-model'

/**
 * What a private chat's title starts with.
 *
 * The separator is the same ` · ` the retired conversations and the branches
 * use, so the generated names read as one family rather than three conventions.
 */
export const USER_CHAT_TITLE_PREFIX = 'Chat'

/** `Chat · ` — the whole lead, which is what a title test compares against. */
export const USER_CHAT_TITLE_LEAD = `${USER_CHAT_TITLE_PREFIX} · `

/**
 * How much of a person's name survives into the title.
 *
 * A session title is a registry key here, and one nobody can read on a row is
 * not doing its job. The cut is on a word boundary for the same reason
 * `branchTitle` cuts on one.
 */
export const USER_CHAT_TITLE_MAX = 48

/** Which of a bot's two chats a reader has asked for. */
export type ChatChoice = 'shared' | 'mine'

/** The gateway's own idea of who is holding this device. */
export interface ChatIdentity {
  /** `/api/auth/me`'s `user_id`, or `owner` on a session-token gateway. */
  userId: string
  /** `/api/auth/me`'s `display_name`. Often empty; the id then stands in. */
  displayName: string
}

const collapse = (value: unknown): string => (typeof value === 'string' ? value : '').replace(/\s+/gu, ' ').trim()

/**
 * The title this person's private chat carries on every bot.
 *
 * The display name when the gateway gave one, the user id otherwise — in that
 * order and no other, because the id is the thing guaranteed to exist and the
 * name is the thing a reader recognises.
 *
 * An empty answer means there is no identity to name, and every caller reads it
 * as "this gateway offers no private chat".
 */
export function userChatTitle(identity: ChatIdentity | null | undefined): string {
  const id = collapse(identity?.userId)

  if (!id) {
    return ''
  }

  const shown = collapse(identity?.displayName) || id

  return `${USER_CHAT_TITLE_LEAD}${shown.length > USER_CHAT_TITLE_MAX ? cutToWord(shown) : shown}`
}

function cutToWord(value: string): string {
  let out = ''

  for (const word of value.split(' ').filter(Boolean)) {
    const next = out ? `${out} ${word}` : word

    if (next.length > USER_CHAT_TITLE_MAX) {
      break
    }

    out = next
  }

  // One word longer than the whole budget: take the budget. A cut name still
  // names somebody; the bare lead names everybody.
  return out || value.slice(0, USER_CHAT_TITLE_MAX)
}

/** Is this the title `userChatTitle` writes for SOMEBODY — anybody? */
export function isUserChatTitle(title: unknown): boolean {
  return collapse(title).startsWith(USER_CHAT_TITLE_LEAD)
}

/**
 * Whether this gateway can offer a private chat at all.
 *
 * True exactly when there is a user id to write a title from. An anonymous
 * session-token gateway with no owner identity answers false, the switch is
 * never drawn, and nothing about that deployment changes.
 */
export function canHaveUserChat(identity: ChatIdentity | null | undefined): boolean {
  return userChatTitle(identity).length > 0
}

export interface ResolveUserChatInput {
  gateway: ChatGateway
  profile: string
  title: string
  /** The canonical chat this one succeeds, for `parent_session_id`. */
  parentSessionId?: string
}

/**
 * This person's chat on this bot, resolved the way the canonical one is.
 *
 * Three steps, in this order and no other — the same three
 * `BotsController.runResolution` runs, for the same reasons:
 *
 *  1. `session.list {profile, title, include_hidden: true}`, an indexed
 *     exact-title lookup rather than a recency window, because a busy profile
 *     pushes anything out of a window.
 *  2. The lookup AGAIN before minting. Between the two, the same person on
 *     another device may have created it, and minting on a stale empty answer
 *     forks the conversation.
 *  3. `session.create`, visible, following the profile's configuration, with
 *     the canonical chat as its parent.
 *
 * `include_hidden` is on even though this chat is never hidden: it makes the
 * listing complete, and a chat some other client hid would otherwise be
 * invisible here and minted a second time.
 */
export async function resolveUserChat(input: ResolveUserChatInput): Promise<BotCanonicalSession> {
  const found = await lookupUserChat(input)

  if (found) {
    return found
  }

  const second = await lookupUserChat(input)

  if (second) {
    return second
  }

  const created = await input.gateway.request('session.create', {
    profile: input.profile,
    title: input.title,
    // NOT hidden. `hidden` is what marks the one canonical row upstream guards,
    // and a hidden chat under another title is one no other client can show.
    hidden: false,
    source: 'hermie',
    cols: SESSION_COLUMNS,
    // The same flag the canonical chat is minted with: the chat follows the
    // profile's current model rather than pinning the one it was born on.
    follow_profile_config: true,
    ...(input.parentSessionId ? { parent_session_id: input.parentSessionId } : {})
  })

  const storedId = created?.stored_session_id || created?.session_id || ''

  if (!storedId) {
    throw new Error(`The gateway created a chat for ${input.profile} without returning its id.`)
  }

  return { id: storedId, resolvedId: storedId, preview: '', lastActive: 0, messageCount: 0 }
}

/** One exact-title lookup. Throws rather than answering "no chat" on failure. */
export async function lookupUserChat(input: ResolveUserChatInput): Promise<BotCanonicalSession | null> {
  let rows: SessionListRow[]

  try {
    const result = await input.gateway.request('session.list', {
      profile: input.profile,
      title: input.title,
      limit: PROFILE_SESSION_LIST_LIMIT,
      include_hidden: true
    })

    rows = result?.sessions ?? []
  } catch (error) {
    // FAIL CLOSED, exactly as `lookupCanonical` does. A lookup that errored is
    // not a person without a chat, and reading it as one mints a second copy of
    // a conversation that already exists.
    throw new Error(
      `Could not check ${input.profile}'s chat registry (${
        error instanceof Error ? error.message : String(error)
      }) — not starting a new chat.`
    )
  }

  return sessionOfRow(rows.find(row => collapse(row.title) === input.title))
}

function sessionOfRow(match: SessionListRow | undefined): BotCanonicalSession | null {
  if (!match?.id) {
    return null
  }

  return {
    id: match.id,
    resolvedId: match.resolved_id || match.id,
    preview: typeof match.preview === 'string' ? match.preview : '',
    lastActive: typeof match.started_at === 'number' ? match.started_at : 0,
    messageCount: typeof match.message_count === 'number' ? match.message_count : 0
  }
}

/**
 * One of the reader's own chats on this bot, by the title it carries — the
 * lookup a legacy `myChats` entry resolves through (sub-chats).
 *
 * The same exact-title lookup `lookupUserChat` runs, under the name the
 * sub-chats code reads it by: a legacy entry means "the bare-lead chat", and
 * the bare lead is a title. Lookup only. Nothing on the sub-chats side mints on
 * a miss; only "New chat" creates.
 */
export function lookupOwnChatByTitle(input: ResolveUserChatInput): Promise<BotCanonicalSession | null> {
  return lookupUserChat(input)
}

export interface LookupOwnChatByIdInput {
  gateway: ChatGateway
  profile: string
  /** The lead this reader's chats carry, `Chat · <their name>`. */
  lead: string
  /** The STORED id the reader's memory names. */
  storedId: string
}

/**
 * One of the reader's own chats on this bot, by the stored id a device
 * remembered for it (`chat-layout.current`).
 *
 * `session.list` has no id filter, so this is one profile listing and a scan.
 * A row only counts while it still wears this reader's title family: an id is
 * an address, and an address that now names somebody else's chat — or the
 * group chat, after an adopt — is not the reader's chat any more.
 *
 * Answers `null` when the listing does not hold it (deleted, or renamed out of
 * the family) and THROWS when the listing failed. The two are kept apart
 * because the caller forgets a remembered id on the first and must not on the
 * second: a gateway that is restarting has not deleted anybody's chat.
 */
export async function lookupOwnChatById(input: LookupOwnChatByIdInput): Promise<BotCanonicalSession | null> {
  let rows: SessionListRow[]

  try {
    const result = await input.gateway.request('session.list', {
      profile: input.profile,
      limit: PROFILE_SESSION_LIST_LIMIT,
      include_hidden: true
    })

    rows = result?.sessions ?? []
  } catch (error) {
    throw new Error(
      `Could not list ${input.profile}'s conversations (${error instanceof Error ? error.message : String(error)}).`
    )
  }

  return sessionOfRow(
    rows.find(
      row => (row.id === input.storedId || row.resolved_id === input.storedId) && isOwnChatTitle(row.title, input.lead)
    )
  )
}
