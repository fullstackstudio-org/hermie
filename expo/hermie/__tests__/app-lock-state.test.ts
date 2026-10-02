/**
 * The app lock's timing, as a table.
 *
 * Every case here is a question that cannot be answered by looking at the app:
 * whether a grace period that has not elapsed keeps it open, whether one that
 * has closes it, whether a cold start honours the grace period (it does not,
 * deliberately), and whether a refused prompt leaves the plate up.
 */
import {
  background,
  DEFAULT_LOCK_THRESHOLD,
  foreground,
  graceMsOf,
  isLockThreshold,
  type LockThreshold,
  start,
  thresholdChanged,
  unlockFailed,
  unlocked
} from '../src/features/lock/lock-state'

const T0 = 1_700_000_000_000

describe('the threshold', () => {
  it('is off by default, so a lock nobody asked for never appears', () => {
    expect(DEFAULT_LOCK_THRESHOLD).toBe('off')
    expect(start('off').locked).toBe(false)
  })

  it('reads a stored value defensively', () => {
    expect(isLockThreshold('5m')).toBe(true)
    expect(isLockThreshold('5 minutes')).toBe(false)
    expect(isLockThreshold(undefined)).toBe(false)
  })

  it.each<[LockThreshold, number]>([
    ['immediately', 0],
    ['1m', 60_000],
    ['5m', 300_000],
    ['15m', 900_000]
  ])('gives %s a grace period of %i ms', (threshold, ms) => {
    expect(graceMsOf(threshold)).toBe(ms)
  })
})

describe('a cold start', () => {
  it.each<LockThreshold>(['immediately', '1m', '5m', '15m'])(
    'locks at %s, whatever the grace period says',
    threshold => {
      expect(start(threshold).locked).toBe(true)
    }
  )

  it('leaves the app open when the lock is off', () => {
    expect(start('off')).toEqual({ threshold: 'off', locked: false, sinceBackground: null })
  })
})

describe('going away and coming back', () => {
  it('locks on the way out at "immediately", so the switcher snapshot is the plate', () => {
    const open = unlocked(start('immediately'))

    expect(open.locked).toBe(false)
    expect(background(open, T0).locked).toBe(true)
  })

  it('does not lock on the way out at a timed threshold', () => {
    const open = unlocked(start('5m'))

    expect(background(open, T0)).toEqual({ threshold: '5m', locked: false, sinceBackground: T0 })
  })

  it('stays open when the app comes back inside the grace period', () => {
    const away = background(unlocked(start('5m')), T0)

    expect(foreground(away, T0 + 299_999).locked).toBe(false)
  })

  it('locks when the app comes back after the grace period', () => {
    const away = background(unlocked(start('5m')), T0)

    expect(foreground(away, T0 + 300_000).locked).toBe(true)
  })

  it('locks exactly at the boundary, not one millisecond later', () => {
    const away = background(unlocked(start('1m')), T0)

    expect(foreground(away, T0 + 59_999).locked).toBe(false)
    expect(foreground(away, T0 + 60_000).locked).toBe(true)
  })

  it('forgets the timestamp once it has been read, so the next return is not judged by an old one', () => {
    const away = background(unlocked(start('15m')), T0)
    const back = foreground(away, T0 + 1_000)

    expect(back.sinceBackground).toBeNull()
    // A whole day later with no intervening background: still open, because
    // nothing went away in between.
    expect(foreground(back, T0 + 86_400_000).locked).toBe(false)
  })

  it('never locks while the threshold is off, however long the app was away', () => {
    const away = background(start('off'), T0)

    expect(away.sinceBackground).toBeNull()
    expect(foreground(away, T0 + 86_400_000).locked).toBe(false)
  })
})

describe('the prompt', () => {
  it('opens the app when it succeeds', () => {
    expect(unlocked(start('1m'))).toEqual({ threshold: '1m', locked: false, sinceBackground: null })
  })

  it('keeps the plate up when it fails', () => {
    const locked = start('1m')

    expect(unlockFailed(locked)).toEqual(locked)
    expect(unlockFailed(locked).locked).toBe(true)
  })

  it('keeps the plate up however many times it fails', () => {
    let state = start('immediately')

    for (let attempt = 0; attempt < 10; attempt += 1) {
      state = unlockFailed(state)
    }

    expect(state.locked).toBe(true)
  })
})

describe('changing the setting', () => {
  it('unlocks when it is switched off, so the plate cannot outlive the preference', () => {
    expect(thresholdChanged(start('immediately'), 'off')).toEqual({
      threshold: 'off',
      locked: false,
      sinceBackground: null
    })
  })

  it('leaves the app open when it is switched on, because the reader is holding it', () => {
    const open = unlocked(start('off'))

    expect(thresholdChanged(open, '5m')).toEqual({ threshold: '5m', locked: false, sinceBackground: null })
  })

  it('takes effect on the next return, not retroactively', () => {
    const away = background(thresholdChanged(unlocked(start('off')), '1m'), T0)

    expect(foreground(away, T0 + 30_000).locked).toBe(false)
    expect(foreground(away, T0 + 61_000).locked).toBe(true)
  })
})
