/**
 * ADR-0017's app half, as one object with a lifetime.
 *
 * It owns four things and nothing else:
 *
 *  1. **Turning it on.** Permission, then an address from the platform, then a
 *     row in the store. The WRITE is somebody else's: `ui-meta-bridge.ts`
 *     notices the store and sends the app-wide section, which is what gives a
 *     registration ADR-0016's compare-and-swap and its offline behaviour for
 *     free. Nothing here talks to a gateway about a registration.
 *  2. **Keeping it fresh.** A push token is not permanent — a restore from
 *     backup, a reinstall of the OS, an Expo project rotation all change it —
 *     and a stale row is a device that has quietly stopped being notified with
 *     nothing on screen to say so. So the address is re-read on every
 *     foreground and the row re-stamped, which is also what tells the daemon
 *     this installation is still real.
 *  3. **The heartbeat.** `push.seen[<installation-id>]` while a chat is on
 *     screen, on a cadence rather than per render. ADR-0017 is explicit that
 *     this is a heuristic: the failure mode is a redundant notification for a
 *     chat somebody is already reading, and the cadence below is chosen to fail
 *     in that direction rather than to make the write cheap.
 *  4. **Taps.** Which is where the care is. See `actions.ts`: a notification
 *     selects a chat and nothing else, and an Allow or a Deny is re-checked
 *     against `approval.pending` before a single byte is sent.
 *
 * **What it deliberately does not do** is decide whether a notification should
 * have been sent. That is the daemon's, it runs next to the gateway, and the app
 * has no way to know what the other devices are doing.
 */
import { pushStampOf } from '@hermie/gateway-client/push'

import type { GatewayNamespace } from '../../gateway/namespace'
import type { RpcFailure } from '../../gateway/rpc-failures'
import { usePushStore, type PushState } from '../../store/push'
import { pushDestinationOf, pushTapOf, resolvePushTap, type OpenApproval } from './actions'
import type { PushAddressFailure, PushPermission, PushPlatform, PushResponse } from './platform-contract'

/**
 * How often `seen` is re-stamped while a chat is on screen.
 *
 * Every stamp is a `profiles.configure` on the gateway, so this is a rate as
 * much as a freshness. A minute is well inside any suppression window the daemon
 * would sensibly pick and is one write a minute from a device somebody is
 * actively reading on, which is the cheapest moment to spend one.
 */
export const PUSH_HEARTBEAT_MS = 60_000

/**
 * `system-settings` is the Mac build: no dialog was raised and nothing was
 * refused, so the switch stays where the reader put it and the row says where
 * to go. Treating it as a refusal is what made the toggle appear to do nothing.
 */
export type PushEnableOutcome = 'enabled' | 'denied' | 'unavailable' | 'system-settings'

/**
 * The ring entry a refused address becomes.
 *
 * It rides the `rpc-failures` ring rather than a ring of its own even though no
 * JSON-RPC call was made, and the reason is that the ring is what the debug
 * screen reads: a second ring would be a second screen nobody opens. `method`
 * is a pseudo-method so the row still says what was being attempted, which is
 * the shape every other entry has.
 */
export const PUSH_ADDRESS_METHOD = 'push.obtainAddress'

export function pushFailureEntry(failure: PushAddressFailure, at: number): RpcFailure {
  const message =
    failure.reason === 'no-project-id'
      ? 'no EAS project id in this build'
      : failure.reason === 'empty'
        ? 'the platform returned no address'
        : failure.reason === 'unsupported'
          ? (failure.message ?? 'this platform cannot mint an address')
          : failure.message

  return { at, method: PUSH_ADDRESS_METHOD, message }
}

/** The three things a tap needs from the rest of the app. */
export interface PushSyncPorts {
  /**
   * Bring that chat to the front, resuming it if it is not open.
   *
   * Every entry point resolves against the gateway before it shows anything —
   * the same rule the widgets and the deep link follow — so a bot that no longer
   * exists lands somewhere honest rather than on an empty screen.
   */
  showChat(bot: string): Promise<void>
  /**
   * Bring ONE of that bot's other conversations to the front, by its stored id.
   *
   * R4b's viewer, which is read-only and resolves the id against the gateway
   * like every other entry point here — so an id that names nothing lands on a
   * screen that says so rather than on an empty transcript.
   */
  showConversation(bot: string, sessionId: string): Promise<void>
  /**
   * Every id this app currently knows that bot's canonical chat by, or none.
   *
   * Two of them where the roster has been read: the STORED id and the RESOLVED
   * id are different strings for the same conversation and a notifier may carry
   * either. It is a question rather than a lookup table because the roster is
   * empty on a cold start from a notification, and `pushDestinationOf` has to
   * be able to tell "not the canonical one" from "nothing to compare against".
   */
  canonicalSessionIds(bot: string): readonly string[]
  /** What `approval.pending` says is open for that bot, asked just now. */
  openApprovals(bot: string): Promise<OpenApproval[]>
  respondApproval(bot: string, requestId: string, choice: string): Promise<void>
  /**
   * Move to the gateway a notification came from, and open the chat there.
   *
   * Answers TRUE when it actually switched, and false for every other case —
   * no key, a key this device does not recognise, or the key of the gateway
   * that is already live. A false answer means the tap is an ordinary one and
   * the three ports above handle it.
   *
   * It does the opening as well as the switching, and that is not tidiness: a
   * switch tears this object's own connection down, so the chat controller
   * these ports are bound to is stopped by the time it returns. Whatever opens
   * the chat has to be on the other side of that teardown.
   *
   * `sessionId` is the conversation to land on when the payload named one the
   * notifier itself classified as not the canonical chat. Empty otherwise —
   * including for a payload that named an id without saying what it was, because
   * the only thing that could tell those apart is the OTHER gateway's roster and
   * this side of the switch has never seen it.
   */
  switchToGateway(gatewayKey: string, bot: string, sessionId: string): Promise<boolean>
}

export interface PushSyncOptions {
  platform: PushPlatform
  ports: PushSyncPorts
  /**
   * The gateway this device is registering ON, or `null` in the wizard.
   *
   * A registration is only meaningful for one gateway (ADR-0017), so the store
   * it reads is that gateway's and the namespace has to come in from outside:
   * this class is built with a connection and dies with it, and the connection
   * knows which gateway it is.
   *
   * `null` is the setup step, which offers the switch before the gateway it
   * would register on has been written down. Nothing is read or persisted
   * there; the store carries the reader's answer in memory and the first
   * `hydrate` after setup adopts it. See `PushState.hydrate`.
   */
  namespace: GatewayNamespace | null
  /** `extra.eas.projectId`. Native only; a browser needs `vapidUrl` instead. */
  projectId?: string | null
  /** Where the daemon publishes its VAPID public key. Browser only. */
  vapidUrl?: string | null
  store?: { getState: () => PushState }
  now?: () => number
  heartbeatMs?: number
  /**
   * Where a refused address goes besides the store.
   *
   * The same sink the chat controller's absorbed gateway refusals use. A
   * registration that never happened is exactly the class of silent failure
   * that ring exists for — see `rpc-failures.ts` — and the owner's
   * `registrations: {}` is what happens without it.
   */
  onFailure?: (failure: RpcFailure) => void
}

export class PushSync {
  private readonly platform: PushPlatform
  private readonly ports: PushSyncPorts
  private readonly namespace: GatewayNamespace | null
  private readonly projectId: string | null
  private readonly vapidUrl: string | null
  private readonly store: { getState: () => PushState }
  private readonly now: () => number
  private readonly heartbeatMs: number
  private readonly onFailure: ((failure: RpcFailure) => void) | undefined

  private timer: ReturnType<typeof setInterval> | undefined
  private stopResponses: (() => void) | undefined
  private running = false
  private foreground = true
  private openBot: string | null = null
  /** One tap at a time, so a double tap cannot answer the same request twice. */
  private handling: Promise<void> = Promise.resolve()

  constructor(options: PushSyncOptions) {
    this.platform = options.platform
    this.ports = options.ports
    this.namespace = options.namespace
    this.projectId = options.projectId ?? null
    this.vapidUrl = options.vapidUrl ?? null
    this.store = options.store ?? usePushStore
    this.now = options.now ?? (() => Date.now())
    this.heartbeatMs = options.heartbeatMs ?? PUSH_HEARTBEAT_MS
    this.onFailure = options.onFailure
  }

  /**
   * Hydrate, prepare the platform, and start listening. Returns its teardown.
   *
   * The listener is wired even when notifications are OFF, because a tap can
   * arrive from a registration made before they were turned off and from a
   * notification that was already on the lock screen. Dropping it would leave a
   * notification that does nothing when tapped, which is worse than one that
   * opens a chat.
   */
  start(): () => void {
    if (this.running) {
      return () => this.stop()
    }

    this.running = true

    void this.boot()

    return () => this.stop()
  }

  stop(): void {
    this.running = false
    this.stopResponses?.()
    this.stopResponses = undefined
    this.clearTimer()
  }

  private async boot(): Promise<void> {
    // Nothing to read in the wizard: there is no gateway to key it by yet.
    if (this.namespace) {
      await this.store.getState().hydrate(this.namespace)
    }

    /*
      A chat can come on screen before the disk read finishes — it always does
      when the app is launched straight onto one — and a beat before the store
      has an installation id stamps nothing, because the id is the key `seen` is
      written under. Measured on a simulator on 2026-09-21: the registration
      reached the gateway and `seen` stayed `{}` for a full period afterwards,
      with a chat open the whole time. So the beat is retried here, once, now
      that there is something to key it by.
    */
    this.syncHeartbeat()

    if (!this.running || !this.platform.available) {
      return
    }

    await this.platform.prepare()

    if (!this.running) {
      return
    }

    this.stopResponses = this.platform.onResponse(response => this.onResponse(response))

    const initial = await this.platform.consumeInitialResponse()

    if (initial && this.running) {
      this.onResponse(initial)
    }

    // A registration made on an earlier launch is confirmed rather than assumed:
    // see the note on freshness at the top.
    await this.refresh()
  }

  // ── the switch ─────────────────────────────────────────────────────────────

  /**
   * Turn notifications on for this device.
   *
   * The store is flipped FIRST, so the switch in Settings moves under the
   * finger and the reader is not looking at a control that appears stuck while
   * a permission dialog is up. If no address comes back, `enabled` stays true
   * and the row simply is not written — which is the honest state: the reader
   * asked, and the platform has not agreed yet.
   */
  async enable(): Promise<PushEnableOutcome> {
    if (!this.platform.available) {
      return 'unavailable'
    }

    this.store.getState().setEnabled(true)

    const permission = await this.platform.requestPermission()

    if (permission !== 'granted') {
      /*
        On a platform that raises no dialog, a not-granted answer is not a
        refusal — the question was never put. Putting the switch back would
        report a decision nobody made, and it is what made the Mac's toggle
        look broken: it moved, nothing happened, and it moved back. It stays
        on, pending, and `refresh` picks the registration up on the foreground
        after System Settings has been visited.
      */
      if (this.platform.needsSystemSettings) {
        return 'system-settings'
      }

      this.store.getState().setEnabled(false)

      return permission === 'denied' ? 'denied' : 'unavailable'
    }

    return (await this.obtain()) ? 'enabled' : 'unavailable'
  }

  /** Open the pane that grants it, where the platform has one. */
  openSystemSettings(): Promise<boolean> {
    return this.platform.available ? this.platform.openSystemSettings() : Promise.resolve(false)
  }

  /** Whether this platform grants notifications in System Settings rather than a dialog. */
  get needsSystemSettings(): boolean {
    return this.platform.needsSystemSettings
  }

  /**
   * Run the whole flow again, for the Retry button in Settings.
   *
   * It is `enable` rather than `obtain` deliberately: a reader pressing Retry
   * after "token request failed" may also have granted permission in system
   * settings in between, and re-asking is free where it was already granted.
   * The switch is already on, so nothing moves under the finger.
   */
  retry(): Promise<PushEnableOutcome> {
    this.store.getState().setAddressFailure(null)

    return this.enable()
  }

  /** Turn them off, and take the row out of the section on the next flush. */
  async disable(): Promise<void> {
    this.store.getState().setEnabled(false)
    await this.platform.dropAddress()
  }

  /** What the platform currently says, for a screen that wants to explain. */
  permission(): Promise<PushPermission> {
    return this.platform.available ? this.platform.permission() : Promise.resolve('denied')
  }

  /**
   * Re-read the address and re-stamp the row. Called on every foreground.
   *
   * A no-op while notifications are off, and — importantly — it does not ask for
   * permission. A reader who revoked it in system settings gets their row
   * removed rather than a dialog they did not open the app for.
   */
  async refresh(): Promise<void> {
    const state = this.store.getState()

    if (!state.loaded || !state.enabled || !this.platform.available) {
      return
    }

    if ((await this.platform.permission()) !== 'granted') {
      /*
        On a platform with no dialog this is the PENDING state, not a
        revocation: the reader turned the switch on, was told to visit System
        Settings, and has not done it yet. Switching it off here would undo
        their decision on every foreground — and this is also the retry the
        Mac needs, because the moment they come back from System Settings is a
        foreground and the branch below then registers.
      */
      if (this.platform.needsSystemSettings) {
        return
      }

      // Revoked outside the app. The switch follows the system, because a
      // switch that says ON while nothing can arrive is the one lie a settings
      // screen must not tell.
      this.store.getState().setEnabled(false)

      return
    }

    await this.obtain()
  }

  /**
   * Ask the platform for an address, and keep whichever answer came back.
   *
   * Both halves matter. A refusal is written to the store so Settings can name
   * it, and pushed to the failure ring so it survives the screen being closed —
   * `obtainAddress` swallowing every error into a `null` is the whole of why a
   * gateway held a heartbeat and no registration.
   */
  private async obtain(): Promise<boolean> {
    let result

    try {
      result = await this.platform.obtainAddress({ projectId: this.projectId, vapidUrl: this.vapidUrl })
    } catch (error) {
      // A platform that throws out of `obtainAddress` rather than answering is
      // the same outcome with worse manners, and it must not take `enable` down
      // with it.
      result = {
        address: null,
        failure: { reason: 'failed' as const, message: error instanceof Error ? error.message : String(error ?? '') }
      }
    }

    if (!result.address) {
      this.noteFailure(result.failure)

      return false
    }

    this.store.getState().setAddress(result.address, pushStampOf(this.now()))

    return true
  }

  private noteFailure(failure: PushAddressFailure): void {
    this.store.getState().setAddressFailure(failure)
    this.onFailure?.(pushFailureEntry(failure, this.now()))
  }

  /**
   * Take this device out of the section, for a sign-out or a change of gateway.
   *
   * The caller has to await this BEFORE the socket goes, which is why it is not
   * folded into the store's own reset: a registration is only meaningful for the
   * gateway it was made on, and the write that removes it needs that gateway.
   */
  async retire(): Promise<void> {
    this.store.getState().retire()
    await this.platform.dropAddress()
  }

  // ── the heartbeat ──────────────────────────────────────────────────────────

  /** Which chat is on screen, or `null`. Drives the heartbeat with `foreground`. */
  setOpenChat(bot: string | null): void {
    if (this.openBot === bot) {
      return
    }

    this.openBot = bot
    this.syncHeartbeat()
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) {
      return
    }

    this.foreground = foreground
    this.syncHeartbeat()
  }

  /** Stamp now. Public so a test can drive the cadence without a clock. */
  beat(): void {
    // The chat on screen travels with the stamp. `openBot` is null only when
    // the heartbeat is not wanted at all, so an empty name here is the harmless
    // "some chat" an older build could also say.
    this.store.getState().beat(this.openBot ?? '', pushStampOf(this.now()))
  }

  private syncHeartbeat(): void {
    const wanted = this.running && this.foreground && this.openBot !== null

    if (!wanted) {
      this.clearTimer()

      return
    }

    if (this.timer !== undefined) {
      // Already running. The one case worth acting on is a timer whose first
      // beat stamped nothing because the store had no id yet; see `boot`.
      if (!this.store.getState().seen[this.store.getState().installationId]) {
        this.beat()
      }

      return
    }

    // Immediately, then on the cadence: the interesting moment is the one where
    // a chat has just come on screen, and waiting a full period to say so is
    // exactly the window in which a redundant notification goes out.
    this.beat()
    this.timer = setInterval(() => this.beat(), this.heartbeatMs)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  // ── taps ───────────────────────────────────────────────────────────────────

  private onResponse(response: PushResponse): void {
    this.handling = this.handling.then(() => this.handle(response)).catch(() => undefined)
  }

  private async handle(response: PushResponse): Promise<void> {
    const tap = pushTapOf(response)

    if (!tap) {
      return
    }

    /*
      A notification from another gateway moves the app before anything else.

      And then stops. An Allow on such a notification opens the chat and
      answers nothing, which is ADR-0017's own rule taken to its conclusion: a
      response has to be validated against `approval.pending` ON THE GATEWAY
      THAT ASKED, and that gateway's connection does not exist until the switch
      has finished. The reader lands on the request and answers it there, which
      is the direction this feature is built to fail in.
    */
    /*
      What the NOTIFIER said, without asking this gateway anything.

      Computed before the switch because it is the only part of the destination
      that survives one: a payload that says `branch` says it about the gateway
      it came from, while an id with no kind can only be placed against a roster
      this side has not read. So the switch is told about the first and nothing
      about the second, and the tap lands on that gateway's chat — which is what
      a cross-gateway tap did before conversations existed.
    */
    const stated = pushDestinationOf({ tap, canonicalIds: [] })

    if (
      await this.ports.switchToGateway(tap.gatewayKey, tap.bot, stated.kind === 'conversation' ? stated.sessionId : '')
    ) {
      return
    }

    const destination =
      stated.kind === 'conversation'
        ? stated
        : pushDestinationOf({ tap, canonicalIds: this.ports.canonicalSessionIds(tap.bot) })

    /*
      A conversation that is not the bot's chat opens, and nothing else happens.

      The same rule the cross-gateway tap above follows, and for the same
      reason: an Allow has to be re-validated against `approval.pending` for the
      session that ASKED, and that session is not the one this controller
      resumed. Answering the canonical chat's oldest open request instead would
      be answering a different question than the one on the lock screen. The
      reader lands on the request and answers it there.
    */
    if (destination.kind === 'conversation') {
      await this.ports.showConversation(tap.bot, destination.sessionId)

      return
    }

    // The chat first, always. It is what an Allow needs anyway — the gateway is
    // asked for that session's open requests — and it is the whole of what a
    // plain tap does.
    await this.ports.showChat(tap.bot)

    if (tap.action === 'open') {
      return
    }

    const intent = resolvePushTap({ tap, pending: await this.ports.openApprovals(tap.bot) })

    if (intent.kind === 'respond') {
      await this.ports.respondApproval(intent.bot, intent.requestId, intent.choice)
    }

    // `open-chat` needs nothing further: the chat is already in front, and what
    // the reader sees there is the request as it actually stands.
  }
}
