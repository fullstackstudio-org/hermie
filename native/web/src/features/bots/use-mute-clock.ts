/**
 * The clock the list reads mutes against, in unix seconds.
 *
 * A mute is a deadline (`state/mute.ts`), so a row's bell has to go when its deadline passes without
 * anybody touching the page. The hook holds `now` and wakes once, when the soonest deadline that is still
 * ahead lapses; with none ahead it sets nothing. A timer that fires late (a sleeping laptop) only redraws
 * late, since every read compares against the clock it has.
 */
import { useEffect, useState } from 'react'

import { MUTE_FOREVER, type Mutes } from '../../state/mute'

/** The longest a timer can wait (a 32-bit count of milliseconds); a later deadline waits again after it. */
const LONGEST_WAIT_MS = 2_147_483_647

const secondsNow = (): number => Math.floor(Date.now() / 1000)

export function useMuteClock(mutes: Mutes): number {
  const [now, setNow] = useState(secondsNow)

  useEffect(() => {
    const current = secondsNow()
    const ahead = Object.values(mutes).filter(until => until !== MUTE_FOREVER && until > current)

    if (!ahead.length) {
      return undefined
    }

    const wait = Math.min(LONGEST_WAIT_MS, (Math.min(...ahead) - Date.now() / 1000) * 1000 + 250)
    const timer = setTimeout(() => setNow(secondsNow()), Math.max(0, wait))

    return () => clearTimeout(timer)
  }, [mutes, now])

  return now
}
