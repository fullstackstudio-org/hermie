/**
 * A gateway without sign-in (the fake in `--auth token`), against the real build (plan W-23).
 *
 * Such a gateway lets in whoever has its session token, and hands the token to the pages it serves by
 * writing it into the dashboard's own `index.html`. The client reads it from there, holds it in memory,
 * and sends it as `X-Hermes-Session-Token` on REST and as `?token=` on the socket. What this proves, in
 * a browser, on the page the gateway serves:
 *
 *  - **It boots from the bootstrap**: the app opens with nobody named, and `/api/auth/me` is never asked.
 *  - **The token stays where it belongs**: in no `localStorage`, `sessionStorage`, IndexedDB or cookie
 *    after use, and in no address the page asks for except the socket's.
 *  - **A refused token is the prompt**: a bootstrap whose token the gateway refuses (a restart between
 *    the page and the check) shows the masked field; a wrong token is said once; the right one opens
 *    the app, and is not kept either.
 *  - **A token that stops working while the page is open** (the gateway restarted) is read again from
 *    the dashboard by itself, once; when the dashboard still has the refused token, the connection line
 *    and its button are the way back.
 *  - **Forgetting the token** goes back to the prompt and leaves nothing behind, in every tab.
 *  - **What needs a person says so**: Passkeys and MCP, in Settings.
 *
 * Every test also fails on a console error or a policy violation (the `diagnostics` fixture); the 401s
 * a browser logs when the gateway refuses a token are the errors these tests provoke on purpose.
 */
import type { Page, Request } from '@playwright/test'

import { BOT, expect, test } from './fixtures'

/** The gateway's token: distinctive, so finding it anywhere is never a coincidence. */
const TOKEN = 'e2e-token-Zq7xK2mW9pR4vT6yB3nD8sF1'

/** What Chromium and WebKit log when a request is answered 401: the gateway doing what it should. */
const REFUSED_BY_GATEWAY = /status of 401/u

test.use({ gatewayOptions: { auth: 'token', token: TOKEN } })

/** Every address the page asks for, and every socket it opens, from the moment this is called. */
function recordTraffic(page: Page): { requests: Request[]; sockets: string[] } {
  const requests: Request[] = []
  const sockets: string[] = []

  page.on('request', request => requests.push(request))
  page.on('websocket', socket => sockets.push(socket.url()))

  return { requests, sockets }
}

/** Everything the page's origin keeps: both web storages, every IndexedDB record, and the cookies. */
async function everythingStored(page: Page): Promise<string> {
  const inPage = await page.evaluate(async () => {
    const dump = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index) ?? ''

        return [key, storage.getItem(key)]
      })

    const databases = await indexedDB.databases()
    const records: unknown[] = []

    for (const { name } of databases) {
      if (!name) {
        continue
      }

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name)

        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })

      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll()

          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const keys = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAllKeys()

          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })

        records.push({ database: name, store, keys, rows })
      }

      db.close()
    }

    return {
      local: dump(localStorage),
      session: dump(sessionStorage),
      indexedDb: records,
      documentCookie: document.cookie
    }
  })

  const cookies = await page.context().cookies()

  return JSON.stringify({ ...inPage, cookies })
}

/** The token is in nothing the origin stores, and in no address but the socket's. */
async function expectTokenOnlyOnTheSocket(
  page: Page,
  traffic: { requests: Request[]; sockets: string[] },
  token = TOKEN
): Promise<void> {
  expect(await everythingStored(page)).not.toContain(token)
  expect(traffic.requests.map(request => request.url()).filter(url => url.includes(token))).toEqual([])
  expect(traffic.sockets.length).toBeGreaterThan(0)

  for (const url of traffic.sockets) {
    expect(new URL(url).searchParams.get('token')).toBe(token)
  }
}

/** The page's own field for the token, and its button. */
const prompt = (page: Page) => ({
  field: page.getByLabel('Session token', { exact: true }),
  proceed: page.getByRole('button', { name: 'Continue' })
})

test('boots from the dashboard’s bootstrap: the app opens, nobody is named, and the token stays in memory', async ({
  app,
  gateway,
  page
}) => {
  const traffic = recordTraffic(page)

  await page.goto(gateway.appUrl(`#/chat/${BOT}`))

  await expect(page.getByText('No sign-in on this gateway')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Forget the token' })).toBeVisible()
  await app.ready()
  await app.send('Hello from a gateway without sign-in')
  await expect(app.transcript.getByText('Hello from a gateway without sign-in')).toBeVisible()

  const paths = traffic.requests.map(request => new URL(request.url()).pathname)

  // The bootstrap was read from the dashboard's own index on the same origin, and nobody was asked for.
  expect(paths).toContain('/')
  expect(traffic.requests.every(request => new URL(request.url()).origin === new URL(gateway.url).origin)).toBe(true)
  expect(paths).not.toContain('/api/auth/me')

  // REST carried the token as the header the gateway reads.
  const profiles = traffic.requests.find(request => new URL(request.url()).pathname === '/api/profiles')

  expect(await profiles?.headerValue('x-hermes-session-token')).toBe(TOKEN)

  await expectTokenOnlyOnTheSocket(page, traffic)
})

test('a token the gateway refuses is the prompt: a wrong one is said once, the right one opens the app', async ({
  app,
  diagnostics,
  gateway,
  page
}) => {
  diagnostics.allow(REFUSED_BY_GATEWAY)

  // The dashboard hands out a token the gateway no longer takes (it restarted between the page and the check).
  await page.route(
    url => url.href === `${gateway.url}/`,
    route =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: { 'cache-control': 'no-store' },
        body: '<!doctype html><html><head><script>window.__HERMES_SESSION_TOKEN__="stale-token";</script></head></html>'
      })
  )

  const traffic = recordTraffic(page)

  await page.goto(gateway.appUrl(`#/chat/${BOT}`))

  const { field, proceed } = prompt(page)

  await expect(field).toBeVisible()
  await expect(page.getByText(/did not accept the token from its dashboard page/u)).toBeVisible()
  await expect(field).toHaveAttribute('type', 'password')
  await expect(field).toHaveAttribute('autocomplete', 'off')
  expect(await field.getAttribute('name')).toBeNull()
  await expect(page.locator('form')).toHaveCount(0)

  await field.fill('not-the-token')
  await proceed.click()

  await expect(page.getByRole('alert')).toHaveText('The gateway did not accept this token. Check it and try again.')
  await expect(field).toHaveValue('')

  await field.fill(TOKEN)
  await field.press('Enter')

  await expect(page.getByText('No sign-in on this gateway')).toBeVisible()
  await app.ready()

  // Neither the typed token nor the refused ones were kept, or put in an address.
  await expectTokenOnlyOnTheSocket(page, traffic)

  const stored = await everythingStored(page)

  expect(stored).not.toContain('not-the-token')
  expect(stored).not.toContain('stale-token')
})

test('a gateway restart is followed by itself: the new token is read from the dashboard once', async ({
  app,
  diagnostics,
  gateway,
  page
}) => {
  diagnostics.allow(REFUSED_BY_GATEWAY)
  // WebKit logs a dropped socket by its URL, the `?token=` included: the browser's own console, as it does
  // for the dashboard's socket; nothing the client writes.
  diagnostics.allow(/WebSocket connection to .* failed/u)
  await page.goto(gateway.appUrl(`#/chat/${BOT}`))
  await app.ready()

  // The gateway restarts with a fresh token, and the socket goes with it. Nobody clicks anything.
  const fresh = 'e2e-token-after-restart-Hy5'
  const traffic = recordTraffic(page)

  gateway.fake.state.token = fresh
  await gateway.dropSockets()

  await expect.poll(() => traffic.sockets.some(url => new URL(url).searchParams.get('token') === fresh)).toBe(true)
  await expect(page.getByText('No sign-in on this gateway')).toBeVisible()
  await app.ready()
  await expect(page.getByRole('alert').filter({ hasText: /did not accept the token/u })).toHaveCount(0)

  // Only the refused dials carried the old token; the token is still in nothing stored.
  expect(await everythingStored(page)).not.toContain(fresh)
  expect(traffic.requests.map(request => request.url()).filter(url => url.includes(fresh))).toEqual([])
})

test('when the dashboard still has the refused token, the line stays, and its button reads it again', async ({
  app,
  diagnostics,
  gateway,
  page
}) => {
  diagnostics.allow(REFUSED_BY_GATEWAY)
  diagnostics.allow(/WebSocket connection to .* failed/u)
  await page.goto(gateway.appUrl(`#/chat/${BOT}`))
  await app.ready()

  // The gateway takes a new token, but its dashboard page still hands out the old one (a cached proxy, say).
  const dashboardPage = (url: URL) => url.href === `${gateway.url}/`

  await page.route(dashboardPage, route =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><script>window.__HERMES_SESSION_TOKEN__="${TOKEN}";</script></head></html>`
    })
  )

  const fresh = 'e2e-token-after-restart-Kw2'

  gateway.fake.state.token = fresh
  await gateway.dropSockets()

  const line = page.getByRole('alert').filter({ hasText: /did not accept the token/u })

  await expect(line).toBeVisible()

  // The page catches up; the button reads it again.
  await page.unroute(dashboardPage)

  const traffic = recordTraffic(page)

  await line.getByRole('button', { name: 'Read it from the dashboard again' }).click()

  await expect(page.getByText('No sign-in on this gateway')).toBeVisible()
  await app.ready()
  await expectTokenOnlyOnTheSocket(page, traffic, fresh)
})

test('forgetting the token in one tab stops the other tab on the same gateway too', async ({
  app,
  context,
  gateway,
  page
}) => {
  const other = await context.newPage()

  await page.goto(gateway.appUrl(`#/chat/${BOT}`))
  await other.goto(gateway.appUrl(`#/chat/${BOT}`))
  await app.ready()
  await expect(other.getByText('No sign-in on this gateway')).toBeVisible()

  await page.getByRole('button', { name: 'Forget the token' }).click()

  // The other tab drops its session and asks for the token: no socket of it stays open on the gateway.
  await expect(other.getByText(/Hermie has forgotten the token/u)).toBeVisible()
  await expect(other.getByLabel('Session token', { exact: true })).toBeVisible()
  await expect.poll(async () => (await gateway.state()).openSockets).toBe(0)

  expect(await everythingStored(other)).not.toContain(TOKEN)
  await other.close()
})

test('forgetting the token goes back to the prompt and leaves nothing behind', async ({ app, gateway, page }) => {
  await page.goto(gateway.appUrl(`#/chat/${BOT}`))
  await app.ready()
  await app.send('Something to cache')
  await expect(app.transcript.getByText('Something to cache')).toBeVisible()

  await page.getByRole('button', { name: 'Forget the token' }).click()

  await expect(page.getByText(/Hermie has forgotten the token/u)).toBeVisible()
  await expect(prompt(page).field).toBeVisible()
  await expect(page.getByRole('log')).toHaveCount(0)

  const stored = await everythingStored(page)

  expect(stored).not.toContain(TOKEN)
  expect(stored).not.toContain('Something to cache')

  // And back in, from the dashboard.
  await page.getByRole('button', { name: 'Read it from the dashboard again' }).click()
  await expect(page.getByText('No sign-in on this gateway')).toBeVisible()
})

test('what belongs to a person says plainly that it needs sign-in', async ({ gateway, page }) => {
  await page.goto(gateway.appUrl('#/settings/passkeys'))
  await expect(page.getByText(/Passkeys belong to a person signed in to the gateway/u)).toBeVisible()

  await page.goto(gateway.appUrl('#/settings/mcp'))
  await expect(page.getByText(/MCP access is granted to a person signed in to the gateway/u)).toBeVisible()

  await page.goto(gateway.appUrl('#/settings/account'))
  await expect(page.getByText(/This gateway has no sign-in, so nobody is signed in here/u)).toBeVisible()
})
