/**
 * The rest of a message's menu (HERM-255) in a real browser, against the fake
 * gateway serving the built client:
 *
 *  - **Edit and resend** on the newest turn puts its words back in the composer
 *    (focused), the turn already in the conversation stays, and sending the
 *    changed words puts a NEW `prompt.submit` on the gateway. The line is not on
 *    an older turn.
 *  - **Branch from here** on a reply asks the gateway for `session.branch`
 *    (named after the reply) and opens the branch where the Conversations page
 *    opens one: the read-only viewer, with the branch's own history. It is
 *    reached from the keyboard too.
 *  - **Copy links** is a submenu of the links a message holds, reached and left
 *    with the arrows, and a link chosen from it is copied.
 */
import type { Page } from '@playwright/test'

import { BOT, expect, test } from './fixtures'

test.use({
  gatewayOptions: {
    scenario: {
      replies: [
        { match: 'links', deltas: ['Try https://one.example and [two](https://two.example/page) today.'] },
        { deltas: ['Fine. '] }
      ]
    }
  }
})

const bubble = (page: Page, kind: 'user' | 'assistant', text: string) =>
  page.getByRole('log').locator(`.hm-bubble[data-kind="${kind}"]`, { hasText: text }).last()

/** How many times the gateway has been sent a method; the log holds method names. */
const calls = async (gateway: { state(): Promise<{ methodLog: unknown[] }> }, method: string): Promise<number> =>
  (await gateway.state()).methodLog.filter(entry => entry === method).length

test.describe('Edit and resend', () => {
  test('puts the newest turn back in the field and sends the changed words as a new turn', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await app.ready()
    await app.send('ping once')
    await expect(bubble(page, 'assistant', 'Fine.')).toBeVisible()
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')

    // A second exchange, so there is an older turn to be refused it.
    await app.send('ping twice')
    await expect(app.transcript.locator('.hm-bubble[data-kind="assistant"]', { hasText: 'Fine.' })).toHaveCount(2)
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')

    await bubble(page, 'user', 'ping once').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Edit and resend' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()

    const before = await calls(gateway, 'prompt.submit')

    await bubble(page, 'user', 'ping twice').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit and resend' }).click()

    await expect(app.field).toHaveValue('ping twice')
    await expect(app.field).toBeFocused()
    // Nothing was sent by choosing it, and the turn in the conversation is where it was.
    expect(await calls(gateway, 'prompt.submit')).toBe(before)
    await expect(bubble(page, 'user', 'ping twice')).toBeVisible()

    await app.field.fill('ping three times')
    await app.field.press('Enter')

    await expect.poll(() => calls(gateway, 'prompt.submit')).toBe(before + 1)
    await expect(bubble(page, 'user', 'ping three times')).toBeVisible()
    await expect(bubble(page, 'user', 'ping twice')).toBeVisible()
    await expect(app.field).toHaveValue('')
  })

  test('is reached from the keyboard, on the turn’s own menu', async ({ app, page }) => {
    await app.open()
    await app.ready()
    await app.send('ping once')
    await expect(bubble(page, 'assistant', 'Fine.')).toBeVisible()
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')

    // The transcript's arrows: newest message first (the reply), then the turn above it.
    await app.transcript.focus()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')

    const menu = page.getByRole('menu', { name: 'Message actions' })

    await expect(menu.getByRole('menuitem')).toHaveText(['Copy text', 'Edit and resend', 'Branch from here'])
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Edit and resend' })).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(app.field).toHaveValue('ping once')
    await expect(app.field).toBeFocused()
    await app.field.fill('')
  })
})

test.describe('Branch from here', () => {
  test('forks the conversation at a reply and opens the branch read-only, like the Conversations page', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await app.ready()
    await app.send('ping once')
    await expect(bubble(page, 'assistant', 'Fine.')).toBeVisible()
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')

    const before = await calls(gateway, 'session.branch')

    await bubble(page, 'assistant', 'Fine.').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Branch from here' }).click()

    await expect(page).toHaveURL(new RegExp(`#/chat/${BOT}/s/[^/]+$`, 'u'))
    await expect(page.getByText('You are reading an earlier conversation. It cannot be answered.')).toBeVisible()
    await expect(app.field).toHaveCount(0)
    expect(await calls(gateway, 'session.branch')).toBe(before + 1)

    // A branch of the gateway's own: visible, named after the reply, holding the history up to it.
    const branches = [...gateway.fake.state.sessions.values()].filter(entry => entry.title === 'Branch · Fine.')

    expect(branches).toHaveLength(1)
    await expect(app.transcript.getByText('ping once')).toBeVisible()

    // And the chat it was taken from is as it was.
    await page.getByRole('link', { name: 'Back to the chat' }).click()
    await expect(page).toHaveURL(new RegExp(`#/chat/${BOT}$`, 'u'))
    await expect(bubble(page, 'assistant', 'Fine.')).toBeVisible()
    await expect(app.field).toBeVisible()
  })

  test('is reached from the keyboard, on the reply’s own line', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()
    await app.send('ping once')
    await expect(bubble(page, 'assistant', 'Fine.')).toBeVisible()
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')

    await app.transcript.focus()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')

    const menu = page.getByRole('menu', { name: 'Message actions' })

    await expect(menu.getByRole('menuitem')).toHaveText(['Copy text', 'Regenerate', 'Branch from here'])
    await page.keyboard.press('End')
    await expect(menu.getByRole('menuitem', { name: 'Branch from here' })).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(page).toHaveURL(new RegExp(`#/chat/${BOT}/s/[^/]+$`, 'u'))
    expect(await calls(gateway, 'session.branch')).toBe(1)
  })
})

test.describe('Copy links', () => {
  test('lists the links of a message in a group, reached and left with the arrows, and copies the one chosen', async ({
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
    await app.send('show me links')
    await expect(bubble(page, 'assistant', 'Try')).toContainText('today.')
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')

    await bubble(page, 'assistant', 'Try').click({ button: 'right', position: { x: 4, y: 4 } })

    const menu = page.getByRole('menu', { name: 'Message actions' })
    const parent = menu.getByRole('menuitem', { name: 'Copy links' })

    await expect(parent).toHaveAttribute('aria-expanded', 'false')
    await parent.focus()
    await page.keyboard.press('ArrowRight')
    await expect(parent).toHaveAttribute('aria-expanded', 'true')

    const group = menu.getByRole('group', { name: 'Copy links' })

    await expect(group.getByRole('menuitem')).toHaveText(['https://one.example', 'https://two.example/page'])
    await expect(group.getByRole('menuitem').first()).toBeFocused()

    // Escape closes the group and not the menu.
    await page.keyboard.press('Escape')
    await expect(group).toBeHidden()
    await expect(parent).toBeFocused()
    await expect(menu).toBeVisible()

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()

    if (browserName === 'chromium') {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://two.example/page')
    } else {
      // A browser may refuse a test the clipboard; either way the page says what happened.
      await expect(page.getByRole('status').filter({ hasText: /^(Copied|Could not copy)$/u })).toHaveCount(1)
    }
  })
})
