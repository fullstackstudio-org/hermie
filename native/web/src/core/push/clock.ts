/**
 * The gateway's clock, as well as this page can know it.
 *
 * Two values this client writes are compared with the gateway's own `time.time()`
 * by the plugin: a registration row's `updatedAt` (a row the plugin retired, on a
 * 403 or a 404/410, comes back only when it is written with an `updatedAt` newer
 * than the moment it was retired) and the `seen` heartbeat (a stamp from the
 * future would keep the chat counted as read, and its notifications held back,
 * for as long as this clock is ahead). A browser whose clock is behind the
 * gateway's would write a row that stays retired; one ahead would silence a chat.
 *
 * So the offset is measured once per page from the `Date` header of a same-origin
 * request to the gateway (`GET /api/status`, which every gateway answers and
 * which the dashboard's sign-in gate lets through), and applied when it is more
 * than a couple of seconds: the header has one-second resolution, and an offset
 * under that is noise. If the request fails or carries no date, the page's own
 * clock is used, with exactly the skew risk described above; the "Register
 * again" button in Settings writes a fresh row either way.
 */

/** An offset smaller than this is left at zero: the `Date` header is whole seconds. */
export const CLOCK_THRESHOLD_MS = 2_000

/**
 * The offset, in milliseconds, to add to this page's clock to read the gateway's,
 * from a `Date` header and the page's clock just before and just after the
 * request. `0` when the header is absent or unreadable, or the offset is below the
 * threshold.
 */
export function offsetFromDate(dateHeader: string | null, sentAt: number, receivedAt: number): number {
  if (!dateHeader) {
    return 0
  }

  const gateway = Date.parse(dateHeader)

  if (!Number.isFinite(gateway)) {
    return 0
  }

  // The header names a whole second the server was in somewhere between the two.
  const offset = gateway + 500 - (sentAt + receivedAt) / 2

  return Math.abs(offset) < CLOCK_THRESHOLD_MS ? 0 : Math.round(offset)
}

export interface GatewayClock {
  /** The gateway's time in milliseconds, as well as it is known now. */
  now(): number
  /** Measure the offset (once; later calls share the first). Never rejects. */
  measure(): Promise<void>
  /** The offset in use, in milliseconds. */
  readonly offset: number
}

export interface GatewayClockOptions {
  /** The gateway's base URL: origin plus prefix, no trailing slash. */
  baseUrl: string
  fetch?: typeof fetch
  local?: () => number
}

export function createGatewayClock(options: GatewayClockOptions): GatewayClock {
  const local = options.local ?? (() => Date.now())
  const request = options.fetch ?? ((input, init) => fetch(input, init))
  let offset = 0
  let measuring: Promise<void> | null = null

  return {
    now: () => local() + offset,
    get offset() {
      return offset
    },
    measure() {
      measuring ??= (async () => {
        const sentAt = local()

        try {
          const response = await request(`${options.baseUrl}/api/status`, {
            credentials: 'same-origin',
            cache: 'no-store'
          })

          offset = offsetFromDate(response.headers.get('date'), sentAt, local())
          // The body is not needed; let it go.
          void response.body?.cancel().catch(() => undefined)
        } catch {
          offset = 0
        }
      })()

      return measuring
    }
  }
}
