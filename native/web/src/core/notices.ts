/**
 * The gateway's out-of-band notices (`notification.show` / `notification.clear`),
 * from the moment the chat controller hands them over (`SessionSignal`) until they
 * are cleared, expire or are dismissed. What the page shows is in
 * `state/notices.ts`.
 *
 * The native apps' `GatewayNoticesModel`, for a browser. The rules, as built:
 *
 *  1. **Keyed.** A notice's id is its `key`, else its `id`, else a serial of this
 *     model's. A second notice with the same id replaces the first in place (and
 *     restarts its lifetime); `notification.clear` names a key and withdraws it.
 *  2. **Lifetime.** `ttl_ms` when it is positive, whatever the `kind`; a `ttl`
 *     notice without one goes after `DEFAULT_TTL_MS`; `sticky` and `agent` stay
 *     until they are cleared or the person closes them.
 *  3. **Bounded.** At most `MAX_NOTICES` are kept, the oldest dropped first.
 *  4. **Plain text.** The text is relayed from the agent, so it is cleaned and
 *     bounded like every other text a bot supplies (`displayText`: no control or
 *     format characters, bidirectional overrides among them, at most
 *     `NOTICE_TEXT_LIMIT` characters) and is never Markdown or a link. A notice
 *     whose text is empty after that is not shown.
 *  5. **Level.** `info`, `warn`, `error` or `success`; anything else is `info`.
 *
 * Every notice goes when the session stops (a sign-out).
 */
import type { StoreApi } from 'zustand/vanilla'

import { type GatewayNotice, type NoticeLevel, type NoticesState, noticesStore } from '../state/notices'
import type { SessionSignal } from './chat-controller'
import { displayText, type SecureInputTimers } from './requests/secure-input'

export const MAX_NOTICES = 8
export const NOTICE_TEXT_LIMIT = 400
/** How long a `ttl` notice that names no lifetime of its own stays. */
export const DEFAULT_TTL_MS = 8_000

const LEVELS: ReadonlySet<string> = new Set(['info', 'warn', 'error', 'success'])

const pageTimers: SecureInputTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

const nonBlank = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

/** Rule 2: the notice's lifetime in milliseconds, or `undefined` for one that stays. */
export function noticeLifetime(kind: unknown, ttlMs: unknown): number | undefined {
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) {
    return ttlMs
  }

  return kind === 'ttl' ? DEFAULT_TTL_MS : undefined
}

export interface NoticesModelOptions {
  /** Where the chat controller's signals are heard (`ChatController.onSessionSignal`). */
  watchSignals: (listener: (signal: SessionSignal) => void) => () => void
  store?: StoreApi<NoticesState>
  timers?: SecureInputTimers
}

export class NoticesModel {
  readonly store: StoreApi<NoticesState>

  private readonly options: NoticesModelOptions
  private readonly timers: SecureInputTimers
  private readonly expiries = new Map<string, unknown>()
  private unsubscribe: (() => void) | undefined
  private unnamed = 0
  private serial = 0
  private stopped = false

  constructor(options: NoticesModelOptions) {
    this.options = options
    this.store = options.store ?? noticesStore
    this.timers = options.timers ?? pageTimers
  }

  start(): void {
    if (this.unsubscribe || this.stopped) {
      return
    }

    this.store.getState().reset()
    this.unsubscribe = this.options.watchSignals(signal => {
      if (signal.kind === 'notice.show') {
        this.show(signal.payload, signal.chat)
      } else if (signal.kind === 'notice.clear') {
        const key = nonBlank(signal.payload.key)

        if (key !== undefined) {
          this.remove(key)
        }
      }
    })
  }

  /** Every notice goes, and nothing more is heard. Idempotent. */
  stop(): void {
    if (this.stopped) {
      return
    }

    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined

    for (const handle of this.expiries.values()) {
      this.timers.clearTimeout(handle)
    }

    this.expiries.clear()
    this.store.getState().reset()
  }

  /** The person closed it. */
  dismiss(id: string): void {
    this.remove(id)
  }

  // ── from the gateway ──────────────────────────────────────────────────────────────────────────

  private show(payload: Record<string, unknown>, chat: string | undefined): void {
    const text = displayText(payload.text, NOTICE_TEXT_LIMIT)

    if (!text) {
      return
    }

    const id = nonBlank(payload.key) ?? nonBlank(payload.id) ?? `notice-${(this.unnamed += 1)}`
    const level = (
      typeof payload.level === 'string' && LEVELS.has(payload.level) ? payload.level : 'info'
    ) as NoticeLevel
    const notice: GatewayNotice = { id, text, level, chat, serial: (this.serial += 1) }
    const current = this.store.getState().notices
    const index = current.findIndex(entry => entry.id === id)
    let next: GatewayNotice[]

    if (index >= 0) {
      next = current.map(entry => (entry.id === id ? notice : entry))
    } else {
      next = [...current, notice]

      while (next.length > MAX_NOTICES) {
        const dropped = next.shift()

        if (dropped) {
          this.cancelExpiry(dropped.id)
        }
      }
    }

    this.cancelExpiry(id)
    this.store.setState({ notices: next })

    const lifetime = noticeLifetime(payload.kind, payload.ttl_ms)

    if (lifetime !== undefined) {
      const serial = notice.serial

      this.expiries.set(
        id,
        this.timers.setTimeout(() => {
          // A notice shown again since has a lifetime of its own.
          if (this.store.getState().notices.find(entry => entry.id === id)?.serial === serial) {
            this.remove(id)
          }
        }, lifetime)
      )
    }
  }

  private remove(id: string): void {
    this.cancelExpiry(id)

    const current = this.store.getState().notices

    if (current.some(entry => entry.id === id)) {
      this.store.setState({ notices: current.filter(entry => entry.id !== id) })
    }
  }

  private cancelExpiry(id: string): void {
    const handle = this.expiries.get(id)

    if (handle !== undefined) {
      this.timers.clearTimeout(handle)
      this.expiries.delete(id)
    }
  }
}
