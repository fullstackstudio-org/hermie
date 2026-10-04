/**
 * Adding a passkey by signing in again, end to end: the built client in a real browser against the fake gateway
 * (cookie mode, the level on, `https://gw.example.test` listed), with Chromium's virtual authenticator.
 *
 * The page asks for a grant (`reauth/begin`, which sets the `__Host-hermes_reauth` binding cookie), leaves for the
 * gateway's own `/auth/login?…&reauth=…&next=…` with the whole window, comes back signed in on the route it left,
 * and finishes with a click: `register/begin` with the grant, the browser's passkey sheet, `register/finish`. The
 * fake plays the identity provider: its sign-in comes straight back (`POST /__fake/passkey/reauth` scripts what it
 * reports).
 *
 * The cases that need the authenticator are Chromium's (WebKit and Firefox have no virtual one Playwright can
 * drive); the older-gateway cases need none, only WebAuthn itself, which Playwright's WebKit on Linux lacks.
 */
import type { CDPSession, Page } from '@playwright/test'

import { expect, type Gateway, test } from './fixtures'

const ORIGIN = 'https://gw.example.test'
const START = 'You will sign in again to prove it is you, then your browser creates the passkey.'

test.use({ secureOrigin: ORIGIN, gatewayOptions: { passkey: { baseUrls: [ORIGIN] } } })

/** Chromium's virtual platform authenticator on `page`. */
async function virtualAuthenticator(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page)

  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true
    }
  })

  return cdp
}

async function post(gateway: Gateway, path: string, body: unknown): Promise<number> {
  const response = await fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  return response.status
}

interface FakeCredential {
  created_via: string
  usable_from?: number
}

const credentialsOf = async (gateway: Gateway): Promise<FakeCredential[]> =>
  ((await (await fetch(`${gateway.url}/__fake/state`)).json()) as { passkey: { credentials: FakeCredential[] } })
    .passkey.credentials

/** The keys of the tab's `sessionStorage`: what the page kept across the trip. */
const stashKeys = (page: Page): Promise<string[]> =>
  page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('passkey-enrol')))

/**
 * Skips the rest of a test in a browser that has no WebAuthn at all. Playwright's WebKit on Linux is built
 * without it (`window.PublicKeyCredential` is undefined there, while macOS WebKit, Firefox and Chromium have
 * it), and the page then rightly offers no way to add a passkey, the code path included. The page has to be a
 * secure context first, so a front that stopped being https fails here instead of being skipped.
 */
async function skipWithoutWebAuthn(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true)
  test.skip(
    !(await page.evaluate(() => typeof window.PublicKeyCredential === 'function')),
    'this browser has no WebAuthn (PublicKeyCredential is undefined), so the page offers no passkey path'
  )
}

test.describe('adding a passkey by signing in again', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'the virtual authenticator is a Chromium DevTools domain')

  test('goes from the click, through the sign-in, to a listed passkey of the person themselves', async ({
    app,
    gateway,
    page
  }) => {
    await virtualAuthenticator(page)
    await app.open('#/settings/passkeys')

    await expect(page.getByText('Passkey confirmations are on for this gateway.')).toBeVisible()
    await expect(page.getByText(START)).toBeVisible()
    // The code path stays beside it.
    await expect(page.getByRole('button', { name: 'Add with a code' })).toBeVisible()

    await page.getByRole('button', { name: 'Add a passkey' }).click()

    // The whole window went to the gateway's sign-in and came back on the route it left, with a grant waiting.
    await expect(page.getByRole('heading', { name: 'Finish adding your passkey' })).toBeVisible()
    expect(new URL(page.url()).hash).toBe('#/settings/passkeys')
    expect(await stashKeys(page)).toHaveLength(1)
    // Nothing happens on its own: no passkey yet, and the sheet waits for the click.
    expect(await credentialsOf(gateway)).toEqual([])

    await page.getByRole('button', { name: 'Finish adding your passkey' }).click()

    await expect(page.getByRole('status').filter({ hasText: 'The passkey was added.' })).toBeVisible()
    await expect(page.getByRole('listitem').filter({ hasText: 'Hermie — gw.example.test' })).toBeVisible()
    // Spent and forgotten.
    await expect(page.getByRole('heading', { name: 'Finish adding your passkey' })).toHaveCount(0)
    expect(await stashKeys(page)).toEqual([])
    expect(await credentialsOf(gateway)).toEqual([expect.objectContaining({ created_via: 'self' })])

    // And it is a passkey that works: the gateway verifies a confirmation signed with it.
    expect(
      await post(gateway, '/__fake/request', {
        method: 'confirm',
        params: { level: 'passkey', title: 'Delete backups', summary: 'Delete 3 old backups.' }
      })
    ).toBe(200)
    await app.dialog.getByRole('button', { name: 'Confirm with passkey' }).click()
    await expect(app.dialog.getByRole('status')).toHaveText(
      'Received. The gateway checks your passkey and carries on only if it holds.'
    )
  })

  test('says why a sign-in did not count and offers to sign in again, which then works', async ({
    app,
    diagnostics,
    gateway,
    page
  }) => {
    // The browser logs the 403 (`reauth_invalid`) the gateway gives on purpose.
    diagnostics.allow(/403/u)
    await virtualAuthenticator(page)
    await app.open('#/settings/passkeys')
    await expect(page.getByText(START)).toBeVisible()

    // The identity provider reuses an earlier sign-in: its `auth_time` is old.
    expect(await post(gateway, '/__fake/passkey/reauth', { fail: 'auth_not_fresh' })).toBe(200)
    await page.getByRole('button', { name: 'Add a passkey' }).click()
    await page.getByRole('button', { name: 'Finish adding your passkey' }).click()

    await expect(page.getByRole('status')).toHaveText(
      'Your identity provider reused an earlier sign-in. Sign out there, then try again.'
    )
    // The grant is over and forgotten; the way on is a new sign-in.
    expect(await stashKeys(page)).toEqual([])
    expect(await credentialsOf(gateway)).toEqual([])
    await expect(page.getByRole('heading', { name: 'Finish adding your passkey' })).toHaveCount(0)

    await post(gateway, '/__fake/passkey/reauth', { clear: true })
    await page.getByRole('button', { name: 'Sign in again' }).click()
    await page.getByRole('button', { name: 'Finish adding your passkey' }).click()

    await expect(page.getByRole('status').filter({ hasText: 'The passkey was added.' })).toBeVisible()
    expect(await credentialsOf(gateway)).toEqual([expect.objectContaining({ created_via: 'self' })])
  })

  test('with a gateway that switched it off, offers the code path only', async ({ app, gateway, page }) => {
    await virtualAuthenticator(page)
    expect(await post(gateway, '/__fake/passkey/enable', { self_enrol: { enabled: false } })).toBe(200)
    await app.open('#/settings/passkeys')

    await expect(page.getByText('Passkey confirmations are on for this gateway.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add with a code' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add a passkey' })).toHaveCount(0)
  })
})

test.describe('an older gateway', () => {
  test('without self_enrol in its status shows only the code path', async ({ app, gateway, page }) => {
    await page.route('**/api/auth/passkeys', async route => {
      if (route.request().method() !== 'GET') {
        await route.fallback()

        return
      }

      const response = await route.fetch({
        url: `${gateway.url}/api/auth/passkeys`,
        headers: await route.request().allHeaders()
      })
      const body = (await response.json()) as Record<string, unknown>

      delete body.self_enrol
      await route.fulfill({ response, json: body })
    })

    await app.open('#/settings/passkeys')
    await skipWithoutWebAuthn(page)

    await expect(page.getByText('Passkey confirmations are on for this gateway.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add with a code' })).toBeVisible()
    await expect(page.getByLabel('Enrolment code')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add a passkey' })).toHaveCount(0)
    await expect(page.getByText(START)).toHaveCount(0)
  })

  test('without the route says so when the button is pressed, and leaves the code path alone', async ({
    app,
    diagnostics,
    page
  }) => {
    // The browser logs the 404 it is given on purpose.
    diagnostics.allow(/404/u)
    await page.route('**/api/auth/passkeys/reauth/begin', route =>
      route.fulfill({ status: 404, json: { detail: 'Not Found' } })
    )
    await app.open('#/settings/passkeys')
    await skipWithoutWebAuthn(page)
    await expect(page.getByText(START)).toBeVisible()

    await page.getByRole('button', { name: 'Add a passkey' }).click()

    await expect(page.getByRole('status')).toContainText('cannot add a passkey by signing in again')
    await expect(page.getByRole('button', { name: 'Add with a code' })).toBeVisible()
    expect(await stashKeys(page)).toEqual([])
  })
})
