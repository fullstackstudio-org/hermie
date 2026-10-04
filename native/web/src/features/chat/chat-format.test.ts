import { describe, expect, it } from 'vitest'

import { formatElapsedClock } from './chat-format'

describe('formatElapsedClock', () => {
  it('reads minutes and seconds under an hour', () => {
    expect(formatElapsedClock(0)).toBe('0:00')
    expect(formatElapsedClock(5)).toBe('0:05')
    expect(formatElapsedClock(42.9)).toBe('0:42')
    expect(formatElapsedClock(60)).toBe('1:00')
    expect(formatElapsedClock(725)).toBe('12:05')
  })

  it('adds the hours from the hour on', () => {
    expect(formatElapsedClock(3_600)).toBe('1:00:00')
    expect(formatElapsedClock(3_723)).toBe('1:02:03')
  })

  it('has no clock to read for a value that is not a time', () => {
    expect(formatElapsedClock(undefined)).toBe('0:00')
    expect(formatElapsedClock(-1)).toBe('0:00')
    expect(formatElapsedClock(Number.NaN)).toBe('0:00')
    expect(formatElapsedClock(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})
