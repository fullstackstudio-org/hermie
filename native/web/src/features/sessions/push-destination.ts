/**
 * Where a notification tap lands, and whether it may answer anything there
 * (ADR-0017, amendment of 2026-09-22: "a tap names its conversation").
 *
 * A payload carries the bot, and may carry `sessionId` and `sessionKind`
 * (`canonical` | `branch` | `other`). `branch` and `other` open the
 * conversation in the read-only viewer (`#/chat/<bot>/s/<id>`); `canonical`, an
 * absent kind and a session id that is the bot's own canonical one all open the
 * chat (`#/chat/<bot>`), which is what every notification did before this. Where
 * the kind is absent but an id is present, it is compared with the ids the
 * roster holds for the bot's canonical chat (stored and resolved); where the
 * roster holds none yet (a cold start from a notification), the chat opens: an
 * id that cannot be placed is not a reason to guess.
 *
 * **A tap into a non-canonical conversation opens it and answers nothing.** An
 * Allow has to be re-validated against `approval.pending` for the session that
 * asked, and that is not the session the bot's chat resumes; so the reader lands
 * there and answers in place. `answersInPlace` is false for it, and the viewer
 * route itself sends nothing: it reads, marks nothing read and has no composer
 * (`use-open-chat.ts`, `ChatScreen`).
 *
 * Pure; the notifications of W-25 call it. Ported from the Expo app's
 * `pushDestinationOf` (`src/features/push/actions.ts`) and the Apple apps'
 * `PushTapRules.destination` and `answersInPlace`, returning a route of this
 * client's router rather than a destination object.
 */
import type { Route } from '../shell/router'

/** What the notifier called the session; empty when it did not say or said something this build does not know. */
export type PushSessionKind = 'canonical' | 'branch' | 'other' | ''

const SESSION_KINDS: readonly string[] = ['canonical', 'branch', 'other']

/** The part of a tap that decides where it lands. */
export interface PushTapTarget {
  bot: string
  /** The conversation it names (the plugin's `sessionId`, Hermie Web's `session`); empty when it names none. */
  sessionId: string
  sessionKind: PushSessionKind
}

/** A kind read from a payload: one this build knows, or none, so an unknown kind falls through to the id comparison. */
export function sessionKindOf(value: unknown): PushSessionKind {
  const kind = typeof value === 'string' ? value.trim() : ''

  return SESSION_KINDS.includes(kind) ? (kind as PushSessionKind) : ''
}

/**
 * The route a tap opens.
 *
 * @param canonicalIds every id the roster knows the bot's canonical chat by
 *   (the stored id and the resolved one); empty while the roster is unread.
 */
export function pushRouteOf(tap: PushTapTarget, canonicalIds: readonly string[]): Route {
  const chat: Route = { name: 'chat', bot: tap.bot }
  const sessionId = tap.sessionId.trim()

  if (tap.sessionKind === 'canonical' || !sessionId) {
    return chat
  }

  if (tap.sessionKind === 'branch' || tap.sessionKind === 'other') {
    return { name: 'chat', bot: tap.bot, session: sessionId }
  }

  // The kind is absent. An id nothing can be compared against says nothing, so it is not a reason to leave the chat.
  if (canonicalIds.length === 0 || canonicalIds.includes(sessionId)) {
    return chat
  }

  return { name: 'chat', bot: tap.bot, session: sessionId }
}

/**
 * Whether a notification's action (Allow, Deny) may be answered from the tap at
 * all: only where the tap lands in the bot's own chat, and never for a
 * conversation the notifier called a branch or another conversation (the
 * Apple apps' `answersInPlace` and their "the destination is the chat" guard,
 * together). The other conditions (the request still open for this bot and
 * session, a choice the gateway offers) are the caller's.
 */
export function answersInPlace(tap: PushTapTarget, canonicalIds: readonly string[]): boolean {
  if (tap.sessionKind === 'branch' || tap.sessionKind === 'other') {
    return false
  }

  const route = pushRouteOf(tap, canonicalIds)

  return route.name === 'chat' && route.session === undefined
}
