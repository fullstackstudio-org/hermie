/**
 * Silencing one chat, as arithmetic.
 *
 * A mute is a deadline, not a flag: `mutes[bot]` is the unix SECOND it lapses,
 * and `0` means never. That choice is what makes the feature survive the thing
 * it has to survive — a phone that was in a drawer for two days. There is no
 * timer to fire and nothing to have missed; every reader compares the stored
 * number against the clock it already has, so a mute that ran out while nobody
 * was looking has simply already run out by the time anybody asks.
 *
 * Seconds rather than milliseconds because that is what everything else in the
 * section speaks — `updatedAt`, the push heartbeat, `last_active` — and a
 * section holding both units is a section somebody will one day compare across.
 *
 * Nothing here reads a clock of its own. `now` is a parameter at every entry
 * point, which is what lets a test say "eight hours later" without waiting and
 * what keeps the projection in `ui-meta-bridge.ts` from changing on every
 * comparison; see the note there about `updatedAt`.
 */

/** A mute with no end. Stored as `0` because it is a deadline that never comes. */
export const MUTE_FOREVER = 0

/** The four the menus offer, in the order they are offered. */
export const MUTE_DURATIONS = ['1h', '8h', '1w', 'forever'] as const

export type MuteDuration = (typeof MUTE_DURATIONS)[number]

/** Bot name → the second it lapses, or `MUTE_FOREVER`. */
export type Mutes = Record<string, number>

const SPANS: Record<Exclude<MuteDuration, 'forever'>, number> = {
  '1h': 60 * 60,
  '8h': 8 * 60 * 60,
  '1w': 7 * 24 * 60 * 60
}

/** What to store for a duration chosen at `now` (unix seconds). */
export function muteUntil(duration: MuteDuration, now: number): number {
  return duration === 'forever' ? MUTE_FOREVER : Math.floor(now) + SPANS[duration]
}

/**
 * Is this chat silent right now?
 *
 * A deadline in the past reads as unmuted whether or not anybody has got round
 * to deleting it, which is the property that makes the clean-up below an
 * optimisation rather than a correctness step.
 */
export function isMuted(mutes: Mutes, botName: string, now: number): boolean {
  const until = mutes[botName]

  if (until === undefined) {
    return false
  }

  return until === MUTE_FOREVER || until > now
}

/** The deadline, or `null` when this chat is not muted. `0` means forever. */
export function mutedUntil(mutes: Mutes, botName: string, now: number): number | null {
  return isMuted(mutes, botName, now) ? (mutes[botName] as number) : null
}

/**
 * The same map without the mutes that have lapsed, or `null` when none had.
 *
 * `null` rather than an equal copy on purpose: the caller is a store whose every
 * write goes to disk and through the `ui_meta` projection, and returning a fresh
 * object each time the app came back to the foreground would send the section
 * again for nothing.
 */
export function withoutExpired(mutes: Mutes, now: number): Mutes | null {
  const kept: Mutes = {}
  let dropped = false

  for (const [botName, until] of Object.entries(mutes)) {
    if (isMuted(mutes, botName, now)) {
      kept[botName] = until
    } else {
      dropped = true
    }
  }

  return dropped ? kept : null
}

/** Read a map off the wire, where another build wrote it. */
export function mutesOf(value: unknown): Mutes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const out: Mutes = {}

  for (const [botName, until] of Object.entries(value as Record<string, unknown>)) {
    // A deadline that is not a finite number says nothing, and a negative one
    // is a deadline that has already passed — both are simply not a mute.
    if (botName && typeof until === 'number' && Number.isFinite(until) && until >= 0) {
      out[botName] = Math.floor(until)
    }
  }

  return out
}

/**
 * When it lapses, as the menus say it.
 *
 * A clock alone would be a lie for anything past midnight — "Muted until 14:30"
 * on a Tuesday, meaning Thursday — so a deadline on another day carries the day
 * with it. The longest mute anybody can choose is a week, so a weekday name is
 * enough to place it, and the one ambiguous case is exactly seven days away,
 * where "until Monday" is also the reading somebody wants.
 *
 * `weekdays` is handed in rather than imported so this stays a pure function of
 * its arguments, which is what a test about the day boundary needs.
 */
export function formatMuteUntil(until: number, now: number, weekdays: readonly string[]): string {
  const end = new Date(until * 1000)

  if (Number.isNaN(end.getTime())) {
    return ''
  }

  const hours = String(end.getHours()).padStart(2, '0')
  const minutes = String(end.getMinutes()).padStart(2, '0')
  const clock = `${hours}:${minutes}`
  const today = new Date(now * 1000)
  const sameDay =
    end.getFullYear() === today.getFullYear() &&
    end.getMonth() === today.getMonth() &&
    end.getDate() === today.getDate()

  return sameDay ? clock : `${weekdays[end.getDay()] ?? ''} ${clock}`.trim()
}
