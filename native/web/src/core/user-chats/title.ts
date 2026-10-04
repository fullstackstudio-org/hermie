/**
 * The title a person's own chat carries, and who it is written for: the part of `user-chat.ts` the first load
 * needs (is there an own chat to offer, and what is it called), kept apart from the part that talks to the
 * gateway (`user-chat.ts`, `user-chat-directory.ts`, a chunk of their own, fetched the first time a chat is
 * resolved). Ported from the Expo app's `features/user-chats/user-chat.ts`, unchanged.
 */

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

export const collapse = (value: unknown): string =>
  (typeof value === 'string' ? value : '').replace(/\s+/gu, ' ').trim()

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
