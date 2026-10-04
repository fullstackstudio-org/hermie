/**
 * The interactive requests (`input.form`, `input.file`, `review.draft`) reach the page, in a real
 * browser against the fake gateway serving the built client. The sheets for them are the next task's,
 * so what is on screen is the stand-in; what this proves is everything under it:
 *
 *  - **The advert.** The gateway sends one of these only to a connection that listed it in the second
 *    `client.capabilities` call: nothing is raised (409 `no_capable_client`) before the page has
 *    attached, and the same raise reaches the page once it has.
 *  - **It is shown, in the app's words,** with the bot's heading and words as plain text; the person
 *    can Decline, which the gateway reads as the JSON-RPC error `4041 cannot_show {reason}` (and the
 *    agent as unavailable), or Skip when the request is optional (`{status: "skipped"}` through
 *    `request.answer`); a review has no Skip.
 *  - **It ends with the gateway's deadline:** the sheet closes and the reader is told.
 *  - **A reload brings it back:** the request is still open on the gateway, the page lists it again
 *    (`open_requests` read after the advert) and it can be answered.
 */
import { BOT, expect, type Gateway, test } from './fixtures'

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

    await expect(app.dialog).toHaveAccessibleName('A request this page cannot show yet')
    expect((await viewOf(gateway, id)).open).toBe(true)

    const calls = (await gateway.state()) as unknown as { clientCapabilities: Record<string, unknown>[] }

    expect(calls.clientCapabilities.at(-1)).toMatchObject({
      server_requests: true,
      requests: ['input.form', 'input.file', 'review.draft']
    })
  })

  test('shows the bot’s words as plain text, and Decline is 4041 cannot_show at the gateway', async ({
    app,
    gateway
  }) => {
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

    await app.dialog.getByRole('button', { name: 'Decline' }).click()

    await expect(app.dialog).toHaveCount(0)
    await expect
      .poll(async () => {
        const view = await viewOf(gateway, id)

        return [view.outcome, view.error?.code, view.error?.message, view.error?.data?.reason]
      })
      .toEqual(['unavailable', 4041, 'cannot_show', 'not_supported_on_device'])
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
    await expect(app.dialog.getByRole('button', { name: 'Decline' })).toBeVisible()
  })

  test('closes when the gateway stops waiting, and says so', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    const id = await raiseWhenAdvertised(gateway, 'input.form')

    await expect(app.dialog).toBeVisible()
    await fetch(`${gateway.url}/__fake/request/${id}/expire`, { method: 'POST' })

    await expect(app.dialog).toHaveCount(0)
    await expect(page.getByText('The request from Researcher timed out.')).toBeAttached()
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
    await expect(app.dialog).toHaveAccessibleName('A request this page cannot show yet', { timeout: 20_000 })
    expect((await viewOf(gateway, id)).open).toBe(true)

    await app.dialog.getByRole('button', { name: 'Decline' }).click()
    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await viewOf(gateway, id)).outcome).toBe('unavailable')
  })
})
