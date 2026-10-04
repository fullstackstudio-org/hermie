/**
 * The sheet for a `review.diff` request, answered in a real browser against the fake gateway serving the built client.
 * The fake reads the agent's unified diff itself (a port of the gateway's parser: it numbers the hunks, pins them to the
 * start or the end of the file, refuses what cannot be shown as it is), holds every answer to the contract, and writes
 * the patch of exactly the hunks the person approved from ITS OWN copy: so what comes back in `approved_patch` is what
 * the page really decided, hunk by hunk.
 *
 *  - **Some approved, some rejected.** The person approves one hunk and rejects the other; Send waits until both are
 *    decided; the patch the gateway wrote holds only the approved hunk, and the transcript says "1 of 2 hunks approved".
 *  - **Approve all and reject all** are one press each; rejecting everything is `decision: rejected` with no patch.
 *  - **Where it lands.** A hunk that appends at the end of the file says "End of the file" and does not draw the header's
 *    line numbers; a new file says "Whole file"; a hunk at the top says "Start of the file"; a rename shows both paths.
 *  - **Every line as it is.** The marker is in a gutter apart from the text, a tab is a stop of 8 columns, markup is text.
 *  - **A row wider than the view** scrolls sideways inside its hunk, and the hunk says so (the contract's overflow
 *    indicator), with the box reachable by the keyboard.
 *  - **Axe**, contrast included, in both colour schemes.
 */
import type { Locator } from '@playwright/test'

import { BOT, expect, type Gateway, seriousViolations, test } from './fixtures'

interface View {
  id: string
  method: string
  open: boolean
  answer?: { decision?: string; hunks?: Record<string, string>; approved_patch?: string }
  refusals: string[]
  outcome?: string
}

const viewOf = async (gateway: Gateway, id: string): Promise<View> =>
  (await (await fetch(`${gateway.url}/__fake/request/${id}`)).json()) as View

/** Raise a request the way the agent does, as soon as the page has advertised it (409 until then). */
async function raise(gateway: Gateway, method: string, params: Record<string, unknown> = {}): Promise<string> {
  let id = ''

  await expect
    .poll(
      async () => {
        const response = await fetch(`${gateway.url}/__fake/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ profile: BOT, method, params })
        })

        if (response.ok) {
          id = ((await response.json()) as { id: string }).id
        }

        return response.status
      },
      { timeout: 20_000 }
    )
    .toBe(200)

  return id
}

/** Two hunks of `app/settings.py`, far apart, neither pinned. */
const SETTINGS_DIFF = [
  '--- a/app/settings.py',
  '+++ b/app/settings.py',
  '@@ -3,5 +3,5 @@ class Settings:',
  '     name = "booking"',
  '-    currency = "USD"',
  '+    currency = "EUR"',
  '     locale = "nl-NL"',
  '     debug = False',
  '     region = "eu"',
  '@@ -20,4 +20,5 @@ def retry():',
  '     attempts = 0',
  '-    limit = 3',
  '+    limit = 5',
  '+    backoff = 2',
  '     return attempts',
  '     # end of retry',
  ''
].join('\n')

const SETTINGS = {
  title: 'Changes to settings.py',
  summary: 'I changed the default currency and the retry limit. Approve or reject each hunk.',
  diff: SETTINGS_DIFF
}

const decide = async (dialog: Locator, hunk: number, choice: 'Approve' | 'Reject'): Promise<void> => {
  await dialog.getByRole('button', { name: `${choice} change ${hunk} of 2` }).click()
}

test.describe('changes to review', () => {
  test('approves one hunk and rejects the other: the gateway writes a patch of the approved one only', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'review.diff', SETTINGS)
    const dialog = app.dialog

    await expect(dialog).toHaveAccessibleName('Changes to review')
    await expect(dialog.locator('.hm-review__path')).toHaveText('app/settings.py')
    await expect(dialog.locator('[data-hunk]')).toHaveCount(2)
    // Every line is there with its marker in a gutter; nothing is decided for the person.
    await expect(dialog.locator('[data-hunk="h1"] .hm-review__row[data-type="removed"] .hm-review__text')).toHaveText(
      '    currency = "USD"'
    )
    await expect(dialog.locator('[data-hunk="h1"] .hm-review__row[data-type="added"] .hm-review__marker')).toHaveText(
      '+'
    )

    const send = dialog.locator('[data-send]')

    await expect(send).toBeDisabled()
    await expect(dialog).toContainText('Approve or reject every change before you send (2 left).')

    await decide(dialog, 1, 'Approve')
    await expect(send).toBeDisabled()
    await decide(dialog, 2, 'Reject')
    await expect(dialog.locator('[data-progress]')).toHaveText('1 approved, 1 rejected, 0 undecided')
    await expect(send).toBeEnabled()
    await expect(send).toHaveText('Apply 1 of 2 changes')
    await send.click()

    await expect(dialog).toHaveCount(0)

    await expect.poll(async () => (await viewOf(gateway, id)).answer?.decision).toBe('approved')

    const view = await viewOf(gateway, id)

    expect(view.answer?.decision).toBe('approved')
    expect(view.answer?.hunks).toEqual({ h1: 'approved', h2: 'rejected' })
    // The gateway's own copy of the approved hunk, and nothing of the rejected one.
    expect(view.answer?.approved_patch).toContain('+    currency = "EUR"')
    expect(view.answer?.approved_patch).not.toContain('backoff')
    expect(view.answer?.approved_patch).not.toContain('limit = 5')
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('1 of 2 hunks approved')
  })

  test('approves the other way round, and a bulk decision can be corrected one hunk at a time', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'review.diff', SETTINGS)
    const dialog = app.dialog

    await dialog.getByRole('button', { name: 'Approve all' }).click()
    await expect(dialog.locator('[data-progress]')).toHaveText('2 approved, 0 rejected, 0 undecided')
    await decide(dialog, 1, 'Reject')
    await dialog.locator('[data-send]').click()

    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await viewOf(gateway, id)).answer?.hunks).toEqual({ h1: 'rejected', h2: 'approved' })

    const answer = (await viewOf(gateway, id)).answer

    expect(answer?.decision).toBe('approved')
    expect(answer?.approved_patch).toContain('+    backoff = 2')
    expect(answer?.approved_patch).not.toContain('EUR')
  })

  test('rejects everything in two presses: the decision is rejected and there is no patch', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'review.diff', SETTINGS)
    const dialog = app.dialog

    await dialog.getByRole('button', { name: 'Reject all' }).click()
    await expect(dialog.locator('[data-send]')).toHaveText('Reject everything and send')
    await dialog.locator('[data-send]').click()

    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await viewOf(gateway, id)).answer?.decision).toBe('rejected')

    const answer = (await viewOf(gateway, id)).answer

    expect(answer?.hunks).toEqual({ h1: 'rejected', h2: 'rejected' })
    expect(answer?.approved_patch).toBeUndefined()
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('Rejected')
  })

  test('takes the keyboard: Tab reaches each hunk’s lines and buttons, Space decides', async ({
    app,
    browserName,
    gateway,
    page
  }) => {
    // Safari on macOS tabs to links and form fields only; Option+Tab is its key for every control.
    const next = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab'

    await app.open()
    await app.ready()

    const id = await raise(gateway, 'review.diff', SETTINGS)
    const dialog = app.dialog

    const approveFirst = dialog.getByRole('button', { name: 'Approve change 1 of 2' })

    // The tap guard keeps every button off for a moment after the sheet appears.
    await expect(approveFirst).toBeEnabled()
    await approveFirst.focus()
    await expect(approveFirst).toBeFocused()
    await page.keyboard.press('Space')
    await expect(approveFirst).toHaveAttribute('aria-pressed', 'true')
    // Next in the tab order: Reject of the same hunk, then the lines of the next one (a focusable scroll region).
    await page.keyboard.press(next)
    await expect(dialog.getByRole('button', { name: 'Reject change 1 of 2' })).toBeFocused()
    await page.keyboard.press(next)
    await expect(dialog.getByRole('region', { name: 'Lines of change 2' })).toBeFocused()
    await page.keyboard.press(next)
    await page.keyboard.press(next)
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('button', { name: 'Reject change 2 of 2' })).toHaveAttribute('aria-pressed', 'true')

    const send = dialog.locator('[data-send]')

    await send.focus()
    await page.keyboard.press('Enter')

    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await viewOf(gateway, id)).answer?.hunks).toEqual({ h1: 'approved', h2: 'rejected' })
  })

  test('says where each hunk lands: the start, the end (without the header’s numbers), the whole file', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const dialog = app.dialog

    // The end of the file: a hunk that appends after the last line. `git apply` puts it after the LAST line wherever
    // the header's number points, so the sheet does not show that number as the place.
    await raise(gateway, 'review.diff', {
      path: 'docs/notes.txt',
      title: 'Add a line to the notes',
      summary: 'I append one line at the end of the file.',
      diff: '@@ -2,1 +2,2 @@ notes\n Second line\n+Third line\n'
    })
    await expect(dialog.locator('[data-hunk="h1"] .hm-review__anchor')).toHaveText('End of the file')
    await expect(dialog.locator('[data-hunk="h1"] .hm-review__header')).toHaveText('notes')
    await expect(dialog.locator('[data-hunk="h1"]')).not.toContainText('@@')
    await expect(dialog.locator('[data-hunk="h1"]')).not.toContainText('-2,1')
    await dialog.getByRole('button', { name: 'Later' }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('says "Start of the file", "Whole file", and shows a rename with both paths', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    const dialog = app.dialog

    await raise(gateway, 'review.diff', {
      title: 'Rename and edit users.py',
      summary: 'I move users.py to accounts.py and change one line in it.',
      diff: [
        'diff --git a/app/users.py b/app/accounts.py',
        'similarity index 80%',
        'rename from app/users.py',
        'rename to app/accounts.py',
        '--- a/app/users.py',
        '+++ b/app/accounts.py',
        '@@ -1,4 +1,4 @@',
        ' import db',
        '-TABLE = "users"',
        '+TABLE = "accounts"',
        ' ',
        ' def load():',
        ''
      ].join('\n')
    })
    await expect(dialog.locator('.hm-review__path')).toHaveText('app/users.py → app/accounts.py')
    await expect(dialog.locator('[data-file-kind]')).toHaveText('Renamed file')
    await expect(dialog.locator('[data-hunk="h1"] .hm-review__anchor')).toHaveText('Start of the file')
    await dialog.getByRole('button', { name: 'Later' }).click()
    await expect(dialog).toHaveCount(0)

    await raise(gateway, 'review.diff', {
      path: 'docs/new.txt',
      title: 'New file',
      summary: 'I would add this file.',
      diff: 'new file mode 100644\n--- /dev/null\n+++ b/docs/new.txt\n@@ -0,0 +1,2 @@\n+First line\n+Second line\n'
    })
    await expect(dialog.locator('[data-file-kind]')).toHaveText('New file')
    await expect(dialog.locator('[data-hunk="h1"] .hm-review__anchor')).toHaveText('Whole file')
    await expect(page.getByRole('dialog').locator('.hm-review__row')).toHaveCount(2)
  })

  test('draws a tab as a stop of 8 columns and every line as text, never a link', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    await raise(gateway, 'review.diff', {
      path: 'cmd/main.go',
      title: 'Changes to main.go',
      summary: 'The file is indented with tabs.',
      diff: [
        '@@ -5,4 +5,5 @@ func main() {',
        ' func main() {',
        ' \tfor i := 0; i < 3; i++ {',
        '-\t\tfmt.Println(i)',
        '+\t\tfmt.Println(i)',
        '+\t\tfmt.Println("**x** https://evil.test <b>y</b>")',
        ' \t}',
        ''
      ].join('\n')
    })

    const text = app.dialog.locator('[data-hunk="h1"] .hm-review__text').nth(2)

    await expect(text).toHaveText('\t\tfmt.Println(i)')

    const shape = await text.evaluate(element => {
      const style = getComputedStyle(element)

      return { tabSize: style.tabSize, whiteSpace: style.whiteSpace, family: style.fontFamily }
    })

    expect(shape.tabSize).toBe('8')
    expect(shape.whiteSpace).toBe('pre')
    expect(shape.family.toLowerCase()).toMatch(/mono|menlo|consolas|courier/u)
    await expect(app.dialog.locator('[data-hunk="h1"] a, [data-hunk="h1"] b')).toHaveCount(0)
    await expect(app.dialog.locator('[data-hunk="h1"]')).toContainText('**x** https://evil.test <b>y</b>')
  })

  test('says so when a row is wider than the view: it scrolls sideways, the box takes the keyboard, nothing is cut', async ({
    app,
    browserName,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const tail = 'END-OF-THE-LONG-LINE'
    const long = `const veryLongLine = "${'abcdefghij'.repeat(44)}${tail}"`

    await raise(gateway, 'review.diff', {
      path: 'src/long.ts',
      title: 'A long line',
      summary: 'One line is wider than the sheet.',
      diff: ['@@ -3,3 +3,3 @@', ' const a = 1', `-const b = 2`, `+${long}`, ' const c = 3', ''].join('\n')
    })

    const dialog = app.dialog
    const lines = dialog.locator('[data-hunk="h1"] .hm-review__lines')

    await expect(lines).toBeVisible()
    await expect(dialog.locator('[data-hunk="h1"] [data-wide]')).toBeVisible()
    await expect(dialog.locator('[data-hunk="h1"] [data-wide]')).toHaveText(
      'Some lines are wider than the view. Scroll sideways to read all of them.'
    )

    const reach = await lines.evaluate(element => ({
      scrolls: element.scrollWidth > element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      ellipsis: getComputedStyle(element.querySelector('.hm-review__text') as Element).textOverflow
    }))

    expect(reach).toEqual({ scrolls: true, overflowX: 'auto', ellipsis: 'clip' })
    // The edge that has more is marked, and the marker moves once the box is scrolled to the end.
    await expect(dialog.locator('[data-hunk="h1"] .hm-review__frame')).toHaveAttribute('data-more-end', 'true')
    // The keyboard scrolls it sideways (the box is focusable): the arrow moves the view, and the edge before it is marked.
    await lines.focus()
    await expect(lines).toBeFocused()

    if (browserName === 'webkit') {
      // WebKit's automation does not run the key's default scroll; the box is focusable all the same (above).
      await lines.evaluate(element => {
        element.scrollLeft = 200
      })
    } else {
      await lines.press('ArrowRight')
    }

    await expect.poll(() => lines.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await expect(dialog.locator('[data-hunk="h1"] .hm-review__frame')).toHaveAttribute('data-more-start', 'true')
    // At the very end there is nothing more after it.
    await lines.evaluate(element => {
      element.scrollLeft = element.scrollWidth
    })
    await expect(dialog.locator('[data-hunk="h1"] .hm-review__frame')).not.toHaveAttribute('data-more-end', /.*/u)
    await expect(dialog.locator('[data-hunk="h1"] .hm-review__frame')).toHaveAttribute('data-more-start', 'true')
    // Nothing was cut: the whole line is in the page.
    await expect(dialog.locator('[data-hunk="h1"]')).toContainText(tail)
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe in the ${scheme} scheme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
    })

    test('a diff has no serious violation, contrast included', async ({ app, gateway, page }) => {
      await app.open()
      await app.ready()

      await raise(gateway, 'review.diff', SETTINGS)
      await expect(app.dialog).toHaveAccessibleName('Changes to review')
      await expect(app.dialog.locator('[data-send]')).toBeDisabled()
      expect(await seriousViolations(page, `diff-${scheme}`)).toEqual([])

      await decide(app.dialog, 1, 'Approve')
      await decide(app.dialog, 2, 'Reject')
      expect(await seriousViolations(page, `diff-decided-${scheme}`)).toEqual([])
    })
  })
}
