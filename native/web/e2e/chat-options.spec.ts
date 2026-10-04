/**
 * The options of a chat's own session beyond YOLO, in a real browser against the fake gateway serving
 * the built client: fast mode, the reasoning effort, the model (and the gateway's expensive-model
 * question), the context meter and the export.
 *
 * What this proves, end to end: every state shown is the session's own (a reload finds each change
 * where it was left, and a change the gateway did not make is not shown); an expensive model is a
 * question first and a switch only after the answer yes (the gateway wrote nothing before it); the
 * context meter reads the session's usage and moves as the conversation grows; and the export is a
 * real download of the conversation on screen, in both formats.
 */
import { readFile } from 'node:fs/promises'

import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

const openOptions = async (page: Page) => {
  await page.getByRole('button', { name: 'Chat options' }).click()

  return page.getByRole('group', { name: 'This conversation' })
}

const writes = async (state: () => Promise<{ methodLog: unknown[] }>): Promise<number> =>
  (await state()).methodLog.filter(entry => entry === 'config.set').length

test('fast mode and the reasoning effort are the session’s, and survive a reload', async ({ app, gateway, page }) => {
  await app.open()
  await app.ready()

  const before = await writes(() => gateway.state())
  const row = await openOptions(page)
  const fast = row.getByRole('checkbox', { name: 'Fast mode' })
  const effort = row.getByRole('combobox', { name: 'Reasoning effort' })

  await expect(fast).not.toBeChecked()
  await expect(effort).toHaveValue('medium')

  await fast.click()
  await expect(fast).toBeChecked()
  await effort.selectOption('high')
  await expect(effort).toHaveValue('high')
  await expect.poll(() => writes(() => gateway.state())).toBe(before + 2)

  // The state is the gateway's: a fresh page finds both where they were left.
  await page.reload()
  await app.ready()

  const again = await openOptions(page)

  await expect(again.getByRole('checkbox', { name: 'Fast mode' })).toBeChecked()
  await expect(again.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('high')

  await again.getByRole('checkbox', { name: 'Fast mode' }).click()
  await expect(again.getByRole('checkbox', { name: 'Fast mode' })).not.toBeChecked()
})

test('the model picker lists the gateway’s providers and switches the chat’s model', async ({ app, page }) => {
  await app.open()
  await app.ready()

  const row = await openOptions(page)
  const model = row.getByRole('combobox', { name: 'Model' })

  await expect(model).toHaveValue('example-provider/example-model')
  await expect(model.locator('optgroup')).toHaveCount(3)
  await expect(model.locator('optgroup').nth(1)).toHaveAttribute('label', 'Second Provider')

  // Eleven models: long enough for the search, which narrows the list and keeps the chat's own.
  const search = row.getByRole('searchbox', { name: 'Search models' })

  await search.fill('reasoner')
  await expect(model.locator('option')).toHaveText(['Example Model', 'Reasoner 2', 'Reasoner 2 Turbo'])
  await model.selectOption('second-provider/reasoner-2-turbo')
  await expect(model).toHaveValue('second-provider/reasoner-2-turbo')

  await page.reload()
  await app.ready()
  await expect(await openOptions(page).then(group => group.getByRole('combobox', { name: 'Model' }))).toHaveValue(
    'second-provider/reasoner-2-turbo'
  )
})

test('an expensive model is a question first, and a switch only after the answer yes', async ({ app, page }) => {
  await app.open()
  await app.ready()

  const row = await openOptions(page)
  const model = row.getByRole('combobox', { name: 'Model' })

  await expect(model.locator('option').first()).toBeAttached()
  await expect(model.locator('option')).not.toHaveCount(1)
  await model.selectOption('example-provider/expensive-model')

  const question = row.getByRole('group', { name: 'This model costs more' })

  await expect(question).toBeVisible()
  await expect(question).toContainText('is an expensive model. Continue?')
  await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused()
  // Not switched: the picker is still on the model the session reports.
  await expect(model).toHaveValue('example-provider/example-model')

  // Escape withdraws the question and no more: the options stay open.
  await page.keyboard.press('Escape')
  await expect(question).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Chat options' })).toHaveAttribute('aria-expanded', 'true')
  await expect(model).toBeFocused()

  // Nothing was written by the asking: a fresh page is still on the old model.
  await page.reload()
  await app.ready()

  const again = await openOptions(page)

  await expect(again.getByRole('combobox', { name: 'Model' })).toHaveValue('example-provider/example-model')

  // Ask again, and say yes.
  await again.getByRole('combobox', { name: 'Model' }).selectOption('example-provider/expensive-model')
  await again.getByRole('button', { name: 'Use it anyway' }).click()
  await expect(again.getByRole('combobox', { name: 'Model' })).toHaveValue('example-provider/expensive-model')
  await expect(again.getByRole('group', { name: 'This model costs more' })).toHaveCount(0)

  await page.reload()
  await app.ready()
  await expect(await openOptions(page).then(group => group.getByRole('combobox', { name: 'Model' }))).toHaveValue(
    'example-provider/expensive-model'
  )
})

test('the context meter reads the session’s usage and grows with the conversation', async ({ app, page }) => {
  await app.open()
  await app.ready()

  const row = await openOptions(page)
  const meter = row.getByRole('meter', { name: 'Context used' })

  await expect(meter).toBeVisible()
  await expect(meter).toHaveAttribute('max', '200000')

  const first = Number(await meter.getAttribute('value'))

  expect(first).toBeGreaterThan(0)
  await expect(row.getByText(/^\d+% · [\d.]+k? \/ 200k$/u)).toBeVisible()

  // A turn adds to what the window holds, and the meter follows without being asked.
  await page.keyboard.press('Escape')
  await app.send('and a short one')
  await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })

  const later = await openOptions(page)

  await expect.poll(async () => Number(await later.getByRole('meter').getAttribute('value'))).toBeGreaterThan(first)
})

test('the conversation on screen downloads as Markdown and as plain text', async ({ app, page }) => {
  await app.open()
  await app.ready()
  await app.send('and a short one')
  await expect(app.transcript.locator('.hm-bubble[data-kind="user"]').last()).toContainText('and a short one')
  await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })

  const row = await openOptions(page)
  const exported = row.getByRole('group', { name: 'Export' })

  const markdown = page.waitForEvent('download')

  await exported.getByRole('button', { name: 'Download as Markdown' }).click()

  const md = await markdown

  expect(md.suggestedFilename()).toMatch(/^[A-Za-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/u)

  const mdText = await readFile((await md.path()) as string, 'utf8')

  expect(mdText).toContain('**You**')
  expect(mdText).toContain('and a short one')

  const text = page.waitForEvent('download')

  await exported.getByRole('button', { name: 'Download as plain text' }).click()

  const txt = await text

  expect(txt.suggestedFilename()).toMatch(/\.txt$/u)

  const txtText = await readFile((await txt.path()) as string, 'utf8')

  expect(txtText).toContain('and a short one')
  expect(txtText).not.toContain('**You**')
  // The panel is still open and nothing was said to be wrong.
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test.describe('in a Dutch browser', () => {
  // The language follows the browser until the reader chooses one.
  test.use({ locale: 'nl-NL' })

  test('is written in Dutch', async ({ app, page }) => {
    await app.open()
    // The composer's own name is English-bound in the helpers: wait on the options button instead.
    await page.getByRole('button', { name: 'Chatopties' }).click()

    const row = page.getByRole('group', { name: 'Dit gesprek' })

    await expect(row.getByRole('checkbox', { name: 'Snelle modus' })).toBeVisible()
    await expect(row.getByRole('combobox', { name: 'Redeneerniveau' })).toBeVisible()
    await expect(row.getByRole('combobox', { name: 'Model' })).toBeVisible()
  })
})
