/**
 * Web Push in the built client, in Chromium (W-25): the service worker is
 * registered through the page's one Trusted Types policy, the browser is
 * subscribed with the key in the plugin's advert, and the row lands in the
 * person's section with that key; a subscription made with another key is
 * replaced on the next load; a push the worker receives is shown as the
 * contract says; and a click reaches the page both ways (posted by the worker,
 * or carried in the address of a cold start).
 *
 * A real push service is not reachable from CI, so `PushManager` is replaced by
 * one that hands out subscriptions locally (kept in `sessionStorage`, so they
 * outlive a reload like a real one). Everything else is the real browser: the
 * worker, its registration, the permission, the page's policy. The push event is
 * delivered to the real worker through the DevTools protocol.
 */
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/** The fake gateway's advert key (`packages/fake-gateway`, `FAKE_WEB_PUSH_PUBLIC_KEY`). */
const ADVERT_KEY = 'BB4V0uA3Mhr24OQdSBvpiQbXxekA10YihCyW0_L4zE616vb3_kTg5WvgJ_rP5L6QUdFKymkHRs2SDtj8M9czWIw'

/** Another valid P-256 key, as a subscription made against some other sender would name. */
const OTHER_KEY = `${ADVERT_KEY.slice(0, 40)}${ADVERT_KEY[40] === 'A' ? 'B' : 'A'}${ADVERT_KEY.slice(41)}`

test.skip(({ browserName }) => browserName !== 'chromium', 'Web Push is checked in Chromium (plan W-25)')

/*
  The full Chromium in its new headless mode: the headless shell Playwright runs by default reports the
  notification permission as denied whatever was granted, and refuses `showNotification`.
*/
test.use({ channel: 'chromium' })

/** A `PushManager` that subscribes without a push service. Runs before the page's own scripts. */
function fakePushManager(): void {
  const STORE = '__fakePush'
  const LOG = '__fakePushLog'

  interface Held {
    endpoint: string
    key: string
    n: number
  }

  const load = (): Held | null => JSON.parse(sessionStorage.getItem(STORE) ?? 'null') as Held | null
  const save = (held: Held | null): void => sessionStorage.setItem(STORE, JSON.stringify(held))
  const log = (entry: string): void =>
    sessionStorage.setItem(
      LOG,
      JSON.stringify([...(JSON.parse(sessionStorage.getItem(LOG) ?? '[]') as string[]), entry])
    )
  const base64Url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '')
  const bytesOf = (key: string): ArrayBuffer => {
    const plain = key.replace(/-/gu, '+').replace(/_/gu, '/')
    const binary = atob(plain.padEnd(plain.length + ((4 - (plain.length % 4)) % 4), '='))

    return Uint8Array.from(binary, char => char.charCodeAt(0)).buffer
  }
  const subscriptionOf = (held: Held) => ({
    endpoint: held.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: bytesOf(held.key) },
    toJSON: () => ({ endpoint: held.endpoint, keys: { p256dh: `p256dh-${held.n}`, auth: `auth-${held.n}` } }),
    unsubscribe: async () => {
      log(`unsubscribe ${held.endpoint}`)
      save(null)

      return true
    }
  })

  PushManager.prototype.getSubscription = async function getSubscription() {
    const held = load()

    return (held ? subscriptionOf(held) : null) as unknown as PushSubscription
  }

  PushManager.prototype.subscribe = async function subscribe(options?: PushSubscriptionOptionsInit) {
    const raw = options?.applicationServerKey
    const key = base64Url(new Uint8Array(raw instanceof ArrayBuffer ? raw : (raw as Uint8Array).buffer))
    const held = load()

    if (held && held.key !== key) {
      throw new DOMException(
        'A subscription with a different applicationServerKey already exists.',
        'InvalidStateError'
      )
    }

    const n = Number(sessionStorage.getItem('__fakePushCount') ?? '0') + 1

    sessionStorage.setItem('__fakePushCount', String(n))

    const next = { endpoint: `https://push.example.test/send/${n}`, key, n }

    save(next)
    log(`subscribe ${key.slice(0, 8)}`)

    return subscriptionOf(next) as unknown as PushSubscription
  }
}

/** This browser's row in the person's section, as the gateway holds it. */
async function rowOf(page: Page, gatewayUrl: string): Promise<Record<string, unknown> | undefined> {
  const response = await page.request.get(`${gatewayUrl}/api/profiles`)
  const roster = (await response.json()) as { profiles: { is_default?: boolean; ui_meta?: Record<string, unknown> }[] }
  const meta = roster.profiles.find(row => row.is_default)?.ui_meta ?? {}
  const key = Object.keys(meta).find(name => name.startsWith('hermie-app:'))
  const push = key
    ? ((meta[key] as { push?: { registrations?: Record<string, Record<string, unknown>> } }).push ?? {})
    : {}

  return Object.values(push.registrations ?? {}).find(row => row.transport === 'webpush')
}

test.beforeEach(async ({ page, gateway }) => {
  await page.context().grantPermissions(['notifications'], { origin: gateway.url })
  await page.addInitScript(fakePushManager)
})

test('turning it on registers the worker, subscribes with the advert’s key and writes the row with it', async ({
  app,
  gateway,
  page
}) => {
  await app.open('#/settings/notifications')

  const toggle = page.getByRole('checkbox', { name: 'Notify this browser' })

  await expect(toggle).toBeEnabled()
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(page.getByText('On. This browser is registered with the gateway.')).toBeVisible()

  await expect
    .poll(() => rowOf(page, gateway.url))
    .toMatchObject({
      v: 1,
      transport: 'webpush',
      platform: 'web',
      endpoint: 'https://push.example.test/send/1',
      keys: { p256dh: 'p256dh-1', auth: 'auth-1' },
      applicationServerKey: ADVERT_KEY,
      clears: true,
      requestMethods: true,
      types: { message: true, request: true, turn_failed: true }
    })

  // The real worker, at the client's directory, registered through the page's policy.
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)

  expect(scope).toBe(`${gateway.url}/dashboard-plugins/hermie/app/`)

  // Off takes the row out and lets the subscription go.
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(() => rowOf(page, gateway.url)).toBeUndefined()
  expect(await page.evaluate(() => sessionStorage.getItem('__fakePush'))).toBe('null')
})

test('the types and the preview are written into the row as they are switched, and kept through a reload', async ({
  app,
  gateway,
  page
}) => {
  await app.open('#/settings/notifications')
  await page.getByRole('checkbox', { name: 'Notify this browser' }).click()
  await expect.poll(async () => (await rowOf(page, gateway.url))?.endpoint).toBe('https://push.example.test/send/1')

  // Off until the reader says otherwise: a notification says which bot and what happened, and no more.
  const preview = page.getByRole('checkbox', { name: 'Show a preview' })

  await expect(preview).not.toBeChecked()
  await expect(page.getByText(/Off, a notification says which bot and what happened/u)).toBeVisible()
  expect((await rowOf(page, gateway.url))?.preview).toBeFalsy()

  await preview.check()
  await expect.poll(async () => (await rowOf(page, gateway.url))?.preview).toBe(true)

  const routines = page.getByRole('checkbox', { name: 'Routines' })

  await expect(routines).toBeChecked()
  await routines.uncheck()
  await expect.poll(async () => ((await rowOf(page, gateway.url))?.types as Record<string, boolean>)?.cron).toBe(false)

  // The choices are this browser's own and come back with the page.
  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Show a preview' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Routines' })).not.toBeChecked()

  await page.getByRole('checkbox', { name: 'Show a preview' }).uncheck()
  await expect.poll(async () => (await rowOf(page, gateway.url))?.preview).toBeFalsy()
})

test('a subscription made with another key is replaced with the advert’s on the next load', async ({
  app,
  gateway,
  page
}) => {
  await app.open('#/settings/notifications')
  await page.getByRole('checkbox', { name: 'Notify this browser' }).click()
  await expect.poll(async () => (await rowOf(page, gateway.url))?.endpoint).toBe('https://push.example.test/send/1')

  const first = (await rowOf(page, gateway.url))?.updatedAt as number

  // The browser now holds a subscription some other sender's key made.
  await page.evaluate(
    other =>
      sessionStorage.setItem(
        '__fakePush',
        JSON.stringify({ endpoint: 'https://push.example.test/other', key: other, n: 7 })
      ),
    OTHER_KEY
  )
  await page.reload()

  await expect
    .poll(async () => (await rowOf(page, gateway.url))?.endpoint, { timeout: 15_000 })
    .toBe('https://push.example.test/send/2')

  const row = await rowOf(page, gateway.url)

  expect(row?.applicationServerKey).toBe(ADVERT_KEY)
  expect(row?.updatedAt as number).toBeGreaterThanOrEqual(first)
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem('__fakePushLog'))) ?? '[]')).toEqual([
    `subscribe ${ADVERT_KEY.slice(0, 8)}`,
    'unsubscribe https://push.example.test/other',
    `subscribe ${ADVERT_KEY.slice(0, 8)}`
  ])
})

test('signing out takes the row off the gateway and lets the subscription go', async ({
  app,
  diagnostics,
  gateway,
  page
}) => {
  await app.open('#/settings/notifications')
  await page.getByRole('checkbox', { name: 'Notify this browser' }).click()
  await expect.poll(async () => (await rowOf(page, gateway.url))?.endpoint).toBe('https://push.example.test/send/1')

  // The gateway's own sign-in page asks for `/favicon.ico`, which a signed-out browser is refused.
  diagnostics.allow(/favicon|status of 401/u)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/u)

  // Signed in again from outside the page, to read the gateway's copy.
  await app.signIn()
  expect(await rowOf(page, gateway.url)).toBeUndefined()
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem('__fakePushLog'))) ?? '[]')).toContain(
    'unsubscribe https://push.example.test/send/1'
  )
})

test('the worker shows a push as the contract says, and a clearing push takes it away', async ({ app, page }) => {
  await app.open('#/settings/notifications')
  await page.getByRole('checkbox', { name: 'Notify this browser' }).click()
  await expect(page.getByText('On. This browser is registered with the gateway.')).toBeVisible()

  const cdp = await page.context().newCDPSession(page)
  const registrations: { registrationId: string; scopeURL: string }[] = []

  cdp.on('ServiceWorker.workerRegistrationUpdated', event => {
    registrations.push(...(event as { registrations: { registrationId: string; scopeURL: string }[] }).registrations)
  })
  await cdp.send('ServiceWorker.enable')
  await expect.poll(() => registrations.length).toBeGreaterThan(0)

  const registration = registrations.find(entry => entry.scopeURL.endsWith('/dashboard-plugins/hermie/app/'))
  const origin = new URL(page.url()).origin
  const approval = {
    v: 1,
    type: 'request',
    bot: 'researcher',
    at: 1_790_000_000,
    eventId: 'request:e73f568f3575f6b525d031267d258a0b',
    sessionKey: '20261003_101500_a1b2c3',
    sessionKind: 'canonical',
    method: 'approval',
    requestId: 'appr-1'
  }

  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin,
    registrationId: registration?.registrationId ?? '',
    data: JSON.stringify({ title: 'researcher', body: 'Needs your approval', data: approval })
  })

  const shown = () =>
    page.evaluate(async () =>
      (await (await navigator.serviceWorker.ready).getNotifications()).map(notification => ({
        title: notification.title,
        body: notification.body,
        tag: notification.tag,
        requireInteraction: notification.requireInteraction,
        actions: (notification as Notification & { actions?: { action: string }[] }).actions?.map(
          action => action.action
        ),
        data: notification.data as unknown
      }))
    )

  await expect.poll(shown).toEqual([
    {
      title: 'researcher',
      body: 'Needs your approval',
      tag: 'hermie:researcher:20261003_101500_a1b2c3',
      requireInteraction: true,
      actions: ['hermie.request.allow', 'hermie.request.deny'],
      data: approval
    }
  ])

  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin,
    registrationId: registration?.registrationId ?? '',
    data: JSON.stringify({
      data: {
        ...approval,
        eventId: 'clear:91d90307460e2dec1c063f97045dc51e',
        clear: true,
        reason: 'answered',
        replaces: approval.eventId
      }
    })
  })

  await expect.poll(shown).toEqual([])
})

/** Turn notifications on from Settings and wait until the page is controlled by the client's worker. */
async function turnOn(page: Page): Promise<void> {
  await page.getByRole('checkbox', { name: 'Notify this browser' }).click()
  await expect(page.getByText('On. This browser is registered with the gateway.')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''))
    .toMatch(/\/sw\.js$/u)
}

/**
 * A click as the worker posts it: a message whose source is the client's own worker. Real clicks on a
 * notification cannot be driven from here; the message is what the worker sends for one. With
 * `fromWorker: false` it is the same message dispatched by a script of the page, with no source.
 */
async function post(page: Page, response: unknown, fromWorker = true): Promise<void> {
  await page.evaluate(
    ([message, worker]) =>
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'hermie-push', response: message },
          ...(worker && navigator.serviceWorker.controller ? { source: navigator.serviceWorker.controller } : {})
        })
      ),
    [response, fromWorker] as const
  )
}

test('a click on a notification opens the conversation it names, from the worker or from a cold start', async ({
  app,
  gateway,
  page
}) => {
  await app.open('#/settings/notifications')
  await turnOn(page)

  // A look-alike dispatched by a script of the page is not the worker: nothing happens.
  await post(page, { actionIdentifier: 'default', data: { bot: 'writer', type: 'message' } }, false)
  await page.waitForTimeout(300)
  await expect(page).toHaveURL(/#\/settings\/notifications$/u)

  // An open window: the worker posts the click to it.
  await post(page, {
    actionIdentifier: 'default',
    data: { bot: 'researcher', type: 'message', sessionKind: 'canonical' }
  })
  await expect(page).toHaveURL(/#\/chat\/researcher$/u)

  // A cold start: the worker opens the client with the click in its address, read once and removed.
  const response = {
    actionIdentifier: 'default',
    data: { bot: 'researcher', type: 'turn_done', sessionId: 'branch-1', sessionKind: 'branch' }
  }

  await page.goto(
    `${gateway.url}/dashboard-plugins/hermie/app/index.html?hermiePush=${encodeURIComponent(JSON.stringify(response))}`
  )
  await expect(page).toHaveURL(/#\/chat\/researcher\/s\/branch-1$/u)
  expect(new URL(page.url()).search).toBe('')
})

test('an Allow on a notification answers only a request the gateway still lists, and with once', async ({
  app,
  gateway,
  page
}) => {
  await app.open('#/settings/notifications')
  await turnOn(page)
  await page.evaluate(() => {
    location.hash = '#/chat/researcher'
  })
  await app.ready()

  const before = (await gateway.answers()).length
  const allow = (requestId: string) =>
    post(page, {
      actionIdentifier: 'hermie.request.allow',
      data: { bot: 'researcher', type: 'request', method: 'approval', requestId, sessionKind: 'canonical' }
    })

  // A forged or stale one first: nothing the gateway lists, so nothing is answered.
  await allow('appr-nobody')
  await page.waitForTimeout(500)
  expect((await gateway.state()).methodLog.filter(entry => entry === 'approval.respond')).toEqual([])

  await gateway.raise('approval', {
    command: 'echo marker',
    description: 'Print a marker',
    choices: ['once', 'session', 'always', 'deny'],
    request_id: 'appr-push-1'
  })
  await expect(app.dialog).toContainText('echo marker')

  await allow('appr-push-1')

  await expect.poll(async () => (await gateway.answers()).length).toBe(before + 1)
  expect((await gateway.answers()).at(-1)?.result).toEqual({ choice: 'once' })
  await expect(app.dialog).toHaveCount(0)
})
