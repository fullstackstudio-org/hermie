/**
 * Asking for the last reply again.
 *
 * Its own module because the DECISION is the whole of it and the decision has
 * three outcomes, only one of which is "send something": a running turn refuses,
 * a conversation with nothing to repeat refuses, and everything else takes one
 * of two roads. Inside a `useCallback` in the screen that is three branches
 * nothing can reach; out here it is a function with a suite.
 *
 * ## Two roads, and the catalogue chooses
 *
 * **`/retry` where the gateway has it.** It is the gateway's own command, it
 * knows what the turn was, and it re-runs it on that side — so the conversation
 * gains a reply rather than gaining a second copy of the prompt that produced
 * it. It goes down the ordinary slash path (`chat-controller.runSlash`), which
 * means it gets the same directive handling, the same notices and the same
 * failure reporting every other command gets.
 *
 * **The previous prompt again, where it does not.** An older gateway, or a
 * profile whose catalogue does not carry the command. Sending the prompt again
 * is what a reader would do by hand, and it is honest: there really are two
 * turns now, and the transcript says so. The alternative — doing nothing on a
 * gateway that cannot retry — is a menu line that silently fails.
 *
 * The catalogue is the same one the composer's autocomplete reads, and a
 * catalogue that has not arrived yet answers "no". That is the safe direction:
 * the fallback works everywhere, and `/retry` is an optimisation on it.
 */
import type { TranscriptItem, UserItem } from '@hermie/transcript'

/** The slice of `useChat` this needs, so a test does not have to build the rest. */
export interface RegenerateSource {
  /** Whether a turn is running right now. */
  turnActive: boolean
  /** The VISIBLE rows, newest last. */
  items: readonly { item: TranscriptItem }[]
  knowsSlashCommand: (name: string) => boolean
  runSlash: (command: string) => Promise<unknown>
  send: (text: string) => Promise<void>
  /**
   * Whether this is the canonical GROUP chat, never a personal sub-chat, a
   * branch or a retired conversation (HERM-83, D6) — `bound-conversation.ts`'s
   * `useGroupChat`, read by the screen and handed in here rather than
   * rediscovered. Absent (a personal chat, or a caller that predates this
   * field) is the safe default: every turn reads as the reader's own.
   */
  groupChat?: boolean
  /**
   * The reader's own identity, `<provider>:<user_id>` exactly as
   * `own-author.ts`'s `useOwnAuthorId` builds it — the same id a transcript
   * row's `author.id` is compared against. Absent, including before
   * `/api/auth/me` has answered, is the safe default: every turn reads as the
   * reader's own.
   */
  ownAuthorId?: string
}

export type RegenerateOutcome =
  /** `/retry` went to the gateway. */
  | { kind: 'retried' }
  /** The previous prompt was sent again, because the gateway has no `/retry`. */
  | { kind: 'resent'; text: string }
  /** A turn is running; nothing was sent. */
  | { kind: 'busy' }
  /** There is no prompt in this conversation to repeat. */
  | { kind: 'nothing' }

/** The command, spelled once, so the catalogue lookup and the call cannot drift. */
const RETRY = 'retry'

/** The newest `user` row with words in it, or `undefined`. */
function newestPrompt(items: readonly { item: TranscriptItem }[]): UserItem | undefined {
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at]?.item

    if (item?.kind === 'user' && item.text.trim()) {
      return item
    }
  }

  return undefined
}

/**
 * Is this turn something the reader can put back under their own name — their
 * own turn, or one no gateway attributed at all (HERM-83)?
 *
 * Mirrors `isOwnUserItem` in `chat-ui/TranscriptList.tsx` exactly, on the two
 * facts this module is handed instead of a whole `TranscriptContext`: outside
 * the group chat, before the reader's own identity has answered, or on a row
 * with no author, every turn reads as the reader's own — unchanged from
 * before `author` existed.
 */
function isOwnPrompt(item: UserItem, source: Pick<RegenerateSource, 'groupChat' | 'ownAuthorId'>): boolean {
  if (!source.groupChat || !source.ownAuthorId || !item.author) {
    return true
  }

  return item.author.id === source.ownAuthorId
}

/**
 * The newest of the reader's own turns.
 *
 * Which is the prompt the last reply answered — and deliberately not the newest
 * row of any kind: a conversation whose tail is a cron delivery or an inbound
 * bot message has nothing the reader asked for, and repeating one of those would
 * be repeating somebody else's words.
 *
 * In the group chat, also deliberately not an OLDER turn of the reader's own
 * (HERM-83): if the newest turn is a colleague's, the reply being regenerated
 * answered THAT, not whatever the reader last said before it. Resending an
 * older prompt of the reader's own would send an answer to the wrong
 * question, so this refuses — same as `regenerateTargetIsOwn`, which the
 * screen asks first to decide whether to offer the menu line at all.
 */
function lastPrompt(
  items: readonly { item: TranscriptItem }[],
  source: Pick<RegenerateSource, 'groupChat' | 'ownAuthorId'>
): string {
  const item = newestPrompt(items)

  return item && isOwnPrompt(item, source) ? item.text : ''
}

/**
 * Whether `Regenerate` is honest to offer on the newest reply at all.
 *
 * Two of the three outcomes say yes: no prompt behind it to repeat (the
 * "nothing" refusal in `regenerateLastTurn` covers that separately, and the
 * line still being drawn there is unchanged), or the newest prompt is the
 * reader's own or unattributed. `false` only for a colleague's newest turn in
 * the group chat (HERM-83) — the one case the line must be HIDDEN rather than
 * offered and then refused, because a reader who presses it would make a copy
 * of a colleague's words appear under their own name.
 */
export function regenerateTargetIsOwn(
  items: readonly { item: TranscriptItem }[],
  source: Pick<RegenerateSource, 'groupChat' | 'ownAuthorId'>
): boolean {
  const item = newestPrompt(items)

  return !item || isOwnPrompt(item, source)
}

/**
 * Run the last reply again, and say which road was taken.
 *
 * Never throws for a refusal — a refusal is an outcome the caller reports — but
 * it does let a gateway failure through, because that is the caller's banner and
 * not this function's business.
 */
export async function regenerateLastTurn(chat: RegenerateSource): Promise<RegenerateOutcome> {
  if (chat.turnActive) {
    return { kind: 'busy' }
  }

  if (chat.knowsSlashCommand(RETRY)) {
    await chat.runSlash(`/${RETRY}`)

    return { kind: 'retried' }
  }

  const text = lastPrompt(chat.items, chat)

  if (!text) {
    return { kind: 'nothing' }
  }

  await chat.send(text)

  return { kind: 'resent', text }
}
