import { describe, expect, it } from 'vitest'

import { presenceOf, type PresenceInput } from './presence'

const idle: PresenceInput = { gatewayReady: true, sessionAttached: true, working: false, needsInput: false }

describe('presenceOf', () => {
  it('is online when connected, attached and idle', () => {
    expect(presenceOf(idle)).toEqual({ state: 'online' })
  })

  it('is working when a turn runs', () => {
    expect(presenceOf({ ...idle, working: true })).toEqual({ state: 'working' })
  })

  it('needs input before it is working: a request is aimed at the reader, busy is only information', () => {
    expect(presenceOf({ ...idle, working: true, needsInput: true })).toEqual({ state: 'needsInput' })
  })

  it('is offline before anything else when the gateway is unreachable, and remembers when it was last heard from', () => {
    expect(presenceOf({ ...idle, gatewayReady: false, needsInput: true, working: true, lastActive: 1700 })).toEqual({
      state: 'offline',
      lastSeenAt: 1700
    })
  })

  it('is offline for a bot with no session, with no time when none is known', () => {
    expect(presenceOf({ ...idle, sessionAttached: false })).toEqual({ state: 'offline' })
    expect(presenceOf({ ...idle, sessionAttached: false, lastActive: 0 })).toEqual({ state: 'offline' })
  })
})
