import { afterEach, describe, expect, it, vi } from 'vitest'

import { monotonicNow } from './monotonic-clock'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the monotonic clock', () => {
  it('reads the performance timeline, not the system clock', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1234.5)

    expect(monotonicNow()).toBe(1234.5)
  })

  it('does not move when the system clock is set back', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))

    const before = monotonicNow()

    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))

    expect(monotonicNow()).toBeGreaterThanOrEqual(before)
  })
})
