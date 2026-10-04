/**
 * Web Push for one page on one gateway: turning it on and off, keeping the
 * registration true, and acting on clicks (plan W-25, ADR-0017's app half).
 *
 *  1. **On.** From a gesture in Settings: the permission is asked first (before
 *     anything else is awaited, so the browser still counts the gesture), then
 *     the worker is registered, the browser subscribed with the advert's key
 *     (`subscriptionStep`), and the address and a fresh `updatedAt` put in the
 *     store. The bridge writes the row (`core/ui-meta-bridge.ts`); nothing here
 *     talks to the gateway about a registration.
 *  2. **True on every launch.** Once the advert is read: a subscription made with
 *     another key is dropped and made again with the advert's, and the row is
 *     written again with a fresh `updatedAt` either way. That is also what brings
 *     back a row the plugin retired (a 403, a 404/410): it is lifted only by a
 *     newer `updatedAt`. The same check runs when the advert's key changes while
 *     the page is open, and when the page comes back into view after
 *     `PUSH_REFRESH_MS`. A permission withdrawn in the browser turns the switch
 *     off, because a switch that says on while nothing can arrive is the one
 *     thing a settings screen must not say.
 *  3. **Off, and sign-out.** The switch off takes the row out of the next write
 *     and unsubscribes. A sign-out does the same, waiting for the write to land
 *     before the connection goes (`signOut`).
 *  4. **Clicks** (`actions.ts`): the conversation the notification names comes
 *     to the front; an Allow or a Deny answers only when `approval.pending`,
 *     asked just now, still lists that request in that session with that choice,
 *     and only when the worker posted it to an open window: the click a cold
 *     start carries in its address opens and never answers (see `start`). One
 *     click at a time, so a double click cannot answer twice.
 *
 * Errors are kept for Settings in the browser's own words, cut short; nothing a
 * notification says and no part of a subscription is ever logged.
 */
import type { StoreApi } from 'zustand/vanilla'

import type { PluginState } from '../../state/plugin'
import type { PushController, PushState, PushTestOutcome } from '../../state/push'
import {
  answersInPlace,
  type OpenApproval,
  type PushResponse,
  type PushTap,
  pushTapOf,
  resolvePushTap,
  responseOfMessage
} from './actions'
import type { GatewayClock } from './clock'
import { type PushBrowser, type PushSupport, pushSupport } from './platform'
import { addressOfSubscription, applicationServerKeyBytes, canonicalKey, subscriptionStep } from './row'

/** How long a row may go unwritten while the page is open before it is written again on the way back into view. */
export const PUSH_REFRESH_MS = 6 * 60 * 60 * 1000

/** How long an Allow or a Deny waits for the chat it lands on to attach to its session. */
export const ATTACH_TIMEOUT_MS = 15_000

/** The longest failure message kept for Settings. */
export const MAX_FAILURE_LENGTH = 200

/** The plugin's test notification route (plan, API Changes; plugin P-4). */
export const PUSH_TEST_PATH = '/api/plugins/hermie/push/test'

/** The browser's own words for a failure, on one line, cut short. Never a subscription or a payload. */
export function failureOf(error: unknown): string {
  // A DOMException is an Error in a browser, not everywhere: its message is read either way.
  const message = (error as { message?: unknown } | null)?.message
  const raw = typeof message === 'string' ? message : String(error ?? '')

  return raw.replace(/\s+/gu, ' ').trim().slice(0, MAX_FAILURE_LENGTH) || 'no message'
}

/** What a click needs from the rest of the page. */
export interface PushTapPorts {
  /** Bring the tap's conversation to the front. True when that is the bot's own chat. */
  show(tap: PushTap): boolean
  /** The runtime session the bot's chat is attached to, waiting up to `timeoutMs`; `''` when it is not. */
  attachedSession(bot: string, timeoutMs: number): Promise<string>
  /** What `approval.pending` says is open for the bot's chat, asked now. */
  openApprovals(bot: string): Promise<readonly OpenApproval[]>
  respondApproval(bot: string, requestId: string, choice: string): Promise<void>
}

export interface PushSyncOptions {
  browser: PushBrowser
  store: StoreApi<PushState>
  plugin: StoreApi<PluginState>
  clock: GatewayClock
  /** The gateway's base URL, for the test route. */
  baseUrl: string
  /** The headers an authenticated request to the gateway carries (`GatewayHttp.requestHeaders`). */
  headers: () => Promise<Record<string, string>>
  taps: PushTapPorts
  fetch?: typeof fetch
  refreshMs?: number
  attachTimeoutMs?: number
}

export class PushSync implements PushController {
  private readonly browser: PushBrowser
  private readonly store: StoreApi<PushState>
  private readonly plugin: StoreApi<PluginState>
  private readonly clock: GatewayClock
  private readonly baseUrl: string
  private readonly headers: () => Promise<Record<string, string>>
  private readonly taps: PushTapPorts
  private readonly request: typeof fetch
  private readonly refreshMs: number
  private readonly attachTimeoutMs: number
  private teardown: (() => void)[] = []
  private running = false
  /** The advert key the last launch check ran against; a different one runs it again. */
  private checkedKey: string | null = null
  private checking: Promise<void> | null = null
  private handling: Promise<void> = Promise.resolve()

  constructor(options: PushSyncOptions) {
    this.browser = options.browser
    this.store = options.store
    this.plugin = options.plugin
    this.clock = options.clock
    this.baseUrl = options.baseUrl
    this.headers = options.headers
    this.taps = options.taps
    this.request = options.fetch ?? ((input, init) => fetch(input, init))
    this.refreshMs = options.refreshMs ?? PUSH_REFRESH_MS
    this.attachTimeoutMs = options.attachTimeoutMs ?? ATTACH_TIMEOUT_MS
  }

  /** Listen for clicks, act on the one this page was opened for, and check the registration once the advert is in. */
  start(launch: PushResponse | null = null): () => void {
    if (this.running) {
      return () => this.stop()
    }

    this.running = true
    this.store.getState().bindController(this)
    this.teardown.push(
      this.browser.onMessage(message => {
        const response = responseOfMessage(message)

        if (response) {
          this.onResponse(response)
        }
      }),
      this.plugin.subscribe(() => this.checkSoon())
    )

    if (launch) {
      /*
        Opened, never answered. The address a cold start carries can be written by anyone who can make
        this browser follow a link, not only by the worker, so an Allow or a Deny in it is read as a
        plain click: the conversation opens with the request on screen, and the reader answers it there.
        Only a click the worker posts to an open window (same origin, `onMessage`) may answer.
      */
      this.onResponse({ ...launch, actionIdentifier: 'default' })
    }

    this.checkSoon()

    return () => this.stop()
  }

  stop(): void {
    if (!this.running) {
      return
    }

    this.running = false

    for (const off of this.teardown.splice(0)) {
      off()
    }

    if (this.store.getState().controller === this) {
      this.store.getState().bindController(null)
    }
  }

  /** Whether this browser can be notified by this gateway, now. */
  support(): PushSupport {
    return pushSupport(this.browser.environment(), this.plugin.getState())
  }

  /** The page came back into view: a row not written for a while is written again. */
  onVisible(): void {
    const state = this.store.getState()

    if (state.enabled && state.address && this.clock.now() / 1000 - state.updatedAt > this.refreshMs / 1000) {
      this.checkedKey = null
      this.checkSoon()
    }
  }

  // MARK: - The switch

  async enable(): Promise<void> {
    const support = this.support()

    if (!support.ok) {
      return
    }

    this.store.getState().setFailure(null)

    // Asked before anything is awaited: the browser only shows the prompt inside the gesture.
    const permission = await this.browser.requestPermission()

    if (permission !== 'granted') {
      // Refused, or dismissed: the switch follows the browser. Settings says which.
      this.store.getState().setEnabled(false)

      return
    }

    this.store.getState().setEnabled(true)
    await this.busy(() => this.subscribe(support.publicKey, false))
    this.checkedKey = canonicalKey(support.publicKey)
  }

  async disable(): Promise<void> {
    this.store.getState().setEnabled(false)
    await this.busy(() => this.unsubscribe())
  }

  async reregister(): Promise<void> {
    const support = this.support()

    if (!support.ok || !this.store.getState().enabled) {
      return
    }

    await this.busy(() => this.subscribe(support.publicKey, true))
    this.checkedKey = canonicalKey(support.publicKey)
  }

  /**
   * Sign-out: the row leaves the section (`flush` sends the write and waits for
   * it, while the connection is still there), then the subscription goes.
   */
  async signOut(flush: () => Promise<void>): Promise<void> {
    const had = this.store.getState().enabled

    this.store.getState().retire()

    try {
      await flush()
    } catch {
      // The row stays until another write or the plugin's own retirement on a 404/410.
    }

    if (had) {
      await this.unsubscribe()
    }
  }

  /** Ask the plugin for a test notification to this browser (`push.test`). */
  async sendTest(): Promise<PushTestOutcome> {
    const installationId = this.store.getState().installationId

    let response: Response

    try {
      response = await this.request(`${this.baseUrl}${PUSH_TEST_PATH}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...(await this.headers()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ installation_id: installationId })
      })
    } catch {
      return { kind: 'failed', status: 0 }
    }

    if (response.status === 404) {
      return { kind: 'not-registered' }
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'))

      return { kind: 'busy', retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 10 }
    }

    if (!response.ok) {
      return { kind: 'failed', status: response.status }
    }

    const body = (await response.json().catch(() => null)) as { outcome?: unknown } | null
    const outcome = typeof body?.outcome === 'string' ? body.outcome : ''

    return outcome === 'sent' ? { kind: 'sent' } : { kind: 'refused', outcome: outcome || 'failed' }
  }

  // MARK: - The launch check

  /** Run the launch check when the advert has a key it has not run against yet. */
  private checkSoon(): void {
    if (!this.running || this.checking) {
      return
    }

    const support = this.support()

    if (!support.ok && support.reason === 'unknown') {
      return
    }

    const key = support.ok ? canonicalKey(support.publicKey) : ''

    if (key === this.checkedKey) {
      return
    }

    this.checkedKey = key
    this.checking = this.check(support).finally(() => {
      this.checking = null
      // The advert may have moved while the check ran.
      this.checkSoon()
    })
  }

  private async check(support: PushSupport): Promise<void> {
    const store = this.store.getState()

    store.setPhase('checking')

    try {
      if (!store.enabled || !support.ok) {
        // Off, or not possible here (Settings says why): no row is written.
        return
      }

      if (this.browser.permission() !== 'granted') {
        // Withdrawn in the browser: the switch follows.
        this.store.getState().setEnabled(false)

        return
      }

      await this.busy(() => this.subscribe(support.publicKey, false))
    } finally {
      this.store.getState().setPhase('settled')
    }
  }

  // MARK: - The subscription

  private async busy(work: () => Promise<void>): Promise<void> {
    this.store.getState().setBusy(true)

    try {
      await work()
    } catch (error) {
      this.store.getState().setFailure(failureOf(error))
    } finally {
      this.store.getState().setBusy(false)
    }
  }

  /** Subscribe with `publicKey` (again when `force`, or when the one held was made with another key), and stamp the row. */
  private async subscribe(publicKey: string, force: boolean): Promise<void> {
    const keyBytes = applicationServerKeyBytes(publicKey)

    if (!keyBytes) {
      throw new Error('the gateway published a key that is not a P-256 public key')
    }

    const worker = await this.browser.worker()
    let subscription = await worker.getSubscription()
    const held = subscription ? subscription.key() || this.store.getState().subscribedKey : null
    const step = force && subscription ? 'resubscribe' : subscriptionStep(held, publicKey)

    if (step === 'resubscribe' && subscription) {
      // A browser refuses a second subscription with another key while the first exists.
      await subscription.unsubscribe().catch(() => false)
      subscription = null
    }

    if (!subscription) {
      subscription = await worker.subscribe(keyBytes)
    }

    const address = addressOfSubscription(subscription.json(), publicKey)

    if (!address) {
      throw new Error('the browser returned a subscription without an endpoint or keys')
    }

    await this.clock.measure()

    if (!this.store.getState().enabled) {
      // Switched off while this ran: the subscription just made is not wanted.
      await subscription.unsubscribe().catch(() => false)

      return
    }

    this.store.getState().setAddress(address, Math.floor(this.clock.now() / 1000))
  }

  private async unsubscribe(): Promise<void> {
    const worker = await this.browser.existingWorker().catch(() => null)
    const subscription = await worker?.getSubscription().catch(() => null)

    // The row leaving the section is what stops the sends; an endpoint the browser
    // would not let go of is retired by the plugin on its next 404/410.
    await subscription?.unsubscribe().catch(() => false)
  }

  // MARK: - Clicks

  private onResponse(response: PushResponse): void {
    this.handling = this.handling.then(() => this.handle(response)).catch(() => undefined)
  }

  private async handle(response: PushResponse): Promise<void> {
    const tap = pushTapOf(response)

    if (!tap || tap.isClear) {
      return
    }

    const inChat = this.taps.show(tap)

    if (tap.action === 'open' || !inChat || !answersInPlace(tap)) {
      return
    }

    const sessionId = await this.taps.attachedSession(tap.bot, this.attachTimeoutMs)

    if (!sessionId) {
      return
    }

    const intent = resolvePushTap(tap, { sessionId, approvals: await this.taps.openApprovals(tap.bot) })

    if (intent.kind === 'respond') {
      await this.taps.respondApproval(tap.bot, intent.requestId, intent.choice)
    }
  }
}
