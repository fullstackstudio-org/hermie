/**
 * The New bot page in a real browser, against the fake gateway serving the built client.
 *
 *  - **Reached** from the sidebar by keyboard; the form is labelled and a handle that cannot work is said under the
 *    field, in words, before anything is sent (taken, reserved, not a legal name).
 *  - **Created** with `profiles.create`: the handle, the description, the model pinned with its provider and the bot
 *    to clone are what the gateway receives; the roster is read again, the new bot is in the list and its chat opens
 *    and takes a message.
 *  - **Refused** by the gateway: its own words are shown under the form (as text) and what was typed stays.
 *  - **Accessibility** with axe, with the form drawn and with an error showing.
 *
 * Names here are made up for the test.
 */
import type { Page } from '@playwright/test'

import { expect, seriousViolations, test } from './fixtures'

const handle = (page: Page) => page.getByRole('textbox', { name: 'Handle' })
const create = (page: Page) => page.getByRole('button', { name: 'Create bot' })

/** The sidebar's way to the page, by keyboard: focus the link and press Return, as a keyboard reader does. */
async function openByKeyboard(page: Page): Promise<void> {
  const link = page.getByRole('link', { name: 'New bot…' })

  await link.focus()
  await expect(link).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/new-bot$/u)
  await expect(page.getByRole('heading', { level: 1, name: 'New bot' })).toBeFocused()
}

test.describe('making a bot', () => {
  test('is reached from the sidebar, and a made bot’s chat opens and takes a message', async ({
    app,
    gateway,
    page
  }) => {
    await app.open('#/')
    await expect(page.locator('a[data-bot="writer"]')).toBeVisible()
    await openByKeyboard(page)

    await handle(page).fill('Scout')
    await page.getByRole('textbox', { name: 'Description' }).fill('Looks things up before anyone asks.')
    await page.getByRole('combobox', { name: 'Model' }).selectOption({ label: 'Reasoner 2' })
    await page.getByRole('combobox', { name: 'Clone settings from' }).selectOption('writer')
    await create(page).click()

    // Its chat opens: the heading is the bot, and the composer takes a message.
    await expect(page).toHaveURL(/#\/chat\/scout$/u)
    await expect(page.getByRole('heading', { level: 1, name: 'Scout' })).toBeVisible()
    await expect(page.locator('a[data-bot="scout"]')).toBeVisible()

    await app.ready()
    await app.send('hello scout')
    await expect(app.transcript.getByText('hello scout')).toBeVisible()

    const made = gateway.fake.state.profiles.find(entry => entry.name === 'scout')

    expect(made).toMatchObject({
      description: 'Looks things up before anyone asks.',
      provider: 'second-provider'
    })
    expect(made?.model).toContain('reasoner-2')
  })

  test('says a handle that cannot work before sending anything, and sends nothing', async ({ app, gateway, page }) => {
    await app.open('#/new-bot')
    await expect(page.getByRole('heading', { level: 1, name: 'New bot' })).toBeVisible()

    await handle(page).fill('Writer')
    await expect(page.getByText('“writer” already exists.')).toBeVisible()
    await expect(handle(page)).toHaveAttribute('aria-invalid', 'true')

    await handle(page).fill('root')
    await expect(page.getByText(/“root” is reserved/u)).toBeVisible()

    await handle(page).fill('My Work')
    await expect(page.getByText(/for example: my-work/u)).toBeVisible()

    await create(page).click()
    await expect(handle(page)).toBeFocused()
    expect(gateway.fake.state.profiles.map(entry => entry.name)).not.toContain('my work')
    expect((await gateway.state()).methodLog).not.toContain('profiles.create')
  })

  test('shows the gateway’s own refusal under the form and keeps what was typed', async ({ app, gateway, page }) => {
    await app.open('#/new-bot')
    await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible()
    await handle(page).fill('scout')
    await page.getByRole('textbox', { name: 'Description' }).fill('Keep me')

    // The gateway refuses this one: a profile appeared under that name between the check and the create.
    gateway.fake.state.profiles.push({ ...gateway.fake.state.profiles[0]!, name: 'scout' })
    await create(page).click()

    await expect(page.getByRole('alert')).toContainText('Could not make the bot')
    await expect(page.getByRole('alert')).toContainText('already exists')
    await expect(handle(page)).toHaveValue('scout')
    await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('Keep me')
    await expect(create(page)).toBeEnabled()
  })
})

test.describe('accessibility', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious or critical axe violation in the ${scheme} scheme, with an error showing`, async ({
      app,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await app.open('#/new-bot')
      await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible()
      expect(await seriousViolations(page, `new-bot-${scheme}`)).toEqual([])

      await handle(page).fill('Writer')
      await expect(page.getByText('“writer” already exists.')).toBeVisible()
      expect(await seriousViolations(page, `new-bot-error-${scheme}`)).toEqual([])
    })
  }
})
