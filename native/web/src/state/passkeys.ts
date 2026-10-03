/**
 * What the page knows about passkeys on its gateway: the `confirm` requests at
 * level `passkey` and where each stands, the notices a person must see, the
 * signed-in user's credentials, and what the connection advertised.
 *
 * Written by the passkey model (`core/passkey/model.ts`) and nothing else; read
 * by the request layer (the confirm sheet), the request queue
 * (`state/requests.ts`) and the passkeys settings page. A vanilla zustand store,
 * like the others in this directory.
 *
 * The phases and the ways a confirmation ends are the native apps'
 * (`HermieCore/Passkey/PasskeyTypes.swift`), so the two clients say the same thing
 * in the same situation.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'

import type { PasskeyCredentialInfo, PasskeyStatus } from '../core/passkey/client'

/** Where one confirmation stands. */
export type ConfirmPhase =
  /** On screen; Confirm and Decline are offered. */
  | { kind: 'waiting' }
  /** The browser's passkey sheet is up. */
  | { kind: 'signing' }
  /** The answer is on its way (`request.answer`). */
  | { kind: 'sending' }
  /** The gateway refused the assertion (4034, `reason` as it gave it). The request stays open: try again. */
  | { kind: 'refused'; reason: string }
  /**
   * The answer did not get a reply (no socket, a timeout), or the browser failed; try again. When the
   * confirmation's `answerMayHaveArrived` is set, an assertion may have reached the gateway all the same, and
   * the sheet says so instead of "not sent".
   */
  | { kind: 'not_sent'; message: string }
  /**
   * `request.answer` said `ok`: the assertion was received and is valid. NOT "confirmed": the
   * gateway commits it next, and says `request.cancel verification_failed` if that fails.
   */
  | { kind: 'received' }
  /** The decline went through. */
  | { kind: 'declined' }
  /** It is over without this page's answer counting. */
  | { kind: 'ended'; end: ConfirmEnd }

/** How a confirmation ended other than by this page's answer. */
export type ConfirmEnd =
  /** `request.cancel timeout`. */
  | { kind: 'timed_out' }
  /** `request.cancel resolved` before this page answered: another client did. */
  | { kind: 'answered_elsewhere' }
  /** The fifth refused answer settled it (`too_many_attempts`). */
  | { kind: 'too_many_attempts' }
  /** The answer was received but the gateway could not commit it (`verification_failed`): NOT confirmed. */
  | { kind: 'verification_failed' }
  /** `request.answer` said 4033: this connection may not answer it. */
  | { kind: 'not_allowed' }
  /** This browser cannot run the ceremony; the 4040 `reason` it sent. */
  | { kind: 'unavailable'; reason: string }
  /** Withdrawn for another reason (`request.cancel`'s, as it came). */
  | { kind: 'withdrawn'; reason: string }
  /**
   * It ended without a definitive word after an assertion may have reached the gateway (a `request.answer`
   * carrying one got no reply): it may have been confirmed. Every ending that is not the gateway's
   * definitive verdict (`timed_out`, `answered_elsewhere`, `withdrawn`, `unavailable`, an answer the gateway
   * no longer takes) becomes this one, so the page never says "nothing was confirmed" when it may have been.
   */
  | { kind: 'outcome_unknown' }

/** Still waiting for this page to answer (or answering). */
export const isOpenPhase = (phase: ConfirmPhase): boolean =>
  phase.kind === 'waiting' ||
  phase.kind === 'signing' ||
  phase.kind === 'sending' ||
  phase.kind === 'refused' ||
  phase.kind === 'not_sent'

/** Confirm and Decline may be pressed. */
export const isActionablePhase = (phase: ConfirmPhase): boolean =>
  phase.kind === 'waiting' || phase.kind === 'refused' || phase.kind === 'not_sent'

/**
 * The gateway's deadline for this confirmation has passed on this page's clock (`now` in unix
 * seconds). A confirmation the gateway never told us was over (a socket that dropped while it
 * timed out) must not stay actionable for ever, so the clock ends it too.
 */
export const isExpired = (confirmation: Pick<PasskeyConfirmation, 'expiresAt'>, now: number): boolean =>
  confirmation.expiresAt !== null && confirmation.expiresAt <= now

/** One `confirm` at level `passkey`, as the sheet shows it. */
export interface PasskeyConfirmation {
  /** The server request's id. */
  id: string
  /** The frame's `params.session_id`: the chat it was raised in. */
  sessionId: string
  /**
   * The title, summary and detail exactly as the frame carried them: the only text the sheet
   * shows, and the value the challenge is computed from.
   */
  title: string
  summary: string
  detail: string | null
  /** The base URL the challenge commits to (the page's own, contract §3). */
  baseUrl: string
  /** The bound user's name, as the gateway gave it. */
  userName: string
  /** Unix seconds when the gateway gives up on it (`passkey.expires_at`), for the countdown. */
  expiresAt: number | null
  phase: ConfirmPhase
  /**
   * A `request.answer` carrying this confirmation's assertion failed without a reply from the gateway
   * (the socket closed, the call timed out): the assertion may have been delivered and accepted. Set once,
   * never cleared; a decline's failure does not set it.
   */
  answerMayHaveArrived: boolean
  /** Bumped on every change, so a list can tell an entry moved without comparing it. */
  version: number
  /** The person closed the sheet of a confirmation that had finished. */
  dismissed: boolean
}

/** Something the person should see that is not one confirmation: never a silent failure. */
export type PasskeyNoticeKind =
  /** The gateway presents another `gateway_id` than the one pinned on enrolment. */
  | { kind: 'gateway_id_mismatch' }
  /** The gateway presents a `gateway_id` pinned for another gateway in this browser. */
  | { kind: 'gateway_id_conflict' }
  /** A passkey request in a contract version this build does not speak. */
  | { kind: 'unsupported_version' }
  /** A passkey request listing no passkey of this site. */
  | { kind: 'no_credential' }
  /** A passkey request this build could not read (a field missing or malformed). */
  | { kind: 'malformed_request' }
  /** The gateway lists no base URL that is this page's address: every answer would be refused. */
  | { kind: 'base_url_not_listed' }
  /** A passkey was added to this account without this browser. */
  | { kind: 'credential_added'; name: string }
  /** A passkey was removed from this account without this browser. */
  | { kind: 'credential_revoked'; name: string }

export interface PasskeyNotice {
  id: number
  notice: PasskeyNoticeKind
  /** Unix seconds. */
  at: number
}

/** Why the level was, or was not, advertised on the current socket. */
export type AdvertisingVerdict =
  | { kind: 'advertised' }
  /** The gateway does not know the level, or speaks another version of it. */
  | { kind: 'not_offered' }
  /** The gateway knows the level and says it is off for this connection. */
  | { kind: 'unavailable'; reason: string }
  /** Not a secure context, no WebAuthn here, or a base URL with a path prefix. */
  | { kind: 'not_supported' }
  /** The gateway does not list this page's host as a web RP. */
  | { kind: 'rp_not_accepted' }
  /** The gateway's base URLs (`GET /api/auth/passkeys`) do not include this page's address. */
  | { kind: 'base_url_not_listed' }
  | { kind: 'gateway_id_mismatch' }
  | { kind: 'gateway_id_conflict' }

export interface PasskeyCapability {
  verdict: AdvertisingVerdict
  /** The levels the second `client.capabilities` accepted (empty without one). */
  accepted: readonly string[]
}

export interface PasskeysState {
  /** In arrival order; finished ones stay until the person closes them (the newest few are kept). */
  confirmations: readonly PasskeyConfirmation[]
  notices: readonly PasskeyNotice[]
  /** The last status read, `null` until one answered. */
  status: PasskeyStatus | null
  /** Why the last status read failed; `not_offered` on a gateway without the routes. */
  statusError: { kind: 'not_offered' | 'refused' | 'transport'; message: string } | null
  credentials: readonly PasskeyCredentialInfo[]
  /** The last run of the two capability calls on this connection. */
  capability: PasskeyCapability | null
  /** This browser can run a ceremony at all (secure context, WebAuthn present, no path prefix). */
  supported: boolean
  /** This browser holds a pin for this gateway's id (`device.passkey.pin@<base URL>`). */
  pinned: boolean
  /** The RP this page's ceremonies use (its hostname). */
  rpId: string
  reset(): void
}

const INITIAL = {
  confirmations: [] as readonly PasskeyConfirmation[],
  notices: [] as readonly PasskeyNotice[],
  status: null,
  statusError: null,
  credentials: [] as readonly PasskeyCredentialInfo[],
  capability: null,
  supported: false,
  pinned: false,
  rpId: ''
}

export function createPasskeysStore(): StoreApi<PasskeysState> {
  return createStore<PasskeysState>(set => ({
    ...INITIAL,
    reset: () => set({ ...INITIAL })
  }))
}

/** The page's store. */
export const passkeysStore: StoreApi<PasskeysState> = createPasskeysStore()

/** The confirmations the request layer shows: every open one, and finished ones nobody closed yet. */
export const visibleConfirmations = (state: Pick<PasskeysState, 'confirmations'>): PasskeyConfirmation[] =>
  state.confirmations.filter(confirmation => !confirmation.dismissed)
