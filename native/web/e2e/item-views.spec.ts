/**
 * The message menu and the chat options in a real browser, against the fake
 * gateway serving the built client:
 *
 *  - **The keyboard reaches a message.** The transcript is one tab stop; the up
 *    arrow moves to the newest message, Enter opens its menu on Copy text, and
 *    choosing it copies the reply's plain words (the clipboard is read back where
 *    the browser lets a test do so) and says so. Escape gives focus back.
 *  - **A pointer reaches it too**, by the one hover button and by a right-click;
 *    a right-click on a link is still the browser's own. No message holds a
 *    control of its own.
 *  - **Regenerate** on the last reply puts the reader's prompt on the gateway
 *    again, because the fake has no `/retry`.
 *  - **The chat's options.** A chat starts quiet, without tool lines; Normal
 *    brings them back at once, the choice outlives a reload, and following the
 *    default again undoes it.
 *  - **Accessibility.** The chat with the options open, and with a menu open, has
 *    no serious or critical axe violation, contrast included.
 */
import type { Page } from '@playwright/test'

import { expect, seriousViolations, test } from './fixtures'

test.use({
  gatewayOptions: {
    scenario: {
      replies: [
        { match: 'bold', deltas: ['Some ', '**bold** words.'] },
        { match: 'link', deltas: ['See [the docs](https://docs.example) for more.'] },
        { deltas: ['Fine. '] }
      ]
    }
  }
})

/** The newest reply, as the element the menu and the keyboard reach. */
const lastReply = (page: Page) => page.getByRole('log').locator('[data-message-id][data-side="bot"]').last()

test.describe('a message’s menu', () => {
  test('is reached from the keyboard: the arrow to the newest message, Enter, and Copy text', async ({
    app,
    page,
    browserName,
    context
  }) => {
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    }

    await app.open()
    await app.ready()
    await app.send('say something bold')
    await expect(lastReply(page)).toContainText('bold words.')
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')

    // No message holds a control: nothing named "Message actions" until a pointer asks.
    await expect(page.getByRole('button', { name: 'Message actions' })).toHaveCount(0)

    await app.transcript.focus()
    await page.keyboard.press('ArrowUp')
    await expect(lastReply(page)).toBeFocused()

    await page.keyboard.press('Enter')

    const menu = page.getByRole('menu', { name: 'Message actions' })

    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Copy text',
      'Copy as Markdown',
      // Every engine this suite runs in can speak.
      'Read aloud',
      'Regenerate',
      'Branch from here'
    ])
    await expect(menu.getByRole('menuitem', { name: 'Copy text' })).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(lastReply(page)).toBeFocused()

    if (browserName === 'chromium') {
      await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toHaveCount(1)
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Some bold words.')
    } else {
      // A browser may refuse a test the clipboard; either way the page says what happened.
      await expect(page.getByRole('status').filter({ hasText: /^(Copied|Could not copy)$/u })).toHaveCount(1)
    }

    // Escape on a message goes back to the transcript, which is still the one tab stop.
    await page.keyboard.press('Escape')
    await expect(app.transcript).toBeFocused()
  })

  test('is reached by a pointer: the one hover button and a right-click, a link keeping its own menu', async ({
    app,
    page
  }) => {
    await app.open()
    await app.ready()
    await app.send('send me a link')
    await expect(lastReply(page)).toContainText('See the docs for more.')
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')

    await lastReply(page).locator('.hm-bubble').hover()

    const more = page.getByRole('button', { name: 'Message actions' })

    await expect(more).toHaveCount(1)
    await more.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()

    await lastReply(page)
      .locator('.hm-bubble p')
      .first()
      .click({ button: 'right', position: { x: 4, y: 4 } })
    await expect(page.getByRole('menu')).toBeVisible()
    await page.keyboard.press('Escape')

    // On the link the browser's own menu is the one asked for; ours stays closed.
    await lastReply(page).getByRole('link', { name: 'the docs' }).click({ button: 'right' })
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('asks for the last reply again', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()
    await app.send('ping once')
    await expect(lastReply(page)).toContainText('Fine.')
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')

    // The log holds method names.
    const submitted = async (): Promise<number> =>
      (await gateway.state()).methodLog.filter(method => method === 'prompt.submit').length
    const before = await submitted()

    await lastReply(page).locator('.hm-bubble').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Regenerate' }).click()

    // The gateway has no `/retry`: the reader's own prompt goes again, and the transcript says so.
    await expect.poll(submitted).toBe(before + 1)
    await expect(app.transcript.locator('.hm-bubble[data-kind="user"]', { hasText: 'ping once' })).toHaveCount(2)
  })
})

test.describe('the chat’s options', () => {
  test('change what the chat shows at once, keep it across a reload, and follow the default again', async ({
    app,
    page
  }) => {
    await app.open()
    await expect(app.transcript).toContainText('Retry semantics')

    const tool = app.transcript.getByRole('button', { name: /read_file/u })
    const options = page.getByRole('button', { name: 'Chat options' })

    // Quiet by default: no tool line.
    await expect(tool).toHaveCount(0)

    await options.click()
    await expect(options).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('radio', { name: 'Normal' }).check()
    await expect(tool).toBeVisible()
    await expect(page.getByText('This conversation has its own view.')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(options).toHaveAttribute('aria-expanded', 'false')
    await expect(options).toBeFocused()

    await page.reload()
    await expect(app.transcript).toContainText('Retry semantics')
    await expect(app.transcript.getByRole('button', { name: /read_file/u })).toBeVisible()

    await page.getByRole('button', { name: 'Chat options' }).click()
    await expect(page.getByRole('radio', { name: 'Normal' })).toBeChecked()
    await page.getByRole('button', { name: "Reset this conversation's view" }).click()
    await expect(page.getByRole('radio', { name: 'Quiet' })).toBeChecked()
    await expect(page.getByRole('radio', { name: 'Quiet' })).toBeFocused()
    await expect(app.transcript.getByRole('button', { name: /read_file/u })).toHaveCount(0)
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the options panel and a message’s menu have no serious accessibility violation (${scheme})`, async ({
    app,
    page
  }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await app.open()
    await expect(app.transcript).toContainText('Retry semantics')

    await page.getByRole('button', { name: 'Chat options' }).click()
    await expect(page.getByRole('group', { name: 'What this conversation shows' })).toBeVisible()
    expect(await seriousViolations(page, `chat-options-${scheme}`)).toEqual([])
    await page.keyboard.press('Escape')

    await lastReply(page).locator('.hm-bubble').hover()
    await lastReply(page).locator('.hm-bubble').click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    expect(await seriousViolations(page, `message-menu-${scheme}`)).toEqual([])
  })
}
