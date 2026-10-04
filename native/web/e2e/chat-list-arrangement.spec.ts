/**
 * The sidebar draws the chat arrangement that Settings, Chat list edits, in a real browser against the
 * fake gateway serving the built client.
 *
 *  - **Order.** Moving a chat in Settings moves its row in the sidebar, and the order survives a reload.
 *  - **Archive.** Archiving a chat takes its row out of the list into an "Archived" group at the bottom,
 *    closed until it is opened with the keyboard; Unarchive brings it back.
 *  - **Folders.** A folder made in Settings is a group with a header in the sidebar, its chat inside it;
 *    the header opens and closes with Enter, the choice stays through a reload, and the arrow keys cross
 *    from the loose chats into the folder and Enter opens the chat.
 *  - **Colour and mute.** A chat's colour is on its row, and a muted chat is marked.
 *  - **Accessibility** with axe, with all of it drawn.
 *
 * Names here are the fake gateway's own bots (`researcher`, `writer`), test data and nothing else.
 */
import type { Page } from '@playwright/test'

import { expect, seriousViolations, test } from './fixtures'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Chats' })

/** The rows of the sidebar, top to bottom, by the bot name each carries. */
const rows = (page: Page): Promise<string[]> =>
  sidebar(page)
    .locator('a[data-bot]')
    .evaluateAll(links => links.map(link => (link as HTMLElement).dataset.bot ?? ''))

/** Settings, Chat list, open, with the roster folded into the arrangement. */
async function openSettings(app: { open(hash?: string): Promise<void> }, page: Page): Promise<void> {
  await app.open('#/settings/chat-list')
  await expect(page.getByRole('list', { name: 'Chats and folders' })).toBeVisible()
  await expect(sidebar(page).locator('a[data-bot]').first()).toBeVisible()
}

const nameOf = (bot: string): string => `${bot.charAt(0).toUpperCase()}${bot.slice(1)}`

test.describe('The sidebar and the arrangement', () => {
  test('follows the order set in Settings, and keeps it through a reload', async ({ app, page }) => {
    await openSettings(app, page)

    const before = await rows(page)

    expect(before.length).toBeGreaterThanOrEqual(2)

    const [first, second] = before as [string, string]

    await page.getByRole('button', { name: `Move down ${nameOf(first)}` }).click()

    await expect.poll(() => rows(page)).toEqual([second, first, ...before.slice(2)])

    await page.reload()
    await expect(sidebar(page).locator('a[data-bot]').first()).toBeVisible()
    expect(await rows(page)).toEqual([second, first, ...before.slice(2)])
  })

  test('moves an archived chat into a closed Archived group, which opens from the keyboard', async ({ app, page }) => {
    await openSettings(app, page)

    const before = await rows(page)

    await page.getByRole('main').getByRole('button', { name: 'Actions for Writer' }).click()
    await page
      .getByRole('group', { name: 'Actions for Writer' })
      .getByRole('button', { name: 'Archive Writer' })
      .click()

    await expect.poll(() => rows(page)).toEqual(before.filter(name => name !== 'writer'))

    const archive = sidebar(page).getByRole('button', { name: 'Archived (1)' })

    await expect(archive).toHaveAttribute('aria-expanded', 'false')
    expect(await rows(page)).not.toContain('writer')

    // Closed by default and operated by the keyboard alone.
    await archive.focus()
    await page.keyboard.press('Enter')
    await expect(archive).toHaveAttribute('aria-expanded', 'true')
    await expect(
      sidebar(page).getByRole('list', { name: 'Archived (1)' }).locator('a[data-bot="writer"]')
    ).toBeVisible()
    // It is the last thing in the list.
    expect((await rows(page)).at(-1)).toBe('writer')

    await page.keyboard.press('Space')
    await expect(archive).toHaveAttribute('aria-expanded', 'false')

    // And out again.
    await page.getByRole('main').getByRole('button', { name: 'Actions for Writer' }).click()
    await page.getByRole('button', { name: 'Unarchive Writer' }).click()
    await expect(sidebar(page).getByRole('button', { name: /^Archived/u })).toHaveCount(0)
    await expect.poll(() => rows(page)).toContain('writer')
  })

  test('shows a folder as a group with a header, which closes and opens, and survives a reload', async ({
    app,
    page
  }) => {
    await openSettings(app, page)

    await page.getByRole('textbox', { name: 'Folder name' }).fill('Reading')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status').filter({ hasText: 'Folder Reading created.' })).toBeVisible()
    await page.getByRole('main').getByRole('button', { name: 'Actions for Writer' }).click()
    await page
      .getByRole('group', { name: 'Actions for Writer' })
      .getByRole('combobox', { name: 'Move to folder' })
      .selectOption({ label: 'Reading' })

    const header = sidebar(page).getByRole('button', { name: 'Reading' })
    const inside = sidebar(page).getByRole('list', { name: 'Reading' }).locator('a[data-bot="writer"]')

    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await expect(inside).toBeVisible()

    await header.focus()
    await page.keyboard.press('Enter')
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(inside).toHaveCount(0)

    // This device's choice, kept.
    await page.reload()
    await expect(sidebar(page).getByRole('button', { name: 'Reading' })).toHaveAttribute('aria-expanded', 'false')
    await expect(sidebar(page).locator('a[data-bot="writer"]')).toHaveCount(0)

    await sidebar(page).getByRole('button', { name: 'Reading' }).focus()
    await page.keyboard.press('Enter')
    await expect(sidebar(page).locator('a[data-bot="writer"]')).toBeVisible()
  })

  test('is walked with the arrow keys across the groups, and Enter opens the chat', async ({ app, page }) => {
    await openSettings(app, page)

    await page.getByRole('textbox', { name: 'Folder name' }).fill('Reading')
    await page.keyboard.press('Enter')
    await page.getByRole('main').getByRole('button', { name: 'Actions for Writer' }).click()
    await page
      .getByRole('group', { name: 'Actions for Writer' })
      .getByRole('combobox', { name: 'Move to folder' })
      .selectOption({ label: 'Reading' })
    await expect(sidebar(page).locator('a[data-bot="writer"]')).toBeVisible()

    const order = await rows(page)

    expect(order.at(-1)).toBe('writer')

    // From the last loose row, one step down goes over the folder's header into its chat.
    const loose = order.at(-2)!

    await sidebar(page).locator(`a[data-bot="${loose}"]`).focus()
    await page.keyboard.press('ArrowDown')
    await expect(sidebar(page).locator('a[data-bot="writer"]')).toBeFocused()

    await page.keyboard.press('ArrowUp')
    await expect(sidebar(page).locator(`a[data-bot="${loose}"]`)).toBeFocused()

    await page.keyboard.press('End')
    await expect(sidebar(page).locator('a[data-bot="writer"]')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#\/chat\/writer$/u)
  })

  test('puts a chat’s colour on its row and marks a muted one', async ({ app, page }) => {
    await openSettings(app, page)

    await page.getByRole('main').getByRole('button', { name: 'Actions for Writer' }).click()

    const panel = page.getByRole('group', { name: 'Actions for Writer' })

    await panel.getByRole('combobox', { name: 'Colour' }).selectOption({ label: 'Teal' })
    await panel.getByRole('combobox', { name: 'Mute' }).selectOption({ label: 'Until I turn it back on' })

    const row = sidebar(page).locator('a[data-bot="writer"]')

    await expect(row).toHaveAttribute('data-accent', 'teal')
    await expect(row).toHaveAttribute('data-muted', 'true')
    await expect(row).toContainText('Muted')
    // The stripe is drawn, in the colour Settings shows beside the name.
    await expect(row).toHaveCSS('box-shadow', /rgb\(14, 122, 132\)/u)
    await expect(sidebar(page).locator('a[data-bot="researcher"]')).not.toHaveAttribute('data-accent', /.+/u)
  })

  test('has no serious accessibility violation with a folder, the archive, a colour and a mute drawn', async ({
    app,
    page
  }) => {
    await openSettings(app, page)

    await page.getByRole('textbox', { name: 'Folder name' }).fill('Reading')
    await page.keyboard.press('Enter')
    await page.getByRole('main').getByRole('button', { name: 'Actions for Writer' }).click()

    const panel = page.getByRole('group', { name: 'Actions for Writer' })

    await panel.getByRole('combobox', { name: 'Move to folder' }).selectOption({ label: 'Reading' })
    await panel.getByRole('combobox', { name: 'Colour' }).selectOption({ label: 'Violet' })
    await panel.getByRole('combobox', { name: 'Mute' }).selectOption({ label: 'Until I turn it back on' })
    await page.getByRole('main').getByRole('button', { name: 'Actions for Researcher' }).click()
    await page.getByRole('button', { name: 'Archive Researcher' }).click()

    const archive = sidebar(page).getByRole('button', { name: 'Archived (1)' })

    await archive.click()
    await expect(sidebar(page).locator('a[data-bot="researcher"]')).toBeVisible()

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      expect(await seriousViolations(page, `sidebar-arrangement-${scheme}`)).toEqual([])
    }
  })
})
