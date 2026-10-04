/**
 * Settings › Boards in a real browser against the fake gateway serving the built client: the Kanban plugin's boards
 * (`/api/plugins/kanban`), one board's columns and cards, and one card.
 *
 *  - **The board** shows the server's columns in its order with the cards in each; another board when it is picked.
 *  - **Moving** is a menu that never lists the dispatcher's columns; a move the board refuses shows the board's own
 *    sentence, naming the parent in the way, and the card stays.
 *  - **A card** opens in place, is edited with a draft that is saved or put back, takes a comment, and is archived
 *    (not deleted) after a question; a new card lands in the column that was picked.
 *  - **A gateway without the plugin** gets what to install, not an empty board.
 *  - **The page is a chunk of its own**, and has no serious accessibility violation in either scheme.
 */
import { expect, type Page, seriousViolations, test } from './fixtures'

async function open(app: { open(hash?: string): Promise<void> }, page: Page): Promise<void> {
  await app.open('#/settings/boards')
  await expect(page.getByRole('heading', { level: 2, name: 'Boards' })).toBeVisible()
  await expect(page.locator('li[data-card]').first()).toBeVisible()
}

const card = (page: Page, title: string) => page.locator('li[data-card]').filter({ hasText: title })
const column = (page: Page, name: string) =>
  page
    .locator('.hm-manage__columns > section')
    .filter({ has: page.getByRole('heading', { level: 3, name: new RegExp(`^${name} \\(`, 'u') }) })

test.describe('Settings › Boards', () => {
  test('shows the server’s columns in its order with the cards in each, and the other board when it is picked', async ({
    app,
    page
  }) => {
    await open(app, page)

    await expect(page.getByRole('heading', { level: 3 })).toHaveText([
      'Triage (0)',
      'To do (2)',
      'Scheduled (0)',
      'Ready (0)',
      'Running (1)',
      'Blocked (0)',
      'Review (0)',
      'Done (0)'
    ])
    // Priority first, then age: the only order there is.
    await expect(column(page, 'To do').locator('li[data-card]')).toHaveText([
      /Ship the build/u,
      /Write the release notes/u
    ])
    await expect(page.getByText(/ordered by priority and age/u)).toBeVisible()

    await page.getByRole('combobox', { name: 'Board' }).selectOption({ label: 'Sprint - 0 cards' })
    await expect(page.getByText('Nothing on this board yet.')).toBeVisible()
    await expect(page.locator('li[data-card]')).toHaveCount(0)
  })

  test('moves a card through a menu that never lists the dispatcher’s columns', async ({ app, page }) => {
    await open(app, page)

    const menu = card(page, 'Write the release notes').getByRole('combobox', {
      name: 'Move Write the release notes to…'
    })

    await expect(menu.locator('option')).toHaveText(['Move to…', 'Triage', 'Ready', 'Blocked', 'Done'])
    await menu.selectOption({ label: 'Done' })

    await expect(page.getByRole('status').filter({ hasText: 'Moved to Done.' })).toBeVisible()
    await expect(column(page, 'Done').locator('li[data-card]')).toContainText('Write the release notes')
    await expect(column(page, 'To do').locator('li[data-card]')).toHaveCount(1)
  })

  test('shows the board’s own sentence for a move it refuses, naming the parent in the way', async ({
    app,
    diagnostics,
    page
  }) => {
    // The browser itself logs the 409 the board answers with.
    diagnostics.allow(/409/u)
    await open(app, page)

    await card(page, 'Ship the build')
      .getByRole('combobox', { name: 'Move Ship the build to…' })
      .selectOption({ label: 'Ready' })

    await expect(page.getByRole('status').filter({ hasText: /blocked by parent\(s\) not done/u })).toContainText(
      'Write the release notes'
    )
    await expect(column(page, 'To do').locator('li[data-card]')).toHaveCount(2)
  })

  test('edits a card with a draft, and Cancel puts the fields back', async ({ app, page }) => {
    await open(app, page)

    const item = card(page, 'Write the release notes')

    await item.getByRole('button', { name: 'Open Write the release notes' }).click()
    await expect(item.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Pull them from the changelog.')
    await expect(item.getByText('Started on this.')).toBeVisible()

    await item.getByRole('textbox', { name: 'Title', exact: true }).fill('Something else')
    await item.getByRole('button', { name: 'Cancel' }).click()
    await expect(item.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Write the release notes')

    await item.getByRole('textbox', { name: 'Title', exact: true }).fill('Write the notes')
    await item.getByRole('spinbutton', { name: 'Priority', exact: true }).fill('5')
    await item.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
    await expect(card(page, 'Write the notes')).toContainText(/priority 5/iu)
    // Priority 5 now outranks the other card: first in its column.
    await expect(column(page, 'To do').locator('li[data-card]').first()).toContainText('Write the notes')
  })

  test('posts a comment as Hermie and shows it', async ({ app, page }) => {
    await open(app, page)

    const item = card(page, 'Write the release notes')

    await item.getByRole('button', { name: 'Open Write the release notes' }).click()
    await item.getByLabel('Comment on Write the release notes').fill('Ready for review.')
    await item.getByRole('button', { name: 'Comment', exact: true }).click()

    await expect(item.getByText('Ready for review.')).toBeVisible()
    await expect(item.getByText(/^hermie,/u)).toBeVisible()
  })

  test('archives a card only after a question, and it leaves the board without being deleted', async ({
    app,
    page
  }) => {
    await open(app, page)

    const item = card(page, 'Write the release notes')

    await item.getByRole('button', { name: 'Open Write the release notes' }).click()
    await item.getByRole('button', { name: 'Archive Write the release notes' }).click()
    await expect(item.getByText('Archive Write the release notes?')).toBeVisible()
    await expect(item.getByRole('button', { name: 'Keep it' })).toBeFocused()
    await item.getByRole('button', { name: 'Keep it' }).click()
    await expect(card(page, 'Write the release notes')).toHaveCount(1)

    await item.getByRole('button', { name: 'Archive Write the release notes' }).click()
    await item
      .getByRole('group', { name: 'Archive Write the release notes' })
      .getByRole('button', { name: 'Archive Write the release notes' })
      .click()

    await expect(page.getByRole('status').filter({ hasText: 'Archived.' })).toBeVisible()
    await expect(page.locator('li[data-card]').filter({ hasText: 'Write the release notes' })).toHaveCount(0)

    // Archived, not deleted: it comes back when archived cards are asked for.
    await page.getByRole('checkbox', { name: 'Show archived' }).check()
    await expect(column(page, 'Archived').locator('li[data-card]')).toContainText('Write the release notes')
  })

  test('makes a card in the column that was picked', async ({ app, page }) => {
    await open(app, page)

    await page.getByText('New card', { exact: true }).click()
    await page.getByRole('textbox', { name: 'Title', exact: true }).last().fill('Draft the post')
    await page.getByLabel('Column').selectOption({ label: 'Blocked' })
    await page.getByRole('button', { name: 'Make the card' }).click()

    await expect(page.getByRole('status').filter({ hasText: 'Draft the post was made.' })).toBeVisible()
    await expect(column(page, 'Blocked').locator('li[data-card]')).toContainText('Draft the post')
  })

  test.describe('on a gateway without the plugin', () => {
    test('says what to install, and shows no board', async ({ app, diagnostics, gateway, page }) => {
      // The browser itself logs the 404 of a route that is not mounted.
      diagnostics.allow(/404/u)
      gateway.fake.state.kanbanBoards = null
      await app.open('#/settings/boards')

      await expect(page.getByText('This gateway has no Kanban plugin.')).toBeVisible()
      await expect(page.getByText('hermes plugins install kanban')).toBeVisible()
      await expect(page.getByRole('combobox')).toHaveCount(0)
    })
  })

  test('is a chunk of its own, fetched when the page is opened and not before', async ({ app, page }) => {
    const fetched: string[] = []

    page.on('request', request => {
      if (/\/assets\/Boards-[\w-]+\.(?:js|css)$/u.test(new URL(request.url()).pathname)) {
        fetched.push(new URL(request.url()).pathname)
      }
    })

    await app.open('#/chat/researcher')
    await app.ready()
    expect(fetched).toEqual([])

    await page.evaluate(() => {
      location.hash = '#/settings'
    })
    await page.getByRole('link', { name: 'Boards' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Boards' })).toBeVisible()
    expect(fetched.length).toBeGreaterThan(0)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious accessibility violation in the ${scheme} scheme, with a card open`, async ({ app, page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await open(app, page)

      expect(await seriousViolations(page, `boards-${scheme}`)).toEqual([])

      await card(page, 'Write the release notes').getByRole('button', { name: 'Open Write the release notes' }).click()
      await expect(
        card(page, 'Write the release notes').getByRole('textbox', { name: 'Notes', exact: true })
      ).toBeVisible()
      await page.getByText('New card', { exact: true }).click()

      expect(await seriousViolations(page, `boards-open-${scheme}`)).toEqual([])
    })
  }
})
