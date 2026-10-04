/**
 * Settings › Connectors in a real browser against the fake gateway serving the built client: the apps a bot can
 * reach on the person's behalf, listed and connected as the account (an owner, never a chat).
 *
 *  - **The list** names each connector with its state, the vendor's status word and its reason; a bot whose
 *    connections are switched off is told so, which is not an empty account.
 *  - **Connecting** shows the vendor's address as a link to open in another tab and follows the operation until the
 *    connector settles: connected (and the list says so), or failed in the vendor's words.
 *  - **Reconnect** is how another account is chosen; there is no Disconnect, and the page says whose decision that is.
 *  - **The page is fetched on demand**, in the chunk the management pages share, and has no serious accessibility violation in either scheme.
 */
import { expect, type Page, seriousViolations, test } from './fixtures'

async function open(app: { open(hash?: string): Promise<void> }, page: Page): Promise<void> {
  await app.open('#/settings/connectors')
  await expect(page.getByRole('heading', { level: 2, name: 'Connectors' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Bot' }).selectOption({ label: 'Researcher' })
  await expect(page.getByRole('list', { name: 'Connectors' })).toBeVisible()
}

const connector = (page: Page, slug: string) => page.locator(`li[data-connector="${slug}"]`)

test.describe('Settings › Connectors', () => {
  test('lists the connectors with their state, the vendor’s status word and reason, and has no Disconnect', async ({
    app,
    page
  }) => {
    await open(app, page)

    await expect(page.locator('li[data-connector]')).toHaveCount(3)
    await expect(connector(page, 'gmail')).toContainText('Connected')
    await expect(connector(page, 'gmail')).toContainText('Status: active')
    await expect(connector(page, 'notion')).toContainText('Not connected')
    await expect(connector(page, 'slack')).toContainText('Switched off')
    await expect(connector(page, 'slack')).toContainText('Reason: the workspace revoked the token')

    await expect(page.getByRole('button', { name: /Disconnect/u })).toHaveCount(0)
    await expect(page.getByText(/Signing out of a connector is done where you manage the account/u)).toBeVisible()
  })

  test('connects through a link opened in another tab, follows the operation and says it is connected', async ({
    app,
    page
  }) => {
    await open(app, page)

    const notion = connector(page, 'notion')

    await notion.getByRole('button', { name: 'Connect notion' }).click()

    const link = notion.getByRole('link', { name: 'Open the sign-in page' })

    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', /^https:\/\/vendor\.test\/authorize\/notion/u)
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/u)

    await expect(page.getByRole('status').filter({ hasText: 'notion is connected.' })).toBeVisible({ timeout: 15_000 })
    await expect(link).toHaveCount(0)
    await expect(notion).toContainText('Connected')
    await expect(notion.getByRole('button', { name: 'Reconnect notion' })).toBeVisible()
  })

  test('says why a connector failed, in the vendor’s words, and stays not connected', async ({ app, page }) => {
    await open(app, page)

    await connector(page, 'slack').getByRole('button', { name: 'Connect slack' }).click()

    await expect(
      page.getByRole('status').filter({ hasText: 'Could not connect: the workspace refused the grant' })
    ).toBeVisible({
      timeout: 15_000
    })
    await expect(connector(page, 'slack')).not.toContainText(/^Connected$/u)
  })

  test('offers Reconnect for a connected one, which asks the gateway to start over for another account', async ({
    app,
    page
  }) => {
    await open(app, page)

    await connector(page, 'gmail').getByRole('button', { name: 'Reconnect gmail' }).click()
    await expect(connector(page, 'gmail').getByRole('link', { name: 'Open the sign-in page' })).toBeVisible()
  })

  test('says "switched off" for a bot whose connections are off, which is not an empty account', async ({
    app,
    gateway,
    page
  }) => {
    gateway.fake.state.connectorsUnavailable = true
    await app.open('#/settings/connectors')
    await page.getByRole('combobox', { name: 'Bot' }).selectOption({ label: 'Researcher' })

    await expect(page.getByText('Connectors are switched off for this bot.')).toBeVisible()
    await expect(page.getByRole('list', { name: 'Connectors' })).toHaveCount(0)
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
    await page.getByRole('link', { name: 'Connectors' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Connectors' })).toBeVisible()
    expect(fetched.length).toBeGreaterThan(0)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious accessibility violation in the ${scheme} scheme, with a sign-in under way`, async ({
      app,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await open(app, page)

      expect(await seriousViolations(page, `connectors-${scheme}`)).toEqual([])

      await connector(page, 'notion').getByRole('button', { name: 'Connect notion' }).click()
      await expect(connector(page, 'notion').getByRole('link', { name: 'Open the sign-in page' })).toBeVisible()

      expect(await seriousViolations(page, `connectors-flow-${scheme}`)).toEqual([])
    })
  }
})
