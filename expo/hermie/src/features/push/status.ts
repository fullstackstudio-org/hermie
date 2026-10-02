/**
 * One sentence about whether this device is actually registered for push.
 *
 * The report that put this here: the owner's gateway held `hermie-app.push`
 * with a live heartbeat and `registrations: {}`. The app had been switched on,
 * was beating happily, and had never obtained a token — `obtainAddress`
 * swallowed every error and answered `null`, `enable` turned that into
 * `'unavailable'`, and the switch settled back with nothing said. From the
 * inside, on, and from the outside, absent.
 *
 * So the state is computed rather than felt, in one pure function with no React
 * and no platform in it, and Settings renders whatever it says. `granted` plus
 * an address is the only state that means notifications will arrive; every
 * other one names what is missing and, where it is worth trying again, says so.
 *
 * The TOKEN TAIL rather than the token: it is an address rather than a
 * credential (ADR-0017), but a settings row is also a screenshot people paste
 * into an issue, and the last few characters are enough to tell two devices'
 * registrations apart in `ui_meta` without publishing either.
 */
import type { PushAddress } from '@hermie/gateway-client/push'

import { strings } from '../../i18n/strings'
import type { PushAddressFailure, PushPermission } from './platform-contract'

/** How much of an address is shown. Enough to match a `ui_meta` row against. */
export const PUSH_ADDRESS_TAIL = 8

export type PushRegistrationState =
  /** The reader has not switched it on. Nothing has been asked of the platform. */
  | { kind: 'off' }
  /** The platform has no notification machinery: a browser over plain http. */
  | { kind: 'unavailable'; detail?: string }
  /** Asked and refused. Only system settings can undo it, so there is no retry. */
  | { kind: 'denied' }
  /**
   * On, and the platform raises no dialog: only System Settings can grant.
   *
   * The Mac build. Distinct from `denied` because nobody has refused anything
   * — the question was never put — and because the answer is a pane the app can
   * open rather than a screen the reader has to find.
   */
  | { kind: 'needs-system-settings' }
  /** On, granted, and an address is registered. The only working state. */
  | { kind: 'registered'; tail: string }
  /** On and granted, and this build can never mint a token. A rebuild, not a retry. */
  | { kind: 'no-project-id' }
  /** On and granted and the token request failed. Worth pressing Retry. */
  | { kind: 'failed'; message: string }
  /** On and granted and nothing has been attempted yet — the moment after the switch. */
  | { kind: 'pending' }

export interface PushStatusInput {
  available: boolean
  enabled: boolean
  permission: PushPermission
  address: PushAddress | null
  /** `PushPlatform.needsSystemSettings`; false everywhere but the Mac build. */
  needsSystemSettings?: boolean
  /** The last thing `obtainAddress` refused with, or `null` if it has not. */
  failure: PushAddressFailure | null
}

/**
 * The last few characters of whichever kind of address this is.
 *
 * The trailing `]` of an `ExponentPushToken[…]` is dropped first. It is the
 * same character on every device, so keeping it spends one of the few positions
 * this row has on nothing — and the point of the tail is telling two
 * registrations in one `ui_meta` section apart.
 */
export function pushAddressTail(address: PushAddress): string {
  const raw = (address.transport === 'expo' ? address.token : address.endpoint).replace(/\]$/u, '')

  return raw.slice(-PUSH_ADDRESS_TAIL)
}

/**
 * What this device's registration actually is, in the order the reader cares.
 *
 * Availability first (nothing below it can be true), then the switch, then
 * permission — a granted-looking row on a denied permission is the lie a
 * settings screen must not tell — then the address, then the reason there is
 * none.
 */
export function pushRegistrationState(input: PushStatusInput): PushRegistrationState {
  if (!input.available) {
    return { kind: 'unavailable' }
  }

  if (!input.enabled) {
    return { kind: 'off' }
  }

  /*
    Before `denied`, and before the address, because on this platform a
    not-granted permission is neither a refusal nor something a retry can move:
    the dialog was never raised. It is checked before the address so that a
    registration made while permission was on, and then turned off in System
    Settings, reads as the instruction it is rather than as "Registered".
  */
  if (input.needsSystemSettings === true && input.permission !== 'granted') {
    return { kind: 'needs-system-settings' }
  }

  if (input.permission === 'denied') {
    return { kind: 'denied' }
  }

  if (input.address) {
    return { kind: 'registered', tail: pushAddressTail(input.address) }
  }

  const failure = input.failure

  if (!failure) {
    return { kind: 'pending' }
  }

  if (failure.reason === 'no-project-id') {
    return { kind: 'no-project-id' }
  }

  if (failure.reason === 'unsupported') {
    return failure.message ? { kind: 'unavailable', detail: failure.message } : { kind: 'unavailable' }
  }

  // `empty` is a platform that answered without an address and without an
  // error, which is rare enough that it has no sentence of its own — it is a
  // failed token request whose message is that it was empty.
  return { kind: 'failed', message: failure.reason === 'empty' ? 'the platform returned no address' : failure.message }
}

/**
 * Whether pressing Retry could change the answer.
 *
 * `denied` and `no-project-id` are deliberately excluded. Re-running the flow
 * on a denied permission shows no dialog and resolves with the same refusal,
 * and a build with no EAS project id cannot grow one at runtime; a button that
 * visibly does nothing is worse than no button.
 */
export function pushRetryable(state: PushRegistrationState): boolean {
  return state.kind === 'failed' || state.kind === 'pending'
}

/**
 * One line for whatever `pushRegistrationState` decided this device is.
 *
 * Here rather than in the settings section because the onboarding step shows
 * the same row, and a second copy of this mapping is how one of them ends up
 * saying "asking the platform for an address…" about a request that failed
 * thirty seconds ago — which is the class of quiet lie this whole module
 * exists to stop.
 */
export function pushStatusText(state: PushRegistrationState): string {
  const text = strings.settings.notifications

  switch (state.kind) {
    case 'off':
      return text.statusOff
    case 'registered':
      return text.statusRegistered(state.tail)
    case 'denied':
      return text.statusDenied
    case 'needs-system-settings':
      return text.statusSystemSettings
    case 'no-project-id':
      return text.statusNoProject
    case 'failed':
      return text.statusFailed(state.message)
    case 'pending':
      return text.statusPending
    default:
      return state.detail ? text.statusUnsupported(state.detail) : text.unavailable
  }
}
