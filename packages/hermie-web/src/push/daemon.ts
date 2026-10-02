/**
 * `hermie-web --push`: the thing that is awake when nobody is looking.
 *
 * [ADR-0017](../../../../docs/adr/0017-push-through-hermie-web.md) in one
 * paragraph: an app that is not running has no socket — iOS suspends it within
 * seconds of backgrounding and Android's Doze does the equivalent — so
 * something that is always running has to watch, and it has to be something the
 * owner already runs. This process already sits next to the gateway, so it is
 * the one.
 *
 * This file owns the LIFECYCLE and nothing else: one connection, the state file
 * around it, and a clean stop. What to notify about is `watcher.ts`, how to
 * reach a device is `expo.ts` and `web-push.ts`, and who asked to be told is
 * `registrations.ts`.
 */
import { CACHE_ROW_LIMIT, type TranscriptCacheSink } from '../cache'
import { PUSH_PUBLIC_KEY_PATH } from '../options'
import { type PushCredentials, resolveCredentials } from './credentials'
import { GatewayLink, type LinkEvent, type LinkServerRequest } from './link'
import { RELAY_DEFAULT_ORIGIN, relayAllowList } from './relay'
import { createSender, pollExpoReceipts, RECEIPT_POLL_INTERVAL_MS } from './senders'
import type { PushType } from './registrations'
import { loadPushState, prunePushState, type PushState, savePushState } from './state'
import { gatewayApiUrl } from './credentials'
import {
  APPROVAL_POLL_MS,
  AVAILABILITY_TTL_SECONDS,
  PushWatcher,
  type PushSender,
  type WatcherOptions
} from './watcher'
import { generateVapidKeys, vapidKeysUsable } from './web-push'

/**
 * How long a session's cache refresh waits for the turn to settle.
 *
 * Long enough that one answer is one read, short enough that a person who
 * finished reading a reply and opened the chat on another device finds it
 * already there.
 */
const CACHE_DEBOUNCE_MS = 3_000

export interface PushDaemonOptions {
  gatewayUrl: string
  /** Hermie Web's own version, written into the availability stamp. */
  version?: string
  /** The session token an ungated gateway takes; empty on a gated one. */
  gatewayToken?: string
  stateDir: string
  log?: (line: string) => void
  /** Injected by the tests. */
  socketFactory?: (url: string, protocols?: string[]) => WebSocket
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  fetchImpl?: typeof fetch
  /** Called after every connect, once the link is live and the watcher has resumed. */
  onOpen?: (link: GatewayLink) => Promise<void> | void
  onEvent?: (event: LinkEvent) => void
  onServerRequest?: (request: LinkServerRequest) => void
  /** The `sub` claim of the VAPID token: a `mailto:` or `https:` contact. */
  vapidSubject?: string
  /**
   * What the operator decided about one person and one bot (`/admin`).
   *
   * Read on every send rather than captured, because the admin page can change
   * it while the daemon is running and a daemon holding a stale copy would go
   * on notifying somebody an operator has just turned off.
   */
  allowedTo?: (owner: string, bot: string) => boolean
  /** The service-wide push ceiling an operator set on `/admin`. See the watcher. */
  policy?: () => { types: Record<PushType, boolean>; preview: 'device' | 'never' }
  /**
   * Ask the gateway to route server→client requests to this connection.
   *
   * Off by default. See `link.ts`: it is only safe on a backend that fans a
   * request out to every peer of a session, and on one that does not, a daemon
   * holding a question open has taken it from the owner.
   */
  serverRequests?: boolean
  /**
   * The relay allow-list (`--push-relays`). Absent means the project's own
   * relay only; see `options.ts`.
   */
  relays?: readonly string[]
  /**
   * Replace the transports. The default sends through Expo and Web Push; the
   * tests hand in a recorder.
   */
  sender?: PushSender
  /** Off for a link-only test that has no business resuming anything. */
  watch?: boolean
  /**
   * The message cache to feed
   * ([ADR-0025](../../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
   *
   * The daemon is the half of the feed that works when nobody is looking: it
   * already resumes every canonical Bot Chat for push, so it already knows
   * which chats exist and already hears when one moves. Absent means the cache
   * is fed only by proxied traffic, which is what a deployment without
   * `--push` gets.
   */
  cache?: TranscriptCacheSink
  /** How long a session's cache refresh waits for more events. Tests drive it to zero. */
  cacheDebounceMs?: number
  /** Off in the tests, which have no use for a quarter-hourly timer. */
  pollReceipts?: boolean
  /** The watcher's clocks, so a test does not have to wait out the real ones. */
  tuning?: Pick<
    WatcherOptions,
    | 'approvalPollMs'
    | 'attachedWindowSeconds'
    | 'availabilityTtlSeconds'
    | 'openingGraceMs'
    | 'rateLimit'
    | 'registrationTtlMs'
  >
}

export interface PushDaemon {
  link: GatewayLink
  credentials: PushCredentials
  state: PushState
  /** The watcher, when this daemon was asked to watch. */
  watcher: PushWatcher | null
  /** The public half of the VAPID key pair, base64url — what `GET /push/vapid-public-key` serves. */
  vapidPublicKey: string
  /** Persist the state file. Debounced by the caller, not here. */
  save(): Promise<void>
  stop(): Promise<void>
}

export async function startPushDaemon(options: PushDaemonOptions): Promise<PushDaemon> {
  const log = options.log ?? ((line: string) => console.warn(line))
  const state = prunePushState(await loadPushState(options.stateDir), Math.floor(Date.now() / 1000))
  /*
    Generated once and then never again. A browser's `PushSubscription` is bound
    to the application-server key that created it, so a daemon that minted a new
    pair on every start would silently orphan every web registration it had ever
    handed out — the subscriptions would still exist and every send to them
    would be refused.
  */
  const vapid = { keys: state.vapid ?? generateVapidKeys(), subject: options.vapidSubject ?? 'https://hermie.dev' }

  if (!vapidKeysUsable(state.vapid)) {
    if (state.vapid) {
      log('push: the stored VAPID key pair could not be read; a new one was generated')
      vapid.keys = generateVapidKeys()
    }

    state.vapid = vapid.keys
  }

  let link: GatewayLink | null = null
  const relays = relayAllowList(options.relays ?? [RELAY_DEFAULT_ORIGIN])

  const save = async (): Promise<void> => {
    // The link is the authority on how far each session has been read; the file
    // is only where that survives a restart.
    Object.assign(state.seq, link?.snapshotWatermarks() ?? {})
    await savePushState(options.stateDir, state)
  }

  const credentials = resolveCredentials({
    gatewayUrl: options.gatewayUrl,
    token: options.gatewayToken || undefined,
    state,
    persist: async stored => {
      state.oidc = stored
      await save()
    },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  })

  let watcher: PushWatcher | null = null

  /**
   * Five rows off the REST transcript, or `null` for a gateway that has no REST
   * surface. The same route and the same `null` contract as the app's
   * `fetchMessages`; the watcher falls back to `session.history` on `null`.
   */
  const fetchTail = async (sessionId: string, limit: number): Promise<Record<string, unknown>[] | null> => {
    const url = gatewayApiUrl(
      options.gatewayUrl,
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${String(limit)}&order=latest`
    )

    try {
      const response = await (options.fetchImpl ?? fetch)(url, { headers: await credentials.httpHeaders() })

      if (!response.ok) {
        return null
      }

      const body = (await response.json()) as { messages?: unknown; rows?: unknown }
      const rows = body?.messages ?? body?.rows

      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
    } catch {
      return null
    }
  }

  /**
   * Put one session's tail in the cache.
   *
   * The REST transcript first, because it is paginated and `session.history` is
   * not: a chat with thousands of rows would otherwise be a multi-megabyte
   * download every time it moved, for a cache entry that keeps two hundred
   * rows. The RPC is the fallback for a gateway with no REST surface, and its
   * shape travels with the rows because the two name their fields differently.
   */
  const refreshCache = async (bot: { name: string; sessionId: string; storedId: string }): Promise<void> => {
    if (!options.cache?.enabled) {
      return
    }

    const rest = await fetchTail(bot.sessionId, CACHE_ROW_LIMIT)
    let rows = rest
    let shape: 'rest' | 'rpc' = 'rest'

    if (rows === null) {
      const result = await (link as GatewayLink)
        .request<{ messages?: unknown }>('session.history', { session_id: bot.sessionId, profile: bot.name })
        .catch(() => null)

      rows = Array.isArray(result?.messages) ? (result.messages as Record<string, unknown>[]) : []
      shape = 'rpc'
    }

    await options.cache.put({
      sessionId: bot.sessionId,
      bot: bot.name,
      // No owner: this is the canonical Bot Chat, resumed off the roster, and
      // ADR-0007 makes it one conversation shared by everybody who can reach
      // the bot. The cache says so explicitly rather than by omission, because
      // every OTHER feed now has to name somebody.
      owner: '',
      storedId: bot.storedId,
      shape,
      rows,
      updatedAt: 0
    })
  }

  /*
    One pending refresh per session, at most.

    A finished turn arrives as a run of events, and a chat being talked to
    produces one every few seconds. Refreshing on each of them would re-read the
    same two hundred rows several times for one answer; waiting a moment past
    the last one reads them once, after the turn has actually settled.
  */
  const cacheTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const scheduleCacheRefresh = (sessionId: string): void => {
    if (!options.cache?.enabled || cacheTimers.has(sessionId)) {
      return
    }

    const timer = setTimeout(() => {
      cacheTimers.delete(sessionId)

      const bot = watcher?.watched.find(entry => entry.sessionId === sessionId)

      if (bot) {
        void refreshCache(bot).catch(() => undefined)
      }
    }, options.cacheDebounceMs ?? CACHE_DEBOUNCE_MS)

    timer.unref?.()
    cacheTimers.set(sessionId, timer)
  }

  link = new GatewayLink({
    dial: () => credentials.dial(),
    onEvent: event => {
      watcher?.onEvent(event)

      // The same event the watcher decides to notify about: a turn that has
      // finished is a transcript that has changed, and nothing else here is.
      if (event.type === 'message.complete' && event.session_id) {
        scheduleCacheRefresh(event.session_id)
      }

      options.onEvent?.(event)
    },
    onServerRequest: request => {
      watcher?.onServerRequest(request)
      options.onServerRequest?.(request)
    },
    onOpen: async (): Promise<void> => {
      // Resuming is what subscribes this connection to a session's events, so
      // it happens on EVERY connect and not only on the first.
      await watcher?.resumeAll()

      /*
        Fill the cache for every chat the roster names.

        Deliberately AFTER the resume and deliberately not awaited by the
        caller's `onOpen`: a browser that opens a chat while this is still
        running gets a 404 from the cache and paints the way it always did,
        which is the right failure. Holding the connect open for a few hundred
        rows per bot would delay the thing this connection exists for.
      */
      for (const bot of watcher?.watched ?? []) {
        void refreshCache(bot).catch(() => undefined)
      }

      await options.onOpen?.(link as GatewayLink)
    },
    log,
    advertiseServerRequests: options.serverRequests === true,
    ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {})
  })

  const sender =
    options.sender ??
    createSender({
      state,
      vapid,
      log,
      relays,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    })

  if (options.watch !== false) {
    watcher = new PushWatcher({
      link,
      state,
      save,
      sender,
      log,
      // So every notification says which gateway it came from, for a device
      // that is set up against more than one.
      gatewayUrl: options.gatewayUrl,
      // Informational only. ADR-0017: the app never dials this; it reads the
      // stamp so Settings can say whether push is available at all.
      availability: () => ({
        endpoint: PUSH_PUBLIC_KEY_PATH,
        vapidPublicKey: vapid.keys.publicKey,
        version: options.version ?? '0.0.0',
        /*
          What this notifier can deliver to, as the plugin's capability
          strings, and the relays it will post to, as the plugin publishes its
          own. `push.relay` only while the project's relay is on the list: the
          native app registers there, so a daemon that may not post there would
          be inviting a row it will never deliver.
        */
        capabilities: ['push.expo', 'push.webpush', ...(relays.includes(RELAY_DEFAULT_ORIGIN) ? ['push.relay'] : [])],
        relayOrigins: relays
      }),
      fetchTail,
      ...(options.allowedTo ? { allowedTo: options.allowedTo } : {}),
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.tuning ?? {})
    })
  }

  /*
    Receipts, not tickets. Expo answers a send with a ticket, which only says the
    request was accepted; whether Apple or Google took it is in a receipt read
    afterwards by ticket id, and it is not ready at send time. This is the sweep
    that reads them back and retires the tokens they condemn.
  */
  const receipts =
    options.pollReceipts === false
      ? null
      : setInterval(() => {
          void pollExpoReceipts(state, {
            state,
            vapid,
            log,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
          })
            .then(result => (result.dead.length || result.expired ? save() : undefined))
            .catch(() => undefined)
        }, RECEIPT_POLL_INTERVAL_MS)

  receipts?.unref()

  /*
    The liveness stamp has to keep moving on a quiet gateway too. Settings reads
    it to say whether push is available, and "available" is a claim about NOW —
    a stamp that only advanced when a chat did would say the daemon had stopped
    every time nobody talked to a bot overnight.
  */
  const heartbeat =
    options.pollReceipts === false || !watcher
      ? null
      : setInterval(
          () => {
            void watcher?.announce().catch(() => undefined)
          },
          (AVAILABILITY_TTL_SECONDS / 2) * 1000
        )

  heartbeat?.unref()

  /*
    The approval queue, on the app's own cadence.

    Without advertising `client.capabilities {server_requests: true}` — which is
    opt-in for the reason `link.ts` gives — a question that opens while nothing
    is attached reaches the daemon only through a resume snapshot or through
    this. The watcher skips the work entirely while nobody is registered.
  */
  const approvalPollMs = options.tuning?.approvalPollMs ?? APPROVAL_POLL_MS
  const approvals =
    !watcher || approvalPollMs <= 0
      ? null
      : setInterval(() => {
          void watcher?.pollApprovals().catch(() => undefined)
        }, approvalPollMs)

  approvals?.unref()

  // A restart must not replay everything the gateway still has in its ring.
  for (const [sessionId, seq] of Object.entries(state.seq)) {
    link.seedWatermark(sessionId, seq)
  }

  log(`push: watching ${options.gatewayUrl} (${credentials.mode} credential), state in ${options.stateDir}`)
  await save()
  link.start()

  return {
    link,
    credentials,
    state,
    watcher,
    vapidPublicKey: vapid.keys.publicKey,
    save,
    async stop() {
      for (const timer of cacheTimers.values()) {
        clearTimeout(timer)
      }

      cacheTimers.clear()

      if (receipts) {
        clearInterval(receipts)
      }

      if (heartbeat) {
        clearInterval(heartbeat)
      }

      if (approvals) {
        clearInterval(approvals)
      }

      await link?.stop()
      await watcher?.settle()
      await save()
    }
  }
}
