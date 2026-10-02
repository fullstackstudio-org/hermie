/**
 * What a tap on a notification is allowed to do.
 *
 * ADR-0017 is explicit, and this file is where that sentence becomes code:
 *
 * > Tapping one does **not** answer anything by itself: the app opens, connects
 * > to the gateway, re-reads the open requests, and responds only if that
 * > request is still open and still says what the notification said it did. A
 * > notification is a hint that something happened, never an instruction.
 *
 * So a payload is never trusted for anything except *which chat to look in*.
 * Everything about the decision — that there is a request, that it is the one
 * named, that it is still open, which answers it will take — comes back from the
 * gateway's own `approval.pending`, and the payload is only allowed to select a
 * row out of that answer. A forged "Allow `rm -rf /`" therefore opens a chat and
 * finds nothing, which is the failure mode the ADR designed for.
 *
 * Everything here is pure. The round trip lives in `push-sync.ts`; what a given
 * pair of (payload, gateway answer) means is a table in a test.
 */
import { isGatewayKey } from '@hermie/gateway-client'

import { PUSH_ACTION_ALLOW, PUSH_ACTION_DENY, PUSH_TYPES_WITH_ACTIONS, type PushResponse } from './platform-contract'

/** One row of `approval.pending`, as far as this needs to read it. */
export interface OpenApproval {
  request_id?: string | null
  choices?: string[] | null
  [key: string]: unknown
}

/**
 * Which conversation a payload says it is about.
 *
 * The gateway's word, not ours. It reads the session's title — `Bot Chat` is
 * the canonical one, `Branch` or `Branch · …` is a branch, anything else is
 * `other` — and says NOTHING at all when it cannot read one. So an empty kind
 * here is "the notifier did not say", which is also what every notification
 * sent before this field existed looks like, and it is read the same way.
 *
 * `other` rather than the app's own `past`, because `past` is "everything else
 * this app decided to list" and a gateway cannot know that. What it can say is
 * "not the canonical chat and not a branch".
 */
export type PushSessionKind = 'canonical' | 'branch' | 'other' | ''

const SESSION_KINDS: readonly string[] = ['canonical', 'branch', 'other']

/** What the app should do once it has asked the gateway. */
export type PushIntent =
  { kind: 'open-chat'; bot: string } | { kind: 'respond'; bot: string; requestId: string; choice: string }

/** What a tap asked for, before the gateway has been consulted. */
export interface PushTap {
  bot: string
  /** Empty unless the payload named one; an action without one cannot answer. */
  requestId: string
  action: 'allow' | 'deny' | 'open'
  /**
   * Which gateway sent it, as `gatewayKeyOf` its origin. Empty when the payload
   * carried none, which is every notification from a notifier older than this.
   *
   * A key is a LOOKUP, exactly like the bot name beside it: it can only select
   * a gateway the owner has already configured on this device. A key nothing
   * matches leaves the app where it is, which is the same answer every other
   * unresolvable field here gets.
   */
  gatewayKey: string
  /**
   * The session the notified thing happened in, or empty.
   *
   * A bot used to have exactly one conversation, so naming the bot named the
   * destination. It branches now, and `/new` retires the one it puts away, so a
   * turn can happen in a session nobody is looking at — and a tap that always
   * opened the canonical chat would land on a transcript with nothing in it
   * about the thing that just buzzed.
   *
   * Like the bot name beside it, this is a LOOKUP and never an instruction:
   * every screen it can reach resolves the id against the gateway before it
   * paints anything.
   */
  sessionId: string
  /** What the notifier called that session. Empty when it did not say. */
  sessionKind: PushSessionKind
}

/** Where a tap should land. */
export type PushDestination =
  /** The bot's own chat — what every tap did before conversations existed. */
  | { kind: 'chat' }
  /** One named conversation of that bot, through R4b's viewer. */
  | { kind: 'conversation'; sessionId: string }

export interface DestinationOptions {
  tap: PushTap
  /**
   * Every id this app currently knows the bot's canonical chat by.
   *
   * Both of them, in practice: the STORED id a listing hands out and the
   * RESOLVED id a live session is stamped with are different strings for the
   * same conversation, and a notifier may carry either. Empty where the roster
   * has not been read yet, which is a real state on a cold start from a
   * notification and is handled rather than guessed at.
   */
  canonicalIds: readonly string[]
}

/**
 * The conversation a tap opens.
 *
 * Three inputs and one rule, and the rule errs towards the chat every time,
 * because the chat is where the app can always say something true:
 *
 *  - the notifier SAID which kind — `branch` and `other` open that
 *    conversation, `canonical` opens the chat. Its answer wins outright: it
 *    read the session's own title, and this app second-guessing it from an id
 *    is how a tap lands on the wrong screen.
 *  - the notifier said nothing, but named a session this app can compare — an
 *    id that is neither of the bot's canonical ids is some other conversation,
 *    so open it.
 *  - anything else — no id, no canonical id to compare against, an unreadable
 *    kind — opens the chat, which is exactly what every notification did before
 *    any of these fields existed.
 */
export function pushDestinationOf(options: DestinationOptions): PushDestination {
  const { tap, canonicalIds } = options
  const chat: PushDestination = { kind: 'chat' }

  if (tap.sessionKind === 'canonical') {
    return chat
  }

  if (!tap.sessionId) {
    return chat
  }

  if (tap.sessionKind === 'branch' || tap.sessionKind === 'other') {
    return { kind: 'conversation', sessionId: tap.sessionId }
  }

  // The kind is absent. An id nothing can be compared against says nothing, so
  // it is not a reason to leave the chat.
  if (!canonicalIds.length || canonicalIds.includes(tap.sessionId)) {
    return chat
  }

  return { kind: 'conversation', sessionId: tap.sessionId }
}

const stringOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * Read a tap, or nothing.
 *
 * A payload with no bot in it is unusable: every entry point in this app resolves
 * against the roster, and "open some chat" is not a destination. That is the one
 * field a notification is trusted for, and even it is only a lookup key.
 */
export function pushTapOf(response: PushResponse): PushTap | null {
  const bot = stringOf(response.data.bot)

  if (!bot) {
    return null
  }

  const action =
    response.actionIdentifier === PUSH_ACTION_ALLOW
      ? 'allow'
      : response.actionIdentifier === PUSH_ACTION_DENY
        ? 'deny'
        : 'open'

  // An Allow or Deny that names no request is a button with nothing to press.
  // It degrades to opening the chat rather than answering the oldest question,
  // which is the kind of guess that answers the wrong one.
  const requestId = stringOf(response.data.requestId)
  const key = stringOf(response.data.gatewayKey)
  const kind = stringOf(response.data.sessionKind)

  return {
    bot,
    requestId,
    action: action !== 'open' && !requestId ? 'open' : action,
    // Checked rather than trusted: anything that is not the shape this project
    // produces is read as no key at all, so a payload cannot make the app
    // search its list for something that was never a key.
    gatewayKey: isGatewayKey(key) ? key : '',
    /*
      `sessionId` is the plugin's spelling and `session` is what Hermie Web's
      own daemon has always written. Both are read, because both notifiers are
      supported and a payload from the older one is not a payload with no
      session in it.
    */
    sessionId: stringOf(response.data.sessionId) || stringOf(response.data.session),
    // A kind this build does not recognise is read as no kind at all, which
    // falls through to the id comparison rather than to a guess.
    sessionKind: SESSION_KINDS.includes(kind) ? (kind as PushSessionKind) : ''
  }
}

/**
 * The choice to send for Allow, out of the ones the gateway is offering.
 *
 * `once` if it is on the list, because a button on a lock screen is the least
 * considered decision the reader will make all day and it should be the
 * narrowest one — never `session`, and never `always`, whatever the queue
 * entry allows. If the gateway offers neither `once` nor anything else this
 * recognises, nothing is sent.
 */
export function allowChoiceOf(approval: OpenApproval): string | null {
  const choices = Array.isArray(approval.choices) ? approval.choices.filter(choice => typeof choice === 'string') : []

  return choices.includes('once') ? 'once' : null
}

/** The choice to send for Deny, on the same rule. */
export function denyChoiceOf(approval: OpenApproval): string | null {
  const choices = Array.isArray(approval.choices) ? approval.choices.filter(choice => typeof choice === 'string') : []

  return choices.includes('deny') ? 'deny' : null
}

export interface ResolveOptions {
  tap: PushTap
  /** What `approval.pending` answered for this bot, just now. */
  pending: readonly OpenApproval[]
}

/**
 * The tap, decided against what the gateway currently says is open.
 *
 * Every path that is not an exact match on a still-open request falls through to
 * opening the chat, which is both the safe answer and the useful one: a question
 * that was answered on another device, a cron that was deleted, a bot that no
 * longer exists all leave the reader looking at the conversation, where the app
 * can say what is actually true.
 */
export function resolvePushTap(options: ResolveOptions): PushIntent {
  const { tap, pending } = options
  const openChat: PushIntent = { kind: 'open-chat', bot: tap.bot }

  if (tap.action === 'open' || !tap.requestId) {
    return openChat
  }

  const match = pending.find(approval => stringOf(approval.request_id) === tap.requestId)

  if (!match) {
    // Answered, expired, or never real. Either way there is nothing to respond
    // to and the chat is where the reader finds out which.
    return openChat
  }

  const choice = tap.action === 'allow' ? allowChoiceOf(match) : denyChoiceOf(match)

  return choice ? { kind: 'respond', bot: tap.bot, requestId: tap.requestId, choice } : openChat
}

/** True when this payload is the kind that would have carried buttons. */
export const wantsActions = (response: PushResponse): boolean =>
  PUSH_TYPES_WITH_ACTIONS.includes(stringOf(response.data.type))
