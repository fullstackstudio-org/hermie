/**
 * Getting in, and being turned away, against a gateway that serves the real build.
 *
 * The client has no sign-in form: signing in happens on the gateway's own
 * `/login`, which sends the reader back to `next`, and the route (the fragment,
 * which `/login` drops) travels in `sessionStorage`. The gateway's gate answers
 * a page load that carries no session with a redirect to `/login` before the
 * client exists, so the client's own "Sign in again" screen is for the other
 * case: a page that loaded signed in and found its session gone when it asked who
 * it was. What this proves, in a browser, on the page the gateway serves:
 *
 *  - **An unauthenticated visit** is sent to the gateway's sign-in page, and
 *    signing in there opens the client signed in.
 *  - **A session that lapses between the page and its first question** (the cookie
 *    deleted, or the gateway ended every session) is "Sign in again", whose
 *    button goes to `/login?next=<the page>`, and signing in there returns to the
 *    client on the route that was open: the fragment, which the trip dropped,
 *    restored once.
 *  - **A session that lapses while the page is open** is the signed-out line over
 *    the app, whose button goes the same way.
 *  - **A frame** gets one sentence and nothing else: no request to the gateway's
 *    API, no chat list.
 *
 * Every test also fails on a console error or a policy violation (the
 * `diagnostics` fixture); the 401 a browser logs when the gateway refuses a call
 * is the one error these tests provoke on purpose.
 */
import type { Page } from '@playwright/test'

import { BOT, expect, test } from './fixtures'

/** What Chromium and WebKit log when a request is answered 401 or 403: the gateway doing what it should. */
const REFUSED_BY_GATEWAY = /status of 40[13]/u

/** The gateway's own sign-in page, and the account it knows. */
async function signInOnGatewayPage(page: Page, password = 'hunter2'): Promise<void> {
  await page.locator('input[name="username"]').fill('tester')
  await page.locator('input[name="password"]').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('an unauthenticated visit is sent to the gateway sign-in page, and signing in opens the client', async ({
  app,
  gateway,
  page
}) => {
  await page.goto(gateway.appUrl())

  // The gate answered before the client existed: the gateway's page, told where to send the reader back to.
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard-plugins%2Fhermie%2Fapp%2Findex\.html$/u)
  await signInOnGatewayPage(page)

  await expect(page).toHaveURL(gateway.appUrl())
  await expect(page.getByRole('link', { name: /Researcher/u })).toBeVisible()
  await expect(app.transcript).toHaveCount(0)
})

test('a wrong password stays on the sign-in page and does not let the client in', async ({
  diagnostics,
  gateway,
  page
}) => {
  diagnostics.allow(REFUSED_BY_GATEWAY)
  await page.goto(gateway.appUrl())
  await signInOnGatewayPage(page, 'not the password')

  await expect(page.getByRole('alert')).toHaveText('Invalid credentials')
  await expect(page).toHaveURL(/\/login\?next=/u)
})

for (const [how, lapse] of [
  ['the cookie is deleted', 'cookie'],
  ['the gateway ends every session', 'gateway']
] as const) {
  test(`${how} before the client asks who it is: "Sign in again", and signing in restores the route`, async ({
    app,
    gateway,
    diagnostics,
    page
  }) => {
    await app.signIn()

    // The page and its script load signed in; the session is gone when the first question is asked.
    await page.route('**/api/auth/me', async route => {
      if (lapse === 'cookie') {
        await page.context().clearCookies()
      } else {
        await gateway.expireSessions()
      }

      await route.continue()
    })
    diagnostics.allow(REFUSED_BY_GATEWAY)
    await page.goto(gateway.appUrl('#/chat/writer'))

    await expect(page.getByRole('heading', { level: 1, name: 'Signed out' })).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('Your session')
    // Nothing of the bots is on the page.
    await expect(page.getByRole('link', { name: /Researcher|Writer/u })).toHaveCount(0)
    await expect(app.transcript).toHaveCount(0)

    await page.unroute('**/api/auth/me')
    await page.getByRole('button', { name: 'Sign in again' }).click()
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard-plugins%2Fhermie%2Fapp%2Findex\.html$/u)

    await signInOnGatewayPage(page)

    // The trip dropped the fragment; the client put it back, once, and opened that chat.
    await expect(page).toHaveURL(gateway.appUrl('#/chat/writer'))
    await expect(page.getByRole('textbox', { name: 'Message Writer' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Writer' })).toBeVisible()
  })
}

test('a session that lapses while the page is open is a signed-out line over the app, with a way back', async ({
  app,
  gateway,
  diagnostics,
  page
}) => {
  await app.open('#/')
  await expect(page.getByRole('link', { name: /Researcher/u })).toBeVisible()

  // The next dial is refused: the cookie no longer names a session.
  diagnostics.allow(REFUSED_BY_GATEWAY)
  diagnostics.allow(/WebSocket/u)
  await gateway.expireSessions()
  await gateway.dropSockets()

  const line = page.locator('.hm-status[data-status="needs_signin"]')

  await expect(line).toBeVisible()
  await expect(line).toHaveAttribute('role', 'alert')

  await line.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/login\?next=/u)
  await signInOnGatewayPage(page)
  await expect(page.getByRole('link', { name: /Researcher/u })).toBeVisible()
})

test('signing out in one tab stops the other tab on the same gateway at once', async ({
  app,
  context,
  gateway,
  page
}) => {
  await app.open('#/')

  const other = await context.newPage()

  await other.goto(gateway.appUrl('#/'))
  await expect(other.getByRole('link', { name: /Researcher/u })).toBeVisible()
  await expect.poll(async () => (await gateway.state()).openSockets).toBe(2)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login\?next=/u)

  // Told by the tab that left: no wait for its next dial to be refused.
  await expect(other.getByRole('heading', { name: 'Signed out' })).toBeVisible()
  await expect(other.getByRole('button', { name: 'Sign in again' })).toBeVisible()
  await expect.poll(async () => (await gateway.state()).openSockets).toBe(0)
  await other.close()
})

test('framed by another page, it says one sentence and asks the gateway for nothing', async ({
  app,
  gateway,
  page
}) => {
  await app.signIn()

  const requests: string[] = []

  page.on('request', request => {
    if (new URL(request.url()).origin === gateway.url) {
      requests.push(new URL(request.url()).pathname)
    }
  })

  // A page that frames the client, on the gateway's own site and signed in: the case the guard is for.
  await page.route(`${gateway.url}/framing-host.html`, route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Host</title><iframe title="client" src="${gateway.appUrl(`#/chat/${BOT}`)}" width="600" height="400"></iframe>`
    })
  )
  await page.goto(`${gateway.url}/framing-host.html`)

  const frame = page.frameLocator('iframe[title="client"]')

  await expect(frame.locator('body')).toHaveText('Hermie does not run inside a frame. Open it in a tab of its own.')
  // One sentence: no heading, no chat list, no button, no transcript.
  await expect(frame.getByRole('heading')).toHaveCount(0)
  await expect(frame.getByRole('button')).toHaveCount(0)
  await expect(frame.getByRole('navigation')).toHaveCount(0)
  await expect(frame.getByRole('log')).toHaveCount(0)

  // The document and its script were fetched; the gateway's API was never asked anything.
  expect(requests).toContain('/dashboard-plugins/hermie/app/index.html')
  expect(requests.filter(path => path.startsWith('/api') || path.startsWith('/auth'))).toEqual([])
})
