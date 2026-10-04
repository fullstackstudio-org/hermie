/**
 * The page's one connection to its gateway, and what keeps it alive.
 *
 * Three layers, each usable on its own:
 *
 *  - `createGatewayConnection`: a `GatewayConnection` on the boot's credentials
 *    over the page's `WebSocket`: the gateway's cookie session
 *    (`CookieSessionCredentials`, narrowed to `same-origin` by the boot), where
 *    every dial mints its own ticket, or on a gateway without sign-in the session
 *    token (`SessionTokenCredentials`), which every dial carries as `?token=`.
 *  - `attachLifecycle`: when the connection dials, closes and dials again, from
 *    the page's visibility and the browser's network reports (below).
 *  - `connectGateway`: the two together, plus the stores and the roster: the
 *    status goes to `state/connection.ts`, the roster is painted from the cache
 *    and read again on every arrival at `ready`, and the plugin advert is taken
 *    off the same `profiles.list` answer into `state/plugin.ts`.
 *
 * The lifecycle, as rules:
 *
 *  1. **Dial when visible.** A page that loads hidden (a restored background
 *     tab) does not dial until it is first shown.
 *  2. **The network is advice.** `online`/`offline` go to `setOnline`, which
 *     labels the status `offline`, takes a live socket down after the package's
 *     grace (`OFFLINE_GRACE_MS`) and collapses the backoff when the network
 *     returns. A report never stops the dial ladder: the page was loaded from
 *     this gateway, which can be reachable with no network interface at all (a
 *     gateway on the same machine), and `navigator.onLine` cannot know that.
 *  3. **Hidden for more than `HIDDEN_GRACE_MS` (60 s) closes the socket**
 *     (`pause`). A hidden tab may be throttled to a stop, and a socket nobody
 *     reads only holds a gateway worker. Shown again within the grace, nothing
 *     happens: switching tabs for a moment must not rebuild every session.
 *  4. **Shown again after a close dials at once** (`resume`): a fresh ticket,
 *     because a ticket is single use, and the replay of every session the page
 *     holds a watermark for (`session.events.since`), which the package's
 *     client does by itself on every reconnect. Shown again while the ladder is
 *     climbing collapses the pending backoff (`retryNow`), because timers in a
 *     hidden tab run late.
 *  5. **A connection that stopped for a reason is left alone.** `needs_signin`
 *     and `incompatible` are not paused by rule 3 and not resumed by rule 4:
 *     dialling again fails the same way and erases the explanation.
 *
 * Ported from the Expo app's `src/gateway/client.ts`. Deliberate differences:
 *
 *  - **The cookie session, or a session token in memory.** The secret-store
 *    token store, the memory token store, the token coordinator and
 *    `NativePkceCredentials` are gone: a page stores no credential (plan W5). A
 *    gateway without sign-in is the one exception, and its token is held only by
 *    the `SessionTokenCredentials` the boot made (W-23). The credentials are the
 *    boot's (`signed_in.session.credentials` or `token_ready.session.credentials`),
 *    handed in, so the connection and the boot share one session.
 *  - **No `endGatewaySession`.** Sign-out is `boot/login-bounce.ts::signOut`,
 *    which ends the cookie session the same way and then clears the page's
 *    storage; the caller stops the connection first (`GatewayClient.stop`).
 *  - **Visibility instead of `AppState`, the W-6 seams instead of net-info.**
 *    React Native paused on `background` at once; a page waits 60 s first
 *    (rule 3), and a page that loads hidden does not dial (rule 1).
 *  - **No Mac and no desktop-shell branch.** Both kept the socket while hidden
 *    because a window there is not about to be killed. This client is a page
 *    in a browser tab; the desktop shell that loads it (plan W16) is a later
 *    task and will decide its own rule there.
 *  - **One namespace.** No `GatewayNamespace`: the page's gateway is its own
 *    origin, and the stores it writes are already keyed by the base path.
 *  - **No share-extension credential.** There is no share extension.
 *  - **The chat store reaches the roster.** The Expo app built its roster
 *    controller inside the same provider that held the chat store, and gave it
 *    the store so a busy session could be attributed to a bot by the ids the
 *    open chats hold. Here `connectGateway` builds the controller, so it takes
 *    the chat store as an option (`chats`, the page's own by default): without
 *    it the running indicator could only see sessions it knew from the roster.
 *  - `connectGateway` is new: it is the React-free part of what the Expo app's
 *    `GatewayProvider` and `ChatRuntime` components did with a connection
 *    (status to the store, roster on `ready`, stores emptied on teardown).
 */
import {
  AuthTimeline,
  type AuthTimelineSink,
  type ConnectionStatus,
  type CredentialProvider,
  type DialPlanSocketFactory,
  type FetchLike,
  GatewayConnection,
  type GatewayConnectionOptions,
  type GatewayHttp
} from '@hermie/gateway-client'
import type { StoreApi } from 'zustand/vanilla'

import type { ChatCache } from '../platform/chat-cache'
import type { KeyValueStore } from '../platform/key-value-store'
import { type NetworkWatcher, networkWatcher } from '../platform/net-info'
import { createSocketFactory } from '../platform/socket'
import { type VisibilityWatcher, visibilityWatcher } from '../platform/visibility'
import { type BotsState, botsStore } from '../state/bots'
import { chatsStore } from '../state/chats'
import { connectionStore, type ConnectionStoreState } from '../state/connection'
import { pluginStore, type PluginState } from '../state/plugin'
import { webPluginAdvert } from './advert'
import { BotsController, type ChatSessionIdSource } from './bots-controller'
import { type ChatGateway, chatGatewayFor } from './link'

/** How long a hidden page keeps its socket (rule 3 above). */
export const HIDDEN_GRACE_MS = 60_000

/** The connection settings a test may shorten; everything else is fixed here. */
export type ConnectionTuning = Pick<
  GatewayConnectionOptions,
  | 'backoffDelayMs'
  | 'readyTimeoutMs'
  | 'heartbeatIntervalMs'
  | 'heartbeatDeadlineMs'
  | 'connectTimeoutMs'
  | 'offlineGraceMs'
  | 'now'
>

export interface CreateConnectionOptions {
  /** The gateway's base URL: the page's origin plus its prefix (`ResolvedBasePath.baseUrl`). */
  baseUrl: string
  /** The boot's credentials: the cookie session (a ticket per dial) or the session token (`?token=`). */
  credentials: CredentialProvider
  /** The page's `fetch` unless told otherwise, for the connection's REST half. */
  fetchImpl?: FetchLike
  /** The page's `WebSocket` unless told otherwise. */
  socketFactory?: DialPlanSocketFactory
  /** Where dials and refusals are recorded. */
  timeline?: AuthTimelineSink
  tuning?: ConnectionTuning
}

/**
 * The page's `fetch`, looked up when called and never called as a method of
 * something else ("Illegal invocation" in some browsers).
 */
const pageFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/** Build the page's connection. The caller owns `start()` / `stop()`, or hands it to `attachLifecycle`. */
export function createGatewayConnection(options: CreateConnectionOptions): GatewayConnection {
  return new GatewayConnection({
    config: { baseUrl: options.baseUrl, authMode: options.credentials.mode },
    credentials: options.credentials,
    socketFactory: options.socketFactory ?? createSocketFactory(),
    fetchImpl: options.fetchImpl ?? pageFetch,
    ...(options.timeline ? { timeline: options.timeline } : {}),
    ...options.tuning
  })
}

/** The part of a `GatewayConnection` the lifecycle drives, so a test can hand in five functions. */
export interface LifecycleConnection {
  readonly status: ConnectionStatus
  start(): void
  pause(): void
  resume(): void
  retryNow(): void
  setOnline(online: boolean): void
}

export interface LifecycleOptions {
  /** The page's own unless told otherwise. */
  visibility?: VisibilityWatcher
  /** The page's own unless told otherwise. */
  network?: NetworkWatcher
  /** Rule 3; `HIDDEN_GRACE_MS` unless told otherwise. */
  hiddenGraceMs?: number
}

/** Statuses a connection stops in for a reason it can explain (rule 5). */
const EXPLAINED_STOPS: ReadonlySet<ConnectionStatus> = new Set(['needs_signin', 'incompatible'])

/**
 * Follow the page's visibility and the browser's network reports (rules 1 to 5
 * at the top of this file). Starts the connection itself, when the page is
 * first visible. Returns the detach, which leaves the connection as it is.
 */
export function attachLifecycle(connection: LifecycleConnection, options: LifecycleOptions = {}): () => void {
  const visibility = options.visibility ?? visibilityWatcher
  const network = options.network ?? networkWatcher
  const graceMs = options.hiddenGraceMs ?? HIDDEN_GRACE_MS

  let started = false
  /** True only while the connection is paused because this lifecycle paused it. */
  let pausedHere = false
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined

  const clearHiddenTimer = () => {
    if (hiddenTimer !== undefined) {
      clearTimeout(hiddenTimer)
      hiddenTimer = undefined
    }
  }

  const onVisible = () => {
    clearHiddenTimer()

    if (!started) {
      started = true
      connection.start()

      return
    }

    if (pausedHere) {
      pausedHere = false
      connection.resume()

      return
    }

    // Harmless on a live socket, a dial in flight or an explained stop: it only
    // cuts short a backoff that a throttled hidden tab may have stretched.
    connection.retryNow()
  }

  const onHidden = () => {
    if (!started || pausedHere || hiddenTimer !== undefined) {
      return
    }

    hiddenTimer = setTimeout(() => {
      hiddenTimer = undefined

      if (EXPLAINED_STOPS.has(connection.status)) {
        return
      }

      connection.pause()
      pausedHere = connection.status === 'paused'
    }, graceMs)
  }

  // The network first, so a page that loads offline dials labelled as such.
  const stopNetwork = network.subscribe(online => connection.setOnline(online))
  const stopVisibility = visibility.subscribe(next => (next === 'visible' ? onVisible() : onHidden()))

  if (visibility.current() === 'visible') {
    onVisible()
  }

  return () => {
    clearHiddenTimer()
    stopVisibility()
    stopNetwork()
  }
}

/** The stores `connectGateway` writes; the page's own unless a test hands in its own. */
export interface GatewayStores {
  connection: StoreApi<ConnectionStoreState>
  bots: StoreApi<BotsState>
  plugin: StoreApi<PluginState>
}

export interface ConnectGatewayOptions extends CreateConnectionOptions, LifecycleOptions {
  /** This gateway's key-value store: the read watermarks are read from and written to it. */
  storage: KeyValueStore
  /** This gateway's transcript cache: the roster paints from it before the socket is up. */
  cache?: ChatCache | null
  /**
   * The chat store, whose session ids attribute a busy session to a bot (the
   * roster's running indicator). The page's own unless told otherwise: it is the
   * store `connectChats` fills, so the two meet without being introduced.
   */
  chats?: ChatSessionIdSource
  stores?: Partial<GatewayStores>
}

/** What W-7b's chat controller and the shell program against. */
export interface GatewayClient {
  readonly connection: GatewayConnection
  /** The connection as the chat layer sees it. */
  readonly gateway: ChatGateway
  /** The REST half, on the same session. */
  readonly http: GatewayHttp
  readonly bots: BotsController
  readonly stores: GatewayStores
  /** Settles once the watermarks are read and the cached roster is painted. Never rejects. */
  readonly hydrated: Promise<void>
  /**
   * Close the connection for good and empty the stores it filled (sign-out:
   * call this before `signOut`). Idempotent.
   */
  stop(): void
}

/**
 * Connect the page to its gateway and keep it connected (see the rules at the
 * top of this file). The stores are reset first, so nothing of an earlier
 * connection shows.
 */
export function connectGateway(options: ConnectGatewayOptions): GatewayClient {
  const stores: GatewayStores = {
    connection: options.stores?.connection ?? connectionStore,
    bots: options.stores?.bots ?? botsStore,
    plugin: options.stores?.plugin ?? pluginStore
  }

  stores.connection.getState().reset()
  stores.bots.getState().reset()
  stores.plugin.getState().reset()

  const timeline =
    options.timeline ?? new AuthTimeline({ sink: snapshot => stores.connection.getState().setAuthTimeline(snapshot) })
  const connection = createGatewayConnection({ ...options, timeline })
  const gateway = chatGatewayFor(connection)
  const bots = new BotsController({
    gateway,
    store: stores.bots,
    cache: options.cache ?? null,
    chats: options.chats ?? chatsStore,
    onRoster: result => stores.plugin.getState().apply(webPluginAdvert(result))
  })

  /*
    The roster is read when the connection becomes usable and again after every
    reconnect, never before: `profiles.list` on a connection still dialling
    fails with "gateway not connected", and a list that took that as its answer
    sat on an error under a header saying Connected (the Expo app's
    `ChatRuntime`, which this is the React-free half of).
  */
  let wasReady = false
  const stopStatus = connection.onStatus((status, error) => {
    stores.connection.getState().setStatus(status, error)

    if (status !== 'ready') {
      wasReady = false

      return
    }

    if (!wasReady) {
      wasReady = true
      void bots.refresh().catch(() => undefined)
    }
  })

  let stopped = false

  const hydrated = (async () => {
    await stores.bots
      .getState()
      .hydrateLastSeen(options.storage)
      .catch(() => undefined)

    if (!stopped) {
      await bots.paintFromCache()
    }

    // A cache read that was in the air when the connection stopped must not
    // paint the roster of somebody who has just signed out.
    if (stopped) {
      stores.bots.getState().reset()
    }
  })()

  const detach = attachLifecycle(connection, options)

  return {
    connection,
    gateway,
    http: connection.http,
    bots,
    stores,
    hydrated,
    stop() {
      if (stopped) {
        return
      }

      stopped = true
      detach()
      stopStatus()
      connection.stop()
      bots.dispose()
      stores.connection.getState().reset()
      stores.bots.getState().reset()
      stores.plugin.getState().reset()
    }
  }
}
