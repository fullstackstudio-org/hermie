/**
 * The browser's half of Web Push (`core/push/platform.ts` says what has to be
 * true, and why): the service worker, registered through the page's one Trusted
 * Types policy; the permission; the `PushSubscription`; the notifications on
 * screen; and the messages the worker posts. The click a cold start carries in
 * its address is read by `push-launch.ts`, before this module is loaded.
 */
import { base64UrlOf } from '../core/push/row'
import {
  type BrowserSubscription,
  environmentOf,
  type PushBrowser,
  type PushPermission,
  type PushWindow,
  type PushWorker,
  SERVICE_WORKER_SCOPE,
  SERVICE_WORKER_URL,
  TRUSTED_TYPES_POLICY,
  WORKER_READY_TIMEOUT_MS
} from '../core/push/platform'

const permissionOf = (value: string): PushPermission => (value === 'granted' || value === 'denied' ? value : 'default')

function subscriptionOf(subscription: PushSubscription): BrowserSubscription {
  return {
    endpoint: subscription.endpoint,
    key() {
      const key = subscription.options?.applicationServerKey

      return key ? base64UrlOf(key) : ''
    },
    json: () => subscription.toJSON(),
    unsubscribe: () => subscription.unsubscribe()
  }
}

function workerOf(registration: ServiceWorkerRegistration): PushWorker {
  return {
    async getSubscription() {
      const subscription = await registration.pushManager.getSubscription()

      return subscription ? subscriptionOf(subscription) : null
    },
    async subscribe(applicationServerKey) {
      return subscriptionOf(
        await registration.pushManager.subscribe({
          // Every browser with Push requires it: a subscription that may deliver silently is refused.
          userVisibleOnly: true,
          applicationServerKey
        })
      )
    },
    async notifications() {
      return registration.getNotifications()
    }
  }
}

const withTimeout = <T>(work: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)

    work.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })

type ScriptUrlPolicy = { createScriptURL(value: string): unknown }

/**
 * Whether a message's source is the service worker at `expected`: a `ServiceWorker` (where the page
 * has the class) whose script is that address.
 */
export function isWorkerAt(source: unknown, expected: string, page: Pick<PushWindow, 'ServiceWorker'>): boolean {
  if (!source || typeof source !== 'object') {
    return false
  }

  if (page.ServiceWorker && !(source instanceof page.ServiceWorker)) {
    return false
  }

  return (source as { scriptURL?: unknown }).scriptURL === expected
}

export function createPushBrowser(page: PushWindow): PushBrowser {
  let worker: Promise<PushWorker> | null = null
  let policy: ScriptUrlPolicy | null = null

  // A policy name can be created once per document, so it is kept for the page's life.
  const scriptUrl = (): unknown => {
    if (!page.trustedTypes) {
      return SERVICE_WORKER_URL
    }

    policy ??= page.trustedTypes.createPolicy(TRUSTED_TYPES_POLICY, {
      createScriptURL(value) {
        if (value !== SERVICE_WORKER_URL) {
          throw new TypeError(`${TRUSTED_TYPES_POLICY} makes no other script URL`)
        }

        return value
      }
    })

    return policy.createScriptURL(SERVICE_WORKER_URL)
  }

  const container = (): ServiceWorkerContainer | null =>
    'serviceWorker' in page.navigator && page.navigator.serviceWorker ? page.navigator.serviceWorker : null

  return {
    environment: () => environmentOf(page),

    permission() {
      return page.Notification ? permissionOf(page.Notification.permission) : 'unsupported'
    },

    async requestPermission() {
      const notification = page.Notification

      if (!notification) {
        return 'unsupported'
      }

      if (notification.permission !== 'default') {
        return permissionOf(notification.permission)
      }

      return permissionOf(await notification.requestPermission())
    },

    worker() {
      worker ??= (async () => {
        const workers = container()

        if (!workers) {
          throw new Error('this browser has no service workers')
        }

        // A TrustedScriptURL under the page's policy; the DOM types only know the string.
        const registration = await workers.register(scriptUrl() as string, {
          scope: SERVICE_WORKER_SCOPE,
          updateViaCache: 'none'
        })

        await withTimeout(workers.ready, WORKER_READY_TIMEOUT_MS, 'the service worker did not start')

        return workerOf(registration)
      })()

      const current = worker

      // A registration that failed may be tried again (a deploy that had not finished, a blip).
      current.catch(() => {
        if (worker === current) {
          worker = null
        }
      })

      return current
    },

    async existingWorker() {
      const workers = container()
      const registration = workers ? await workers.getRegistration(SERVICE_WORKER_SCOPE) : undefined

      return registration?.active ? workerOf(registration) : null
    },

    onMessage(listener) {
      const workers = container()

      if (!workers) {
        return () => undefined
      }

      // This client's worker, and nothing else: another worker of the origin (another plugin's, the
      // dashboard's) or a script of the page cannot post a click this page acts on.
      const expected = new URL(SERVICE_WORKER_URL, page.document?.baseURI ?? '').href
      const handle = (event: Pick<MessageEvent, 'data' | 'source'>): void => {
        if (isWorkerAt(event.source, expected, page)) {
          listener(event.data)
        }
      }

      workers.addEventListener('message', handle)
      workers.startMessages()

      return () => workers.removeEventListener('message', handle)
    }
  }
}

/** The page's own; on a page with no window (a test in Node), one that offers nothing. */
export const pagePushBrowser: PushBrowser = createPushBrowser(
  typeof window === 'undefined'
    ? ({ isSecureContext: false, navigator: { userAgent: '', maxTouchPoints: 0 } } as unknown as PushWindow)
    : (window as unknown as PushWindow)
)
