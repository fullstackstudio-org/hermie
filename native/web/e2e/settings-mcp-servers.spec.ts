/**
 * Settings › MCP servers in a real browser against the fake gateway serving the built client: the servers a bot
 * reaches its tools through (not Settings › MCP, which is the gateway's own endpoint for agents).
 *
 *  - **The list** is the config with the gateway's cached state beside it; nothing is tested until it is asked.
 *  - **A test** connects and lists the tools of a server that answers, and gives the reason of one that does not.
 *  - **Authorising** shows the sign-in address as a link to open in another tab and follows the flow until the
 *    gateway says it is done; the server then passes its test.
 *  - **Removing** asks first and is read back from the gateway; **adding** takes a catalogue preset or a server of
 *    the reader's own, and says why a name was refused.
 *  - **Reloading** asks first with the gateway's own warning.
 *  - **The page is a chunk of its own**, and has no serious accessibility violation in either scheme.
 */
import { expect, type Page, seriousViolations, test } from './fixtures'

async function open(app: { open(hash?: string): Promise<void> }, page: Page): Promise<void> {
  await app.open('#/settings/mcp-servers')
  await expect(page.getByRole('heading', { level: 2, name: 'MCP servers' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Bot' }).selectOption({ label: 'Researcher' })
  await expect(page.getByRole('list', { name: 'MCP servers' })).toBeVisible()
}

const server = (page: Page, name: string) =>
  page.locator('li[data-server]').filter({ has: page.getByText(name, { exact: true }) })

test.describe('Settings › MCP servers', () => {
  test('lists the configured servers with their state, and tests nothing until it is asked', async ({
    app,
    gateway,
    page
  }) => {
    await open(app, page)

    await expect(page.locator('li[data-server]')).toHaveCount(3)
    await expect(server(page, 'files')).toContainText('Connected')
    await expect(server(page, 'files')).toContainText('npx -y @modelcontextprotocol/server-filesystem /tmp')
    await expect(server(page, 'weather')).toContainText('Not connected')
    await expect(server(page, 'weather')).toContainText('Needs: WEATHER_API_KEY')
    await expect(server(page, 'calendar')).toContainText('Authentication: oauth')

    const methods = ((await gateway.state()).methodLog as { method?: string }[]).map(entry => entry.method)

    expect(methods).not.toContain('mcp.servers.test')
  })

  test('connects when asked: the tools of a server that answers, the reason of one that does not', async ({
    app,
    page
  }) => {
    await open(app, page)

    await server(page, 'files').getByRole('button', { name: 'Test the connection to files' }).click()
    await expect(server(page, 'files')).toContainText('Connected. 2 tools available.')
    await expect(server(page, 'files').getByRole('list', { name: 'Tools of files' })).toContainText('read_file')

    await server(page, 'weather').getByRole('button', { name: 'Test the connection to weather' }).click()
    await expect(server(page, 'weather')).toContainText('Could not connect: spawn weather-mcp ENOENT')
  })

  test('authorises a server through a link opened in another tab, and the server then passes its test', async ({
    app,
    page
  }) => {
    await open(app, page)

    const calendar = server(page, 'calendar')

    await calendar.getByRole('button', { name: 'Test the connection to calendar' }).click()
    await expect(calendar).toContainText('Could not connect')
    await expect(calendar).toContainText('Needs authorising')

    await calendar.getByRole('button', { name: 'Authorise calendar' }).click()

    const link = calendar.getByRole('link', { name: 'Open the sign-in page' })

    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', /^https:\/\/calendar\.example\.test\/authorize\?/u)
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/u)

    // The gateway's flow settles on its own after a poll; the page says so and the link goes.
    await expect(calendar).toContainText('Authorised.', { timeout: 15_000 })
    await expect(link).toHaveCount(0)
    await expect(calendar).not.toContainText('Needs authorising')

    await calendar.getByRole('button', { name: 'Test the connection to calendar' }).click()
    await expect(calendar).toContainText('Connected. 1 tool available.')
  })

  test('cancels an authorisation, and says so', async ({ app, page }) => {
    await open(app, page)

    const calendar = server(page, 'calendar')

    await calendar.getByRole('button', { name: 'Authorise calendar' }).click()
    await expect(calendar.getByRole('link', { name: 'Open the sign-in page' })).toBeVisible()
    await calendar.getByRole('button', { name: 'Cancel' }).click()

    await expect(calendar).toContainText('The authorisation was cancelled.')
    await expect(calendar.getByRole('link')).toHaveCount(0)
  })

  test('asks before it removes a server, and the gateway no longer has it afterwards', async ({ app, page }) => {
    await open(app, page)

    const weather = server(page, 'weather')

    await weather.getByRole('button', { name: 'Remove weather' }).click()
    await expect(weather.getByRole('group', { name: 'Remove weather' })).toContainText('Remove weather?')
    await expect(weather.getByRole('button', { name: 'Keep it' })).toBeFocused()
    await weather.getByRole('button', { name: 'Keep it' }).click()
    await expect(page.locator('li[data-server]')).toHaveCount(3)
    await expect(weather.getByRole('button', { name: 'Remove weather' })).toBeFocused()

    await weather.getByRole('button', { name: 'Remove weather' }).click()
    await weather.getByRole('group', { name: 'Remove weather' }).getByRole('button', { name: 'Remove weather' }).click()

    await expect(page.locator('li[data-server]')).toHaveCount(2)
    await expect(page.getByRole('status').filter({ hasText: 'weather was removed.' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: 'MCP servers' })).toBeFocused()

    // Read again from the gateway.
    await app.open('#/settings/mcp-servers')
    await page.getByRole('combobox', { name: 'Bot' }).selectOption({ label: 'Researcher' })
    await expect(page.locator('li[data-server]')).toHaveCount(2)
    await expect(page.getByText('weather', { exact: true })).toHaveCount(0)
  })

  test('adds a server of its own, a preset of the catalogue, and says why a name was refused', async ({
    app,
    page
  }) => {
    await open(app, page)
    await page.getByText('Add a server', { exact: true }).click()

    await page.getByLabel('Name', { exact: true }).fill('notes')
    await page.getByLabel('Command (for a server that is started here)').fill('npx')
    await page.getByLabel('Arguments, separated by spaces').fill('-y server-notes')
    await page.getByRole('button', { name: 'Add the server' }).click()

    await expect(page.getByRole('status').filter({ hasText: 'notes was added.' })).toBeVisible()
    await expect(server(page, 'notes')).toContainText('npx -y server-notes')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('')

    await page.getByLabel('Start from').selectOption('github')
    await expect(page.getByText('Needs GITHUB_TOKEN in the bot’s environment.')).toBeVisible()
    await page.getByRole('button', { name: 'Add the server' }).click()
    await expect(server(page, 'github')).toContainText('https://github.example.test/mcp')

    // A name that is taken is refused by the gateway, in its words, and what was typed stays.
    await page.getByLabel('Name', { exact: true }).fill('notes')
    await page.getByLabel('Command (for a server that is started here)').fill('npx')
    await page.getByRole('button', { name: 'Add the server' }).click()
    await expect(page.getByRole('alert')).toContainText("server 'notes' is already configured")
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('notes')
  })

  test('asks before it reloads the servers into running chats, with the gateway’s own warning', async ({
    app,
    page
  }) => {
    await open(app, page)

    await page.getByRole('button', { name: 'Reload servers' }).click()

    const group = page.getByRole('group', { name: 'Reload servers' })

    await expect(group).toContainText('prompt cache')
    await expect(group.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await group.getByRole('button', { name: 'Reload anyway' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'The servers were reloaded.' })).toBeVisible()
  })

  test('is a chunk of its own, fetched when the page is opened and not before', async ({ app, page }) => {
    const fetched: string[] = []

    page.on('request', request => {
      if (/\/assets\/McpServers-[\w-]+\.(?:js|css)$/u.test(new URL(request.url()).pathname)) {
        fetched.push(new URL(request.url()).pathname)
      }
    })

    await app.open('#/chat/researcher')
    await app.ready()
    expect(fetched).toEqual([])

    await page.evaluate(() => {
      location.hash = '#/settings'
    })
    await page.getByRole('link', { name: 'MCP servers' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'MCP servers' })).toBeVisible()
    expect(fetched.length).toBeGreaterThan(0)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious accessibility violation in the ${scheme} scheme, with a probe, a question and the form open`, async ({
      app,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await open(app, page)
      await server(page, 'files').getByRole('button', { name: 'Test the connection to files' }).click()
      await expect(server(page, 'files')).toContainText('Connected. 2 tools available.')

      expect(await seriousViolations(page, `mcp-servers-${scheme}`)).toEqual([])

      await server(page, 'weather').getByRole('button', { name: 'Remove weather' }).click()
      await page.getByText('Add a server', { exact: true }).click()
      await expect(page.getByLabel('Start from')).toBeVisible()

      expect(await seriousViolations(page, `mcp-servers-open-${scheme}`)).toEqual([])
    })
  }
})
