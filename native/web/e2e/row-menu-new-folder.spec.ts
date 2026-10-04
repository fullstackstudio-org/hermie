/**
 * A chat row's menu: Move to folder ends in "New folder…", which asks for a name in a small form in the menu's own
 * box and makes the folder around the chat the menu was opened from, in a real browser against the fake gateway
 * serving the built client. Names here are the fake gateway's own bots, test data and nothing else.
 *
 *  - **With no folder yet**, Move to folder is still there, offering No folder and New folder…, so a first folder
 *    is made from a row without going to Settings.
 *  - **The form** takes the focus, makes the folder on Return or Create (the chat is inside it, said politely, and the
 *    folder survives a reload), and Cancel or Escape goes back to the folder list without making anything.
 *  - **Accessibility** with axe in the light and the dark scheme, with the form open.
 */
import type { Page } from '@playwright/test'

import { expect, seriousViolations, test } from './fixtures'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Chats' })
const row = (page: Page, bot: string) => sidebar(page).locator(`a[data-bot="${bot}"]`)
const menu = (page: Page, name: string) => page.getByRole('menu', { name: `Actions for ${name}` })

async function openList(app: { open(hash?: string): Promise<void> }, page: Page): Promise<void> {
  await app.open('#/')
  await expect(row(page, 'writer')).toBeVisible()
  await expect(sidebar(page).locator('.hm-chat-list')).toHaveAttribute('data-row-menus', 'ready')
}

/** The row's menu, opened on its Move to folder list and on the New folder… line. */
async function openForm(page: Page, name = 'Writer') {
  await sidebar(page)
    .getByRole('button', { name: `Actions for ${name}` })
    .click()
  await expect(menu(page, name)).toBeVisible()
  await page.getByRole('menuitem', { name: 'Move to folder' }).click()
  await page.getByRole('menuitem', { name: 'New folder…' }).click()

  const dialog = page.getByRole('dialog', { name: 'New folder' })

  await expect(dialog).toBeVisible()

  return dialog
}

test.describe('Row menu › New folder…', () => {
  test('is offered with no folder yet, next to No folder', async ({ app, page }) => {
    await openList(app, page)
    await sidebar(page).getByRole('button', { name: 'Actions for Writer' }).click()
    await page.getByRole('menuitem', { name: 'Move to folder' }).click()

    await expect(page.getByRole('menuitemradio')).toHaveText(['No folder'])
    await expect(page.getByRole('menuitem', { name: 'New folder…' })).toBeVisible()
  })

  test('makes the folder around the chat on Return, with the focus in the field, and it survives a reload', async ({
    app,
    page
  }) => {
    await openList(app, page)

    const dialog = await openForm(page)
    const field = dialog.getByRole('textbox', { name: 'Folder name' })

    await expect(field).toBeFocused()
    await field.fill('Reading')
    await page.keyboard.press('Enter')

    await expect(dialog).toHaveCount(0)
    await expect(sidebar(page).getByRole('list', { name: 'Reading' }).locator('a[data-bot="writer"]')).toBeVisible()
    await expect(
      page.getByRole('status').filter({ hasText: 'Writer is now in the new folder Reading.' })
    ).toBeAttached()

    await app.open('#/')
    await expect(sidebar(page).getByRole('list', { name: 'Reading' }).locator('a[data-bot="writer"]')).toBeVisible()
  })

  test('makes it from Create too, and Cancel and Escape go back to the folder list without making anything', async ({
    app,
    page
  }) => {
    await openList(app, page)

    const dialog = await openForm(page)

    await dialog.getByRole('textbox', { name: 'Folder name' }).fill('Draft')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'New folder…' })).toBeFocused()
    await expect(sidebar(page).getByRole('list', { name: 'Draft' })).toHaveCount(0)

    await page.getByRole('menuitem', { name: 'New folder…' }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'New folder' })).toHaveCount(0)
    await expect(menu(page, 'Writer')).toBeVisible()

    await page.getByRole('menuitem', { name: 'New folder…' }).click()
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Later')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(sidebar(page).getByRole('list', { name: 'Later' }).locator('a[data-bot="writer"]')).toBeVisible()
  })

  test('is a second folder when one exists, and the chat is in the new one', async ({ app, page }) => {
    await app.open('#/settings/chat-list')
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Work')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status').filter({ hasText: 'Folder Work created.' })).toBeVisible()
    await page.evaluate(() => {
      location.hash = '#/'
    })
    await expect(row(page, 'researcher')).toBeVisible()
    await expect(sidebar(page).locator('.hm-chat-list')).toHaveAttribute('data-row-menus', 'ready')

    const dialog = await openForm(page, 'Researcher')

    await dialog.getByRole('textbox', { name: 'Folder name' }).fill('Later')
    await page.keyboard.press('Enter')

    await expect(sidebar(page).getByRole('list', { name: 'Later' }).locator('a[data-bot="researcher"]')).toBeVisible()

    // Both folders are there for the next chat to be moved into, the first one still empty.
    await sidebar(page).getByRole('button', { name: 'Actions for Writer' }).click()
    await page.getByRole('menuitem', { name: 'Move to folder' }).click()
    await expect(page.getByRole('menuitemradio')).toHaveText(['No folder', 'Work', 'Later'])
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious accessibility violation in the ${scheme} scheme, with the form open`, async ({
      app,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await openList(app, page)
      await openForm(page)

      expect(await seriousViolations(page, `row-menu-new-folder-${scheme}`)).toEqual([])
    })
  }
})
