/**
 * The Agents bar in a real browser, against the fake gateway serving the built client.
 *
 * A prompt that says "delegate" makes the fake fan out three subagents (staggered, the third failing), slowed here
 * so the bar, the panel, Steer and Stop have a window to be used in.
 *
 *  - **The bar** appears over the composer while agents run, with the count and a clock, and goes when they are done.
 *  - **The panel** lists the children (goal, status, tool, what they wrote); Steer sends a correction the gateway
 *    takes, Stop ends a child (the gateway's registry loses it and the row says Stopped).
 *  - **The transcript** of a running child is its live tail; after it has finished, its own stored transcript.
 *  - **Keyboard**: Escape goes back one level and the focus returns to the control that opened what was closed.
 *  - **Accessibility** with axe, with the panel and with a transcript open.
 */
import type { Page } from '@playwright/test'

import { expect, seriousViolations, test } from './fixtures'

// Slow enough that a child is running for several seconds.
test.use({ gatewayOptions: { subagentStepMs: 2_500 } })

const bar = (page: Page) => page.getByRole('region', { name: 'Agents' })
const head = (page: Page) => bar(page).locator('.hm-agentsbar__head')
const rowFor = (page: Page, goal: string) =>
  bar(page)
    .locator('li.hm-agentsbar__row')
    .filter({ has: page.locator('.hm-agentsbar__goal', { hasText: goal }) })

/** Ask for the fan-out and wait for the bar to say agents are working. */
async function delegate(app: { send(text: string): Promise<void>; ready(): Promise<void> }, page: Page): Promise<void> {
  await app.ready()
  await app.send('please delegate this')
  await expect(head(page)).toContainText(/agents? working/u, { timeout: 30_000 })
}

test.describe('the bar', () => {
  test('appears over the composer with a count and a clock, opens a panel of the children and goes when they are done', async ({
    app,
    page
  }) => {
    await app.open()
    await delegate(app, page)

    // Over the field: the bar comes before the composer in the page.
    const above = await page.evaluate(() => {
      const strip = document.querySelector('.hm-agentsbar')
      const field = document.querySelector('textarea')

      return Boolean(strip && field && strip.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING)
    })

    expect(above).toBe(true)
    await expect(head(page).locator('.hm-agentsbar__clock')).toHaveText(/^\d+:\d\d$/u)
    await expect(head(page)).toHaveAttribute('aria-expanded', 'false')

    await head(page).click()
    await expect(head(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(rowFor(page, 'Audit the dependencies')).toBeVisible()
    await expect(rowFor(page, 'Audit the dependencies').locator('.hm-agentsbar__status')).toHaveText(/Running|Queued/u)

    // Everything finishes; the panel is open, so the bar stays and says nothing runs.
    await expect(head(page)).toContainText('No agents running', { timeout: 60_000 })
    await expect(rowFor(page, 'Audit the dependencies')).toContainText('Two packages behind')
    await expect(rowFor(page, 'Check the licence headers').locator('.hm-agentsbar__status')).toHaveText('Failed')

    await head(page).click()
    await expect(bar(page)).toHaveCount(0)
  })
})

test.describe('the panel', () => {
  test('steers a running child: the correction reaches the gateway and the focus comes back to Steer', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await delegate(app, page)
    await head(page).click()

    const row = rowFor(page, 'Audit the dependencies')

    await expect(row.getByRole('button', { name: /^Steer/u })).toBeVisible()
    await row.getByRole('button', { name: /^Steer/u }).click()

    const field = row.getByRole('textbox', { name: /Send a correction/u })

    await expect(field).toBeFocused()
    await field.fill('Use the lockfile only')
    await field.press('Enter')

    await expect(bar(page).getByText('Steer queued')).toBeVisible()
    await expect(row.getByRole('button', { name: /^Steer/u })).toBeFocused()
    expect(gateway.fake.state.methodLog).toContain('subagent.steer')
  })

  test('stops a running child: the gateway loses it and its row says it was stopped', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await delegate(app, page)
    await head(page).click()

    const row = rowFor(page, 'Audit the dependencies')

    await row.getByRole('button', { name: /^Stop/u }).click()

    await expect(bar(page).getByText('Stopping…')).toBeVisible()
    await expect(row.locator('.hm-agentsbar__status')).toHaveText('Stopped')
    expect(gateway.fake.state.methodLog).toContain('subagent.interrupt')
    // The Stop button went with the child's running; the focus is on its row, not lost to the page.
    await expect(row).toBeFocused()
  })

  test('reads a running child’s live tail, and goes back with Escape to the button it came from', async ({
    app,
    page
  }) => {
    await app.open()
    await delegate(app, page)
    await head(page).click()

    const row = rowFor(page, 'Audit the dependencies')

    await row.getByRole('button', { name: /^Open transcript/u }).click()

    const heading = bar(page).getByRole('heading', { name: 'Transcript · Audit the dependencies' })

    await expect(heading).toBeFocused()
    await expect(bar(page).getByText('Live tail · refreshing every few seconds')).toBeVisible()
    await expect(bar(page).getByRole('region', { name: 'Transcript · Audit the dependencies' })).toContainText(
      '> Audit the dependencies'
    )

    await page.keyboard.press('Escape')
    await expect(heading).toHaveCount(0)
    await expect(row.getByRole('button', { name: /^Open transcript/u })).toBeFocused()

    // A second Escape closes the panel itself and gives the focus to the bar's button.
    await page.keyboard.press('Escape')
    await expect(head(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(head(page)).toBeFocused()
  })

  test('reads the stored transcript of a child that has finished', async ({ app, page }) => {
    await app.open()
    await delegate(app, page)
    await head(page).click()
    await expect(head(page)).toContainText('No agents running', { timeout: 60_000 })

    await rowFor(page, 'Summarize the changelog')
      .getByRole('button', { name: /^Open transcript/u })
      .click()

    await expect(bar(page).getByText('The child’s own transcript, read-only.')).toBeVisible()
    await expect(bar(page).getByRole('region', { name: 'Transcript · Summarize the changelog' })).toContainText(
      'Nine entries since the last tag'
    )
  })
})

test.describe('accessibility', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious or critical axe violation in the ${scheme} scheme, with the panel and a transcript open`, async ({
      app,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await app.open()
      await delegate(app, page)
      await head(page).click()
      await expect(rowFor(page, 'Audit the dependencies')).toBeVisible()
      expect(await seriousViolations(page, `agents-panel-${scheme}`)).toEqual([])

      await rowFor(page, 'Audit the dependencies')
        .getByRole('button', { name: /^Open transcript/u })
        .click()
      await expect(bar(page).getByRole('region', { name: /^Transcript/u })).toContainText('Audit the dependencies')
      expect(await seriousViolations(page, `agents-transcript-${scheme}`)).toEqual([])
    })
  }
})
