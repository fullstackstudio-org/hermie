/**
 * Per-key rate limiting for the requests the gateway asks of a person: a port of the fork's
 * `tui_gateway/request_limits.py`.
 *
 * A `RequestLimiter` keeps, per key (a conversation), how many requests are open and when the last ones were sent. Two
 * limits: `maxPending` requests open at the same time (`already_pending`) and `maxPerWindow` requests sent within
 * `windowSeconds` (`rate_limited`). Keys are independent. Time is passed in (seconds), never read here, so a test
 * drives the window with a plain number. A request that was reserved but never reached anybody is released with
 * `sentAt: undefined` and does not count against the window.
 */
export const ALREADY_PENDING = 'already_pending'
export const RATE_LIMITED = 'rate_limited'

export class RequestLimiter {
  /** key → open requests. */
  readonly pending = new Map<string, number>()
  /** key → send times still inside the window, oldest first. */
  readonly sent = new Map<string, number[]>()

  constructor(
    readonly maxPending: number,
    readonly maxPerWindow: number,
    readonly windowSeconds: number
  ) {}

  /** Take one open slot for `key`: `''` on success, else the reason it is refused. A refusal changes nothing but expired history. */
  reserve(key: string, now: number): string {
    const history = (this.sent.get(key) ?? []).filter(at => now - at < this.windowSeconds)

    if (history.length) {
      this.sent.set(key, history)
    } else {
      this.sent.delete(key)
    }

    if ((this.pending.get(key) ?? 0) >= this.maxPending) {
      return ALREADY_PENDING
    }

    if (history.length >= this.maxPerWindow) {
      return RATE_LIMITED
    }

    this.pending.set(key, (this.pending.get(key) ?? 0) + 1)

    return ''
  }

  /** Give back a slot taken by `reserve`. `sentAt` is when the request went out, or `undefined` when nothing reached a person. */
  release(key: string, sentAt: number | undefined): void {
    const left = (this.pending.get(key) ?? 0) - 1

    if (left > 0) {
      this.pending.set(key, left)
    } else {
      this.pending.delete(key)
    }

    if (sentAt !== undefined) {
      this.sent.set(key, [...(this.sent.get(key) ?? []), sentAt])
    }
  }

  reset(): void {
    this.pending.clear()
    this.sent.clear()
  }
}

/** `input.*` and `review.*` per conversation per window. */
export const MAX_PER_WINDOW = 12
/** `device.*` per conversation per window: what is personal is asked for less often. */
export const DEVICE_MAX_PER_WINDOW = 6
export const WINDOW_SECONDS = 600
export const MAX_PENDING = 1

/**
 * The two families' limiters and the one rule across them: only one interactive request is open per conversation,
 * whichever family (a person is asked one thing at a time); each family has its own number per window.
 */
export class FamilyLimits {
  readonly general = new RequestLimiter(MAX_PENDING, MAX_PER_WINDOW, WINDOW_SECONDS)
  readonly device = new RequestLimiter(MAX_PENDING, DEVICE_MAX_PER_WINDOW, WINDOW_SECONDS)

  /** The limiter of `device` or of everything else, and the reason it is refused (`''` when a slot was taken). */
  reserve(isDevice: boolean, key: string, now: number): { limiter: RequestLimiter; refused: string } {
    const [own, other] = isDevice ? [this.device, this.general] : [this.general, this.device]

    if ((other.pending.get(key) ?? 0) >= other.maxPending) {
      return { limiter: own, refused: ALREADY_PENDING }
    }

    return { limiter: own, refused: own.reserve(key, now) }
  }

  reset(): void {
    this.general.reset()
    this.device.reset()
  }
}
