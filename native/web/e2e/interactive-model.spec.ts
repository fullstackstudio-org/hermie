/**
 * The interactive requests (`input.form`, `input.file`, `review.draft`, `review.diff`) reach the page, in a real browser against the
 * fake gateway serving the built client. What this proves is the model under the sheets (their own answers are in
 * `requests-interactive.spec.ts`):
 *
 *  - **The advert.** The page lists the four methods in the second `client.capabilities` call. The gateway sends one
 *    of these only to a connection that did: nothing is raised before the page has attached (409
 *    `no_capable_client`), and the same raise reaches the page once it has.
 *  - **It is shown, in the app's words,** with the bot's heading and words as plain text; the person can Skip when the
 *    request is optional (`{status: "skipped"}` through `request.answer`); a review has no Skip.
 *  - **It ends with the gateway's deadline:** the sheet closes and the reader is told.
 *  - **A reload brings it back:** the request is still open on the gateway, the page lists it again
 *    (`open_requests` read after the advert) and it can be answered.
 *  - **A dropped socket does not end it:** the new socket's resume and replay run before its advert, when the gateway
 *    still hides the request from it; the page waits for the advert before it believes a list.
 */
import { BOT, expect, type Gateway, test } from './fixtures'

/** Cut without a close frame: the browser says so on the console. */
const DROPPED_SOCKET = /WebSocket connection to .* failed/u

interface View {
  id: string
  method: string
  open: boolean
  answer?: Record<string, unknown>
  outcome?: string
  error?: { code?: number; message?: string; data?: { reason?: string } }
}

const viewOf = async (gateway: Gateway, id: string): Promise<View> =>
  (await (await fetch(`${gateway.url}/__fake/request/${id}`)).json()) as View

/**
 * Raise a request the way the agent does, as soon as a client has advertised it: the gateway says 409 until
 * then, and the page's advert is part of what is under test, so this waits for it instead of sleeping.
 */
async function raiseWhenAdvertised(gateway: Gateway, method: string, params: Record<string, unknown> = {}) {
  let id = ''

  await expect
    .poll(
      async () => {
        const response = await fetch(`${gateway.url}/__fake/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ profile: BOT, method, params })
        })

        if (response.ok) {
          id = ((await response.json()) as { id: string }).id
        }

        return response.status
      },
      { timeout: 20_000 }
    )
    .toBe(200)

  return id
}

test.describe('a request from the agent reaches the page', () => {
  test('is not sent before the page has advertised it, and is once it has', async ({ app, gateway }) => {
    const early = await fetch(`${gateway.url}/__fake/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: BOT, method: 'input.form' })
    })

    expect(early.status).toBe(409)
    expect(((await early.json()) as { error: string }).error).toBe('no_capable_client')

    await app.open()
    await app.ready()

    const id = await raiseWhenAdvertised(gateway, 'input.form')

    await expect(app.dialog).toHaveAccessibleName('A form to fill in')
    expect((await viewOf(gateway, id)).open).toBe(true)

    const calls = (await gateway.state()) as unknown as { clientCapabilities: Record<string, unknown>[] }

    expect(calls.clientCapabilities.at(-1)).toMatchObject({
      server_requests: true,
      requests: ['input.form', 'input.file', 'review.draft', 'review.diff']
    })
  })

  test('shows the bot’s words as plain text, and Skip answers {status: skipped}', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    const id = await raiseWhenAdvertised(gateway, 'input.form', {
      title: 'Hotel **booking** <b>details</b>',
      summary: 'Fill this in [here](https://evil.test).'
    })

    await expect(app.dialog).toContainText('Hotel **booking** <b>details</b>')
    await expect(app.dialog).toContainText('Fill this in [here](https://evil.test).')
    await expect(app.dialog.getByRole('link')).toHaveCount(0)
    await expect(app.dialog.locator('b')).toHaveCount(0)

    await app.dialog.getByRole('button', { name: 'Skip' }).click()

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await viewOf(gateway, id)).answer).toEqual({ status: 'skipped' })
  })

  test('Skip answers {status: skipped} when the request is optional; a review has none', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    const file = await raiseWhenAdvertised(gateway, 'input.file')

    await expect(app.dialog).toBeVisible()
    await app.dialog.getByRole('button', { name: 'Skip' }).click()
    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await viewOf(gateway, file)).answer).toEqual({ status: 'skipped' })

    await raiseWhenAdvertised(gateway, 'review.draft')

    await expect(app.dialog).toBeVisible()
    await expect(app.dialog.getByRole('button', { name: 'Skip' })).toHaveCount(0)
    await expect(app.dialog.getByRole('button', { name: 'Reject' })).toBeVisible()
  })

  test('closes when the gateway stops waiting, and says so', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    const id = await raiseWhenAdvertised(gateway, 'input.form')

    await expect(app.dialog).toBeVisible()
    await fetch(`${gateway.url}/__fake/request/${id}/expire`, { method: 'POST' })

    await expect(app.dialog).toHaveCount(0)
    await expect(page.getByText('The request from Researcher timed out.').first()).toBeAttached()
    // The chat keeps the line, in view, until it is closed, and the transcript records how the request ended.
    await expect(page.locator('[data-interactive-notice="expired"]')).toBeVisible()
    await expect(page.locator('[data-interactive-notice="expired"]')).toContainText(
      'The request from Researcher timed out.'
    )
    await expect(page.locator('article[data-kind="request"]')).toContainText('Timed out')
    await page.locator('[data-interactive-notice="expired"]').getByRole('button', { name: 'Close' }).click()
    await expect(page.locator('[data-interactive-notice]')).toHaveCount(0)
  })

  test('is shown again after a reload: the gateway still waits, and the page asks for what is open', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await app.ready()

    const id = await raiseWhenAdvertised(gateway, 'input.form')

    await expect(app.dialog).toBeVisible()
    await page.reload()
    await expect(app.dialog).toHaveAccessibleName('A form to fill in', { timeout: 20_000 })
    expect((await viewOf(gateway, id)).open).toBe(true)

    await app.dialog.getByRole('button', { name: 'Skip' }).click()
    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await viewOf(gateway, id)).answer).toEqual({ status: 'skipped' })
  })

  test('stays open through a dropped socket, and is answered on the new one', async ({
    app,
    gateway,
    page,
    diagnostics
  }) => {
    await app.open()
    await app.ready()

    const id = await raiseWhenAdvertised(gateway, 'input.form')

    await expect(app.dialog).toHaveAccessibleName('A form to fill in')

    // A question every connection may see comes first (the form steps aside, still asked), so the new socket's
    // resume lists an open request: that one, not the form, which the gateway hides from a socket that has not
    // advertised it yet.
    await gateway.raise('clarify', { question: 'Which colour?', choices: ['Red', 'Blue'], request_id: 'q-colour' })
    await expect(app.dialog).toHaveAccessibleName('Before I continue')

    const state = async () =>
      (await gateway.state()) as unknown as {
        connections: number
        clientCapabilities: Record<string, unknown>[]
        methodLog: string[]
      }
    const before = await state()

    diagnostics.allow(DROPPED_SOCKET)
    expect(await gateway.dropSockets()).toBeGreaterThan(0)

    // The page dials again, resumes (the gateway hides the form from the new socket), then advertises.
    await expect.poll(async () => (await state()).connections).toBeGreaterThan(before.connections)
    await expect
      .poll(
        async () =>
          (await state()).clientCapabilities.filter(call => Array.isArray(call.requests)).length >
          before.clientCapabilities.filter(call => Array.isArray(call.requests)).length,
        { timeout: 20_000 }
      )
      .toBe(true)
    // ... and reads the open requests again once the gateway accepted it: the resume's and the replay's lists,
    // which did not list the form, are behind it.
    await expect
      .poll(async () => {
        const since = (await state()).methodLog.slice(before.methodLog.length)
        const advert = since.lastIndexOf('client.capabilities')

        return advert >= 0 && since.slice(advert + 1).includes('session.events.since')
      })
      .toBe(true)

    // The question is on screen, and the form behind it is the same request, still open, and nothing said it ended.
    await expect(app.dialog).toHaveAccessibleName('Before I continue')
    await expect(page.getByText('ended while the connection was down')).toHaveCount(0)
    expect((await viewOf(gateway, id)).open).toBe(true)

    // The question is answered, and the form comes back by itself.
    await page.getByRole('radio', { name: 'Red' }).check()
    await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled()
    await page.getByRole('button', { name: 'Submit' }).click()
    await expect(app.dialog).toHaveAccessibleName('A form to fill in')
    expect((await viewOf(gateway, id)).open).toBe(true)

    // Answered through the new socket.
    await app.dialog.getByRole('button', { name: 'Skip' }).click()
    await expect.poll(async () => (await viewOf(gateway, id)).answer).toEqual({ status: 'skipped' })
    await expect(app.dialog).toHaveCount(0)
  })
})
