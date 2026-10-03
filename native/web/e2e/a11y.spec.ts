/**
 * Accessibility, with axe in a real browser, in both colour schemes.
 *
 * jsdom has no layout, so the unit suites' axe runs cannot judge colour contrast
 * or what is really visible; this suite does, on the built client, with the page's
 * own colours and fonts. Every screen and every sheet is checked in the light and
 * the dark scheme, and none may have a serious or critical violation (the lesser
 * ones are attached to the report and do not fail the run).
 *
 * The screens: the chat list; a chat (with a tool line opened, so its detail is
 * on the page, and a draft in the composer); the signed-out screen; and each
 * sheet of the request layer: an approval, a single question, and a batch of
 * questions on its first step and on its last.
 *
 * The keyboard walkthroughs (tab order, the dialog's trap and the focus's return)
 * are in `requests.spec.ts` and `chat.spec.ts`; axe cannot judge those.
 */
import { BOT, expect, seriousViolations, test } from './fixtures'

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`in the ${scheme} scheme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
    })

    test('the chat list has no serious accessibility violation', async ({ app, page }) => {
      await app.open('#/')
      await expect(page.getByRole('link', { name: /^Researcher/u })).toBeVisible()
      await expect(page.getByRole('link', { name: /^Writer/u })).toBeVisible()

      expect(await seriousViolations(page, `list-${scheme}`)).toEqual([])
    })

    test('a chat has no serious accessibility violation, with a tool line open and a draft in the composer', async ({
      app,
      page
    }) => {
      await app.open()
      await expect(app.transcript).toContainText('Retry semantics')
      await app.ready()

      await app.transcript.getByRole('button', { name: /^read_file/u }).click()
      await app.field.fill('a draft')

      expect(await seriousViolations(page, `chat-${scheme}`)).toEqual([])
    })

    test('the signed-out screen has no serious accessibility violation', async ({
      app,
      gateway,
      page,
      diagnostics
    }) => {
      await app.signIn()
      await page.route('**/api/auth/me', async route => {
        await gateway.expireSessions()
        await route.continue()
      })
      diagnostics.allow(/status of 40[13]/u)
      await page.goto(gateway.appUrl(`#/chat/${BOT}`))
      await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible()

      expect(await seriousViolations(page, `signed-out-${scheme}`)).toEqual([])
    })

    test('every request sheet has no serious accessibility violation', async ({ app, gateway, page }) => {
      await app.open()
      await app.ready()

      // An approval.
      await gateway.raise('approval', {
        command: 'find . -name "*.log" -mtime +30 -delete',
        description: 'Delete old logs',
        tool_name: 'run_command',
        request_id: `appr-axe-${scheme}`
      })
      await expect(app.dialog).toBeVisible()
      await expect(page.getByRole('button', { name: 'Allow once' })).toBeEnabled()
      expect(await seriousViolations(page, `approval-${scheme}`)).toEqual([])
      await app.dialog.getByRole('button', { name: 'Deny' }).click()
      await expect(app.dialog).toHaveCount(0)

      // A single question.
      await gateway.raise('clarify', {
        question: 'Which colour?',
        choices: ['Red', 'Blue', 'Green'],
        request_id: `q-axe-one-${scheme}`
      })
      await expect(app.dialog).toBeVisible()
      expect(await seriousViolations(page, `clarify-${scheme}`)).toEqual([])
      await page.getByRole('button', { name: 'Skip' }).click()
      await expect(app.dialog).toHaveCount(0)

      // A batch: its first step and its last.
      await gateway.raise('clarify', {
        request_id: `q-axe-${scheme}`,
        questions: [
          { qid: 'one', question: 'Pick some', choices: ['x', 'y'], multi_select: true },
          { qid: 'two', question: 'Why?' }
        ]
      })
      await expect(app.dialog).toBeVisible()
      expect(await seriousViolations(page, `batch-first-${scheme}`)).toEqual([])
      await page.getByRole('checkbox', { name: 'x' }).check()
      await page.getByRole('button', { name: 'Next' }).click()
      await expect(app.dialog).toContainText('Question 2 of 2')
      expect(await seriousViolations(page, `batch-last-${scheme}`)).toEqual([])
      await page.getByRole('button', { name: 'Skip' }).click()
      await expect(app.dialog).toHaveCount(0)
    })
  })
}
