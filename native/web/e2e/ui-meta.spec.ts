/**
 * The person's `ui_meta`, in a browser, on the page the gateway serves.
 *
 * `core/ui-meta-bridge.integration.test.ts` proves the rules against the fake
 * with two pages in Node; this is the built client doing its share of it in a
 * real engine: on a gateway that holds no section for this person yet, the page
 * reads the roster's `ui_meta`, seeds the section with what it holds and then
 * folds the live roster into it (a second write), and a reload, which finds the section there and nothing
 * changed, writes nothing: no echo of what came in, and no fold dated or sent
 * again.
 */
import { expect, test } from './fixtures'

const count = (log: unknown[], method: string): number => log.filter(entry => entry === method).length

test('seeds the person’s section, folds the roster in, and writes nothing on a reload that changed nothing', async ({
  app,
  gateway,
  page
}) => {
  await app.open()
  await expect(page.getByRole('link', { name: /Researcher/u })).toBeVisible()

  // The seed (the section this page holds, before anything is folded into it),
  // then the live roster folded in behind it, which is a write of its own one
  // debounce later. Then quiet.
  await expect
    .poll(async () => count((await gateway.state()).methodLog, 'profiles.configure'), { timeout: 10_000 })
    .toBe(2)
  await page.waitForTimeout(1_500)

  const writes = count((await gateway.state()).methodLog, 'profiles.configure')

  expect(writes).toBe(2)

  const lists = count((await gateway.state()).methodLog, 'profiles.list')

  await page.reload()
  await expect(page.getByRole('link', { name: /Researcher/u })).toBeVisible()
  // The roster's read and the reconcile's, at least, after the reload.
  await expect
    .poll(async () => count((await gateway.state()).methodLog, 'profiles.list'), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(lists + 2)
  await page.waitForTimeout(1_000)

  expect(count((await gateway.state()).methodLog, 'profiles.configure')).toBe(writes)
})
