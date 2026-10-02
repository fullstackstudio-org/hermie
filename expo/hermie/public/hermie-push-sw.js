/**
 * Hermie's service worker: the browser half of ADR-0017.
 *
 * A Web Push subscription is not a socket the page holds — the browser wakes
 * THIS worker with the payload whether or not a tab is open, which is the whole
 * reason the browser build can be notified at all. So the worker has exactly two
 * jobs, and no state:
 *
 *  - render the payload as a notification;
 *  - when one is clicked, get the reader back to the app and tell it what was
 *    clicked, focusing a tab that already exists rather than opening a second.
 *
 * The payload's `data` bag is handed on WHOLE, unread except for the two
 * fields the rendering itself needs. That is what carries `sessionId` and
 * `sessionKind` to the app without this file having to know what they mean:
 * where a tap lands is `features/push/actions.ts`'s decision, on the other side
 * of the message below, where it can be tested.
 *
 * It decides nothing else. Whether an Allow button may actually allow anything
 * is re-checked against the gateway by the app (`features/push/actions.ts`),
 * because a notification is a hint that something happened and never an
 * instruction — ADR-0017's threat model says so, and a service worker woken by
 * a remote payload is precisely where that has to be true.
 *
 * It is served from `public/`, which `expo export --platform web` copies to the
 * root of the export, so its scope is the whole app.
 */

/* global clients */

/** Read the payload defensively: it arrived from a push service. */
function payloadOf(event) {
  try {
    const data = event.data ? event.data.json() : null

    return data && typeof data === 'object' ? data : {}
  } catch {
    // Not JSON. There is nothing useful to show, and throwing inside a push
    // event costs the subscription its reliability record with the browser.
    return {}
  }
}

/**
 * How one notification replaces another.
 *
 * The bot, and the session where the payload names one. Both spellings are
 * read: `sessionId` is the plugin's and `session` is what Hermie Web's own
 * daemon writes.
 */
function tagFor(data) {
  const bot = typeof data.bot === 'string' && data.bot ? data.bot : ''

  if (!bot) {
    return 'hermie'
  }

  const session =
    typeof data.sessionId === 'string' && data.sessionId
      ? data.sessionId
      : typeof data.session === 'string' && data.session
        ? data.session
        : ''

  return session ? `hermie:${bot}:${session}` : `hermie:${bot}`
}

self.addEventListener('install', () => {
  // Take over immediately: a reader who has just turned notifications on should
  // not have to close every tab before the first one can arrive.
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', event => {
  const payload = payloadOf(event)
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Hermie'
  const body = typeof payload.body === 'string' ? payload.body : ''
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {}
  const needsInput = data.type === 'request'

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data,
      // Per CONVERSATION and not per bot. A bot has branches now and a
      // conversation `/new` put away, and a tag is what makes one notification
      // replace another — so a branch reporting in would quietly swallow the
      // chat's own unread notification, which is a buzz with nothing left on
      // screen to say what it was about.
      tag: tagFor(data),
      // A question with a countdown on it stays on screen until it is dealt
      // with; everything else behaves like an ordinary message notification.
      requireInteraction: needsInput,
      actions: needsInput
        ? [
            { action: 'allow', title: 'Allow' },
            { action: 'deny', title: 'Deny' }
          ]
        : []
    })
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()

  const response = {
    actionIdentifier: event.action || 'default',
    data: event.notification.data && typeof event.notification.data === 'object' ? event.notification.data : {}
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
      for (const client of windows) {
        if ('focus' in client) {
          // A tab that is already open is told directly. `consumeInitialResponse`
          // in the app reads the query below instead, which is only for the cold
          // start, so the two paths never both fire for one click.
          client.postMessage({ source: 'hermie-push', response })

          return client.focus()
        }
      }

      const query = encodeURIComponent(JSON.stringify(response))

      return clients.openWindow(`${self.registration.scope}?hermiePush=${query}`)
    })
  )
})
