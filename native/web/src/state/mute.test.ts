/**
 * Silencing one chat.
 *
 * A mute is a DEADLINE rather than a flag, and almost every case here is about
 * that one choice: nothing fires, nothing has to be running, and a page that
 * was closed for two days comes back to exactly the state the arithmetic says
 * it should be in.
 *
 * Ported from the Expo app's `__tests__/mute.test.ts`: the cases about
 * `store/mute.ts` itself, unchanged but for the strings' path. The row menu and
 * the widgets are the Expo app's features, not this module's.
 */
import { describe, expect, it } from 'vitest'

import { strings } from '../generated/strings'
import { formatMuteUntil, isMuted, MUTE_FOREVER, muteUntil, mutedUntil, mutesOf, withoutExpired } from './mute'

/** A Wednesday at 10:00 local time, so the day-boundary cases are readable. */

const NOON = Math.floor(new Date(2026, 8, 23, 10, 0, 0).getTime() / 1000)

const HOUR = 60 * 60

describe('a mute as a deadline', () => {
  it('turns each offered span into the second it lapses', () => {
    expect(muteUntil('1h', NOON)).toBe(NOON + HOUR)
    expect(muteUntil('8h', NOON)).toBe(NOON + 8 * HOUR)
    expect(muteUntil('1w', NOON)).toBe(NOON + 7 * 24 * HOUR)
  })

  it('stores forever as a deadline that never comes', () => {
    expect(muteUntil('forever', NOON)).toBe(MUTE_FOREVER)
    expect(isMuted({ writer: MUTE_FOREVER }, 'writer', NOON + 10 * 365 * 24 * HOUR)).toBe(true)
  })

  it('reads a deadline in the past as unmuted without anybody sweeping it', () => {
    // The property the whole design rests on. Nothing fires when a mute lapses,
    // so a phone that was asleep for two days must come back unmuted purely by
    // comparing two numbers.
    const mutes = { writer: NOON + HOUR }

    expect(isMuted(mutes, 'writer', NOON)).toBe(true)
    expect(isMuted(mutes, 'writer', NOON + HOUR - 1)).toBe(true)
    expect(isMuted(mutes, 'writer', NOON + HOUR)).toBe(false)
    expect(isMuted(mutes, 'writer', NOON + 2 * 24 * HOUR)).toBe(false)
  })

  it('says a chat nobody muted is not muted', () => {
    expect(isMuted({}, 'writer', NOON)).toBe(false)
    expect(mutedUntil({}, 'writer', NOON)).toBeNull()
  })

  it('hands back the deadline only while it still stands', () => {
    expect(mutedUntil({ writer: NOON + HOUR }, 'writer', NOON)).toBe(NOON + HOUR)
    expect(mutedUntil({ writer: NOON + HOUR }, 'writer', NOON + 2 * HOUR)).toBeNull()
    expect(mutedUntil({ writer: MUTE_FOREVER }, 'writer', NOON)).toBe(MUTE_FOREVER)
  })
})

describe('sweeping the ones that lapsed', () => {
  it('drops the expired and keeps the rest', () => {
    const swept = withoutExpired({ writer: NOON - HOUR, researcher: NOON + HOUR, notes: MUTE_FOREVER }, NOON)

    expect(swept).toEqual({ researcher: NOON + HOUR, notes: MUTE_FOREVER })
  })

  it('answers null when nothing had lapsed', () => {
    // Not an equal copy. The sweep runs on every foreground and the map is part
    // of the `ui_meta` projection, so a fresh object each time would send the
    // whole arrangement to the gateway for nothing.
    expect(withoutExpired({ researcher: NOON + HOUR }, NOON)).toBeNull()
    expect(withoutExpired({}, NOON)).toBeNull()
  })
})

describe('reading a map another build wrote', () => {
  it('keeps the deadlines and drops everything else', () => {
    expect(mutesOf({ writer: NOON, notes: MUTE_FOREVER, a: 'soon', b: null, c: Number.NaN, d: -1, '': 5 })).toEqual({
      writer: NOON,
      notes: MUTE_FOREVER
    })
  })

  it('answers empty for anything that is not a map at all', () => {
    expect(mutesOf(undefined)).toEqual({})
    expect(mutesOf(null)).toEqual({})
    expect(mutesOf([1, 2])).toEqual({})
    expect(mutesOf('muted')).toEqual({})
  })
})

describe('saying when it comes back', () => {
  const weekdays = strings.app.layout.muteWeekdays

  it('says the clock alone for a deadline later today', () => {
    expect(formatMuteUntil(muteUntil('1h', NOON), NOON, weekdays)).toBe('11:00')
  })

  it('carries the day for a deadline that is not today', () => {
    // The case a bare clock would lie about: "Muted until 10:00" on a Wednesday,
    // meaning next Wednesday.
    expect(formatMuteUntil(muteUntil('1w', NOON), NOON, weekdays)).toBe('Wed 10:00')
    expect(formatMuteUntil(muteUntil('8h', NOON + 10 * HOUR), NOON, weekdays)).toBe('Thu 04:00')
  })
})
