/**
 * An image attached to a chat, in a real browser, against the fake gateway serving the built client.
 *
 * The gateway's history names an attached image by its absolute path (`@image:<path>`), or `[image]` when it
 * has no name for it. What the page does about it:
 *
 *  - **A path in the chat's own profile's `images/` folder** is fetched through
 *    `GET /api/files/images/<name>?profile=<profile>`, with the page's session cookie (never a token in the
 *    address), and drawn as a thumbnail.
 *  - **Any other path** (another profile's folder, a nested one, the default profile's folder in a named
 *    profile's chat) is NOT asked of that route: only the file name would be, and a file of that name in the
 *    chat's own `images/` folder would be a different picture. It falls back to the files routes, which this
 *    gateway does not have either, so the chip says it could not be fetched.
 *  - **A 404** is that same chip, with the gateway's refusal in words.
 *  - **`[image]`** is a compact "Image" chip that is not a control, and nothing is fetched for it.
 *
 * The pictures sit in a temporary folder the fake gateway serves as the researcher's profile home
 * (`profileHomes`); the paths the history names never exist on this machine.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Locator } from '@playwright/test'

import { BOT, expect, test } from './fixtures'

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

const home = mkdtempSync(join(tmpdir(), 'hermie-e2e-attached-'))

mkdirSync(join(home, 'images'))
writeFileSync(join(home, 'images', 'upload_20261004_160406_1.png'), PNG)

const OWN = `/root/.hermes/profiles/${BOT}/images/upload_20261004_160406_1.png`
const NOT_FETCHED = 'The gateway did not hand this file over.'

// Each process that loads this file (the runner, every worker) has a folder of its own, and takes it away
// when it ends.
process.on('exit', () => rmSync(home, { recursive: true, force: true }))

test.describe('an image attached to a chat', () => {
  test.use({ gatewayOptions: { profileHomes: { [BOT]: home } } })

  const reply = (app: { transcript: Locator }) => app.transcript.locator('.hm-bubble[data-kind="user"]').last()

  test('is fetched by the gateway’s own route, as the chat’s profile, with the session cookie, and drawn', async ({
    app,
    gateway,
    page
  }) => {
    const addresses: string[] = []

    page.on('request', request => {
      if (request.url().includes('/api/files/images/')) {
        addresses.push(request.url())
      }
    })

    await gateway.inject({ user: `what is this?\n@image:${OWN}`, assistant: 'A single pixel.' })
    await app.open()

    const picture = reply(app).locator('img')

    await expect(picture).toBeVisible()
    await expect(picture).toHaveAttribute('src', /^data:image\/png;base64,/u)
    await expect(reply(app)).toContainText('what is this?')
    await expect(reply(app)).not.toContainText('@image')

    expect(gateway.fake.state.attachedImageRequests).toEqual([
      { name: 'upload_20261004_160406_1.png', profile: BOT, status: 200 }
    ])
    // The route is the page's own and its credential is the cookie: no token anywhere in the address.
    expect(addresses).toEqual([`${gateway.url}/api/files/images/upload_20261004_160406_1.png?profile=${BOT}`])
  })

  test('is fetched the same way from the handle the gateway writes for an attached image', async ({ app, gateway }) => {
    await gateway.inject({ user: `look\n\n[Image attached at: ${OWN}]`, assistant: 'Seen.' })
    await app.open()

    await expect(reply(app).locator('img')).toBeVisible()
    expect(gateway.fake.state.attachedImageRequests).toHaveLength(1)
  })

  test('says it could not be fetched when the gateway has no such image (404)', async ({
    app,
    diagnostics,
    gateway
  }) => {
    // The browser itself logs the 404; the page handles it.
    diagnostics.allow(/404/u)
    await gateway.inject({
      user: `gone\n@image:/root/.hermes/profiles/${BOT}/images/upload_gone.png`,
      assistant: 'Hm.'
    })
    await app.open()

    await expect(reply(app).getByText(NOT_FETCHED)).toBeVisible()
    await expect(reply(app).locator('img')).toHaveCount(0)
    expect(gateway.fake.state.attachedImageRequests).toEqual([{ name: 'upload_gone.png', profile: BOT, status: 404 }])
  })

  for (const [what, path] of [
    ['the default profile’s folder', '/root/.hermes/images/upload_20261004_160406_1.png'],
    ['another profile’s folder', '/root/.hermes/profiles/writer/images/upload_20261004_160406_1.png'],
    ['a nested folder', `/root/.hermes/profiles/${BOT}/images/sub/upload_20261004_160406_1.png`],
    ['a folder that is not an images folder', `/root/.hermes/profiles/${BOT}/workspace/upload_20261004_160406_1.png`]
  ] as const) {
    test(`does not ask the route for a path in ${what}`, async ({ app, diagnostics, gateway }) => {
      diagnostics.allow(/404/u)
      await gateway.inject({ user: `elsewhere\n@image:${path}`, assistant: 'Hm.' })
      await app.open()

      // The files routes are all that is left, and this gateway has neither.
      await expect(reply(app).getByText(NOT_FETCHED)).toBeVisible()
      await expect(reply(app).locator('img')).toHaveCount(0)
      expect(gateway.fake.state.attachedImageRequests).toEqual([])
    })
  }

  test('is a compact Image chip that is not a control when the gateway named no file', async ({ app, gateway }) => {
    await gateway.inject({ user: 'what is this?\n[image]', assistant: 'I cannot see it.' })
    await app.open()

    const attachments = reply(app).getByRole('list', { name: 'Attachments' })

    await expect(attachments.getByRole('listitem')).toHaveCount(1)
    await expect(attachments).toContainText('Image')
    await expect(attachments.getByRole('button')).toHaveCount(0)
    await expect(reply(app)).not.toContainText('[image]')
    await expect(reply(app).locator('img')).toHaveCount(0)
    expect(gateway.fake.state.attachedImageRequests).toEqual([])
  })
})
