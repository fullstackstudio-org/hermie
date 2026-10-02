/**
 * What one bot's bead says, as a pure function.
 *
 * Four states and one precedence order, in one place, because the chat list and
 * the chat header have to agree: a row that says "Working…" above a header that
 * says "Online" is two bugs that look like one.
 *
 * The order is not the order the states are defined in — it is the order of how
 * badly each one wants the reader:
 *
 *  1. **Offline** first, and unconditionally. The gateway is unreachable or the
 *     bot has no session, and nothing else is knowable: a "needs input" bead on
 *     a chat you cannot answer is a promise the app cannot keep.
 *  2. **Needs input** next. An approval or a clarify is waiting on a person, and
 *     it is the only state in the app that animates.
 *  3. **Working**, from the roster's running signal. Static — a bot being busy
 *     is information, not a request.
 *  4. **Online** otherwise: connected, attached, idle.
 *
 * Nothing here reads a store or a clock, so the whole table is testable as a
 * table.
 */
import type { PresenceState } from '../../ui/tokens'

export type { PresenceState }

export interface PresenceInput {
  /** The gateway socket is up and usable (`status === 'ready'`). */
  gatewayReady: boolean
  /** This bot's canonical chat is resolved, so there is a session to talk to. */
  sessionAttached: boolean
  /** A turn is running: `session.active_list` said so, or one is streaming. */
  working: boolean
  /** An approval or clarify request is open and unanswered. */
  needsInput: boolean
  /** The canonical chat's `last_active`, in unix SECONDS, when it is known. */
  lastActive?: number | undefined
}

export interface Presence {
  state: PresenceState
  /**
   * When this bot was last heard from, in unix seconds — set only while it is
   * offline and only when the roster gave us a number. The row renders it as
   * `Offline · last seen 21:09`; without it the row just says `Offline`.
   */
  lastSeenAt?: number
}

export function presenceOf(input: PresenceInput): Presence {
  if (!input.gatewayReady || !input.sessionAttached) {
    return input.lastActive && input.lastActive > 0
      ? { state: 'offline', lastSeenAt: input.lastActive }
      : { state: 'offline' }
  }

  if (input.needsInput) {
    return { state: 'needsInput' }
  }

  if (input.working) {
    return { state: 'working' }
  }

  return { state: 'online' }
}
