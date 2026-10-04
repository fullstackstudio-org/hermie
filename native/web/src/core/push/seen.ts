/**
 * The two things this page says about what the reader is already looking at.
 *
 *  - **The heartbeat** (`push.seen[<installation id>] = {bot, at}`): while a bot's
 *    chat is on screen and the page is visible, stamped at once and then once a
 *    minute. The plugin holds back a notification about a chat somebody is
 *    reading on one of their devices, so the phone in a pocket does not buzz for
 *    the conversation open on the desk. A heuristic, as ADR-0017 says: it fails
 *    towards a notification that was not needed, never towards one that was
 *    missed, which is why the stamp stops the moment the page is hidden.
 *  - **Closing what is already dealt with**: when a chat comes on screen, its
 *    notifications go (they are about what the reader is now reading); when a
 *    request stops being open in this page (answered here or elsewhere, cancelled,
 *    timed out), its notification goes, which is what a clearing push does for a
 *    browser the push did not reach (`contract/push/contract.json`, `clear`).
 *
 * The stamps are unix seconds on the gateway's clock where it is known
 * (`clock.ts`). Nothing here reads a clock of its own.
 */
import type { StoreApi } from 'zustand/vanilla'

import type { PushState } from '../../state/push'
import type { ShownNotificationHandle } from './platform'

/** How often the heartbeat is stamped while a chat is on screen. */
export const PUSH_HEARTBEAT_MS = 60_000

export interface HeartbeatOptions {
  store: StoreApi<PushState>
  /** Unix seconds. */
  now: () => number
  intervalMs?: number
}

/** The heartbeat: `setOpenChat` and `setVisible` decide whether it runs. */
export class PushHeartbeat {
  private readonly store: StoreApi<PushState>
  private readonly now: () => number
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private bot: string | null = null
  private visible = true
  private stopped = false

  constructor(options: HeartbeatOptions) {
    this.store = options.store
    this.now = options.now
    this.intervalMs = options.intervalMs ?? PUSH_HEARTBEAT_MS
  }

  /** The bot whose chat is on screen, or `null`. */
  setOpenChat(bot: string | null): void {
    if (bot === this.bot) {
      return
    }

    this.bot = bot
    this.restart()
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) {
      return
    }

    this.visible = visible
    this.restart()
  }

  stop(): void {
    this.stopped = true
    this.clear()
  }

  private restart(): void {
    this.clear()

    const bot = this.bot

    if (this.stopped || !this.visible || bot === null) {
      return
    }

    // At once: the moment a chat comes on screen is the moment a notification for it is not wanted.
    this.beat(bot)
    this.timer = setInterval(() => this.beat(bot), this.intervalMs)
  }

  private beat(bot: string): void {
    this.store.getState().beat(bot, this.now())
  }

  private clear(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** What is on screen: a bot's own chat, or one of its other conversations by its stored id. */
export interface OnScreen {
  bot: string
  /** The conversation's stored id, for one that is not the bot's chat; empty for the chat. */
  conversation: string
}

/**
 * Whether a notification is about what is on screen: the same bot, and the
 * conversation it names is the one shown. A notification about another
 * conversation of the bot (a branch, a session the notifier called `other`) stays
 * while the chat is on screen, and the chat's own stay while another
 * conversation is shown.
 */
export function aboutOnScreen(data: unknown, screen: OnScreen): boolean {
  if (!isObject(data) || text(data.bot) !== screen.bot) {
    return false
  }

  const kind = text(data.sessionKind)
  const conversation =
    text(data.type) === 'request' ? text(data.sessionKey) : text(data.sessionId) || text(data.session)

  if (screen.conversation) {
    return conversation === screen.conversation
  }

  return kind !== 'branch' && kind !== 'other'
}

/** Whether a notification is about this request. */
export function aboutRequest(data: unknown, requestId: string): boolean {
  return Boolean(requestId) && isObject(data) && (text(data.requestId) || text(data.request)) === requestId
}

/** Close every notification `matches` picks. Never rejects: a notification left on screen is not an error. */
export async function closeNotifications(
  notifications: () => Promise<readonly ShownNotificationHandle[]>,
  matches: (data: unknown) => boolean
): Promise<number> {
  let closed = 0

  try {
    for (const notification of await notifications()) {
      if (matches(notification.data)) {
        notification.close()
        closed += 1
      }
    }
  } catch {
    // No worker, or a browser that cannot list them: nothing to close here.
  }

  return closed
}
