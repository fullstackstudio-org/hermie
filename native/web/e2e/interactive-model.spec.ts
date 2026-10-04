/**
 * The interactive requests (`input.form`, `input.file`, `review.draft`) reach the page, in a real
 * browser against the fake gateway serving the built client. The sheets for them are the next task's,
 * so what is on screen is the stand-in; what this proves is everything under it:
 *
 *  - **The advert.** Off by default until the sheets exist: a page left as it is advertises nothing and
 *    the gateway answers the agent 409 `no_capable_client`. The other tests turn it on (the device-local
 *    switch `ADVERTISE_INTERACTIVE_REQUESTS_KEY`). The gateway sends one of these only to a connection
 *    that listed it in the second `client.capabilities` call: nothing is raised before the page has
 *    attached, and the same raise reaches the page once it has.
 *  - **It is shown, in the app's words,** with the bot's heading and words as plain text; the person
 *    can Decline, which the gateway reads as the JSON-RPC error `4041 cannot_show {reason}` (and the
 *    agent as unavailable), or Skip when the request is optional (`{status: "skipped"}` through
 *    `request.answer`); a review has no Skip.
 *  - **It ends with the gateway's deadline:** the sheet closes and the reader is told.
 *  - **A reload brings it back:** the request is still open on the gateway, the page lists it again
 *    (`open_requests` read after the advert) and it can be answered.
 *  - **A dropped socket does not end it:** the new socket's resume and replay run before its advert, when
 *    the gateway still hides the request from it; the page waits for the advert before it believes a list.
 */
import type { Page } from '@playwright/test'

import { BOT, expect, type Gateway, test } from './fixtures'

/** The device-local switch that turns the advert on before the sheets do (`ADVERTISE_INTERACTIVE_REQUESTS_KEY`). */
const ADVERT_SWITCH = 'hermie:/:device.dev.advertise-interactive-requests'
/** Cut without a close frame: the browser says so on the console. */
const DROPPED_SOCKET = /WebSocket connection to .* failed/u

async function advertise(page: Page): Promise<void> {
  await page.addInitScript(key => localStorage.setItem(key, 'on'), ADVERT_SWITCH)
}

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

test.describe('a page left as it is', () => {
  test('advertises none of them yet, and the gateway tells the agent there is no capable client', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    await expect
      .poll(async () => ((await gateway.state()) as unknown as { clientCapabilities: unknown[] }).clientCapabilities)
      .not.toHaveLength(0)

    const calls = (await gateway.state()) as unknown as { clientCapabilities: Record<string, unknown>[] }

    expect(calls.clientCapabilities.some(call => 'requests' in call)).toBe(false)

    const raised = await fetch(`${gateway.url}/__fake/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: BOT, method: 'input.form' })
    })

    expect(raised.status).toBe(409)
    expect(((await raised.json()) as { error: string }).error).toBe('no_capable_client')
    await expect(app.dialog).toHaveCount(0)
  })
})

test.describe('a request from the agent reaches the page', () => {
  test.beforeEach(async ({ page }) => advertise(page))

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

  test('stays open through a dropped socket, and is answered on the new one', async ({
    app,
    gateway,
    page,
    diagnostics
  }) => {
    await app.open()
    await app.ready()

    const id = await raiseWhenAdvertised(gateway, 'input.form')

    await expect(app.dialog).toHaveAccessibleName('A request this page cannot show yet')

    // A question every connection may see waits behind it, so the new socket's resume lists an open request:
    // that one, not the form, which the gateway hides from a socket that has not advertised it yet.
    await gateway.raise('clarify', { question: 'Which colour?', choices: ['Red', 'Blue'], request_id: 'q-colour' })

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

    // Still the same request, still open, and nothing said it ended.
    await expect(app.dialog).toHaveAccessibleName('A request this page cannot show yet')
    await expect(page.getByText('ended while the connection was down')).toHaveCount(0)
    expect((await viewOf(gateway, id)).open).toBe(true)

    // Answered through the new socket; the question behind it is next.
    await app.dialog.getByRole('button', { name: 'Skip' }).click()
    await expect.poll(async () => (await viewOf(gateway, id)).answer).toEqual({ status: 'skipped' })
    await expect(app.dialog).toContainText('Which colour?')
  })
})
