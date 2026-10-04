/**
 * Putting one of the reader's own turns back in the composer.
 *
 * The decision is the whole of it, so it lives here with a suite rather than
 * inside a click handler in the screen: which turn may be put back, and what the
 * field holds afterwards.
 *
 * Ported from the Expo app's `editResend` (`features/chats/ChatScreen.tsx`,
 * `chat-ui/message-menu.ts`), which has no gateway call of its own and neither
 * does this: **there is no edit RPC.** The turn already in the conversation is
 * left exactly where it is, and sending the field starts a NEW turn from the
 * same words (`ChatController.send`), which is why the menu line says "and
 * resend" and not "Edit". The attachment REFERENCES travel with the words, not
 * the files: a reference is what the turn holds and what the gateway
 * understands, and the bytes are long gone from this page.
 *
 * Two differences from the Expo app, both deliberate:
 *
 *  - **Only the newest turn.** Expo offers the line on every turn of the
 *    reader's own. Here it is the newest one: it is the only one whose reply
 *    the reader can still see being asked for again, and a turn three
 *    exchanges back resent from the bottom reads as a new question rather than
 *    a correction.
 *  - **A draft is never thrown away.** Expo replaces the draft. The web
 *    composer's own "Edit" on a queued message (`Composer.tsx`) puts the words
 *    ahead of what is typed, and so does this: the words in the field are the
 *    reader's, not ours to lose.
 */
import type { TranscriptItem } from '@hermie/transcript'

import { isOwnPrompt, newestPrompt, type RegenerateSource } from './regenerate'

/**
 * The reader's newest turn, when it is theirs to put back: its id, or `null`.
 *
 * In the group chat a colleague's newest turn is `null`, and an older turn of
 * the reader's own is deliberately not walked back to: that would resend a
 * sentence that answers a different question (the rule `regenerateTargetIsOwn`
 * holds for Regenerate, HERM-83). Outside the group chat, before the reader's
 * own identity has answered, or on a row with no author, every turn is theirs.
 */
export function editResendTarget(
  items: readonly { item: TranscriptItem }[],
  source: Pick<RegenerateSource, 'groupChat' | 'ownAuthorId'>
): string | null {
  const item = newestPrompt(items)

  return item && isOwnPrompt(item, source) ? item.id : null
}

/** What a turn is, as text for the field: its words, then its attachments' references on the line after. */
export function editResendText(text: string, attachments: readonly string[]): string {
  return attachments.length ? `${text}\n${attachments.join(' ')}`.trim() : text
}

/** The field after the turn is put back: the turn first, and whatever was already typed after it, on its own line. */
export function mergeIntoDraft(current: string, turn: string): string {
  return current.trim() === '' ? turn : `${turn}\n${current}`
}
