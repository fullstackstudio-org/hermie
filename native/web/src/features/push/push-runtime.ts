/**
 * Web Push, wired to the page: the controller (`core/push/sync.ts`) on this
 * session's gateway, with the router, the chats and the request queue as its
 * ports.
 *
 * Loaded as a chunk of its own once the session has started
 * (`features/shell/session.ts`): nothing on the first screen waits for it, and
 * the click a cold start carries (`?hermiePush=`) has been read out of the address
 * before it loads, by the entry module, so a route change in between cannot lose
 * it.
 *
 *  - **Where a click lands** is a route of this client's router
 *    (`features/sessions/push-destination.ts`, W-22): the bot's chat, or the
 *    conversation the notifier called a branch or another one, in the read-only
 *    viewer.
 *  - **The heartbeat** runs while the route is a bot's chat (not a conversation
 *    in the viewer) and the page is visible (`core/push/seen.ts`).
 *  - **What is already dealt with** goes: a chat coming on screen closes its
 *    notifications, a conversation in the viewer closes its own, and a request
 *    that leaves the queue (answered here or elsewhere, withdrawn) closes the
 *    notification about it. Only notifications already on screen are touched;
 *    the worker is never registered for it.
 */
import { gatewayKeyOf } from '@hermie/gateway-client'
import type { StoreApi } from 'zustand/vanilla'

import type { ChatRuntime } from '../../core/chat-controller'
import { conversationIdOf, type PushResponse, type PushTap } from '../../core/push/actions'
import { createGatewayClock, type GatewayClock } from '../../core/push/clock'
import type { PushBrowser } from '../../core/push/platform'
import { aboutOnScreen, aboutRequest, closeNotifications, type OnScreen, PushHeartbeat } from '../../core/push/seen'
import { PushSync } from '../../core/push/sync'
import { type HashRouter, pageHashRouter } from '../../platform/hash-router'
import type { WebKeyValueStore } from '../../platform/key-value-store'
import { type VisibilityWatcher, visibilityWatcher } from '../../platform/visibility'
import { pagePushBrowser } from '../../platform/web-push'
import type { BotsState } from '../../state/bots'
import type { PluginState } from '../../state/plugin'
import { type PushState, pushStore } from '../../state/push'
import { type OpenRequest, type RequestsState, requestsStore } from '../../state/requests'
import { pushRouteOf } from '../sessions/push-destination'
import { formatRoute, parseRoute } from '../shell/router'

/** How often a page in view asks whether its row is due to be written again. */
export const REFRESH_CHECK_MS = 60 * 60 * 1000

export interface StartPushOptions {
  /** The gateway's base URL: origin plus prefix, no trailing slash. */
  baseUrl: string
  storage: WebKeyValueStore
  chats: Pick<ChatRuntime, 'controller' | 'chats'>
  bots: StoreApi<BotsState>
  plugin: StoreApi<PluginState>
  /** The headers an authenticated request carries (`GatewayHttp.requestHeaders`). */
  headers: () => Promise<Record<string, string>>
  /** The click this page was opened for, already taken out of the address. */
  launch?: PushResponse | null
  /** The page's own unless a test hands in its own. */
  store?: StoreApi<PushState>
  browser?: PushBrowser
  router?: HashRouter
  visibility?: VisibilityWatcher
  requests?: StoreApi<RequestsState>
  clock?: GatewayClock
}

export interface PushRuntime {
  readonly sync: PushSync
  /** Take this browser's row out (waiting on `flush` to send it) and unsubscribe. For sign-out. */
  signOut(flush: () => Promise<void>): Promise<void>
  /** Stop listening. Idempotent. */
  stop(): void
}

/** Every id a request on the queue is known by: what a notification may name it with. */
function requestIdsOf(queue: readonly OpenRequest[]): Set<string> {
  const ids = new Set<string>()

  for (const entry of queue) {
    switch (entry.kind) {
      case 'engine':
        ids.add(entry.item.requestId)

        if (entry.item.kind === 'approval' && entry.item.approvalId) {
          ids.add(entry.item.approvalId)
        }

        break
      case 'confirm':
      case 'secure':
      case 'interactive':
        ids.add(entry.id)
        break
      case 'connection':
        break
    }
  }

  return ids
}

export function startPush(options: StartPushOptions): PushRuntime {
  const store = options.store ?? pushStore
  const browser = options.browser ?? pagePushBrowser
  const router = options.router ?? pageHashRouter
  const visibility = options.visibility ?? visibilityWatcher
  const requests = options.requests ?? requestsStore
  const clock = options.clock ?? createGatewayClock({ baseUrl: options.baseUrl })
  const chats = options.chats.chats

  store.getState().hydrate(options.storage)
  store.getState().setGatewayKey(gatewayKeyOf(options.baseUrl))
  void clock.measure()

  /** Every id the page knows the bot's own chat by: the roster's and the chat's, stored and resolved. */
  const canonicalIds = (bot: string): string[] => {
    const ids = new Set<string>()
    const canonical = options.bots.getState().bots.find(row => row.name === bot)?.canonical
    const chat = chats.getState().chats[bot]

    for (const id of [canonical?.id, canonical?.resolvedId, chat?.storedSessionId, chat?.resolvedSessionId]) {
      if (id) {
        ids.add(id)
      }
    }

    return [...ids]
  }

  const show = (tap: PushTap): boolean => {
    const route = pushRouteOf(
      { bot: tap.bot, sessionId: conversationIdOf(tap), sessionKind: tap.sessionKind },
      canonicalIds(tap.bot)
    )

    router.navigate(formatRoute(route))

    return route.name === 'chat' && route.session === undefined
  }

  const attachedSession = (bot: string, timeoutMs: number): Promise<string> =>
    new Promise(resolve => {
      const now = chats.getState().chats[bot]?.runtimeSessionId

      if (now) {
        resolve(now)

        return
      }

      const timer = setTimeout(() => {
        off()
        resolve('')
      }, timeoutMs)
      const off = chats.subscribe(state => {
        const id = state.chats[bot]?.runtimeSessionId

        if (id) {
          clearTimeout(timer)
          off()
          resolve(id)
        }
      })
    })

  const sync = new PushSync({
    browser,
    store,
    plugin: options.plugin,
    clock,
    baseUrl: options.baseUrl,
    headers: options.headers,
    taps: {
      show,
      attachedSession,
      openApprovals: bot => options.chats.controller.openApprovals(bot),
      /*
        The notification names the queue's id; a chat that holds the request as an open card holds it under
        its server request id, and answering that one is what closes the card on the reply it waits on.
      */
      respondApproval: (bot, requestId, choice) => {
        const items = Object.values(chats.getState().chats[bot]?.items ?? {})
        const card = items.find(
          item => item.kind === 'approval' && item.approvalId === requestId && item.state === 'open'
        )

        return options.chats.controller.respondApproval(
          bot,
          card?.kind === 'approval' ? card.requestId : requestId,
          choice
        )
      }
    }
  })

  const heartbeat = new PushHeartbeat({ store, now: () => Math.floor(clock.now() / 1000) })

  /** Close what is about the screen, without registering a worker where none is. */
  const notifications = async () => (await browser.existingWorker().catch(() => null))?.notifications() ?? []

  let screen: OnScreen | null = null

  /*
    The plugin is the only reader of the heartbeat: on a gateway without one, a
    write a minute into the person's section would say something to nobody.
  */
  const beatFor = (): void => {
    const notifier = options.plugin.getState().advert !== null

    heartbeat.setOpenChat(notifier && screen && !screen.conversation ? screen.bot : null)
  }

  const stopPlugin = options.plugin.subscribe(beatFor)

  const follow = (hash: string): void => {
    const route = parseRoute(hash)

    screen = route?.name === 'chat' ? { bot: route.bot, conversation: route.session ?? '' } : null
    beatFor()

    const shown = screen

    if (shown && visibility.current() === 'visible') {
      void closeNotifications(notifications, data => aboutOnScreen(data, shown))
    }
  }

  const stopRoute = router.subscribe(follow)

  follow(router.current())
  heartbeat.setVisible(visibility.current() === 'visible')

  const stopVisibility = visibility.subscribe(state => {
    heartbeat.setVisible(state === 'visible')

    if (state === 'visible') {
      sync.onVisible()
      follow(router.current())
    }
  })

  let open = requestIdsOf(requests.getState().queue)
  const stopRequests = requests.subscribe(state => {
    const now = requestIdsOf(state.queue)
    const gone = [...open].filter(id => !now.has(id))

    open = now

    if (gone.length > 0) {
      void closeNotifications(notifications, data => gone.some(id => aboutRequest(data, id)))
    }
  })

  sync.start(options.launch ?? null)

  // A page left open and in view for days writes its row again too (`PushSync.onVisible` decides when).
  const refresh = setInterval(() => {
    if (visibility.current() === 'visible') {
      sync.onVisible()
    }
  }, REFRESH_CHECK_MS)

  let stopped = false

  return {
    sync,
    signOut: flush => sync.signOut(flush),
    stop() {
      if (stopped) {
        return
      }

      stopped = true
      clearInterval(refresh)
      stopRoute()
      stopPlugin()
      stopVisibility()
      stopRequests()
      heartbeat.stop()
      sync.stop()
      // What this session held (an address, a heartbeat) is not the next session's.
      store.getState().reset()
    }
  }
}
