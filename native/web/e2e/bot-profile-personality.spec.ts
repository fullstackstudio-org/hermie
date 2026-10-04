/**
 * A bot's profile page: its personality (`SOUL.md`) and its model, in a real browser against the fake gateway
 * serving the built client. Names here are the fake gateway's own bots, test data and nothing else.
 *
 *  - **The personality** is an editor of one height that scrolls inside; it waits for Save, writes the text
 *    exactly as typed (read back from the gateway), and Revert puts the gateway's text back.
 *  - **The model** is the bot's default, chosen from the gateway's inventory (the same list the chat's own picker
 *    offers) and written as the model id and its provider; an expensive model asks first, with the gateway's own
 *    words, and writes nothing until the answer is yes.
 *  - **Accessibility** with axe in the light and the dark scheme, with a question open.
 */
import { BOT, expect, type Page, seriousViolations, test } from './fixtures'

const soulOf = (gateway: { fake: { state: { profileSouls: Map<string, string> } } }, bot = BOT): string =>
  gateway.fake.state.profileSouls.get(bot) ?? ''

const pinOf = (
  gateway: { fake: { state: { profiles: { name: string; model?: string; provider?: string }[] } } },
  bot = BOT
) => {
  const row = gateway.fake.state.profiles.find(entry => entry.name === bot)

  return { model: row?.model, provider: row?.provider }
}

async function open(app: { open(hash?: string): Promise<void> }, page: Page): Promise<void> {
  await app.open(`#/chat/${BOT}/profile`)
  await expect(page.getByRole('heading', { level: 2, name: 'Personality' })).toBeVisible()
}

test.describe('The profile page: personality', () => {
  test('is an editor of one height that scrolls inside, and shows what the gateway holds', async ({
    app,
    gateway,
    page
  }) => {
    gateway.fake.state.profileSouls.set(BOT, Array.from({ length: 120 }, (_, index) => `Rule ${index + 1}.`).join('\n'))
    await open(app, page)

    const editor = page.getByRole('textbox', { name: 'Personality' })

    await expect(editor).toHaveValue(/^Rule 1\.\nRule 2\./u)

    const box = await editor.boundingBox()

    expect(box?.height).toBeGreaterThan(150)
    expect(box?.height).toBeLessThan(400)

    // It scrolls inside: the content is far taller than the box.
    const scrolls = await editor.evaluate(node => node.scrollHeight > node.clientHeight)

    expect(scrolls).toBe(true)
  })

  test('says none is set when the profile has none', async ({ app, page }) => {
    await open(app, page)

    await expect(page.getByRole('textbox', { name: 'Personality' })).toHaveAttribute(
      'placeholder',
      'No personality is set.'
    )
  })

  test('waits for Save, writes the text exactly as typed, and Revert puts the gateway’s text back', async ({
    app,
    gateway,
    page
  }) => {
    await open(app, page)

    const editor = page.getByRole('textbox', { name: 'Personality' })
    const section = page.getByRole('region', { name: 'Personality' })

    await expect(section.getByRole('button', { name: 'Save' })).toHaveCount(0)
    await editor.fill('  You are terse.\n\n  You never apologise.\n')
    expect(soulOf(gateway)).toBe('')

    await section.getByRole('button', { name: 'Revert' }).click()
    await expect(editor).toHaveValue('')
    await expect(section.getByRole('button', { name: 'Save' })).toHaveCount(0)
    expect(soulOf(gateway)).toBe('')

    await editor.fill('  You are terse.\n\n  You never apologise.\n')
    await section.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByRole('status').filter({ hasText: 'Personality saved.' })).toBeAttached()
    await expect(section.getByRole('button', { name: 'Save' })).toHaveCount(0)
    expect(soulOf(gateway)).toBe('  You are terse.\n\n  You never apologise.\n')

    // Read again from the gateway after a reload.
    await app.open(`#/chat/${BOT}/profile`)
    await expect(page.getByRole('textbox', { name: 'Personality' })).toHaveValue(
      '  You are terse.\n\n  You never apologise.\n'
    )
  })

  test('draws the personality as text, never as markup', async ({ app, gateway, page }) => {
    gateway.fake.state.profileSouls.set(BOT, '<img src=x onerror=alert(1)> **not bold**')
    await open(app, page)

    await expect(page.getByRole('textbox', { name: 'Personality' })).toHaveValue(
      '<img src=x onerror=alert(1)> **not bold**'
    )
    await expect(page.locator('img[src="x"]')).toHaveCount(0)
  })
})

test.describe('The profile page: model', () => {
  test('offers the gateway’s models in a group per provider and the bot’s own selected, with a search', async ({
    app,
    page
  }) => {
    await open(app, page)

    const picker = page.getByRole('combobox', { name: 'Model', exact: true })

    await expect(picker).toBeEnabled()
    await expect(picker.locator('optgroup')).toHaveCount(3)
    await expect(page.getByRole('searchbox', { name: 'Search models' })).toBeVisible()

    await page.getByRole('searchbox', { name: 'Search models' }).fill('local')
    await expect(picker.locator('optgroup')).toHaveCount(1)
  })

  test('pins the bot to another model: its id and its provider, and the roster follows', async ({
    app,
    gateway,
    page
  }) => {
    await open(app, page)

    const picker = page.getByRole('combobox', { name: 'Model', exact: true })

    await expect(picker).toBeEnabled()
    await picker.selectOption({ label: 'Reasoner 2' })

    await expect.poll(() => pinOf(gateway)).toEqual({ model: 'reasoner-2', provider: 'second-provider' })
    await expect(picker.locator('option:checked')).toHaveText('Reasoner 2')
  })

  test('asks before an expensive model, with the gateway’s words, and writes nothing until it is told yes', async ({
    app,
    gateway,
    page
  }) => {
    await open(app, page)

    const picker = page.getByRole('combobox', { name: 'Model', exact: true })
    const before = pinOf(gateway)

    await expect(picker).toBeEnabled()
    await picker.selectOption({ label: 'Expensive Model' })

    const question = page.getByRole('group', { name: 'This model costs more' })

    await expect(question).toContainText('expensive-model is an expensive model. Continue?')
    await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused()
    expect(pinOf(gateway)).toEqual(before)

    await question.getByRole('button', { name: 'Cancel' }).click()
    await expect(question).toHaveCount(0)
    await expect(picker).toBeFocused()
    expect(pinOf(gateway)).toEqual(before)

    await picker.selectOption({ label: 'Expensive Model' })
    await page
      .getByRole('group', { name: 'This model costs more' })
      .getByRole('button', { name: 'Use it anyway' })
      .click()

    await expect.poll(() => pinOf(gateway)).toEqual({ model: 'expensive-model', provider: 'example-provider' })
    await expect(question).toHaveCount(0)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious accessibility violation in the ${scheme} scheme, with the question open`, async ({
      app,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await open(app, page)
      await page.getByRole('textbox', { name: 'Personality' }).fill('Be brief.')

      const picker = page.getByRole('combobox', { name: 'Model', exact: true })

      await expect(picker).toBeEnabled()
      expect(await seriousViolations(page, `profile-personality-${scheme}`)).toEqual([])

      await picker.selectOption({ label: 'Expensive Model' })
      await expect(page.getByRole('group', { name: 'This model costs more' })).toBeVisible()

      expect(await seriousViolations(page, `profile-model-question-${scheme}`)).toEqual([])
    })
  }
})
