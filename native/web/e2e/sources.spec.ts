/**
 * The pages a reply used (`contract/sources/`), in a real browser: the "Sources" pill under the reply, the dialog it opens,
 * and what the page tells the gateway it draws.
 *
 * The fake gateway ends a turn with sources the way the real one does (`message.complete.sources`, and
 * `display_metadata.sources` on the reply's row), so the pill is checked both live and after a reload from the history.
 * The spec checks what a reader and a screen reader meet (names, roles, focus, Escape), the link policy (a new tab, no
 * opener, no referrer, only on a press), that nothing leaves the page because of the list (no request to any origin but the
 * gateway's before a link is opened, no image), runs axe over the page with the dialog closed and open, and that the
 * page advertises `chart`, `cards` and `alerts` in `client.capabilities`.
 *
 * Set `SOURCES_WEB_SHOTS` to a directory to also write a picture of the reply with the pill, and of the open dialog, for each
 * scheme and width.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { type Locator } from '@playwright/test'

import { type App, expect, seriousViolations, test } from './fixtures'

const pillOf = (app: App): Locator => app.transcript.getByRole('button', { name: /^(Sources|Bronnen)/u })

/** The newest reply that says `text`. */
const replyWith = (app: App, text: string): Locator =>
  app.transcript.locator('.hm-msg[data-side="bot"]', { hasText: text }).last()

test.describe('the Sources pill and its dialog', () => {
  test('sit under a reply that used pages, open on a press, and follow the link policy', async ({ app, page }) => {
    // Every origin the page talks to before a link is opened: the gateway's, and no other.
    const origins = new Set<string>()

    page.on('request', request => {
      const url = new URL(request.url())

      if (url.protocol.startsWith('http')) {
        origins.add(url.origin)
      }
    })

    await app.open()
    await app.ready()
    await app.send('please show misleading sources')

    const reply = replyWith(app, 'I checked your bank')

    await expect(reply).toBeVisible()

    const pill = pillOf(app)

    await expect(pill).toBeVisible()
    await expect(pill).toContainText('2')
    await expect(pill).toHaveAttribute('aria-haspopup', 'dialog')
    // Under the bubble, in the same message, and not in it.
    await expect(reply.locator('.hm-bubble').getByRole('button', { name: /^Sources/u })).toHaveCount(0)
    await expect(reply.getByRole('button', { name: /^Sources/u })).toBeVisible()

    await pill.click()

    const dialog = page.getByRole('dialog', { name: 'Sources' })

    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused()
    await expect(dialog.getByRole('region', { name: 'Read' }).getByRole('listitem')).toHaveCount(1)
    await expect(dialog.getByRole('region', { name: 'Found' }).getByRole('listitem')).toHaveCount(1)

    // A title that names another place than its address: the host is written out beside it.
    const misleading = dialog.getByRole('link', { name: /Your bank - secure sign in/u })

    await expect(misleading).toContainText('phish.example.net')
    await expect(misleading).toHaveAttribute('href', 'https://phish.example.net/login')
    await expect(misleading).toHaveAttribute('target', '_blank')
    await expect(misleading).toHaveAttribute('rel', 'noopener noreferrer')

    const second = dialog.getByRole('link', { name: /Reuters: markets calm/u })

    await expect(second).toContainText('www.example.com')

    // Nothing was asked of any other origin, and no image is on the page, because the reply has sources.
    expect([...origins]).toHaveLength(1)
    await expect(dialog.locator('img')).toHaveCount(0)
    await expect(reply.locator('img')).toHaveCount(0)

    // Tab stays in the dialog.
    const done = dialog.getByRole('button', { name: 'Done' })

    await second.focus()
    await page.keyboard.press('Tab')
    await expect(done).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(second).toBeFocused()

    // Escape closes it, and the focus is back on the pill.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(pill).toBeFocused()

    // The backdrop closes it too.
    await pill.click()
    await expect(dialog).toBeVisible()
    await page.mouse.click(4, 4)
    await expect(dialog).toHaveCount(0)

    // A press on the link opens a new tab, with no way back to this page; this is the first request to that origin.
    await page
      .context()
      .route('https://phish.example.net/**', route => route.fulfill({ body: 'ok', contentType: 'text/plain' }))
    await pill.click()

    const [popup] = await Promise.all([
      page.context().waitForEvent('page'),
      page
        .getByRole('dialog', { name: 'Sources' })
        .getByRole('link', { name: /Your bank - secure sign in/u })
        .click()
    ])

    expect(await popup.evaluate(() => window.opener)).toBeNull()
    await popup.close()
  })

  test('are still there after a reload, from the history', async ({ app, page }) => {
    await app.open()
    await app.ready()
    await app.send('please show many sources')
    await expect(replyWith(app, 'I read two pages')).toBeVisible()
    await expect(pillOf(app)).toContainText('8')

    await page.reload()
    await app.ready()

    const pill = pillOf(app)

    await expect(pill).toBeVisible()
    await expect(pill).toContainText('8')
    await pill.click()

    const dialog = page.getByRole('dialog', { name: 'Sources' })

    await expect(dialog.getByRole('region', { name: 'Read' }).getByRole('listitem')).toHaveCount(2)
    await expect(dialog.getByRole('region', { name: 'Found' }).getByRole('listitem')).toHaveCount(6)
    // A name that is not ASCII arrives as the gateway stored it: punycode.
    await expect(dialog).toContainText('xn--bcher-kva.example')
    // An entry with no title shows its host as its title.
    await expect(dialog.getByRole('link', { name: /wiki\.example\.org/u })).toBeVisible()
  })

  test('are not drawn for a reply that used none', async ({ app }) => {
    await app.open()
    await app.ready()
    await app.send('hello there')
    await expect(app.transcript.locator('.hm-bubble[data-kind="assistant"]').last()).toBeVisible()
    await expect(pillOf(app)).toHaveCount(0)
  })
})

test.describe('what the page advertises', () => {
  test('is exactly chart, cards and alerts, in the call that follows a result that carried the key', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    await expect
      .poll(async () => {
        const state = (await gateway.state()) as unknown as {
          clientCapabilities: { markup?: string[] }[]
        }

        return state.clientCapabilities.filter(call => call.markup !== undefined).map(call => call.markup)
      })
      .toContainEqual(['alerts', 'cards', 'chart'])

    const state = (await gateway.state()) as unknown as { clientCapabilities: { markup?: string[] }[] }

    // Every call that carried the key carried exactly those three names.
    expect(
      state.clientCapabilities.every(call => call.markup === undefined || call.markup.join() === 'alerts,cards,chart')
    ).toBe(true)
  })
})

test.describe('a gateway that does not know the key', () => {
  test.use({ gatewayOptions: { markup: false } })

  test('is never sent it: the page works as before', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    const state = (await gateway.state()) as unknown as { clientCapabilities: Record<string, unknown>[] }

    expect(state.clientCapabilities.length).toBeGreaterThan(0)
    expect(state.clientCapabilities.some(call => 'markup' in call)).toBe(false)
  })
})

const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1100, height: 800 }
] as const

for (const scheme of ['light', 'dark'] as const) {
  for (const size of WIDTHS) {
    test.describe(`in the ${scheme} scheme at ${size.width} px`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: size.width, height: size.height })
        await page.emulateMedia({ colorScheme: scheme })
      })

      test('is accessible, closed and open, and fits the screen', async ({ app, page, browserName, diagnostics }) => {
        await app.open()
        await app.ready()
        await app.send('please show sources')

        const reply = replyWith(app, 'The gateway is installed')

        await expect(reply).toBeVisible()
        await expect(pillOf(app)).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        expect(await seriousViolations(page, `sources-closed-${scheme}-${size.width}`)).toEqual([])

        const shots = process.env.SOURCES_WEB_SHOTS

        if (shots && browserName === 'webkit') {
          // Playwright's own screenshot in WebKit appends an empty style element, which the page's policy refuses.
          diagnostics.allow(/^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'/u)
          diagnostics.allowViolation(/^style-src-elem blocked inline at \S+\/index\.html:\d+ $/u)
        }

        if (shots) {
          mkdirSync(shots, { recursive: true })
          await reply.screenshot({ path: join(shots, `reply-pill-${scheme}-${size.name}-${browserName}.png`) })
        }

        await pillOf(app).click()

        const dialog = page.getByRole('dialog', { name: 'Sources' })

        await expect(dialog).toBeVisible()

        const box = await dialog.boundingBox()

        expect(box).not.toBeNull()
        expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= size.width).toBe(true)
        expect(await seriousViolations(page, `sources-open-${scheme}-${size.width}`)).toEqual([])

        if (shots) {
          await page.screenshot({ path: join(shots, `dialog-${scheme}-${size.name}-${browserName}.png`) })
        }
      })
    })
  }
}
