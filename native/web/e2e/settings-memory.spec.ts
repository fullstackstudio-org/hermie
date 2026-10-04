/**
 * Settings › Memory in a real browser against the fake gateway serving the built client: the Hermie plugin's
 * memory routes as the page reads and writes them (`/api/plugins/hermie/memory/...`).
 *
 *  - **Both files** of the picked bot with their entries, how full each is, and the providers that cannot be
 *    listed; another bot's memory when it is picked.
 *  - **Editing**: Replace writes the entry (read back from the gateway), Cancel puts it back and writes nothing.
 *  - **Adding** and **removing**: a new entry appears under its file; a removal asks first and is read back.
 *  - **The store's refusal** (an entry that would not fit) is shown as the store said it.
 *  - **The search** is the plugin's: it matches across both files.
 *  - **A gateway without the memory browser** gets what to install, and the page is fetched on demand, in the chunk the management pages share.
 *  - **Accessibility** with axe in the light and the dark scheme, with an editor and a question open.
 */
import { PLUGIN_ADVERT } from '@hermie/fake-gateway'

import { expect, type Page, seriousViolations, test } from './fixtures'

interface Listing {
  targets: { target: 'memory' | 'user'; entries: { text: string }[] }[]
}

/** What the gateway holds for a bot, read the way the page reads it. */
async function held(page: Page, gatewayUrl: string, profile: string, target: 'memory' | 'user'): Promise<string[]> {
  const answer = await page.request.get(`${gatewayUrl}/api/plugins/hermie/memory/list?profile=${profile}`)

  expect(answer.ok()).toBe(true)

  return ((await answer.json()) as Listing).targets.find(row => row.target === target)?.entries.map(e => e.text) ?? []
}

async function openFor(app: { open(hash?: string): Promise<void> }, page: Page, bot = 'Researcher'): Promise<void> {
  await app.open('#/settings/memory')
  await expect(page.getByRole('heading', { level: 2, name: 'Memory' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Bot' }).selectOption({ label: bot })
}

test.describe('Settings › Memory', () => {
  test('shows both files of the picked bot with their usage, names the providers that cannot be listed, and follows the picker', async ({
    app,
    page
  }) => {
    await openFor(app, page)

    await expect(page.getByRole('heading', { level: 3, name: 'MEMORY.md' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: 'USER.md' })).toBeVisible()
    await expect(page.getByText('Northwind Trading invoices on the first of the month.')).toBeVisible()
    await expect(page.getByText('Reads Dutch and English.')).toBeVisible()
    await expect(page.getByRole('meter', { name: /^MEMORY\.md is \d+% full$/u })).toBeVisible()
    await expect(page.getByText('mem0', { exact: true })).toBeVisible()
    await expect(page.getByText('Not browsable')).toBeVisible()

    await page.getByRole('combobox', { name: 'Bot' }).selectOption({ label: 'Writer' })
    await expect(page.getByText('Drafts open with the verb, never with the subject.')).toBeVisible()
    await expect(page.getByText('Northwind Trading invoices on the first of the month.')).toHaveCount(0)
  })

  test('replaces an entry and the gateway holds it; Cancel puts the text back and writes nothing', async ({
    app,
    gateway,
    page
  }) => {
    await openFor(app, page)

    const first = 'Prefers footnotes to parentheses.'

    await page.getByRole('button', { name: 'Edit entry 3 in MEMORY.md' }).click()

    const field = page.getByRole('textbox', { name: 'Text of entry 3 in MEMORY.md' })

    await expect(field).toBeFocused()
    await field.fill('Something the reader changed their mind about')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText(first)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit entry 3 in MEMORY.md' })).toBeFocused()
    expect(await held(page, gateway.url, 'researcher', 'memory')).toContain(first)

    await page.getByRole('button', { name: 'Edit entry 3 in MEMORY.md' }).click()
    await field.fill('Prefers endnotes.')
    await page.getByRole('button', { name: 'Replace' }).click()

    await expect(page.getByText('Prefers endnotes.')).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'Replaced.' })).toBeVisible()
    expect(await held(page, gateway.url, 'researcher', 'memory')).toEqual([
      'Northwind Trading invoices on the first of the month.',
      'The tailnet address is the one to use from outside; @dana set it up on 2026-09-21.',
      'Prefers endnotes.'
    ])
  })

  test('adds an entry under the file it was written in', async ({ app, gateway, page }) => {
    await openFor(app, page)

    await page.getByRole('textbox', { name: 'Add to USER.md' }).fill('Likes short answers.')
    await page.getByRole('button', { name: 'Add' }).nth(1).click()

    await expect(page.getByText('Likes short answers.')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Add to USER.md' })).toHaveValue('')
    expect(await held(page, gateway.url, 'researcher', 'user')).toEqual([
      'Robin works from Lisbon and answers fastest in the morning.',
      'Reads Dutch and English.',
      'Likes short answers.'
    ])
  })

  test('asks before it removes, and the entry is gone from the gateway once it is confirmed', async ({
    app,
    gateway,
    page
  }) => {
    await openFor(app, page)

    const entry = 'Prefers footnotes to parentheses.'

    await page.getByRole('button', { name: 'Remove entry 3 from MEMORY.md' }).click()

    const group = page.getByRole('group', { name: 'Remove entry 3 from MEMORY.md' })

    await expect(group).toContainText('Remove this entry?')
    await expect(group.getByRole('button', { name: 'Keep it' })).toBeFocused()
    await group.getByRole('button', { name: 'Keep it' }).click()
    await expect(page.getByText(entry)).toBeVisible()
    expect(await held(page, gateway.url, 'researcher', 'memory')).toContain(entry)

    await page.getByRole('button', { name: 'Remove entry 3 from MEMORY.md' }).click()
    await group.getByRole('button', { name: 'Remove entry 3 from MEMORY.md' }).click()

    await expect(page.getByText(entry)).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Removed.' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: 'MEMORY.md' })).toBeFocused()
    expect(await held(page, gateway.url, 'researcher', 'memory')).not.toContain(entry)
  })

  test('shows the store’s own sentence when a write would not fit, and writes nothing', async ({
    app,
    gateway,
    page
  }) => {
    await openFor(app, page)

    await page.getByRole('textbox', { name: 'Add to MEMORY.md' }).fill('x'.repeat(5000))
    await page.getByRole('button', { name: 'Add' }).first().click()

    await expect(page.getByRole('status').filter({ hasText: /limit|exceed|chars/iu })).toBeVisible()
    expect(await held(page, gateway.url, 'researcher', 'memory')).toHaveLength(3)
    // The draft is still there to be shortened.
    await expect(page.getByRole('textbox', { name: 'Add to MEMORY.md' })).toHaveValue('x'.repeat(5000))
  })

  test('searches with the plugin, across both files', async ({ app, page }) => {
    await openFor(app, page)

    await page.getByRole('searchbox', { name: 'Search this memory' }).fill('lisbon')
    await expect(page.getByText('Robin works from Lisbon and answers fastest in the morning.')).toBeVisible()
    await expect(page.getByText('Prefers footnotes to parentheses.')).toHaveCount(0)

    await page.getByRole('searchbox', { name: 'Search this memory' }).fill('nothing-like-this')
    await expect(page.getByText('Nothing matches “nothing-like-this”.')).toBeVisible()

    await page.getByRole('searchbox', { name: 'Search this memory' }).fill('')
    await expect(page.getByText('Prefers footnotes to parentheses.')).toBeVisible()
  })

  test('shows what each backend holds as stored when the disclosure is opened', async ({ app, page }) => {
    await openFor(app, page)

    await page.getByText('Raw', { exact: true }).click()
    await expect(page.getByText('mem0 answers a query and offers no call that lists what it holds.')).toBeVisible()
    await expect(page.locator('pre.hm-manage__scroll').first()).toContainText('Prefers footnotes to parentheses.')
  })

  test.describe('on a gateway whose plugin has no memory browser', () => {
    test.use({
      gatewayOptions: {
        plugin: {
          ...PLUGIN_ADVERT,
          capabilities: (PLUGIN_ADVERT.capabilities as string[]).filter(entry => !entry.startsWith('memory.'))
        }
      }
    })

    test('says what to install, and offers nothing to read', async ({ app, page }) => {
      await app.open('#/settings/memory')

      await expect(page.getByText('The Hermie plugin has no memory browser')).toBeVisible()
      await expect(page.getByText('hermes plugins install hermie')).toBeVisible()
      await expect(page.getByRole('textbox')).toHaveCount(0)
    })
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
    await page.getByRole('link', { name: 'Memory' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Memory' })).toBeVisible()
    expect(fetched.length).toBeGreaterThan(0)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious accessibility violation in the ${scheme} scheme, with an editor and a question open`, async ({
      app,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await openFor(app, page)
      await expect(page.getByText('Prefers footnotes to parentheses.')).toBeVisible()

      expect(await seriousViolations(page, `memory-${scheme}`)).toEqual([])

      await page.getByRole('button', { name: 'Edit entry 1 in USER.md' }).click()
      await page.getByRole('button', { name: 'Remove entry 3 from MEMORY.md' }).click()
      await expect(page.getByRole('group', { name: 'Remove entry 3 from MEMORY.md' })).toBeVisible()

      expect(await seriousViolations(page, `memory-open-${scheme}`)).toEqual([])
    })
  }
})
