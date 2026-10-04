/**
 * Settings, in a real browser against the fake gateway serving the built client.
 *
 *  - **The home and its chunks.** The sidebar's Settings link opens the home; Settings is a chunk fetched
 *    when it is reached and each section a chunk of its own, fetched when it is opened.
 *  - **Appearance.** A language switch takes effect where the reader stands, with no reload (a marker on
 *    the window survives it) and stays through one; the scheme, the tint and the text size reach the
 *    document, and the text size reaches the words of a message and nothing else.
 *  - **Chat list.** Reordering from the keyboard alone (Tab to a Move button, Enter), with the focus
 *    staying where it was and the change reaching the gateway; a chat's colour and archive, which survive
 *    a reload and reach the gateway as the person's own section.
 *  - **Chats.** The transcript cache is read back from IndexedDB: a chat leaves a copy, "Clear now"
 *    removes it, and switched off nothing is kept.
 *  - **Account.** Sign out asks first, then ends the gateway's session and clears what is this person's
 *    and not the browser's.
 *  - **Accessibility** with axe in the light and the dark scheme, on every page, with a row's panel and
 *    the sign-out question open.
 *
 * Names here are the fake gateway's own bots (`researcher`, `writer`), test data and nothing else.
 */
import type { Page } from '@playwright/test'

import { BOT, expect, goTo, seriousViolations, test } from './fixtures'

/** The chats the Chat list page draws at the top level, in order, by the bot name each row carries. */
const drawn = (page: Page): Promise<string[]> =>
  page
    .getByRole('list', { name: 'Chats and folders' })
    .locator('li[data-bot]')
    .evaluateAll(items => items.map(item => (item as HTMLElement).dataset.bot ?? ''))

/** How many transcripts this browser holds in its cache (IndexedDB `hermie-cache`), read from the page. */
const cachedTranscripts = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('hermie-cache')

        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const database = open.result

          if (!database.objectStoreNames.contains('transcripts')) {
            database.close()
            resolve(0)

            return
          }

          const count = database.transaction('transcripts', 'readonly').objectStore('transcripts').count()

          count.onerror = () => reject(count.error)
          count.onsuccess = () => {
            database.close()
            resolve(count.result)
          }
        }
      })
  )

/** What the gateway holds of the person's arrangement and a bot's colour, read as the page reads it. */
async function holds(page: Page, gatewayUrl: string): Promise<{ archived: string[]; colours: Record<string, string> }> {
  const response = await page.request.get(`${gatewayUrl}/api/profiles`)
  const body = (await response.json()) as {
    profiles: { name: string; ui_meta?: Record<string, Record<string, unknown>> }[]
  }
  const archived = new Set<string>()
  const colours: Record<string, string> = {}

  for (const profile of body.profiles) {
    for (const [key, section] of Object.entries(profile.ui_meta ?? {})) {
      if (key.startsWith('hermie-app') && Array.isArray(section.archivedBots)) {
        for (const name of section.archivedBots) {
          archived.add(String(name))
        }
      }

      if (key === 'hermie' && typeof section.colour === 'string') {
        colours[profile.name] = section.colour
      }
    }
  }

  return { archived: [...archived], colours }
}

test.describe('the home', () => {
  test('is reached from the sidebar, lists every section, and is a chunk fetched when it is reached', async ({
    app,
    page
  }) => {
    const fetched: string[] = []

    page.on('request', request => {
      const path = new URL(request.url()).pathname

      if (
        /\/assets\/(?:SettingsHost|Arrangement|Appearance|Chats|Account|Gateway|About)-[\w-]+\.(?:js|css)$/u.test(path)
      ) {
        fetched.push(path.split('/').pop() ?? path)
      }
    })

    await app.open(`#/chat/${BOT}`)
    await app.ready()
    expect(fetched).toEqual([])

    await page.getByRole('contentinfo').getByRole('link', { name: 'Settings' }).click()

    await expect(page).toHaveURL(/#\/settings$/u)
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    await expect(page.getByRole('main').getByRole('link')).toHaveText([
      'Account',
      'This gateway',
      'Passkeys',
      'MCP',
      'Chats & messages',
      'Notifications',
      'Chat list',
      'Appearance',
      'About'
    ])
    expect(fetched.some(name => name.startsWith('SettingsHost-'))).toBe(true)
    // Opening the home fetches no section.
    expect(fetched.filter(name => !name.startsWith('SettingsHost-'))).toEqual([])

    await page.getByRole('main').getByRole('link', { name: 'Chat list' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Chat list' })).toBeVisible()
    expect(fetched.some(name => name.startsWith('Arrangement-'))).toBe(true)
    expect(fetched.some(name => name.startsWith('Appearance-'))).toBe(false)
  })

  test('sends a section it does not have back to the home', async ({ app, page }) => {
    await app.open('#/settings/nothing-here')

    await expect(page).toHaveURL(/#\/settings$/u)
    await expect(page.getByRole('main').getByRole('link', { name: 'Appearance' })).toBeVisible()
  })
})

test.describe('Appearance', () => {
  test('switches the language where the reader stands, with no reload, and keeps it through one', async ({
    app,
    page
  }) => {
    await app.open('#/settings/appearance')
    await expect(page.getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible()

    // Anything a reload would lose.
    await page.evaluate(() => {
      ;(window as unknown as { __stayed?: number }).__stayed = 1
    })

    await page.getByRole('group', { name: 'Language' }).getByRole('radio', { name: 'Nederlands' }).check()

    await expect(page.getByRole('heading', { level: 2, name: 'Weergave' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Instellingen' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl')
    await expect(page.getByRole('group', { name: 'Taal' }).getByRole('radio', { name: 'Nederlands' })).toBeChecked()
    // The sidebar, which this page did not touch, moved with it.
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Instellingen' })).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __stayed?: number }).__stayed)).toBe(1)

    await page.getByRole('group', { name: 'Taal' }).getByRole('radio', { name: 'Deutsch' }).check()
    await expect(page.getByRole('heading', { level: 2, name: 'Darstellung' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')

    await page.reload()
    await expect(page.getByRole('heading', { level: 2, name: 'Darstellung' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'de')

    // Back to following the browser, which is English here.
    await page.getByRole('group', { name: 'Sprache' }).getByRole('radio', { name: 'Browser folgen' }).check()
    await expect(page.getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible()
  })

  test('applies the scheme and the tint to the page, and they stay through a reload', async ({ app, page }) => {
    await app.open('#/settings/appearance')

    await page.getByRole('group', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).check()
    await page.getByRole('group', { name: 'Accent colour' }).getByRole('radio', { name: 'Teal' }).check()

    await expect(page.locator('html')).toHaveAttribute('data-scheme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-tint', 'teal')
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(12, 13, 16)')

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-scheme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-tint', 'teal')
    await expect(page.getByRole('group', { name: 'Theme' }).getByRole('radio', { name: 'Dark' })).toBeChecked()
  })

  test('sizes the words of a message and nothing around them', async ({ app, page }) => {
    await app.open(`#/chat/${BOT}`)
    await app.ready()

    const bubble = page.locator('.hm-bubble').first()

    await expect(bubble).toBeVisible()
    await expect(bubble).toHaveCSS('font-size', '16px')

    await goTo(page, '#/settings/appearance')
    await page.getByRole('group', { name: 'Chat text size' }).getByRole('radio', { name: 'Large', exact: true }).check()
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large')

    // The settings page itself is not the conversation: its own type stays where it was.
    await expect(page.getByRole('heading', { level: 2, name: 'Appearance' })).toHaveCSS('font-size', '20px')

    await goTo(page, `#/chat/${BOT}`)
    // 16px at 115%: Firefox reports 18.4063px where Chromium reports 18.4px, so the size is compared
    // as a number, within 0.05px, not as the string each engine happens to print.
    await expect
      .poll(async () =>
        Number.parseFloat(
          await page
            .locator('.hm-bubble')
            .first()
            .evaluate(el => getComputedStyle(el).fontSize)
        )
      )
      .toBeCloseTo(18.4, 1)
    await expect(page.getByRole('textbox', { name: /^Message / })).toHaveCSS('font-size', '16px')
  })
})

test.describe('Chat list', () => {
  test('reorders from the keyboard, keeps the focus on the button, and reaches the gateway', async ({
    app,
    gateway,
    page
  }) => {
    await app.open('#/settings/chat-list')
    await expect(page.getByRole('heading', { level: 2, name: 'Chat list' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Chats and folders' })).toBeVisible()

    const before = await drawn(page)

    expect(before.length).toBeGreaterThanOrEqual(2)

    const [first, second] = before as [string, string]
    const name = (bot: string): string => `${bot.charAt(0).toUpperCase()}${bot.slice(1)}`

    // Wait for the roster to be folded in and sent once, so the move below is a write of its own.
    await expect
      .poll(async () => (await gateway.state()).methodLog.filter(entry => entry === 'profiles.configure').length, {
        timeout: 15_000
      })
      .toBeGreaterThanOrEqual(1)
    const writes = (await gateway.state()).methodLog.filter(entry => entry === 'profiles.configure').length

    const down = page.getByRole('button', { name: `Move down ${name(first)}` })

    // Tab reaches it; no pointer is used.
    await down.focus()
    await expect(down).toBeFocused()
    await page.keyboard.press('Enter')

    expect((await drawn(page)).slice(0, 2)).toEqual([second, first])
    await expect(page.getByRole('status').filter({ hasText: 'is now at position 2 of' })).toHaveText(
      new RegExp(`^${name(first)} is now at position 2 of ${before.length}\\.$`, 'u')
    )
    // The button the reader pressed still has the focus, though its row moved under it.
    await expect(page.getByRole('button', { name: `Move down ${name(first)}` })).toBeFocused()

    // And the other way, with the Space bar this time.
    await page.getByRole('button', { name: `Move up ${name(first)}` }).focus()
    await page.keyboard.press('Space')
    expect((await drawn(page)).slice(0, 2)).toEqual([first, second])

    // The first row cannot go up: the button says so and stays in the tab order.
    const up = page.getByRole('button', { name: `Move up ${name(first)}` })

    await expect(up).toHaveAttribute('aria-disabled', 'true')
    await up.focus()
    await page.keyboard.press('Enter')
    expect((await drawn(page)).slice(0, 2)).toEqual([first, second])
    await expect(up).toBeFocused()

    // A move reached the gateway (debounced), and survives a reload.
    await page.getByRole('button', { name: `Move down ${name(first)}` }).focus()
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => (await gateway.state()).methodLog.filter(entry => entry === 'profiles.configure').length, {
        timeout: 15_000
      })
      .toBeGreaterThan(writes)

    await page.reload()
    await expect(page.getByRole('list', { name: 'Chats and folders' })).toBeVisible()
    expect((await drawn(page)).slice(0, 2)).toEqual([second, first])
  })

  test('gives a chat a colour and archives it, and both survive a reload and reach the gateway', async ({
    app,
    gateway,
    page
  }) => {
    await app.open('#/settings/chat-list')
    await expect(page.getByRole('list', { name: 'Chats and folders' })).toBeVisible()

    await page.getByRole('main').getByRole('button', { name: 'Actions for Writer' }).click()

    const panel = page.getByRole('group', { name: 'Actions for Writer' })

    await panel.getByRole('combobox', { name: 'Colour' }).selectOption({ label: 'Teal' })
    await expect(page.locator('li[data-bot="writer"] .hm-swatch')).toHaveAttribute('data-accent', 'teal')

    await panel.getByRole('button', { name: 'Archive Writer' }).click()

    await expect(page.getByRole('heading', { level: 3, name: 'Archived (1)' })).toBeFocused()
    await expect(page.getByRole('status').filter({ hasText: 'Writer is archived.' })).toBeVisible()
    expect(await drawn(page)).not.toContain('writer')
    await expect(page.getByRole('list', { name: 'Archived (1)' }).locator('li[data-bot="writer"]')).toBeVisible()

    await expect
      .poll(async () => holds(page, gateway.url), { timeout: 15_000 })
      .toEqual({ archived: ['writer'], colours: { writer: 'teal' } })

    await page.reload()
    await expect(page.getByRole('heading', { level: 3, name: 'Archived (1)' })).toBeVisible()
    await expect(
      page.getByRole('list', { name: 'Archived (1)' }).locator('li[data-bot="writer"] .hm-swatch')
    ).toHaveAttribute('data-accent', 'teal')

    // And back out of the archive.
    await page.getByRole('main').getByRole('button', { name: 'Actions for Writer' }).click()
    await page.getByRole('button', { name: 'Unarchive Writer' }).click()
    await expect(page.getByRole('heading', { level: 3, name: /^Archived/u })).toHaveCount(0)
    expect(await drawn(page)).toContain('writer')
  })

  test('makes a folder, moves a chat into it from the keyboard, and mutes a chat', async ({ app, page }) => {
    await app.open('#/settings/chat-list')
    await expect(page.getByRole('list', { name: 'Chats and folders' })).toBeVisible()

    await page.getByRole('textbox', { name: 'Folder name' }).fill('Reading')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status').filter({ hasText: 'Folder Reading created.' })).toBeVisible()

    await page.getByRole('main').getByRole('button', { name: 'Actions for Writer' }).click()
    await page
      .getByRole('group', { name: 'Actions for Writer' })
      .getByRole('combobox', { name: 'Move to folder' })
      .selectOption({ label: 'Reading' })

    await expect(page.getByRole('list', { name: 'Chats in Reading' }).locator('li[data-bot="writer"]')).toBeVisible()

    await page.getByRole('group', { name: 'Actions for Writer' }).getByRole('combobox', { name: 'Mute' }).selectOption({
      label: 'Until I turn it back on'
    })
    await expect(page.locator('li[data-bot="writer"] .hm-arr__badge')).toHaveText('Muted')
  })
})

test.describe('Chats', () => {
  test('keeps a copy of a chat in this browser, clears it on request, and keeps none when switched off', async ({
    app,
    page
  }) => {
    await app.open(`#/chat/${BOT}`)
    await app.ready()
    await expect(page.locator('.hm-bubble').first()).toBeVisible()

    // Leaving the chat writes its copy.
    await goTo(page, '#/settings/chats')
    await expect(page.getByRole('heading', { level: 2, name: 'Chats & messages' })).toBeVisible()
    await expect.poll(() => cachedTranscripts(page), { timeout: 15_000 }).toBeGreaterThan(0)

    const keep = page.getByRole('checkbox', { name: 'Keep transcripts in this browser' })

    await expect(keep).toBeChecked()
    await page.getByRole('button', { name: 'Clear now' }).click()
    await expect(page.getByText('The stored transcripts were cleared.')).toBeVisible()
    await expect.poll(() => cachedTranscripts(page)).toBe(0)

    // Off: nothing is kept, although a chat is opened and left again.
    await keep.uncheck()
    await expect(page.getByText(/no longer kept in this browser/u)).toBeVisible()
    await goTo(page, `#/chat/${BOT}`)
    await expect(page.locator('.hm-bubble').first()).toBeVisible()
    await goTo(page, '#/settings/chats')
    await expect(keep).not.toBeChecked()
    await page.waitForTimeout(500)
    expect(await cachedTranscripts(page)).toBe(0)

    // The choice is the browser's: it is still off after a reload.
    await page.reload()
    await expect(page.getByRole('checkbox', { name: 'Keep transcripts in this browser' })).not.toBeChecked()
  })

  test('changes what a new conversation shows, and the chat’s own options say it follows the default', async ({
    app,
    page
  }) => {
    await app.open('#/settings/chats')

    await page.getByRole('group', { name: 'Default verbosity' }).getByRole('radio', { name: 'Verbose' }).check()
    await page.getByRole('checkbox', { name: 'Show thinking' }).check()

    await goTo(page, `#/chat/${BOT}`)
    await app.ready()
    await page.getByRole('button', { name: 'Chat options' }).click()

    const options = page.getByRole('group', { name: 'What this conversation shows' })

    await expect(options.getByRole('radio', { name: 'Verbose' })).toBeChecked()
    await expect(options.getByRole('checkbox', { name: 'Show thinking' })).toBeChecked()
    await expect(options.getByText('Following the default set in Settings.')).toBeVisible()
  })
})

test.describe('This gateway', () => {
  test('says where the page came from and what the plugin advertises, and has nothing to change', async ({
    app,
    gateway,
    page
  }) => {
    await app.open('#/settings/gateway')
    await expect(page.getByRole('heading', { level: 2, name: 'This gateway' })).toBeVisible()

    const host = new URL(gateway.url).host

    await expect(page.getByText('Host', { exact: true }).locator('xpath=following-sibling::dd')).toHaveText(host)
    await expect(page.getByText('Address', { exact: true }).locator('xpath=following-sibling::dd')).toHaveText(
      gateway.url
    )
    await expect(page.getByText('Plugin', { exact: true }).locator('xpath=following-sibling::dd')).toContainText(
      'Hermie plugin'
    )
    await expect(
      page.getByText('Plugin modules', { exact: true }).locator('xpath=following-sibling::dd')
    ).toContainText('web: on')
    // The fake names a client build of its own, which is not the one under test: the page says it differs
    // (a plugin carrying this very build says "No update is known", which the unit tests cover).
    await expect(page.getByText('Update', { exact: true }).locator('xpath=following-sibling::dd')).toContainText(
      'Reload this page to use it'
    )
    await expect(page.getByRole('main').getByRole('button')).toHaveCount(0)
  })
})

test.describe('About', () => {
  test('names the build and lists the licences the build carries', async ({ app, page }) => {
    await app.open('#/settings/about')

    await expect(page.getByRole('heading', { level: 2, name: 'About' })).toBeVisible()
    await expect(page.getByText('Version', { exact: true }).locator('xpath=following-sibling::dd')).toHaveText(
      /^\d+\.\d+\.\d+/u
    )
    await expect(page.getByText('Commit', { exact: true }).locator('xpath=following-sibling::dd')).toHaveText(
      /^[0-9a-f]{40}$/u
    )

    const list = page.getByRole('list', { name: 'Licences' })

    await expect(list).toBeVisible()
    await expect(list.getByRole('listitem').filter({ hasText: 'react' }).first()).toBeVisible()

    // A package's licence is behind its line.
    const item = list
      .getByRole('listitem')
      .filter({ hasText: /^zustand/u })
      .first()

    await item.getByText(/^zustand/u).click()
    await expect(item.locator('pre')).toContainText('MIT License')
  })
})

test.describe('Account', () => {
  test('asks first, then ends the session and clears what is this person’s and not the browser’s', async ({
    app,
    gateway,
    page
  }) => {
    await app.open('#/settings/account')
    await expect(page.getByRole('heading', { level: 2, name: 'Account' })).toBeVisible()
    await expect(page.getByText('Signed in as', { exact: true }).locator('xpath=following-sibling::dd')).toContainText(
      'Fake Tester'
    )

    // A device choice and something that is this person's.
    await page.evaluate(() => {
      localStorage.setItem(`hermie:/:device.scheme`, 'dark')
      localStorage.setItem(`hermie:/:chat.view`, '{"defaults":{"level":"verbose"}}')
    })

    await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click()

    const question = page.getByRole('group', { name: 'Sign out' })

    await expect(question.getByText('Sign out of this gateway in this browser?')).toBeVisible()
    await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused()

    // Cancel goes back, nothing signed out.
    await question.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('group', { name: 'Sign out' })).toHaveCount(0)
    expect((await page.request.get(`${gateway.url}/api/auth/me`)).status()).toBe(200)

    await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click()
    await page.getByRole('group', { name: 'Sign out' }).getByRole('button', { name: 'Sign out' }).click()

    await expect(page).toHaveURL(/\/login/u)
    expect((await page.request.get(`${gateway.url}/api/auth/me`)).status()).toBe(401)

    const kept = await page.evaluate(() => ({
      scheme: localStorage.getItem('hermie:/:device.scheme'),
      view: localStorage.getItem('hermie:/:chat.view')
    }))

    expect(kept).toEqual({ scheme: 'dark', view: null })
  })
})

test.describe('accessibility', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious violation on any settings page in the ${scheme} scheme`, async ({ app, page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await app.open('#/settings')
      await expect(page.getByRole('main').getByRole('link', { name: 'Appearance' })).toBeVisible()
      expect(await seriousViolations(page, `settings-home-${scheme}`)).toEqual([])

      for (const [hash, heading] of [
        ['account', 'Account'],
        ['gateway', 'This gateway'],
        ['chats', 'Chats & messages'],
        ['appearance', 'Appearance'],
        ['about', 'About']
      ] as const) {
        await goTo(page, `#/settings/${hash}`)
        await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible()

        if (hash === 'about') {
          await expect(page.getByRole('list', { name: 'Licences' })).toBeVisible()
        }

        expect(await seriousViolations(page, `settings-${hash}-${scheme}`)).toEqual([])
      }

      await goTo(page, '#/settings/chat-list')
      await expect(page.getByRole('list', { name: 'Chats and folders' })).toBeVisible()
      await page.getByRole('main').getByRole('button', { name: 'Actions for Writer' }).click()
      await page.getByRole('combobox', { name: 'Colour' }).selectOption({ label: 'Lime' })
      expect(await seriousViolations(page, `settings-chat-list-${scheme}`)).toEqual([])

      await goTo(page, '#/settings/account')
      await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click()
      await expect(page.getByRole('group', { name: 'Sign out' })).toBeVisible()
      expect(await seriousViolations(page, `settings-sign-out-${scheme}`)).toEqual([])
    })
  }

  test('is operable at 320 px wide without scrolling sideways', async ({ app, page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await app.open('#/settings/chat-list')
    await expect(page.getByRole('list', { name: 'Chats and folders' })).toBeVisible()
    await page.getByRole('main').getByRole('button', { name: 'Actions for Writer' }).click()

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    ).toBe(true)
  })
})
