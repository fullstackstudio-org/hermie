/**
 * The keyboard shortcuts in a real browser, against the fake gateway serving the built client.
 *
 *  - **Search** (Command or Control+K) focuses the chats field from anywhere, the composer included.
 *  - **The chats**: the previous and the next (Command or Control+arrow, and Alt+arrow, which no browser keeps), and a
 *    chat by its number (Command or Control+1 to 9), walk the rows of the list as it is drawn.
 *  - **A new conversation** (Command or Control+N, and Control+Alt+N beside it) opens the Conversations page of the
 *    chat that is open with its question asked, the focus on Cancel; it starts nothing by itself.
 *  - **The list of shortcuts** opens on the question mark outside a field and from the sidebar's button, is a dialog
 *    that keeps the focus, and gives it back; the arrow chords and the question mark are left to a field that has the
 *    caret.
 *  - **Accessibility** with axe, with the list open.
 *
 * What this cannot prove: that a browser hands a page the chords it hands it. Playwright puts the key into the page
 * itself, so a browser's own shortcut (a new window on Control+N, Control+Tab) never gets the chance to take it; which
 * chords a browser keeps is written down in `platform/shortcuts.ts` and in the list, not measured here.
 */
import type { Page } from '@playwright/test'

import { BOT, expect, seriousViolations, test } from './fixtures'

const MOD = 'ControlOrMeta'
const rows = (page: Page) => page.locator('.hm-chat-list a[data-bot]')
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search chats' })

/** The chats of the list in the order it draws them. */
const listed = (page: Page): Promise<(string | undefined)[]> =>
  rows(page).evaluateAll(links => links.map(link => (link as HTMLElement).dataset.bot))

/** Focus something on the page that is not a field, as a reader who has just opened a chat is. */
const focusPage = (page: Page) => page.getByRole('heading', { level: 1 }).focus()

test.describe('search', () => {
  test('focuses the chats field from the page and from the composer, and what is typed there narrows the list', async ({
    app,
    page
  }) => {
    await app.open()
    await app.ready()
    await focusPage(page)

    await page.keyboard.press(`${MOD}+k`)
    await expect(search(page)).toBeFocused()

    // From the composer: a letter chord means nothing to the text.
    await app.field.focus()
    await page.keyboard.press(`${MOD}+k`)
    await expect(search(page)).toBeFocused()
    expect(await app.field.inputValue()).toBe('')

    await search(page).fill('writ')
    await expect(rows(page)).toHaveCount(1)

    // Again: what was typed is selected, so the next word replaces it.
    await page.keyboard.press(`${MOD}+k`)
    await page.keyboard.type('res')
    await expect(search(page)).toHaveValue('res')
  })
})

test.describe('the chats', () => {
  test('walk the list with Command or Control and the arrows, and with Alt and the arrows, round at the ends', async ({
    app,
    page
  }) => {
    await app.open('#/')
    await expect(rows(page).first()).toBeVisible()

    const names = (await listed(page)) as string[]

    expect(names.length).toBeGreaterThan(1)

    await app.open(`#/chat/${names[0]}`)
    await focusPage(page)
    await page.keyboard.press(`${MOD}+ArrowDown`)
    await expect(page).toHaveURL(new RegExp(`#/chat/${names[1]}$`, 'u'))

    await focusPage(page)
    await page.keyboard.press('Alt+ArrowUp')
    await expect(page).toHaveURL(new RegExp(`#/chat/${names[0]}$`, 'u'))

    // Round: up from the first is the last.
    await focusPage(page)
    await page.keyboard.press(`${MOD}+ArrowUp`)
    await expect(page).toHaveURL(new RegExp(`#/chat/${names[names.length - 1]}$`, 'u'))
  })

  test('go to a chat by its number', async ({ app, page }) => {
    await app.open('#/')
    await expect(rows(page).first()).toBeVisible()

    const names = (await listed(page)) as string[]

    await focusPage(page)
    await page.keyboard.press(`${MOD}+2`)
    await expect(page).toHaveURL(new RegExp(`#/chat/${names[1]}$`, 'u'))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await focusPage(page)
    await page.keyboard.press(`${MOD}+1`)
    await expect(page).toHaveURL(new RegExp(`#/chat/${names[0]}$`, 'u'))

    // A number with no chat behind it does nothing.
    await focusPage(page)
    await page.keyboard.press(`${MOD}+9`)
    await expect(page).toHaveURL(new RegExp(`#/chat/${names[0]}$`, 'u'))
  })

  test('leave the arrows to the composer while it has the caret, and the numbers do not', async ({ app, page }) => {
    await app.open()
    await app.ready()
    await app.field.fill('line one\nline two')
    await app.field.focus()

    await page.keyboard.press('Alt+ArrowDown')
    await page.keyboard.press(`${MOD}+ArrowUp`)
    await expect(page).toHaveURL(new RegExp(`#/chat/${BOT}$`, 'u'))
    expect(await app.field.inputValue()).toBe('line one\nline two')

    // A number is not a thing a text field does anything with: the chat changes, and the words stay with their chat.
    await page.keyboard.press(`${MOD}+2`)
    await expect(page).not.toHaveURL(new RegExp(`#/chat/${BOT}$`, 'u'))
  })
})

test.describe('a new conversation', () => {
  for (const chord of [`${MOD}+n`, `${MOD}+Alt+n`]) {
    test(`on ${chord} opens the Conversations page with its question asked, and starts nothing`, async ({
      app,
      gateway,
      page
    }) => {
      await app.open()
      await app.ready()
      await focusPage(page)

      await page.keyboard.press(chord)
      await expect(page).toHaveURL(new RegExp(`#/chat/${BOT}/conversations$`, 'u'))
      await expect(page.getByText(/moves to Past conversations/u)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused()

      // Asked and not done: Return on the focused button leaves it, and the gateway made nothing.
      await page.keyboard.press('Enter')
      await expect(page.getByText(/moves to Past conversations/u)).toHaveCount(0)
      expect((await gateway.state()).methodLog).not.toContain('session.create')
    })
  }

  test('does nothing with no chat open', async ({ app, page }) => {
    await app.open('#/')
    await expect(rows(page).first()).toBeVisible()
    await page.keyboard.press(`${MOD}+Alt+n`)
    await expect(page).toHaveURL(/#\/$/u)
  })
})

test.describe('the list of shortcuts', () => {
  test('opens on the question mark, is a dialog that keeps the focus, closes with Escape and gives the focus back', async ({
    app,
    page
  }) => {
    await app.open()
    await app.ready()
    await focusPage(page)

    await page.keyboard.press('?')

    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })

    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused()
    await expect(dialog.getByRole('row')).toHaveCount(7)
    await expect(dialog.getByRole('rowheader', { name: 'Search the chats' })).toBeVisible()

    // Behind it nothing is reachable: the chat shortcuts wait.
    await page.keyboard.press(`${MOD}+2`)
    await expect(page).toHaveURL(new RegExp(`#/chat/${BOT}$`, 'u'))

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  })

  test('opens from the sidebar’s button, and a question mark typed into the composer is a question mark', async ({
    app,
    page
  }) => {
    await app.open()
    await app.ready()

    await app.field.fill('what?')
    await app.field.focus()
    await page.keyboard.press('?')
    expect(await app.field.inputValue()).toBe('what??')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const button = page.getByRole('button', { name: 'Keyboard shortcuts' })

    await button.click()
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(button).toBeFocused()
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious or critical axe violation in the ${scheme} scheme`, async ({ app, page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await app.open()
      await app.ready()
      await focusPage(page)
      await page.keyboard.press('?')
      await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
      expect(await seriousViolations(page, `shortcuts-${scheme}`)).toEqual([])
    })
  }
})
