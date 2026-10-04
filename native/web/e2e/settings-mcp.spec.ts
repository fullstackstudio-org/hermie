/**
 * Settings › MCP, and the `<name> via <client>` label of an agent's turn, in a real browser against the
 * fake gateway serving the built client (`--mcp`; `contract/gateway/mcp.md`).
 *
 *  - **The page** shows the gateway's endpoint, its add command and its JSON config as the
 *    gateway sent them, each with a Copy button that puts exactly that text on the clipboard, the
 *    instructions, and the connected clients with their name, when they were allowed, from where, and
 *    when they were last used.
 *  - **Revoke** asks first; Cancel changes nothing; confirming ends the grant at the gateway (read back
 *    from its control endpoint) and the row is gone.
 *  - **`mcp.changed`** reloads an open page: a client allowed elsewhere appears, and one revoked in
 *    another tab disappears, each with a line saying so.
 *  - **A gateway without MCP** (the routes unknown, or the feature off) gets one sentence and nothing else.
 *  - **The page is a chunk of its own**, fetched when it is opened and not before.
 *  - **Accessibility** with axe in the light and the dark scheme, with a confirmation open too.
 *  - **An agent's turn** is drawn as `You via <client>` (the reader's own) or `<name> via <client>` (a colleague's),
 *    never as the person alone.
 *
 * The client name `Claude Code` is test data here: it is what the fake registers a client as by default.
 */
import { BOT, expect, type Gateway, seriousViolations, test } from './fixtures'

interface Grant {
  id: string
  client_name: string
  created_ip: string | null
  last_used_at: number | null
  revoked_at: number | null
  revoked_by: string | null
}

/** Seed a client the person has allowed, as a consent would; the gateway announces it with `mcp.changed`. */
async function seed(gateway: Gateway, body: Record<string, unknown> = {}): Promise<{ id: string }> {
  const response = await fetch(`${gateway.url}/__fake/mcp/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  expect(response.ok, `seeding a grant answered ${response.status}`).toBe(true)

  return ((await response.json()) as { grant: { id: string } }).grant
}

/** Every grant the fake holds, revoked ones too. */
async function grantsOf(gateway: Gateway): Promise<Grant[]> {
  const body = (await (await fetch(`${gateway.url}/__fake/mcp/grants`)).json()) as { grants: Grant[] }

  return body.grants
}

test.describe('Settings › MCP', () => {
  test.use({ gatewayOptions: { mcp: true } })

  test('shows the endpoint, the command, the config, the instructions and the connected clients as the gateway said them', async ({
    app,
    gateway,
    page
  }) => {
    await seed(gateway, {
      client_name: 'Claude Code',
      created_ip: '203.0.113.5',
      last_used_at: 1_790_003_600,
      last_used_ip: '198.51.100.9'
    })
    await seed(gateway, { client_name: 'Second Agent', created_ip: null, created_at: 1_789_000_000 })
    await app.open('#/settings/mcp')

    await expect(page.getByRole('heading', { level: 2, name: 'MCP' })).toBeVisible()
    await expect(page.getByText('MCP is on for this gateway.')).toBeVisible()

    // What the gateway says, read the way the page reads it.
    const said = (await (await page.request.get(`${gateway.url}/api/auth/mcp`)).json()) as {
      endpoint_url: string
      claude_command: string
      config_json: string
      instructions: string
    }

    await expect(page.locator('[data-mcp="endpoint"]')).toHaveText(said.endpoint_url)
    await expect(page.locator('[data-mcp="command"]')).toHaveText(said.claude_command)
    await expect(page.locator('[data-mcp="config"]')).toHaveText(said.config_json)
    await expect(page.getByText(said.instructions.split('\n')[0] ?? '', { exact: false }).first()).toBeVisible()

    const clients = page.getByRole('list', { name: 'Connected clients' }).getByRole('listitem')

    await expect(clients).toHaveCount(2)

    // Newest first: the one allowed last is on top.
    const used = clients.filter({ hasText: 'Claude Code' })
    const unused = clients.filter({ hasText: 'Second Agent' })

    await expect(used).toContainText('from 203.0.113.5')
    await expect(used).toContainText(/Last used .* from 198\.51\.100\.9/u)
    await expect(unused).toContainText('Never used')
    await expect(unused).not.toContainText('from')
    await expect(used.getByRole('button', { name: 'Revoke Claude Code' })).toBeEnabled()
  })

  test('has a Copy button for the endpoint, the command and the config, and each puts exactly that text on the clipboard', async ({
    app,
    browserName,
    gateway,
    page
  }) => {
    if (browserName === 'chromium') {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    }

    await seed(gateway)
    await app.open('#/settings/mcp')
    await expect(page.getByText('MCP is on for this gateway.')).toBeVisible()

    const said = (await (await page.request.get(`${gateway.url}/api/auth/mcp`)).json()) as {
      endpoint_url: string
      claude_command: string
      config_json: string
    }

    for (const [name, text] of [
      ['Copy the endpoint address', said.endpoint_url],
      ['Copy the add command', said.claude_command],
      ['Copy the JSON config', said.config_json]
    ] as const) {
      const button = page.getByRole('button', { name })

      await expect(button).toBeVisible()
      await expect(button).toBeEnabled()
      await button.click()
      await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toBeVisible()

      // Only Chromium lets a test read the clipboard back.
      if (browserName === 'chromium') {
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text)
      }
    }
  })

  test('asks before it revokes, and the grant is ended at the gateway and the row is gone', async ({
    app,
    gateway,
    page
  }) => {
    const first = await seed(gateway, { client_name: 'Claude Code' })
    const second = await seed(gateway, { client_name: 'Second Agent' })

    await app.open('#/settings/mcp')

    const clients = page.getByRole('list', { name: 'Connected clients' }).getByRole('listitem')

    await expect(clients).toHaveCount(2)

    // Cancel: nothing happens, and the focus is back on the button that was pressed.
    await page.getByRole('button', { name: 'Revoke Claude Code' }).click()

    const group = page.getByRole('group', { name: 'Revoke Claude Code' })

    await expect(group).toContainText('stops working at once')
    await expect(group.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await group.getByRole('button', { name: 'Cancel' }).click()
    await expect(group).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Revoke Claude Code' })).toBeFocused()
    expect((await grantsOf(gateway)).every(grant => grant.revoked_at === null)).toBe(true)

    // Confirm: the grant is revoked as the person, and the row is gone.
    await page.getByRole('button', { name: 'Revoke Claude Code' }).click()
    await group.getByRole('button', { name: 'Revoke Claude Code' }).click()

    await expect(clients).toHaveCount(1)
    await expect(clients.first()).toContainText('Second Agent')
    await expect(page.getByRole('status').filter({ hasText: 'Claude Code was revoked.' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: 'Connected clients' })).toBeFocused()

    await expect
      .poll(async () => (await grantsOf(gateway)).find(grant => grant.id === first.id))
      .toMatchObject({ revoked_by: 'user' })
    expect((await grantsOf(gateway)).find(grant => grant.id === second.id)?.revoked_at).toBeNull()

    // The last one: the list says there is nobody.
    await page.getByRole('button', { name: 'Revoke Second Agent' }).click()
    await page.getByRole('group').getByRole('button', { name: 'Revoke Second Agent' }).click()
    await expect(page.getByText('No client is connected yet.')).toBeVisible()
  })

  test('reloads on mcp.changed: a client allowed elsewhere appears, one revoked in another tab disappears', async ({
    app,
    gateway,
    page
  }) => {
    await seed(gateway, { client_name: 'Claude Code', announce: false })
    await app.open('#/settings/mcp')

    const clients = page.getByRole('list', { name: 'Connected clients' }).getByRole('listitem')

    await expect(clients).toHaveCount(1)

    // Allowed somewhere else: the gateway says so, and the open page shows it without being asked.
    await seed(gateway, { client_name: 'Second Agent' })
    await expect(clients).toHaveCount(2)
    await expect(page.getByRole('status').filter({ hasText: 'Second Agent was allowed.' })).toBeVisible()

    // Revoked in another tab of the same person: this one follows.
    const other = await page.context().newPage()

    await other.goto(gateway.appUrl('#/settings/mcp'))
    await other.getByRole('button', { name: 'Revoke Second Agent' }).click()
    await other.getByRole('group').getByRole('button', { name: 'Revoke Second Agent' }).click()
    await expect(other.getByRole('list', { name: 'Connected clients' }).getByRole('listitem')).toHaveCount(1)

    await expect(clients).toHaveCount(1)
    await expect(clients.first()).toContainText('Claude Code')
    await expect(page.getByRole('status').filter({ hasText: 'Second Agent was revoked.' })).toBeVisible()
  })

  test('comes in a chunk fetched when the page is opened and not before', async ({ app, page }) => {
    const fetched: string[] = []

    page.on('request', request => {
      // The small Settings pages, MCP among them, are one chunk (`features/settings/settings-pages.ts`).
      if (/\/assets\/settings-pages-[\w-]+\.(?:js|css)$/u.test(new URL(request.url()).pathname)) {
        fetched.push(new URL(request.url()).pathname)
      }
    })

    await app.open('#/chat/researcher')
    await app.ready()
    expect(fetched).toEqual([])

    await page.evaluate(() => {
      location.hash = '#/settings'
    })
    await page.getByRole('link', { name: 'MCP', exact: true }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'MCP' })).toBeVisible()
    expect(fetched.length).toBeGreaterThan(0)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious accessibility violation in the ${scheme} scheme, with a confirmation open too`, async ({
      app,
      gateway,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await seed(gateway, { client_name: 'Claude Code', created_ip: '203.0.113.5', last_used_at: 1_790_003_600 })
      await seed(gateway, { client_name: 'Second Agent' })
      await app.open('#/settings/mcp')
      await expect(page.getByRole('list', { name: 'Connected clients' }).getByRole('listitem')).toHaveCount(2)

      expect(await seriousViolations(page, `mcp-${scheme}`)).toEqual([])

      await page.getByRole('button', { name: 'Revoke Claude Code' }).click()
      await expect(page.getByRole('group', { name: 'Revoke Claude Code' })).toBeVisible()

      expect(await seriousViolations(page, `mcp-confirm-${scheme}`)).toEqual([])
    })
  }
})

test.describe('Settings › MCP on a gateway without MCP', () => {
  test.describe('with the routes unknown', () => {
    test('says this gateway does not offer MCP, and shows nothing else', async ({ app, diagnostics, page }) => {
      // The browser itself logs the 404 of a route the gateway does not have; the page handles it.
      diagnostics.allow(/404/u)
      await app.open('#/settings/mcp')

      await expect(page.getByText('This gateway does not offer MCP.')).toBeVisible()
      await expect(page.getByRole('button', { name: /^Copy/u })).toHaveCount(0)
      await expect(page.getByRole('heading', { level: 3 })).toHaveCount(0)
      await expect(page.getByText('MCP is on for this gateway.')).toHaveCount(0)
    })
  })

  test.describe('with the feature off', () => {
    test.use({ gatewayOptions: { mcp: { enabled: false } } })

    test('says the same, and has no accessibility violation in either scheme', async ({ app, diagnostics, page }) => {
      diagnostics.allow(/404/u)
      await app.open('#/settings/mcp')

      await expect(page.getByText('This gateway does not offer MCP.')).toBeVisible()

      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        expect(await seriousViolations(page, `mcp-off-${scheme}`)).toEqual([])
      }
    })
  })
})

test.describe('an agent’s turn', () => {
  const OWN = 'self-hosted:sam-sub'
  const COLLEAGUE = 'authentik:dana'
  const via = { kind: 'mcp', client: 'Claude Code' }

  test.use({
    gatewayOptions: {
      mcp: true,
      perMessageAuthor: true,
      accounts: [{ username: 'tester', password: 'hunter2', userId: 'sam-sub', displayName: 'Sam' }]
    }
  })

  test('is drawn as `You via <client>` for the reader’s own and `<name> via <client>` for a colleague’s, never as the person alone', async ({
    app,
    diagnostics,
    gateway
  }) => {
    // The browser logs the 404 for a colleague the gateway holds no picture of; the page handles it.
    diagnostics.allow(/404/u)
    await gateway.inject({ user: 'A colleague, typing.', assistant: 'Noted.', author: { id: COLLEAGUE, name: 'Dana' } })
    await gateway.inject({
      user: 'A colleague, through an agent.',
      assistant: 'Noted too.',
      author: { id: COLLEAGUE, name: 'Dana', via }
    })
    await gateway.inject({
      user: 'Me, through an agent.',
      assistant: 'And noted.',
      author: { id: OWN, name: 'Sam', via }
    })
    await gateway.inject({ user: 'Me, typing.', assistant: 'Fine.', author: { id: OWN, name: 'Sam' } })
    await app.open(`#/chat/${BOT}`)

    const row = (text: string) => app.transcript.locator('.hm-msg', { hasText: text })

    await expect(row('A colleague, through an agent.').locator('.hm-msg__sender')).toHaveText('Dana via Claude Code')
    await expect(row('A colleague, through an agent.')).toHaveAttribute('data-side', 'other')
    await expect(row('Me, through an agent.').locator('.hm-msg__sender')).toHaveText('You via Claude Code')
    await expect(row('Me, through an agent.')).toHaveAttribute('data-side', 'own')

    // A turn typed by the person is not captioned for itself, and a colleague's is as before.
    await expect(row('Me, typing.').locator('.hm-msg__sender')).toHaveCount(0)
    await expect(row('A colleague, typing.').locator('.hm-msg__sender')).toHaveText('Dana')
  })
})
