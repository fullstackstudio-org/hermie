/**
 * The service worker's two jobs (plan W14), as a function of the scope it runs in
 * so a test can hand in its own:
 *
 *  - `push`: show the notification the payload describes, or, for a clearing
 *    push, close the one it withdraws and show nothing (`notification.ts`);
 *  - `notificationclick`: hand the click to a window of the client that is open
 *    (focusing it), or open one that carries the click in its address.
 *
 * Nothing else. There is no `fetch` handler, so the worker never serves the app
 * shell and a rolled-back or revoked client can never be brought back from a
 * cache; and the worker makes no network request of its own, so it never calls
 * the gateway. Whether a click may answer anything is decided by the page,
 * against the gateway (`core/push/actions.ts`): a notification is a hint, never an
 * instruction. No message text is ever logged.
 *
 * The browser types of a worker scope are not in this project's `lib` (the page's
 * DOM types are), so the few members used here are described structurally.
 */
import {
  closes,
  displayOf,
  inScope,
  launchUrlOf,
  PUSH_MESSAGE_SOURCE,
  type PushResponseMessage,
  responseOf,
  type ShownNotification
} from './notification'

export interface WorkerNotification {
  readonly data: unknown
  close(): void
}

export interface WorkerRegistration {
  readonly scope: string
  showNotification(title: string, options: ShownNotification['options']): Promise<void>
  getNotifications(): Promise<readonly WorkerNotification[]>
}

export interface WorkerWindow {
  readonly url: string
  readonly focused?: boolean
  readonly visibilityState?: string
  postMessage(message: unknown): void
  focus(): Promise<unknown>
}

export interface WorkerClients {
  matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WorkerWindow[]>
  openWindow(url: string): Promise<unknown>
  claim(): Promise<void>
}

export interface WorkerEvent {
  waitUntil(work: Promise<unknown>): void
}

export interface WorkerPushEvent extends WorkerEvent {
  readonly data: { json(): unknown } | null
}

export interface WorkerClickEvent extends WorkerEvent {
  readonly action: string
  readonly notification: WorkerNotification
}

export interface WorkerScope {
  readonly registration: WorkerRegistration
  readonly clients: WorkerClients
  readonly navigator?: { readonly languages?: readonly string[]; readonly language?: string }
  skipWaiting(): Promise<void>
  addEventListener(type: 'install' | 'activate', listener: (event: WorkerEvent) => void): void
  addEventListener(type: 'push', listener: (event: WorkerPushEvent) => void): void
  addEventListener(type: 'notificationclick', listener: (event: WorkerClickEvent) => void): void
}

/** The message a window of the client is posted when one of its notifications is clicked. */
export interface WorkerMessage {
  source: typeof PUSH_MESSAGE_SOURCE
  response: PushResponseMessage
}

function languagesOf(scope: WorkerScope): readonly string[] {
  const languages = scope.navigator?.languages

  if (Array.isArray(languages) && languages.length > 0) {
    return languages
  }

  return scope.navigator?.language ? [scope.navigator.language] : []
}

/** The payload, or `null` when it is not JSON: a push that cannot be read still shows something. */
function readPayload(event: WorkerPushEvent): unknown {
  try {
    return event.data ? event.data.json() : null
  } catch {
    // Throwing in a push event costs the subscription its standing with the
    // browser; an unreadable payload is shown as a plain notification instead.
    return null
  }
}

async function closeMatching(scope: WorkerScope, target: Parameters<typeof closes>[0]): Promise<void> {
  for (const notification of await scope.registration.getNotifications()) {
    if (closes(target, notification.data)) {
      notification.close()
    }
  }
}

/** The window a click goes to: the focused one, else a visible one, else any, of the client only. */
function windowFor(windows: readonly WorkerWindow[], scope: string): WorkerWindow | undefined {
  const ours = windows.filter(window => inScope(window.url, scope))

  return ours.find(window => window.focused) ?? ours.find(window => window.visibilityState === 'visible') ?? ours[0]
}

export function installWorker(scope: WorkerScope): void {
  scope.addEventListener('install', () => {
    // Take over at once: somebody who has just turned notifications on should not
    // have to close every tab before the first one can arrive.
    void scope.skipWaiting()
  })

  scope.addEventListener('activate', event => {
    event.waitUntil(scope.clients.claim())
  })

  scope.addEventListener('push', event => {
    const display = displayOf(readPayload(event), languagesOf(scope))

    if (display.kind === 'clear') {
      event.waitUntil(closeMatching(scope, display.target))

      return
    }

    event.waitUntil(scope.registration.showNotification(display.notification.title, display.notification.options))
  })

  scope.addEventListener('notificationclick', event => {
    event.notification.close()

    const response = responseOf(event.action, event.notification.data)

    event.waitUntil(
      (async () => {
        const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true })
        const target = windowFor(windows, scope.registration.scope)

        if (target) {
          // An open client is told directly; the launch query is only for a cold
          // start, so one click never reaches the page both ways.
          const message: WorkerMessage = { source: PUSH_MESSAGE_SOURCE, response }

          target.postMessage(message)
          await target.focus()

          return
        }

        await scope.clients.openWindow(launchUrlOf(scope.registration.scope, response))
      })()
    )
  })
}
