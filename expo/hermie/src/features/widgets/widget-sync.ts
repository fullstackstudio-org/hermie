/**
 * Keeps the home-screen widgets' file in step with the app, and stops there.
 *
 * The widgets read one JSON file out of a shared container (`platform/widgets`)
 * and are redrawn when it changes. This is the only thing that writes it. It
 * owns three decisions and nothing else:
 *
 *  - **When.** Every store that feeds a widget is subscribed to, and every
 *    notification restarts one debounce timer. A streaming turn notifies the
 *    chat store on every token, so an undebounced writer would rewrite the file
 *    a hundred times a second and ask WidgetKit to reload each time — which on
 *    a device does not mean a hundred redraws, it means the budget is spent and
 *    the widget stops updating for the rest of the day.
 *  - **Whether.** A write that would draw the same pixels is dropped
 *    (`sameWidgetContent`). That is what makes the debounce safe to keep short:
 *    the timer decides how quickly a real change lands, and the comparison
 *    decides whether anything is spent on a change that is not one.
 *  - **Avatars, once each.** A bot's picture is a data URL in the roster store
 *    and a file in the container, so it is written the first time it is seen and
 *    on every change, and never again. The bookkeeping is here rather than in
 *    the native module because the module is the dumb half on purpose.
 *
 * It never throws and never rejects. A widget that is one turn out of date is a
 * widget; a chat that failed to render because a file write went wrong is a bug.
 */
import { intentQueue } from '../../platform/intent-queue'
import { widgetBridge, type WidgetBridge } from '../../platform/widgets'
import { useBotsStore, type BotsState } from '../../store/bots'
import { useChatLayoutStore, type ChatLayoutState } from '../../store/chat-layout'
import { useSettingsStore, type SettingsState } from '../../store/settings'
import { useChatsStore, type ChatsState } from '../../store/chats'
import { projectWidgetSnapshot, sameWidgetContent, type WidgetSnapshot } from './snapshot'

/**
 * Long enough that a streaming turn writes once rather than per token, short
 * enough that a reply which lands while the reader is looking at the home screen
 * is there by the time they look again. WidgetKit coalesces reload requests on
 * its own schedule anyway, so pushing this lower buys nothing.
 */
export const WIDGET_SYNC_DEBOUNCE_MS = 1_500

type Unsubscribe = () => void

interface Stores {
  bots: { getState: () => BotsState; subscribe: (listener: () => void) => Unsubscribe }
  chats: { getState: () => ChatsState; subscribe: (listener: () => void) => Unsubscribe }
  layout: { getState: () => ChatLayoutState; subscribe: (listener: () => void) => Unsubscribe }
  /** For the name order alone — see `projectBot`'s `label`. */
  settings: { getState: () => SettingsState; subscribe: (listener: () => void) => Unsubscribe }
}

/**
 * The system's own search index, as the one thing it needs told.
 *
 * Structural rather than the whole `IntentQueue`, because this class uses one
 * of that seam's three methods and a test should not have to stub a Shortcuts
 * queue to prove something about a snapshot.
 */
export interface SpotlightIndex {
  indexBots(bots: readonly { name: string; label: string; subtitle: string }[]): Promise<boolean>
}

export interface WidgetSyncOptions {
  bridge?: WidgetBridge
  stores?: Stores
  debounceMs?: number
  now?: () => number
  spotlight?: SpotlightIndex
}

export class WidgetSync {
  private readonly bridge: WidgetBridge
  private readonly stores: Stores
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly spotlight: SpotlightIndex

  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private paused = false
  private gatewayReady = false
  /** The active gateway's address, so the file can name the gateway it describes. */
  private gatewayAddress = ''
  /**
   * The value `pause()` froze, or null while the app is in the foreground.
   *
   * It exists because the first version of `pause()` did not have it and did not
   * work. Reading `gatewayReady` at the top of `pause()` is not enough: the write
   * it starts is serialised behind `inFlight` and then awaits the avatar pass, so
   * it reads the flag several microtasks later — by which time React has
   * re-rendered, the effect on `status` has run, and the flag says what
   * backgrounding did to the socket rather than what was true when the home
   * button was pressed. Measured on a simulator: four grey beads, again, with the
   * `pause()` already in place.
   */
  private frozenGatewayReady: boolean | null = null
  /** The last content actually written, so an unchanged one costs nothing. */
  private written: WidgetSnapshot | null = null
  /** bot name → the data URL whose bytes are already in the container. */
  private avatarsWritten = new Map<string, string>()
  /** One write at a time; a second request while one is in flight re-runs after. */
  private inFlight: Promise<void> = Promise.resolve()

  constructor(options: WidgetSyncOptions = {}) {
    this.bridge = options.bridge ?? widgetBridge
    this.stores = options.stores ?? {
      bots: useBotsStore,
      chats: useChatsStore,
      layout: useChatLayoutStore,
      settings: useSettingsStore
    }
    this.debounceMs = options.debounceMs ?? WIDGET_SYNC_DEBOUNCE_MS
    this.now = options.now ?? (() => Date.now())
    this.spotlight = options.spotlight ?? intentQueue
  }

  /**
   * Subscribe to everything a widget reads. Returns its own teardown, which is
   * what `ChatRuntimeProvider` calls when the connection is replaced.
   *
   * A no-op where there is no container. The subscriptions themselves are cheap,
   * but the projection is a pass over the whole roster and every open chat, and
   * running it on every token of every turn to throw the answer away is not.
   */
  start(): Unsubscribe {
    if (!this.bridge.available || this.running) {
      return () => undefined
    }

    this.running = true

    const stop = [
      this.stores.bots.subscribe(() => this.schedule()),
      this.stores.chats.subscribe(() => this.schedule()),
      this.stores.layout.subscribe(() => this.schedule()),
      // The name order is the only thing here a widget reads, and switching it
      // has to reach the home screen without waiting for the next message.
      this.stores.settings.subscribe(() => this.schedule())
    ]

    // One write straight away, so a widget added while the app was closed has
    // something to draw before the first store notification arrives.
    this.schedule()

    return () => {
      this.running = false
      this.clearTimer()
      for (const unsubscribe of stop) {
        unsubscribe()
      }
    }
  }

  /**
   * Which gateway the rows being written belong to. Pushed in for the same
   * reason `setGatewayReady` is: the registry lives in a React context and this
   * class has no React in it.
   */
  setGatewayAddress(address: string): void {
    if (address === this.gatewayAddress) {
      return
    }

    this.gatewayAddress = address

    if (!this.paused) {
      this.schedule()
    }
  }

  /**
   * Whether the gateway socket is usable. It is pushed in rather than read,
   * because `status` lives in a React context and this class has no React in it.
   *
   * It matters more than it looks: `presenceOf` answers `offline` for everything
   * when the gateway is not ready, and a widget showing four green dots for a
   * gateway the phone cannot reach is the one lie a glanceable surface must not
   * tell.
   */
  setGatewayReady(ready: boolean): void {
    if (ready === this.gatewayReady) {
      return
    }

    // While paused the value is recorded and nothing is written. That is the
    // whole of the fix described on `pause()`: the socket going down BECAUSE the
    // app was backgrounded must not reach the home screen as "every bot is
    // offline".
    this.gatewayReady = ready

    if (!this.paused) {
      this.schedule()
    }
  }

  /**
   * Stop writing, after one last write of what is true right now.
   *
   * Called the moment the app goes to the background, and it exists because of
   * something measured on a simulator on 2026-09-21: the widget showed every bot
   * OFFLINE a second after the home button was pressed, with a snapshot stamped
   * at that exact moment. That was not a bug in presence — it was presence being
   * right about the wrong question. `attachLifecycle` tears the socket down when
   * a phone backgrounds the app (`src/gateway/client.ts`), `presenceOf` answers
   * `offline` for every bot when the gateway is not ready, and the background
   * flush then wrote that down and asked WidgetKit to draw it. So the home
   * screen's last word on four live agents was four grey beads, caused by
   * looking at the home screen.
   *
   * A widget cannot know what a bot is doing while the app is not running. What
   * it can honestly show is the last thing the app saw, and `generatedAt` is in
   * the file so it can say when. So: write once here, synchronously, while the
   * answer is still the foreground one, and then go quiet until the app is back.
   *
   * The ordering is what makes this work and it is worth stating. Both this and
   * the gateway's own pause hang off the same `AppState` change, and their
   * registration order is not something to rely on — but `setGatewayReady` is
   * driven by a React effect on `status`, which cannot run until a re-render, and
   * a re-render cannot happen inside the listener that called this. So the flag
   * this reads is necessarily still the foreground one, whichever listener ran
   * first.
   */
  pause(): void {
    if (this.paused) {
      return
    }

    this.paused = true
    // Synchronously, before anything can yield. See `frozenGatewayReady`.
    this.frozenGatewayReady = this.gatewayReady
    this.clearTimer()
    void this.write()
  }

  /** Back in the foreground: write what is true now, and start listening again. */
  resume(): void {
    if (!this.paused) {
      return
    }

    this.paused = false
    this.frozenGatewayReady = null
    void this.flush()
  }

  /**
   * Write now, skipping the debounce. Called when the app comes to the front:
   * the reader has just come back from the home screen they were looking at, so
   * the next thing worth doing is making sure what they saw there was true.
   */
  async flush(): Promise<void> {
    this.clearTimer()
    await this.write()
  }

  private schedule(): void {
    if (!this.running || this.paused) {
      return
    }

    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.write()
    }, this.debounceMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Serialised behind `inFlight`, so two writes cannot interleave their files. */
  private write(): Promise<void> {
    this.inFlight = this.inFlight.then(() => this.writeOnce()).catch(() => undefined)

    return this.inFlight
  }

  private async writeOnce(): Promise<void> {
    if (!this.bridge.available) {
      return
    }

    const bots = this.stores.bots.getState()
    const layout = this.stores.layout.getState()

    // Before the projection, because the projection reports which bots have a
    // picture and the answer has to be true by the time it is written down.
    await this.syncAvatars(bots.avatars)

    const snapshot = projectWidgetSnapshot({
      bots: bots.bots,
      nameOrder: this.stores.settings.getState().botNameOrder,
      hideHandleWhenNamed: this.stores.settings.getState().hideHandleWhenNamed,
      labels: layout.labels,
      chats: this.stores.chats.getState().chats,
      running: bots.running,
      lastSeen: bots.lastSeen,
      accents: layout.accents,
      archived: layout.archived,
      // The arrangement itself, for the folder a widget can be pinned to. It is
      // the only part of the owner's list order that reaches a home screen —
      // see `projectWidgetSnapshot` on why the rows are ordered by recency and
      // this is not.
      folders: layout.folders,
      mutes: layout.mutes,
      gatewayReady: this.frozenGatewayReady ?? this.gatewayReady,
      gatewayAddress: this.gatewayAddress,
      avatars: Object.fromEntries([...this.avatarsWritten.keys()].map(name => [name, true as const])),
      now: this.now()
    })

    if (sameWidgetContent(this.written, snapshot)) {
      return
    }

    if (await this.bridge.writeSnapshot(JSON.stringify(snapshot))) {
      this.written = snapshot
      await this.index(snapshot)
    }
  }

  /**
   * Put the roster in the system's own search index.
   *
   * Hung off the widget write rather than given a schedule of its own, and the
   * reason is that this class already answers the question Spotlight is asking.
   * "The roster changed in a way somebody would see" is precisely what
   * `sameWidgetContent` decides, and it is already debounced — so an index pass
   * costs one call on exactly the edges that matter, and a streaming turn does
   * not reindex the roster a hundred times a second.
   *
   * The SUBTITLE is the last line rather than the presence, because Spotlight
   * shows one row and a reader looking for a chat is looking for what was said
   * in it. A bot with nothing in it yet gets an empty subtitle, which the index
   * draws as a single line, rather than the word "Offline" — which would be
   * true of every bot on a phone whose app is not running, which is every phone
   * where somebody is using Spotlight.
   */
  private async index(snapshot: WidgetSnapshot): Promise<void> {
    await this.spotlight
      .indexBots(snapshot.bots.map(bot => ({ name: bot.name, label: bot.displayName, subtitle: bot.lastLine })))
      .catch(() => false)
  }

  /**
   * One PNG per bot that has one, written once.
   *
   * The roster holds avatars as the data URL `profiles.get_asset` returns, and
   * the container wants bytes, so the prefix is taken off here. A URL whose
   * shape is not the one expected is skipped rather than written as garbage: the
   * widget then draws the initials, which is the same thing the app's own
   * `Avatar` does for a picture it cannot load.
   */
  private async syncAvatars(avatars: Record<string, string>): Promise<void> {
    for (const [name, dataUrl] of Object.entries(avatars)) {
      if (this.avatarsWritten.get(name) === dataUrl) {
        continue
      }

      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)

      if (!dataUrl.startsWith('data:') || !base64) {
        continue
      }

      if (await this.bridge.writeAvatar(name, base64)) {
        this.avatarsWritten.set(name, dataUrl)
      }
    }

    // A bot that left the roster leaves its picture behind otherwise, and a
    // shared container is not somewhere to accumulate files nobody will read.
    const keep = Object.keys(avatars)

    if (keep.length !== this.avatarsWritten.size) {
      await this.bridge.pruneAvatars(keep)

      for (const name of [...this.avatarsWritten.keys()]) {
        if (!(name in avatars)) {
          this.avatarsWritten.delete(name)
        }
      }
    }
  }
}
