/**
 * The gateway's clock from its `Date` header: what a row's `updatedAt` and the
 * heartbeat are stamped with.
 */
import { describe, expect, it, vi } from 'vitest'

import { CLOCK_THRESHOLD_MS, createGatewayClock, offsetFromDate } from './clock'

const AT = Date.parse('2026-10-04T12:00:00Z')

describe('offsetFromDate', () => {
  it('is the gateway’s lead over this page, when it is more than the threshold', () => {
    // The gateway is ten minutes ahead.
    expect(offsetFromDate(new Date(AT + 600_000).toUTCString(), AT - 100, AT + 100)).toBe(600_500)
  })

  it('is negative for a gateway behind this page', () => {
    expect(offsetFromDate(new Date(AT - 600_000).toUTCString(), AT, AT)).toBe(-599_500)
  })

  it('is zero below the threshold, without a header, and for one that does not parse', () => {
    expect(offsetFromDate(new Date(AT).toUTCString(), AT, AT)).toBe(0)
    expect(Math.abs(offsetFromDate(new Date(AT + CLOCK_THRESHOLD_MS - 1_000).toUTCString(), AT, AT))).toBe(0)
    expect(offsetFromDate(null, AT, AT)).toBe(0)
    expect(offsetFromDate('yesterday-ish', AT, AT)).toBe(0)
  })
})

describe('createGatewayClock', () => {
  it('measures once, from `/api/status`, and reads the gateway’s time after', async () => {
    const fetch = vi.fn(async () => new Response('{}', { headers: { date: new Date(AT + 3_600_000).toUTCString() } }))
    const clock = createGatewayClock({ baseUrl: 'https://gw.example.test/prefix', fetch, local: () => AT })

    expect(clock.now()).toBe(AT)

    await Promise.all([clock.measure(), clock.measure()])

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('https://gw.example.test/prefix/api/status', {
      credentials: 'same-origin',
      cache: 'no-store'
    })
    expect(clock.now()).toBe(AT + 3_600_500)
  })

  it('keeps the page’s own clock when the gateway cannot be asked', async () => {
    const clock = createGatewayClock({
      baseUrl: 'https://gw.example.test',
      fetch: vi.fn(async () => {
        throw new TypeError('offline')
      }),
      local: () => AT
    })

    await clock.measure()

    expect(clock.offset).toBe(0)
    expect(clock.now()).toBe(AT)
  })
})
