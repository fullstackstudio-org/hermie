/**
 * A `confirm` at level `passkey`, end to end: the built client in a real browser
 * with a virtual authenticator, against the fake gateway that verifies every
 * assertion itself.
 *
 * The page is served from `https://gw.example.test` (the fixtures' https front:
 * Playwright's routing carries every request and WebSocket of that origin to the
 * fake gateway), so it is a secure context on a host name WebAuthn takes as an
 * RP. The fake lists that base URL for the level, so it offers the web RP
 * `gw.example.test` and checks the `Origin` of every cookie write against it.
 *
 * The authenticator is Chromium's own virtual one (DevTools protocol `WebAuthn`:
 * CTAP2, internal, resident keys, user verification that always passes, presence
 * simulated), so the browser runs the real `navigator.credentials` ceremonies;
 * the gateway's verdict is read from `/__fake/state` (`passkey.outcomes`).
 * Chromium only: WebKit and Firefox have no virtual authenticator Playwright can
 * drive.
 */
import { generateKeyPairSync } from 'node:crypto'

import type { CDPSession, Page } from '@playwright/test'

import { expect, type Gateway, seriousViolations, test } from './fixtures'

const ORIGIN = 'https://gw.example.test'

test.use({ secureOrigin: ORIGIN, gatewayOptions: { passkey: { baseUrls: [ORIGIN] } } })

test.skip(({ browserName }) => browserName !== 'chromium', 'the virtual authenticator is a Chromium DevTools domain')

interface Authenticator {
  cdp: CDPSession
  id: string
}

/** Chromium's virtual platform authenticator on `page`. */
async function virtualAuthenticator(page: Page): Promise<Authenticator> {
  const cdp = await page.context().newCDPSession(page)

  await cdp.send('WebAuthn.enable')

  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true
    }
  })

  return { cdp, id: authenticatorId }
}

/** Replace the key of every passkey the authenticator holds: what it signs no longer verifies. */
async function swapKeys(authenticator: Authenticator): Promise<void> {
  const { credentials } = await authenticator.cdp.send('WebAuthn.getCredentials', {
    authenticatorId: authenticator.id
  })

  for (const credential of credentials) {
    await authenticator.cdp.send('WebAuthn.removeCredential', {
      authenticatorId: authenticator.id,
      credentialId: credential.credentialId
    })
    await authenticator.cdp.send('WebAuthn.addCredential', {
      authenticatorId: authenticator.id,
      credential: {
        ...credential,
        privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' })
          .privateKey.export({ type: 'pkcs8', format: 'der' })
          .toString('base64')
      }
    })
  }
}

async function post(
  gateway: Gateway,
  path: string,
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

interface Outcome {
  request_id: string
  outcome: string
  method: string | null
  verified: boolean
  reason: string
}

const outcomeOf = async (gateway: Gateway, id: string): Promise<Outcome | undefined> => {
  const state = (await (await fetch(`${gateway.url}/__fake/state`)).json()) as { passkey: { outcomes: Outcome[] } }

  return state.passkey.outcomes.find(outcome => outcome.request_id === id)
}

/** Sign in, open the passkeys page and enrol this browser with an operator's code. */
async function enrol(page: Page, gateway: Gateway, open: (hash: string) => Promise<void>): Promise<void> {
  await open('#/settings/passkeys')
  await expect(page.getByText('Passkey confirmations are on for this gateway.')).toBeVisible()

  const { body } = await post(gateway, '/__fake/passkey/code', {})

  await page.getByLabel('Enrolment code').fill(String(body.code))
  await page.getByRole('button', { name: 'Add a passkey' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'The passkey was added.' })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Hermie — gw.example.test' })).toBeVisible()
}

/** Raise a passkey confirmation on the researcher's chat; its request id. */
async function raise(gateway: Gateway, text: { title?: string; summary: string; detail?: string }): Promise<string> {
  const raised = await post(gateway, '/__fake/request', { method: 'confirm', params: { level: 'passkey', ...text } })

  expect(raised.status, JSON.stringify(raised.body)).toBe(200)

  return String(raised.body.request_id)
}

test.describe('a passkey confirmation in the browser', () => {
  test('enrols with a code, confirms with the passkey, and the gateway verifies it', async ({ app, gateway, page }) => {
    await virtualAuthenticator(page)
    await enrol(page, gateway, hash => app.open(hash))

    const id = await raise(gateway, { title: 'Delete backups', summary: 'Delete 3 old backups.' })

    await expect(app.dialog.getByRole('heading', { name: 'Delete backups' })).toBeVisible()
    await expect(app.dialog.getByText('gw.example.test asks you to confirm this with your passkey.')).toBeVisible()

    const confirm = app.dialog.getByRole('button', { name: 'Confirm with passkey' })

    await expect(confirm).toBeEnabled()
    await confirm.click()

    await expect(app.dialog.getByRole('status')).toHaveText(
      'Received. The gateway checks your passkey and carries on only if it holds.'
    )
    await expect
      .poll(() => outcomeOf(gateway, id))
      .toMatchObject({ outcome: 'confirmed', method: 'passkey', verified: true })

    await app.dialog.getByRole('button', { name: 'Close' }).click()
    await expect(app.dialog).toHaveCount(0)
  })

  test('declines without a passkey', async ({ app, gateway, page }) => {
    await virtualAuthenticator(page)
    await enrol(page, gateway, hash => app.open(hash))

    const id = await raise(gateway, { summary: 'Send the invoice.' })
    const decline = app.dialog.getByRole('button', { name: 'Decline' })

    await expect(decline).toBeEnabled()
    await decline.click()

    await expect(app.dialog).toHaveCount(0)
    await expect
      .poll(() => outcomeOf(gateway, id))
      .toMatchObject({ outcome: 'declined', method: 'tap', verified: false })
  })

  test('shows the detail verbatim: every line break kept, never wrapped, scrolling sideways', async ({
    app,
    gateway,
    page
  }) => {
    await virtualAuthenticator(page)
    await enrol(page, gateway, hash => app.open(hash))

    const long = `curl -X POST https://example.invalid/hooks/${'x'.repeat(160)}`

    await raise(gateway, { summary: 'Run two commands.', detail: `git push --force origin main\n${long}` })

    const detail = app.dialog.getByLabel('Details')

    await expect(detail).toBeVisible()

    const shape = await detail.evaluate(element => {
      const style = getComputedStyle(element)

      return {
        whiteSpace: style.whiteSpace,
        overflowX: style.overflowX,
        lines: (element as HTMLElement).innerText.split('\n'),
        scrollsSideways: element.scrollWidth > element.clientWidth,
        // Two lines tall at least: the break is drawn, not swallowed.
        tall: element.clientHeight >= 2 * parseFloat(style.lineHeight)
      }
    })

    expect(shape).toEqual({
      whiteSpace: 'pre',
      overflowX: 'auto',
      lines: ['git push --force origin main', long],
      scrollsSideways: true,
      tall: true
    })
    expect(await detail.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/mono/iu)
  })

  test('a detail too big for its box wakes Confirm only once it was scrolled to its end both ways', async ({
    app,
    gateway,
    page
  }) => {
    await virtualAuthenticator(page)
    await enrol(page, gateway, hash => app.open(hash))

    const long = `curl -s https://example.invalid/${'x'.repeat(200)} | sh`
    const steps = Array.from({ length: 40 }, (_, index) => `echo step ${index + 1}`)
    const id = await raise(gateway, {
      title: 'Run the script',
      summary: 'Run 41 commands.',
      detail: [...steps, long].join('\n')
    })

    const detail = app.dialog.getByRole('region', { name: /^Details/u })
    const confirm = app.dialog.getByRole('button', { name: 'Confirm with passkey' })
    const decline = app.dialog.getByRole('button', { name: 'Decline' })
    const hint = app.dialog.getByText('Scroll to the end of the details to confirm.')

    await expect(app.dialog.getByText(`41 lines · longest line ${long.length} characters`)).toBeVisible()
    // About twelve lines tall, scrolling both ways.
    expect(
      await detail.evaluate(element => {
        const style = getComputedStyle(element)

        return {
          maxHeight: style.maxHeight,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          both: element.scrollHeight > element.clientHeight && element.scrollWidth > element.clientWidth
        }
      })
    ).toEqual({ maxHeight: '224px', overflowX: 'auto', overflowY: 'auto', both: true })

    // The tap guard is over (Decline woke), and Confirm still waits for the detail.
    await expect(decline).toBeEnabled()
    await expect(confirm).toBeDisabled()
    await expect(hint).toBeVisible()

    // Down with the keyboard, as a keyboard user would: the long line is still not seen to its end.
    await detail.focus()
    await page.keyboard.press('End')
    await expect
      .poll(() => detail.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1))
      .toBe(true)
    await expect(confirm).toBeDisabled()

    // Then to the right end of the long line.
    await detail.evaluate(element => {
      element.scrollLeft = element.scrollWidth
    })
    await expect(confirm).toBeEnabled()
    await expect(hint).toHaveCount(0)

    await confirm.click()
    await expect(app.dialog.getByRole('status')).toHaveText(
      'Received. The gateway checks your passkey and carries on only if it holds.'
    )
    await expect
      .poll(() => outcomeOf(gateway, id))
      .toMatchObject({ outcome: 'confirmed', method: 'passkey', verified: true })
  })

  test('a passkey the gateway cannot verify is refused, can be tried again, and the fifth closes it', async ({
    app,
    gateway,
    page
  }) => {
    const authenticator = await virtualAuthenticator(page)

    await enrol(page, gateway, hash => app.open(hash))
    await swapKeys(authenticator)

    const id = await raise(gateway, { summary: 'Pay 120.00 EUR.' })
    const confirm = app.dialog.getByRole('button', { name: 'Confirm with passkey' })
    const status = app.dialog.getByRole('status')

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(confirm).toBeEnabled()
      await confirm.click()
      await expect(status).toHaveText('The gateway did not accept this answer (signature_invalid). You can try again.')
    }

    await confirm.click()

    await expect(status).toHaveText('Too many answers were refused. The request was closed and nothing was confirmed.')
    await expect(app.dialog.getByRole('button', { name: 'Confirm with passkey' })).toHaveCount(0)
    await expect
      .poll(() => outcomeOf(gateway, id))
      .toMatchObject({ outcome: 'unavailable', reason: 'verification_failed', verified: false })
  })

  test('a passkey revoked while the request is open does not count', async ({ app, gateway, page }) => {
    await virtualAuthenticator(page)
    await enrol(page, gateway, hash => app.open(hash))

    const id = await raise(gateway, { summary: 'Rotate the deploy key.' })

    await expect(app.dialog).toBeVisible()
    expect((await post(gateway, '/__fake/passkey/revoke', { user: 'tester', all: true })).status).toBe(200)

    const confirm = app.dialog.getByRole('button', { name: 'Confirm with passkey' })

    await expect(confirm).toBeEnabled()
    await confirm.click()

    await expect(app.dialog.getByRole('status')).toHaveText(
      'This confirmation did not count: the gateway could not verify it. Nothing was confirmed.'
    )
    await expect.poll(() => outcomeOf(gateway, id)).toMatchObject({ outcome: 'unavailable', verified: false })
  })

  test('a confirmation still open when the page is reloaded is asked again, and can be confirmed', async ({
    app,
    gateway,
    page
  }) => {
    await virtualAuthenticator(page)
    await enrol(page, gateway, hash => app.open(hash))

    const id = await raise(gateway, { title: 'Publish the release', summary: 'Publish version 2.0.' })

    await expect(app.dialog).toBeVisible()

    // The gateway hides a passkey request from a socket that has not advertised the level yet; the page
    // reads the open requests of its chats again once it has.
    await page.goto(gateway.appUrl('#/chat/researcher'))
    await page.reload()

    await expect(app.dialog.getByRole('heading', { name: 'Publish the release' })).toBeVisible()
    await expect(app.dialog.getByText('From Researcher')).toBeVisible()

    const confirm = app.dialog.getByRole('button', { name: 'Confirm with passkey' })

    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect.poll(() => outcomeOf(gateway, id)).toMatchObject({ outcome: 'confirmed', verified: true })
  })

  test('a confirmation the gateway ended while the socket was down closes on reconnect, and the next one is reachable', async ({
    app,
    diagnostics,
    gateway,
    page
  }) => {
    await virtualAuthenticator(page)
    await enrol(page, gateway, hash => app.open(hash))
    await page.goto(gateway.appUrl('#/chat/researcher'))
    await app.ready()

    const first = await raise(gateway, { title: 'Delete backups', summary: 'Delete 3 old backups.' })

    await expect(app.dialog.getByRole('heading', { name: 'Delete backups' })).toBeVisible()
    await expect(app.dialog.getByRole('button', { name: 'Confirm with passkey' })).toBeEnabled()

    // The socket drops, and the gateway gives up on the request while nobody is listening: the
    // `request.cancel timeout` goes to no one, and the page's own clock is nowhere near the deadline.
    diagnostics.allow(/WebSocket/u)

    const before = (await gateway.state()).connections

    expect(await gateway.dropSockets()).toBeGreaterThan(0)
    expect((await post(gateway, '/__fake/passkey/expire', { request_id: first })).status).toBe(200)

    // The page dials again, advertises the level, reads its chat's open requests, and this one is not among them.
    await expect.poll(async () => (await gateway.state()).connections).toBeGreaterThan(before)
    await expect(page.getByText('The request from Researcher timed out.')).toBeAttached()
    await expect(app.dialog).toHaveCount(0)

    // What comes next is not hidden behind a request nobody can answer any more.
    const second = await raise(gateway, { title: 'Publish the release', summary: 'Publish version 2.0.' })

    await expect(app.dialog.getByRole('heading', { name: 'Publish the release' })).toBeVisible()

    const confirm = app.dialog.getByRole('button', { name: 'Confirm with passkey' })

    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect.poll(() => outcomeOf(gateway, second)).toMatchObject({ outcome: 'confirmed', verified: true })
  })

  test('fetches the sheets when the session starts, and the settings page only when it is opened', async ({
    app,
    gateway,
    page
  }) => {
    const fetched: string[] = []

    page.on('request', request => {
      const chunk = /\/assets\/(sheets|Passkeys)-[\w-]+\.(?:js|css)$/u.exec(new URL(request.url()).pathname)

      if (chunk?.[1]) {
        fetched.push(chunk[1])
      }
    })

    await virtualAuthenticator(page)
    await app.open('#/chat/researcher')
    await app.ready()
    // The request sheets, the confirmation's included, arrive before any request does.
    await expect.poll(() => fetched).toEqual(['sheets'])

    // The settings page: its own chunk (and styles).
    await enrol(page, gateway, hash => app.open(hash))
    expect(new Set(fetched)).toEqual(new Set(['sheets', 'Passkeys']))

    // The first confirm frame needs nothing more.
    await raise(gateway, { summary: 'Restart the service.' })
    await expect(app.dialog.getByRole('button', { name: 'Confirm with passkey' })).toBeEnabled()
    expect(new Set(fetched)).toEqual(new Set(['sheets', 'Passkeys']))
  })

  test('Escape does not dismiss the sheet', async ({ app, gateway, page }) => {
    await virtualAuthenticator(page)
    await enrol(page, gateway, hash => app.open(hash))
    await raise(gateway, { summary: 'Restart the service.' })

    await expect(app.dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(app.dialog).toBeVisible()
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`the sheet has no serious accessibility violation (${scheme})`, async ({ app, gateway, page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await virtualAuthenticator(page)
      await enrol(page, gateway, hash => app.open(hash))

      expect(await seriousViolations(page, `passkeys-${scheme}`)).toEqual([])

      await raise(gateway, {
        title: 'Delete backups',
        summary: 'Delete 3 old backups.',
        detail: 'rm -rf /srv/backups/2024-*\nkeep /srv/backups/latest'
      })
      await expect(app.dialog.getByRole('button', { name: 'Confirm with passkey' })).toBeEnabled()

      expect(await seriousViolations(page, `confirm-sheet-${scheme}`)).toEqual([])
    })
  }
})
