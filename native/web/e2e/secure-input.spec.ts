/**
 * What a bot asks for that is a secret (`secret`, `sudo`, `vault.unlock_prompt`,
 * `vault.code`, `vault.save_login`), and what only the desktop app can answer, in
 * a real browser against the fake gateway serving the built client.
 *
 * Every request is raised through `/__fake/request`, and the answer is read back
 * from what the fake recorded (`serverRequestAnswers`). What this proves:
 *
 *  - **Each prompt** opens its sheet in the app's own words, names the gateway,
 *    and its answer reaches the gateway as `{value}`: as typed, a code without its
 *    spaces, a login as the JSON string `{identifier, password}`; Skip is `''`.
 *  - **The fields** are masked, `autocomplete="off"`, unnamed and in no form, and
 *    nothing is focused for the reader.
 *  - **Nothing is kept.** After an answer the value is in no field, nowhere in the
 *    page's markup, not in the address, not in local or session storage and not in
 *    any IndexedDB store the page wrote (the transcript cache among them).
 *    Nor in anything the page wrote to its console.
 *  - **Withdrawn** (`request.cancel`): the sheet closes and the chat says why.
 *  - **Withdrawn while the socket was down**: after the reconnect the sheet
 *    closes with a notice saying so, and nothing can be sent to it.
 *  - **Signing out** with a prompt open answers it `''` before the socket goes.
 *  - **Expired**: the gateway's deadline closes it, on the page's clock.
 *  - **Restored**: one still open when the page is reloaded comes back from
 *    `open_requests` and can be answered.
 *  - **Desktop only** (`terminal.read`, `preview.act`, ...): answered with a
 *    JSON-RPC error at once, and one notice in the chat, no dialog.
 *  - **A phone**: long request words wrap inside the sheet at 320 px.
 */
import type { Page } from '@playwright/test'

import { expect, type Gateway, test } from './fixtures'

const SECRET = 'e2e-hunter2-ZQ7xK-never-kept'

/** Everything the page could have kept, as one text. */
async function everythingKept(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [location.href, document.documentElement.outerHTML]

    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) ?? ''

        parts.push(key, storage.getItem(key) ?? '')
      }
    }

    // Every record of every store of every database the origin has.
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []

    for (const { name } of databases) {
      if (!name) {
        continue
      }

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name)

        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error)
      })

      for (const store of [...db.objectStoreNames]) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll()

          request.onsuccess = () => resolve(request.result as unknown[])
          request.onerror = () => reject(request.error)
        })

        parts.push(JSON.stringify(rows))
      }

      db.close()
    }

    return parts.join('\n')
  })
}

/** What the page wrote to its console in this test: the value must not be in it either. */
let consoleLines: string[] = []

test.beforeEach(({ page }) => {
  consoleLines = []
  page.on('console', message => consoleLines.push(message.text()))
})

test.afterEach(() => {
  expect(consoleLines.join('\n')).not.toContain('ZQ7xK')
})

/** The chat's line about a prompt that ended without an answer, or a request it declined. */
const chatNotice = (page: Page) => page.locator('[data-secure-notice]')

const lastAnswer = async (gateway: Gateway, method: string) =>
  (await gateway.answers()).filter(answer => answer.method === method).at(-1)

test.describe('answering a prompt', () => {
  for (const { method, params, title, label, typed, sent } of [
    {
      method: 'secret',
      params: { env_var: 'OPENAI_API_KEY', prompt: 'Paste your **API key** [here](https://evil.test)' },
      title: 'Researcher asks for a secret',
      label: 'Value',
      typed: SECRET,
      sent: SECRET
    },
    {
      method: 'sudo',
      params: { command: 'apt install jq' },
      title: 'Researcher asks for an administrator password',
      label: 'Password',
      typed: SECRET,
      sent: SECRET
    },
    {
      method: 'vault.unlock_prompt',
      params: { backend: 'bitwarden', display_name: 'Bitwarden' },
      title: 'Researcher asks to unlock a password manager',
      label: 'Master password',
      typed: SECRET,
      sent: SECRET
    },
    {
      method: 'vault.code',
      params: { site: 'github.com', hint: 'From your authenticator' },
      title: 'Researcher asks for a one-time code',
      label: 'Code',
      typed: '123 456',
      sent: '123456'
    }
  ]) {
    test(`${method}: its sheet, masked fields, and {value} at the gateway`, async ({ app, gateway, page }) => {
      await app.open()
      await app.ready()

      await gateway.raise(method, params)

      await expect(app.dialog).toHaveAccessibleName(title)
      await expect(app.dialog).toContainText(/On gateway \S+/u)
      // Focus is on the dialog, never on the field: keystrokes meant for something else do not land in it.
      await expect(app.dialog).toBeFocused()

      const input = app.dialog.getByLabel(label, { exact: true })

      await expect(input).toHaveAttribute('type', 'password')
      await expect(input).toHaveAttribute('autocomplete', method === 'vault.code' ? 'one-time-code' : 'off')
      expect(await input.evaluate(element => element.hasAttribute('name') || element.closest('form') !== null)).toBe(
        false
      )
      // The bot's words are text, never a link.
      await expect(app.dialog.getByRole('link')).toHaveCount(0)

      await input.fill(typed)
      await app.dialog.getByRole('button', { name: 'Send' }).click()

      await expect(app.dialog).toHaveCount(0)
      await expect.poll(async () => (await lastAnswer(gateway, method))?.result).toEqual({ value: sent })
      expect(await everythingKept(page)).not.toContain('ZQ7xK')
    })
  }

  test('vault.save_login: the JSON string {identifier, password}', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    await gateway.raise('vault.save_login', { origin: 'https://github.com', site: 'GitHub' })
    await expect(app.dialog).toHaveAccessibleName('Researcher asks to save a login')

    await app.dialog.getByLabel('Username').fill('alex-ZQ7xK')
    await app.dialog.getByLabel('Password').fill(SECRET)
    await app.dialog.getByRole('button', { name: 'Save' }).click()

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await lastAnswer(gateway, 'vault.save_login'))?.result).toBeTruthy()

    const value = (await lastAnswer(gateway, 'vault.save_login'))?.result?.value

    expect(typeof value).toBe('string')
    expect(JSON.parse(value as string)).toEqual({ identifier: 'alex-ZQ7xK', password: SECRET })
    expect(await everythingKept(page)).not.toContain('ZQ7xK')
  })

  test('Skip answers the empty string, from the keyboard', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    await gateway.raise('sudo', { command: 'ls' })
    await expect(app.dialog).toBeVisible()
    // Escape does not close it.
    await page.keyboard.press('Escape')
    await expect(app.dialog).toBeVisible()

    // The buttons wake a moment after the sheet appears (the tap guard).
    const skip = app.dialog.getByRole('button', { name: 'Skip' })

    await expect(skip).toBeEnabled()
    await skip.focus()
    await page.keyboard.press('Enter')

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await lastAnswer(gateway, 'sudo'))?.result).toEqual({ value: '' })
  })
})

test.describe('ending without an answer', () => {
  test('withdrawn: the sheet closes with what was typed, and the chat says why', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    await gateway.raise('secret', { env_var: 'X', prompt: 'A key please' })
    await app.dialog.getByLabel('Value').fill(SECRET)

    expect(await gateway.withdraw('interrupted')).toBe(1)

    await expect(app.dialog).toHaveCount(0)
    await expect(chatNotice(page)).toContainText('Researcher no longer asks for this. Nothing was sent.')
    expect(await gateway.answers()).toEqual([])
    expect(await everythingKept(page)).not.toContain('ZQ7xK')

    await page.getByRole('button', { name: 'Close' }).click()
    await expect(chatNotice(page)).toHaveCount(0)
  })

  test("expired: the gateway's two minutes pass, the sheet closes and the chat says so", async ({
    app,
    gateway,
    page
  }) => {
    await page.clock.install()
    await app.open()
    await app.ready()

    await gateway.raise('sudo', { command: 'ls' })
    await expect(app.dialog).toContainText('Expires in 2:00')

    await page.clock.runFor(60_000)
    await expect(app.dialog).toContainText('Expires in 1:00')

    await page.clock.runFor(60_000)

    await expect(app.dialog).toHaveCount(0)
    await expect(chatNotice(page)).toContainText('The request from Researcher expired. Nothing was sent.')
    expect((await gateway.answers()).filter(answer => answer.method === 'sudo')).toEqual([])
  })
})

test.describe('a withdrawal the page did not hear', () => {
  test('a prompt the gateway withdrew while the socket was down closes after the reconnect, and says so', async ({
    app,
    diagnostics,
    gateway,
    page
  }) => {
    // The socket is cut on purpose; WebKit says so in the console.
    diagnostics.allow(/network connection was lost|WebSocket connection to .* failed/u)

    await app.open()
    await app.ready()

    await gateway.raise('sudo', { command: 'ls' })
    await expect(app.dialog).toBeVisible()
    await app.dialog.getByLabel('Password').fill(SECRET)

    // The page goes offline and its socket with it; the gateway gives up on the request meanwhile.
    await page.context().setOffline(true)
    await gateway.dropSockets()
    await expect.poll(async () => (await gateway.state()).openSockets).toBe(0)
    expect(await gateway.withdraw('timeout')).toBe(1)
    await page.context().setOffline(false)

    // Back on the gateway: the sheet closes, its field emptied, and the chat says why.
    await expect(app.dialog).toHaveCount(0, { timeout: 30_000 })
    await expect(chatNotice(page)).toContainText(
      'The request from Researcher ended while the connection was down. Nothing was sent.'
    )
    // Nothing is left to send to: no sheet, no field.
    await expect(page.locator('input[data-secure-field]')).toHaveCount(0)
    expect((await gateway.answers()).filter(answer => answer.method === 'sudo')).toEqual([])
    expect(await everythingKept(page)).not.toContain('ZQ7xK')
  })
})

test.describe('signing out', () => {
  test('with a prompt open answers it with the empty string before the socket goes', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    await gateway.raise('secret', { env_var: 'X', prompt: 'A key please' })
    await expect(app.dialog).toBeVisible()
    await app.dialog.getByLabel('Value').fill(SECRET)

    // A reader cannot reach Sign out behind the sheet (the page is inert); the click stands in for any
    // sign-out while a prompt is open, which must tell the bot "skipped" rather than leave it waiting.
    await page.getByRole('button', { name: 'Sign out' }).dispatchEvent('click')

    await expect.poll(async () => (await lastAnswer(gateway, 'secret'))?.result).toEqual({ value: '' })
  })
})

test.describe('restored', () => {
  test('one still open when the page is reloaded comes back and can be answered', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    await gateway.raise('vault.code', { site: 'github.com' })
    await expect(app.dialog).toBeVisible()

    await page.reload()

    await expect(app.dialog).toHaveAccessibleName('Researcher asks for a one-time code')
    await app.dialog.getByLabel('Code').fill('654321')
    await app.dialog.getByRole('button', { name: 'Send' }).click()

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await lastAnswer(gateway, 'vault.code'))?.result).toEqual({ value: '654321' })

    // Answered once: it is not asked again.
    await page.reload()
    await expect(app.field).toBeVisible()
    await expect(app.dialog).toHaveCount(0)
  })
})

test.describe('what only the desktop app can answer', () => {
  for (const method of ['terminal.read', 'preview.act', 'window.read', 'tour']) {
    test(`${method}: declined at once, one notice in the chat, no dialog`, async ({ app, gateway, page }) => {
      await app.open()
      await app.ready()

      await gateway.raise(method, {})

      await expect(chatNotice(page)).toContainText(
        `Researcher sent a request that needs the Hermes desktop app (${method}). It was declined here.`
      )
      await expect(app.dialog).toHaveCount(0)
      await expect
        .poll(async () => (await lastAnswer(gateway, method))?.error)
        .toEqual({ code: -32601, message: `not supported by this client: ${method}` })
    })
  }
})

test.describe('on a phone', () => {
  test('a long command and a long address wrap inside the sheet, which does not scroll the page sideways', async ({
    app,
    gateway,
    page
  }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await app.open()
    await app.ready()

    const sideways = (): Promise<boolean> =>
      page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

    for (const [method, params] of [
      ['sudo', { command: `docker run --rm -v /srv/${'very-long-path-segment/'.repeat(12)}:/data image` }],
      ['vault.save_login', { origin: `https://${'sub.'.repeat(20)}example.test/login`, site: 'Example' }]
    ] as const) {
      await gateway.raise(method, params)
      await expect(app.dialog).toBeVisible()
      expect(await sideways()).toBe(false)

      const box = await app.dialog.boundingBox()

      expect(box?.x).toBeGreaterThanOrEqual(0)
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320)

      const skip = app.dialog.getByRole('button', { name: 'Skip' })

      await expect(skip).toBeEnabled()
      await skip.click()
      await expect(app.dialog).toHaveCount(0)
    }
  })
})
