/**
 * What a chat says about its connection, and WHERE it says it.
 *
 * This is the whole of the decision, kept away from the screen because the
 * screen is where it went wrong: the connection notice used to be a bar at the
 * top of the transcript pane, and the transcript pane's top is UNDER the
 * floating header. A reader saw "Waiting for the g…" with the rest of the
 * sentence behind the contact pill, because a `Banner` above a list that the
 * chrome floats over has nowhere to be.
 *
 * Two placements replace it, and which one applies is decided by one thing: is
 * there anything on screen already?
 *
 *  - **Nothing on screen** — a chat that has never been opened on this device,
 *    or whose cache was dropped. There is no transcript to interrupt, so the
 *    notice IS the screen: a centred plate with the bot on it, the way every
 *    messenger draws a conversation it cannot show yet.
 *  - **A cached transcript** — the reader can read. The pane stays exactly as
 *    it was and the notice shrinks to a pill above the composer, with the
 *    header's own subtitle carrying the state word. Nothing covers a message.
 *
 * `blocked` is the one case that produces neither. A refusal the reader has to
 * act on — signed out, an incompatible gateway, a host guard — is not a wait,
 * and it has its own banner with its own button. Two notices about one
 * connection is how a screen stops being read at all.
 */
import type { ConnectionStatus, GatewayError } from '@hermie/gateway-client'

/** Which of the three words the connection has earned. */
export type ConnectionPhase = 'connecting' | 'reconnecting' | 'offline'

export interface ConnectionNotice {
  /** `none` is the common case: a live connection says nothing at all. */
  kind: 'none' | 'empty' | 'pill'
  phase: ConnectionPhase
  /**
   * Offer the reader a dial of their own.
   *
   * Deliberately NOT offered immediately. The ladder's first rungs are hundreds
   * of milliseconds apart, so a button in the first second competes with a
   * reconnect that is already happening and teaches the reader that pressing it
   * is what fixes this. After five seconds the ladder is far enough up that a
   * reset to the bottom is worth something.
   */
  retry: boolean
  /**
   * What to say INSTEAD of the phase word, when the phase word would mislead.
   *
   * Empty almost always, and that is the point: "Reconnecting…" is the right
   * thing to read while a gateway is briefly away. It is the wrong thing to
   * read when the address answered — with a 405 from a proxy, say — because
   * then nothing is coming back however long the reader waits. See `wording`.
   */
  message: string
  /** A second line, when there is one and the placement has room for it. */
  hint: string
}

/** How long a reconnect runs before the reader is offered a dial of their own. */
export const RETRY_OFFER_MS = 5_000

const NONE: ConnectionNotice = { kind: 'none', phase: 'connecting', retry: false, message: '', hint: '' }

/**
 * A status that is not `ready` but is also not a wait.
 *
 * `paused` is the app in the background — the connection stopped on purpose and
 * nothing is wrong. Drawing "Reconnecting…" over a chat the reader is about to
 * come back to means the first frame after a resume is a lie about the last
 * one.
 */
function phaseFor(status: ConnectionStatus): ConnectionPhase {
  if (status === 'offline') {
    return 'offline'
  }

  if (status === 'reconnecting') {
    return 'reconnecting'
  }

  return 'connecting'
}

/**
 * Whether this reconnect has something to say beyond the phase word.
 *
 * Only `protocol` earns it, and only while reconnecting. That kind means the
 * address gave a well-formed HTTP answer that no gateway would give — the
 * measured case is a reverse proxy in front of an unrelated site answering the
 * ticket mint with a 405 — and "Reconnecting…" over that is the app waiting for
 * something that is not going to happen. Every other kind either resolves on
 * its own (a drop, a timeout) or already has a banner of its own, which
 * `blocked` above stands down for.
 *
 * The Retry offer is deliberately kept. The reader may have just fixed the
 * address or joined the network, and the ladder is now minutes long by design.
 */
function wording(phase: ConnectionPhase, error: GatewayError | null): { message: string; hint: string } {
  if (phase !== 'reconnecting' || error?.kind !== 'protocol') {
    return { message: '', hint: '' }
  }

  return { message: error.message, hint: error.hint ?? '' }
}

export function connectionNotice(input: {
  status: ConnectionStatus
  /** Is there anything in the pane? Rows the reader can read, cached or live. */
  hasTranscript: boolean
  /** A refusal with its own banner; see the note above. */
  blocked: boolean
  /** How long this connection has been away from `ready`. */
  waitingMs: number
  /** The connection's own account of why it is not up, when it has one. */
  lastError?: GatewayError | null
}): ConnectionNotice {
  if (input.status === 'ready' || input.status === 'paused' || input.blocked) {
    return NONE
  }

  const phase = phaseFor(input.status)

  return {
    kind: input.hasTranscript ? 'pill' : 'empty',
    phase,
    retry: phase === 'reconnecting' && input.waitingMs > RETRY_OFFER_MS,
    ...wording(phase, input.lastError ?? null)
  }
}
