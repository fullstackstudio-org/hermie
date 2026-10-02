/**
 * What one bot's bead says.
 *
 * The list and (in Part 2) the chat header both read this, which is the whole
 * reason it is a function rather than four conditions in a row component: a row
 * that says "Working…" above a header that says "Online" is two bugs that look
 * like one.
 *
 * The cases worth writing down are the precedence ones, because that is where a
 * plausible-looking implementation goes wrong.
 */
import { presenceOf, type PresenceInput } from '../src/features/bots/presence'

const READY: PresenceInput = {
  gatewayReady: true,
  needsInput: false,
  sessionAttached: true,
  working: false
}

describe('presenceOf', () => {
  it('is online when the gateway is up and the session is attached', () => {
    expect(presenceOf(READY)).toEqual({ state: 'online' })
  })

  it('is working while a turn is running', () => {
    expect(presenceOf({ ...READY, working: true })).toEqual({ state: 'working' })
  })

  it('is needs-input while a request is open', () => {
    expect(presenceOf({ ...READY, needsInput: true })).toEqual({ state: 'needsInput' })
  })

  /**
   * A bot parked on an approval is also "running" as far as the roster is
   * concerned, so these two arrive together constantly. The question aimed at a
   * person outranks the fact that a turn is open.
   */
  it('prefers needs-input over working when both are true', () => {
    expect(presenceOf({ ...READY, needsInput: true, working: true })).toEqual({ state: 'needsInput' })
  })

  it('is offline while the gateway is not ready, whatever else is true', () => {
    expect(presenceOf({ ...READY, gatewayReady: false, needsInput: true, working: true })).toEqual({
      state: 'offline'
    })
  })

  /**
   * "Offline" beats everything for a reason that is not tidiness: a needs-input
   * bead on a chat that cannot be answered is a promise the app cannot keep.
   */
  it('is offline when there is no session, even on a healthy gateway', () => {
    expect(presenceOf({ ...READY, sessionAttached: false })).toEqual({ state: 'offline' })
  })

  it('carries last seen only when offline and only when it is known', () => {
    expect(presenceOf({ ...READY, gatewayReady: false, lastActive: 1_700_000_000 })).toEqual({
      state: 'offline',
      lastSeenAt: 1_700_000_000
    })

    // Zero is the roster's "never", not a timestamp at the epoch.
    expect(presenceOf({ ...READY, gatewayReady: false, lastActive: 0 })).toEqual({ state: 'offline' })
    expect(presenceOf({ ...READY, lastActive: 1_700_000_000 })).toEqual({ state: 'online' })
  })
})
