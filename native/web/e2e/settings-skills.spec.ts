/**
 * Settings › Skills in a real browser against the fake gateway serving the built client: the installed skills with
 * the picked bot's switches, and the hub the gateway offers.
 *
 *  - **The switches** are the bot's: a moved switch is still moved after the page is read again (so the gateway
 *    holds it), and another bot's are its own.
 *  - **The hub** is browsed and searched; a row opens its details, with the hub's own instructions in a box that
 *    scrolls and can be reached by keyboard.
 *  - **Install** puts the skill into the picked bot's list, and the hub then marks it instead of offering it.
 *  - **The page is fetched on demand**, in the chunk the management pages share, fetched when it is opened and not before.
 *  - **Accessibility** with axe in the light and the dark scheme, with a row's details open.
 */
import { expect, type Page, seriousViolations, test } from './fixtures'

async function openFor(app: { open(hash?: string): Promise<void> }, page: Page, bot = 'Researcher'): Promise<void> {
  await app.open('#/settings/skills')
  await expect(page.getByRole('heading', { level: 2, name: 'Skills' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Bot' }).selectOption({ label: bot })
  await expect(page.getByRole('list', { name: 'INSTALLED' })).toBeVisible()
}

test.describe('Settings › Skills', () => {
  test('lists the picked bot’s skills with its switches, and the other bot’s have their own', async ({ app, page }) => {
    await openFor(app, page)

    const installed = page.getByRole('list', { name: 'INSTALLED' })

    await expect(installed.getByRole('checkbox')).toHaveCount(3)
    await expect(installed.getByRole('checkbox', { name: 'pdf' })).toBeChecked()

    // `writer` has switched pdf off and has two skills, not three.
    await page.getByRole('combobox', { name: 'Bot' }).selectOption({ label: 'Writer' })
    await expect(installed.getByRole('checkbox')).toHaveCount(2)
    await expect(installed.getByRole('checkbox', { name: 'pdf' })).not.toBeChecked()
    await expect(installed.getByRole('checkbox', { name: 'docx' })).toBeChecked()
  })

  test('keeps a moved switch: the gateway holds it, and the other skills are untouched', async ({ app, page }) => {
    await openFor(app, page)

    const installed = page.getByRole('list', { name: 'INSTALLED' })

    await installed.getByRole('checkbox', { name: 'docx' }).uncheck()
    await expect(installed.getByRole('checkbox', { name: 'docx' })).not.toBeChecked()

    // Read again from the gateway.
    await app.open('#/settings/skills')
    await page.getByRole('combobox', { name: 'Bot' }).selectOption({ label: 'Researcher' })
    await expect(installed.getByRole('checkbox', { name: 'docx' })).not.toBeChecked()
    await expect(installed.getByRole('checkbox', { name: 'pdf' })).toBeChecked()
    await expect(installed.getByRole('checkbox', { name: 'web-search' })).toBeChecked()
  })

  test('browses the hub, searches it, and opens a row’s details with a scrolling box of instructions', async ({
    app,
    page
  }) => {
    await openFor(app, page)

    const hub = page.getByRole('list', { name: 'CATALOGUE' })

    await expect(hub.getByRole('listitem')).toHaveCount(5)

    await page.getByRole('searchbox', { name: 'Search the hub' }).fill('spread')
    await expect(hub.getByRole('listitem')).toHaveCount(1)
    await expect(hub.getByText('xlsx', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Details of xlsx' }).click()

    const instructions = page.getByLabel('Instructions of xlsx')

    await expect(instructions).toContainText('# xlsx')
    await instructions.focus()
    await expect(instructions).toBeFocused()

    await page.getByRole('button', { name: 'Hide the details of xlsx' }).click()
    await expect(instructions).toHaveCount(0)

    await page.getByRole('searchbox', { name: 'Search the hub' }).fill('no-such-skill')
    await expect(page.getByText('Nothing matched.')).toBeVisible()
  })

  test('installs a skill into the picked bot, and the hub then marks it', async ({ app, page }) => {
    await openFor(app, page)

    await page.getByRole('button', { name: 'Install xlsx' }).click()

    await expect(page.getByRole('status').filter({ hasText: 'Installed xlsx.' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'INSTALLED' }).getByRole('checkbox', { name: 'xlsx' })).toBeChecked()
    await expect(page.getByRole('button', { name: 'Install xlsx' })).toHaveCount(0)

    // Only the picked bot got it.
    await page.getByRole('combobox', { name: 'Bot' }).selectOption({ label: 'Writer' })
    await expect(page.getByRole('list', { name: 'INSTALLED' }).getByRole('checkbox', { name: 'xlsx' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Install xlsx' })).toBeVisible()
  })

  test('is fetched when the page is opened and not before, in the management pages’ chunk', async ({ app, page }) => {
    const fetched: string[] = []

    page.on('request', request => {
      if (/\/assets\/manage-pages-[\w-]+\.(?:js|css)$/u.test(new URL(request.url()).pathname)) {
        fetched.push(new URL(request.url()).pathname)
      }
    })

    await app.open('#/chat/researcher')
    await app.ready()
    expect(fetched).toEqual([])

    await page.evaluate(() => {
      location.hash = '#/settings'
    })
    await page.getByRole('link', { name: 'Skills' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Skills' })).toBeVisible()
    expect(fetched.length).toBeGreaterThan(0)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious accessibility violation in the ${scheme} scheme, with a row’s details open`, async ({
      app,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await openFor(app, page)
      await expect(page.getByRole('list', { name: 'CATALOGUE' }).getByRole('listitem')).toHaveCount(5)

      expect(await seriousViolations(page, `skills-${scheme}`)).toEqual([])

      await page.getByRole('button', { name: 'Details of xlsx' }).click()
      await expect(page.getByLabel('Instructions of xlsx')).toBeVisible()

      expect(await seriousViolations(page, `skills-open-${scheme}`)).toEqual([])
    })
  }
})
