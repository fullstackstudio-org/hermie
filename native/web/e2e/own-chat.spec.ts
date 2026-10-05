/**
 * The choice between the shared Bot Chat and the reader's own (ADR-0007, amended), in a real browser against the
 * fake gateway serving the built client.
 *
 *  - **Where it is**: a labelled group of two radios on the chat's options panel and above the groups on a bot's
 *    Conversations page, on the shared chat until the reader says otherwise.
 *  - **Choosing My chat** finds the reader's chat on this bot or makes it (`Chat · <name>`, visible, under the shared
 *    chat), opens it, and the message sent there is in it and not in the shared one; choosing Shared goes back to
 *    the transcript that was left. The page says what happened, and the choice is kept through a reload.
 *  - **Accessibility** with axe, with the control drawn on both surfaces.
 */
import type { Page } from '@playwright/test'

import { BOT, expect, seriousViolations, test } from './fixtures'

const choice = (page: Page) => page.getByRole('group', { name: 'Whose chat' })
const mine = (page: Page) => choice(page).getByRole('radio', { name: 'My chat' })
const shared = (page: Page) => choice(page).getByRole('radio', { name: 'Shared Bot Chat' })

/** Open the chat's options panel. */
async function openOptions(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /options/iu })
    .first()
    .click()
  await expect(choice(page)).toBeVisible()
}

test.describe('the choice', () => {
  test('is on the options panel and above the groups of the Conversations page, on the shared chat at first', async ({
    app,
    page
  }) => {
    await app.open(`#/chat/${BOT}`)
    await app.ready()
    await openOptions(page)

    await expect(shared(page)).toBeChecked()
    await expect(mine(page)).not.toBeChecked()
    await expect(page.getByText('Everyone on this gateway shares this conversation.')).toBeVisible()

    await page.keyboard.press('Escape')
    await page.goto(page.url().replace(/#.*$/u, `#/chat/${BOT}/conversations`))

    await expect(page.getByRole('heading', { level: 1, name: 'Conversations' })).toBeVisible()
    await expect(shared(page)).toBeChecked()
    // Above the groups: it comes before the first group's heading.
    const above = await page.evaluate(() => {
      const control = document.querySelector('.hm-chatchoice')
      const group = document.querySelector('.hm-conversations__group')

      return Boolean(control && group && control.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING)
    })

    expect(above).toBe(true)
  })

  test('opens the reader’s own chat, keeps the two transcripts apart and goes back, and survives a reload', async ({
    app,
    gateway,
    page
  }) => {
    await app.open(`#/chat/${BOT}`)
    await app.ready()
    await app.send('hello shared')
    await expect(app.transcript.getByText('hello shared')).toBeVisible()

    await openOptions(page)
    await mine(page).check()

    // The gateway made the chat: visible, titled for the reader, and under the shared one.
    await expect(page.getByText('Now in your own chat.')).toBeAttached()
    await expect(mine(page)).toBeChecked()
    await expect(page.getByText('Only you see this conversation. The bot keeps its own memory.')).toBeVisible()
    expect(gateway.fake.state.methodLog).toContain('session.create')
    await page.keyboard.press('Escape')

    // A new, empty conversation: the shared one's words are not here.
    await expect(app.transcript.getByText('hello shared')).toHaveCount(0)
    await app.ready()
    await app.send('hello mine')
    await expect(app.transcript.getByText('hello mine')).toBeVisible()

    // A reload opens the chat the reader chose.
    await page.reload()
    await expect(app.transcript.getByText('hello mine')).toBeVisible({ timeout: 30_000 })
    await expect(app.transcript.getByText('hello shared')).toHaveCount(0)

    // And back to the shared one: its transcript is what was left there.
    await openOptions(page)
    await expect(mine(page)).toBeChecked()
    await shared(page).check()
    await expect(page.getByText('Now in the shared Bot Chat.')).toBeAttached()
    await page.keyboard.press('Escape')
    await expect(app.transcript.getByText('hello shared')).toBeVisible()
    await expect(app.transcript.getByText('hello mine')).toHaveCount(0)
  })

  test('keeps a slow read of the shared chat, set off by a reply, out of the own chat', async ({ app, page }) => {
    // Half a second after a reply the client reads the newest rows of every open chat. Hold that read, so the choice
    // is made while it is on its way, and let it in only once the own chat is open: it describes the shared chat,
    // and has to land nowhere.
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => (release = resolve))
    const asked = new Promise<void>(resolve => {
      void page.route('**/api/sessions/*/messages*', async route => {
        resolve()
        await gate
        await route.continue()
      })
    })

    await app.open(`#/chat/${BOT}`)
    await app.ready()
    await app.send('hello shared')
    await expect(app.transcript.getByText('hello shared')).toBeVisible()
    await asked

    await openOptions(page)
    await mine(page).check()
    await expect(page.getByText('Now in your own chat.')).toBeAttached()
    await page.keyboard.press('Escape')

    const answered = page.waitForResponse(response => /\/api\/sessions\/[^/]+\/messages/u.test(response.url()))

    release()
    await answered
    // Two frames: whatever the read does with its rows, it has done it by then.
    await page.evaluate(
      () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )

    await expect(app.transcript.getByText('hello shared')).toHaveCount(0)
  })

  test('is the same choice on the Conversations page, which then lists the reader’s own chat', async ({
    app,
    page
  }) => {
    await app.open(`#/chat/${BOT}/conversations`)
    await expect(shared(page)).toBeChecked()

    await mine(page).check()
    await expect(page.getByText('Now in your own chat.')).toBeAttached()
    await expect(mine(page)).toBeChecked()
    await expect(page.getByRole('heading', { level: 2, name: 'My chat' })).toBeVisible()

    await shared(page).check()
    await expect(page.getByText('Now in the shared Bot Chat.')).toBeAttached()
    await expect(shared(page)).toBeChecked()
  })
})

test.describe('accessibility', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious or critical axe violation in the ${scheme} scheme, on the panel and on the page`, async ({
      app,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await app.open(`#/chat/${BOT}`)
      await app.ready()
      await openOptions(page)
      expect(await seriousViolations(page, `own-chat-panel-${scheme}`)).toEqual([])

      await page.keyboard.press('Escape')
      await page.goto(page.url().replace(/#.*$/u, `#/chat/${BOT}/conversations`))
      await expect(choice(page)).toBeVisible()
      expect(await seriousViolations(page, `own-chat-page-${scheme}`)).toEqual([])
    })
  }
})
