/**
 * Whether this browser can be notified by this gateway, and the browser's half of
 * it: the service worker, the permission and the `PushSubscription`.
 *
 * **What has to be true** (plan W-25), each a different sentence in Settings:
 *
 *  - a secure context (`https:`, or `localhost` and `127.0.0.1`): the Push API
 *    and service workers do not exist on plain http;
 *  - a browser with service workers, `PushManager` and `Notification`. Safari on
 *    an iPhone or iPad has them only for a web app added to the Home Screen and
 *    opened from there, which is said as such rather than as "not supported";
 *  - a plugin on the gateway (an advert at all) that sends Web Push
 *    (`push.webpush`) and publishes the key it signs with (`push.webpush.key` with
 *    `webPush.publicKey`, plan W13). A plugin that claims the first and not the
 *    second predates the key, and a subscription made against no key it can name
 *    would be refused by every push service.
 *
 * **The service worker** is `./sw.js` beside the page, registered with the page's
 * directory as its scope (the route sends no `Service-Worker-Allowed`, so it
 * cannot be wider). The page's policy requires Trusted Types for script URLs and
 * allows exactly one policy, `hermie-service-worker` (`index.html`,
 * `scripts/web/check-bundle.mjs`); it is created here, once, and turns nothing
 * into a script URL but that one address. Without it Chromium refuses the
 * registration outright.
 *
 * Everything that touches the browser goes through `PushBrowser`
 * (`platform/web-push.ts`), so the rules above it are tested without one.
 */
import { hasPluginCapability } from '@hermie/gateway-client/plugin'

import { type WebPluginAdvert, webPushPublicKey } from '../advert'

/** The worker, beside the page. */
export const SERVICE_WORKER_URL = './sw.js'

/** Its scope: the page's own directory. */
export const SERVICE_WORKER_SCOPE = './'

/** The one Trusted Types policy the page's policy allows. */
export const TRUSTED_TYPES_POLICY = 'hermie-service-worker'

/** How long the worker has to become active before registering is reported as failed. */
export const WORKER_READY_TIMEOUT_MS = 15_000

/** The capability a plugin claims when it sends Web Push at all. */
export const CAP_PUSH_WEBPUSH = 'push.webpush'

/** The capability of the test notification route (plugin P-4). */
export const CAP_PUSH_TEST = 'push.test'

/** What the browser itself offers. */
export interface PushEnvironment {
  secure: boolean
  serviceWorker: boolean
  pushManager: boolean
  notification: boolean
  /** An iPhone or iPad (an iPad reports itself as a Mac with touch). */
  ios: boolean
  /** Opened as an installed web app rather than in a browser tab. */
  standalone: boolean
}

/** Why notifications cannot be offered here; each is its own sentence in Settings. */
export type PushUnavailable =
  /** Plain http. */
  | 'insecure'
  /** Safari on an iPhone or iPad, in a tab: only an app added to the Home Screen can be notified. */
  | 'ios-home-screen'
  /** A browser without service workers, the Push API or notifications. */
  | 'browser'
  /** The gateway's advert has not been read yet. */
  | 'unknown'
  /** No Hermie plugin on the gateway. */
  | 'no-plugin'
  /** The plugin sends no Web Push (its push module is off, or it cannot sign). */
  | 'webpush-off'
  /** The plugin sends Web Push but does not publish its key: it predates P-3. */
  | 'plugin-too-old'

export type PushSupport = { ok: true; publicKey: string } | { ok: false; reason: PushUnavailable }

/** The browser's part of `pushSupport`, or `null` when the browser is fine. */
export function browserProblem(environment: PushEnvironment): PushUnavailable | null {
  if (!environment.secure) {
    return 'insecure'
  }

  const complete = environment.serviceWorker && environment.pushManager && environment.notification

  if (!complete) {
    // Safari on iOS hides the Push API from a tab and shows it to an installed app.
    return environment.ios && !environment.standalone ? 'ios-home-screen' : 'browser'
  }

  return null
}

/** Whether this browser can be notified by this gateway, and with which key; or the first reason it cannot. */
export function pushSupport(
  environment: PushEnvironment,
  plugin: { read: boolean; advert: WebPluginAdvert | null }
): PushSupport {
  const problem = browserProblem(environment)

  if (problem) {
    return { ok: false, reason: problem }
  }

  if (!plugin.read) {
    return { ok: false, reason: 'unknown' }
  }

  if (!plugin.advert) {
    return { ok: false, reason: 'no-plugin' }
  }

  if (!hasPluginCapability(plugin.advert, CAP_PUSH_WEBPUSH)) {
    return { ok: false, reason: 'webpush-off' }
  }

  const publicKey = webPushPublicKey(plugin.advert)

  return publicKey ? { ok: true, publicKey } : { ok: false, reason: 'plugin-too-old' }
}

/** Whether the advert offers the test notification route. */
export const offersTestNotification = (advert: WebPluginAdvert | null): boolean =>
  hasPluginCapability(advert, CAP_PUSH_TEST)

/** The permission as the browser states it; `unsupported` where there is no `Notification`. */
export type PushPermission = 'granted' | 'denied' | 'default' | 'unsupported'

/** A `PushSubscription`, as far as this client reads one. */
export interface BrowserSubscription {
  readonly endpoint: string
  /** The key it was made with, base64url; `''` when the browser does not say. */
  key(): string
  json(): unknown
  unsubscribe(): Promise<boolean>
}

/** A notification on screen, as far as this client reads one. */
export interface ShownNotificationHandle {
  readonly data: unknown
  close(): void
}

/** The registered, active worker. */
export interface PushWorker {
  getSubscription(): Promise<BrowserSubscription | null>
  subscribe(applicationServerKey: Uint8Array<ArrayBuffer>): Promise<BrowserSubscription>
  notifications(): Promise<readonly ShownNotificationHandle[]>
}

/** Everything the client asks of the browser for Web Push. */
export interface PushBrowser {
  environment(): PushEnvironment
  permission(): PushPermission
  /** Ask, where the browser still asks; the settled answer. Must be called from a user gesture. */
  requestPermission(): Promise<PushPermission>
  /** The worker: registered once per page, then the same promise. Rejects when it cannot be. */
  worker(): Promise<PushWorker>
  /** The worker that is already registered, without registering one; `null` when there is none. */
  existingWorker(): Promise<PushWorker | null>
  /** Every message the worker posts to this page. Returns its teardown. */
  onMessage(listener: (data: unknown) => void): () => void
}

/** The parts of `window` this module reads, so a test can hand in its own. */
export interface PushWindow {
  isSecureContext: boolean
  navigator: Navigator & { standalone?: boolean }
  matchMedia?: (query: string) => MediaQueryList
  Notification?: typeof Notification
  PushManager?: unknown
  trustedTypes?: {
    createPolicy(
      name: string,
      rules: { createScriptURL(value: string): string }
    ): {
      createScriptURL(value: string): unknown
    }
  }
}

export function environmentOf(page: PushWindow): PushEnvironment {
  const nav = page.navigator
  const agent = nav.userAgent ?? ''
  const ios = /\b(iPhone|iPad|iPod)\b/u.test(agent) || (/\bMacintosh\b/u.test(agent) && nav.maxTouchPoints > 1)
  const standalone = nav.standalone === true || Boolean(page.matchMedia?.('(display-mode: standalone)').matches)

  return {
    secure: page.isSecureContext === true,
    serviceWorker: 'serviceWorker' in nav && Boolean(nav.serviceWorker),
    pushManager: typeof page.PushManager !== 'undefined',
    notification: typeof page.Notification !== 'undefined',
    ios,
    standalone
  }
}
