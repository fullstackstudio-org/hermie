/**
 * The composer and the request layer in a real browser, against the fake gateway,
 * on the built client.
 *
 * As `open-chat.spec.ts`: the page is the production build (minified, under the
 * document's own policy) served at `<gateway>/dashboard-plugins/hermie/app/index.html`
 * by the fake gateway's dashboard route, signed in through its own
 * `/auth/password-login`. The gateway streams a reply slowly (`streamDelayMs`), so a
 * turn is something a test can act in the middle of. What it checks:
 *
 *  - **Sending.** Return sends, the reader's own bubble is painted, the reply
 *    streams into the open chat (`aria-busy`), and the field is empty again.
 *  - **Stopping** mid-stream: Stop appears while the reply runs, the interrupt
 *    reaches the gateway (`runningSessions` empties), and no word arrives after.
 *  - **The queue**: a message sent while a reply runs is a chip with Steer, Edit
 *    and Delete.
 *  - **The draft**: kept per chat, across leaving the chat and across a reload.
 *  - **Approving and denying**: the prompt "approve" raises an approval on the
 *    gateway; the answer it receives is in `/__fake/state` (`serverRequestAnswers`).
 *  - **A clarify** raised through `/__fake/request`: a single question, a
 *    multi-step batch, Skip answering `''`.
 *  - **The layer is modal**: Escape does not close it, the page behind it is
 *    inert, it names the bot when the chat on screen is another one, and focus
 *    returns to the field when it is gone. All of it with the keyboard alone.
 *  - **A request raised before the page loads** is restored on resume.
 *  - **Accessibility**: axe, contrast included, with the layer open, in light
 *    and dark.
 *  - **The policy**: nothing the composer or the layer does is refused by it.
 *
 * The client is built here, into a temporary directory, so the run is never
 * against a stale `dist/`; the gateway is started in this process and stopped by
 * `afterAll`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { expect, type Locator, type Page, test } from '@playwright/test'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)

const BOT = 'researcher'

/** A reply of 24 frames, each of which says whose it is: "Alpha part 1. ", "Alpha part 2. ", ... */
const parts = (name: string): string[] => Array.from({ length: 24 }, (_, index) => `${name} part ${index + 1}. `)

let gateway: FakeGateway
let workDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'hermie-compose-e2e-'))

  // The page the gateway serves is `<assets>/app/index.html`: the build goes straight there.
  execFileSync('npx', ['vite', 'build', '--outDir', join(workDir, 'assets', 'app'), '--emptyOutDir'], {
    cwd: root,
    stdio: 'pipe'
  })

  // Slow enough that a turn of twenty-odd frames takes a few seconds: a test can act in the middle of it.
  gateway = await startFakeGateway({
    auth: 'cookie',
    streamDelayMs: 120,
    pluginAssets: join(workDir, 'assets'),
    // Each long reply says its own name in every part, so a test can tell ITS reply from one an earlier test left in
    // the chat. Anything else (including the prompt "approve", which parks on an approval) gets a one-word answer.
    scenario: {
      replies: [
        { match: 'alpha', deltas: parts('Alpha') },
        { match: 'bravo', deltas: parts('Bravo') },
        { match: 'charlie', deltas: parts('Charlie') },
        { deltas: ['Fine. '] }
      ]
    }
  })
})

test.afterAll(async () => {
  await gateway?.close()
  rmSync(workDir, { recursive: true, force: true })
})

/** What the document's policy refused, and what the page threw, in the test that is running. */
let refused: string[] = []

test.beforeEach(({ page }) => {
  refused = []
  page.on('console', message => {
    if (message.type() === 'error' && /Content Security Policy|Refused to|Trusted Type/iu.test(message.text())) {
      refused.push(message.text())
    }
  })
  page.on('pageerror', error => refused.push(error.message))
})

test.afterEach(async () => {
  // Whatever a test left open must not come back, as a restored request, in the next one.
  await fetch(`${gateway.url}/__fake/withdraw-requests`, { method: 'POST', body: '{}' })
  expect(refused).toEqual([])
})

const appUrl = (hash: string): string => `${gateway.url}/dashboard-plugins/hermie/app/index.html${hash}`

/** Sign in as the gateway's own login page would, then open the client at a route. */
async function openApp(page: Page, hash = `#/chat/${BOT}`): Promise<void> {
  const login = await page.request.post(`${gateway.url}/auth/password-login`, {
    data: { username: 'tester', password: 'hunter2', next: '/' }
  })

  expect(login.ok()).toBe(true)
  await page.goto(appUrl(hash))
}

const transcript = (page: Page): Locator => page.getByRole('log')
const field = (page: Page): Locator => page.getByRole('textbox', { name: /^Message / })
const sendButton = (page: Page): Locator => page.getByRole('button', { name: 'Send', exact: true })
const stopButton = (page: Page): Locator => page.getByRole('button', { name: 'Stop', exact: true })
const dialog = (page: Page): Locator => page.getByRole('dialog')
/** The newest reply that says it is `name`'s: an earlier test's reply of the same name is older, and not this one. */
const replyOf = (page: Page, name: string): Locator =>
  transcript(page)
    .locator('.hm-bubble[data-kind="assistant"]', { hasText: `${name} part 1.` })
    .last()

/** The chat is attached and the connection ready: what has to be true for Send to be on. */
async function ready(page: Page): Promise<void> {
  await field(page).fill('x')
  await expect(sendButton(page)).toBeEnabled({ timeout: 15_000 })
  await field(page).fill('')
}

/** Type in the field and press Return, as a keyboard reader would. */
async function send(page: Page, text: string): Promise<void> {
  await field(page).fill(text)
  await expect(sendButton(page)).toBeEnabled()
  await field(page).press('Enter')
}

interface FakeAnswer {
  id: string
  method: string
  result?: Record<string, unknown>
  error?: unknown
}

/** What the gateway has been answered, from its own read-back endpoint. */
async function answers(): Promise<FakeAnswer[]> {
  const response = await fetch(`${gateway.url}/__fake/state`)
  const state = (await response.json()) as { serverRequestAnswers: FakeAnswer[]; runningSessions: string[] }

  return state.serverRequestAnswers
}

const running = async (): Promise<string[]> =>
  ((await (await fetch(`${gateway.url}/__fake/state`)).json()) as { runningSessions: string[] }).runningSessions

async function raise(method: string, params: Record<string, unknown>, profile = BOT): Promise<void> {
  const response = await fetch(`${gateway.url}/__fake/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile, method, params })
  })

  expect(response.ok).toBe(true)
}

/** Move to another route without reloading: the chats the page holds stay attached. */
const goTo = (page: Page, hash: string): Promise<void> =>
  page.evaluate(next => {
    location.hash = next
  }, hash)

/** axe, with the page's own colours and fonts: contrast needs a layout, which is the point of running it here. */
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'))

  return page.evaluate(async () => {
    const axe = (globalThis as unknown as { axe: { run(context: Document): Promise<{ violations: AxeViolation[] }> } })
      .axe
    const result = await axe.run(document)

    return result.violations.map(
      violation =>
        `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
    )
  })
}

interface AxeViolation {
  id: string
  help: string
  nodes: { target: string[] }[]
}

// ── sending ─────────────────────────────────────────────────────────────────

test('sends with Return, paints the reader’s bubble, streams the reply in and empties the field', async ({ page }) => {
  await openApp(page)
  await ready(page)

  await send(page, 'tell me the alpha story')

  // The reader's own bubble, at once, and the field is ready for the next message.
  await expect(transcript(page).locator('.hm-bubble[data-kind="user"]').last()).toContainText('tell me the alpha story')
  await expect(field(page)).toHaveValue('')

  // The reply streams into the open chat: the log is busy meanwhile, and words arrive before it is over.
  await expect(transcript(page)).toHaveAttribute('aria-busy', 'true')
  await expect(replyOf(page, 'Alpha')).toBeVisible()
  await expect(replyOf(page, 'Alpha')).not.toContainText('Alpha part 24.')
  await expect(transcript(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })
  await expect(replyOf(page, 'Alpha')).toContainText('Alpha part 24.')
})

test('breaks the line on Shift+Return and sends nothing', async ({ page }) => {
  await openApp(page)
  await ready(page)

  await field(page).fill('first line')
  await field(page).press('Shift+Enter')
  await field(page).pressSequentially('second line')

  await expect(field(page)).toHaveValue('first line\nsecond line')
  await expect(transcript(page).locator('.hm-bubble[data-kind="user"]', { hasText: 'second line' })).toHaveCount(0)
  // The field grew to hold the second line.
  const height = await field(page).evaluate(element => element.getBoundingClientRect().height)

  expect(height).toBeGreaterThan(50)
})

test('stops a reply in the middle: the interrupt reaches the gateway and no word arrives after it', async ({
  page
}) => {
  await openApp(page)
  await ready(page)

  await expect(stopButton(page)).toHaveCount(0)

  await send(page, 'tell me the bravo story')
  await expect(replyOf(page, 'Bravo')).toBeVisible()
  await expect(stopButton(page)).toBeVisible()
  await stopButton(page).click()

  await expect(stopButton(page)).toHaveCount(0)
  await expect(transcript(page)).not.toHaveAttribute('aria-busy', 'true')
  await expect.poll(running).toEqual([])

  const said = await replyOf(page, 'Bravo').innerText()

  await page.waitForTimeout(900)
  expect(await replyOf(page, 'Bravo').innerText()).toBe(said)
  expect(said).not.toContain('Bravo part 24.')
  // The partial reply was really said, so it stays, and the field takes the next message.
  expect(said).toContain('Bravo part 1.')
  await send(page, 'and a short one')
  await expect(transcript(page).locator('.hm-bubble[data-kind="user"]').last()).toContainText('and a short one')
  await expect(transcript(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })
})

// ── the queue ───────────────────────────────────────────────────────────────

test('parks what is sent while a reply runs as a chip, which can be taken back or deleted', async ({ page }) => {
  await openApp(page)
  await ready(page)

  await send(page, 'tell me the charlie story')
  await expect(stopButton(page)).toBeVisible()

  await send(page, 'and then this')
  await send(page, 'and this as well')

  const queue = page.getByRole('list', { name: 'Messages waiting to be sent' })

  await expect(queue.getByRole('listitem')).toHaveCount(2)
  await expect(queue).toContainText('and then this')
  // Parked is not sent: no bubble for it yet.
  await expect(transcript(page).locator('.hm-bubble[data-kind="user"]', { hasText: 'and then this' })).toHaveCount(0)

  await queue.getByRole('button', { name: /^Delete: and then this/u }).click()
  await expect(queue.getByRole('listitem')).toHaveCount(1)

  await queue.getByRole('button', { name: /^Edit: and this as well/u }).click()
  await expect(field(page)).toHaveValue('and this as well')
  await expect(queue).toHaveCount(0)

  await stopButton(page).click()
  await expect(stopButton(page)).toHaveCount(0)
})

// ── the draft ───────────────────────────────────────────────────────────────

test('keeps the draft per chat, across leaving the chat and across a reload', async ({ page }) => {
  await openApp(page)
  await ready(page)

  await field(page).fill('half a thought')
  await goTo(page, '#/chat/writer')
  await expect(page.getByRole('textbox', { name: 'Message Writer' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Message Writer' }).fill('something for the writer')

  await goTo(page, `#/chat/${BOT}`)
  await expect(field(page)).toHaveValue('half a thought')

  await page.reload()
  await expect(field(page)).toHaveValue('half a thought')

  await goTo(page, '#/chat/writer')
  await expect(page.getByRole('textbox', { name: 'Message Writer' })).toHaveValue('something for the writer')

  // Sent is not kept.
  await goTo(page, `#/chat/${BOT}`)
  await ready(page)
  await field(page).fill('half a thought')
  await field(page).press('Enter')
  await page.reload()
  await expect(field(page)).toHaveValue('')
})

// ── approval ────────────────────────────────────────────────────────────────

test('approves from the keyboard alone: the prompt raises one, Escape does not close it, focus comes back', async ({
  page
}) => {
  await openApp(page)
  await ready(page)

  const before = (await answers()).length

  await field(page).focus()
  await page.keyboard.type('please approve this one')
  await page.keyboard.press('Enter')

  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page)).toHaveAccessibleName('Allow this command?')
  await expect(dialog(page)).toContainText('rm -rf ./build')
  await expect(dialog(page)).toContainText('Remove the build directory')
  await expect(dialog(page)).toContainText('From Researcher')
  await expect(dialog(page).getByRole('button')).toHaveText([
    'Allow once',
    'Allow for this session',
    'Always allow',
    'Deny'
  ])

  // Focus is on the dialog, not on a button: a Return meant for the field presses nothing.
  await expect(dialog(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeVisible()
  expect((await answers()).length).toBe(before)

  // The page behind it is out of reach: Tab stays inside the dialog.
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab')
    expect(await dialog(page).evaluate(element => element.contains(document.activeElement))).toBe(true)
  }

  // The buttons wake a moment after the dialog appears (a click already on its way answers nothing).
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeEnabled()

  // Tab to Allow once and press it.
  await dialog(page).focus()
  await page.keyboard.press('Tab') // the command, a scroll region
  await page.keyboard.press('Tab') // Allow once
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await answers()).length).toBe(before + 1)

  const answer = (await answers()).at(-1)

  expect(answer?.method).toBe('approval')
  expect(answer?.result).toEqual({ choice: 'once' })
  // Focus is back in the field the reader was typing in, and the turn the approval parked goes on to its end.
  await expect(field(page)).toBeFocused()
  await expect(transcript(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })
})

test('denies, and the gateway is answered with the refusal', async ({ page }) => {
  await openApp(page)
  await ready(page)

  const before = (await answers()).length

  await send(page, 'approve this too')
  await expect(dialog(page)).toBeVisible()
  await dialog(page).getByRole('button', { name: 'Deny' }).click()

  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await answers()).length).toBe(before + 1)
  expect((await answers()).at(-1)?.result).toEqual({ choice: 'deny' })
  await expect(transcript(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })
})

test('shows an approval for a bot whose chat is not on screen, and names it', async ({ page }) => {
  await openApp(page)
  await ready(page)

  await goTo(page, '#/chat/writer')
  await expect(page.getByRole('textbox', { name: 'Message Writer' })).toBeVisible()

  const before = (await answers()).length

  await raise('approval', {
    command: 'ls -la',
    description: 'List the directory',
    choices: ['once', 'deny'],
    request_id: 'appr-elsewhere'
  })

  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page)).toContainText('From Researcher')
  await expect(dialog(page)).toContainText('ls -la')
  // The heading behind it is the writer's: the layer is over a chat that is not the one asking.
  await expect(page.getByRole('heading', { level: 1, includeHidden: true })).toHaveText('Writer')

  await dialog(page).getByRole('button', { name: 'Allow once' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await answers()).length).toBe(before + 1)
  expect((await answers()).at(-1)?.result).toEqual({ choice: 'once' })
})

test('shows what is waiting one at a time, oldest first, and says how many are behind', async ({ page }) => {
  await openApp(page)
  await ready(page)

  const before = (await answers()).length

  await raise('approval', { command: 'first command', choices: ['once', 'deny'], request_id: 'appr-1' })
  await expect(dialog(page)).toContainText('first command')
  await raise('approval', { command: 'second command', choices: ['once', 'deny'], request_id: 'appr-2' })
  await expect(dialog(page)).toContainText('1 more waiting')
  await expect(dialog(page)).toContainText('first command')

  await dialog(page).getByRole('button', { name: 'Allow once' }).click()
  await expect(dialog(page)).toContainText('second command')
  await expect(dialog(page)).not.toContainText('more waiting')
  await dialog(page).getByRole('button', { name: 'Deny' }).click()

  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await answers()).length).toBe(before + 2)
  expect((await answers()).slice(-2).map(answer => answer.result)).toEqual([{ choice: 'once' }, { choice: 'deny' }])
})

test('closes when the gateway withdraws the request, and restores one raised before the page loaded', async ({
  page
}) => {
  await openApp(page)
  await ready(page)

  await raise('approval', { command: 'will be withdrawn', choices: ['once', 'deny'], request_id: 'appr-w' })
  await expect(dialog(page)).toContainText('will be withdrawn')

  await fetch(`${gateway.url}/__fake/withdraw-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'cancelled' })
  })
  await expect(dialog(page)).toHaveCount(0)

  // Raised while no page is looking: restored from `open_requests` when the chat is resumed.
  await page.goto('about:blank')
  await raise('clarify', { question: 'Still there?', choices: ['Yes', 'No'], request_id: 'q-restore' })
  await page.goto(appUrl(`#/chat/${BOT}`))
  await expect(dialog(page)).toContainText('Still there?')
})

// ── clarify ─────────────────────────────────────────────────────────────────

test('answers a clarify with a choice, with the keyboard alone', async ({ page }) => {
  await openApp(page)
  await ready(page)

  const before = (await answers()).length

  await raise('clarify', { question: 'Which colour?', choices: ['Red', 'Blue', 'Green'], request_id: 'q-colour' })

  await expect(dialog(page)).toHaveAccessibleName('Before I continue')
  await expect(dialog(page)).toContainText('Which colour?')
  await expect(dialog(page)).toContainText('From Researcher')
  await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled()

  // The arrow keys move a radio group; Tab leaves it.
  await page.getByRole('radio', { name: 'Red' }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('radio', { name: 'Blue' })).toBeChecked()
  await page.getByRole('button', { name: 'Submit' }).focus()
  await page.keyboard.press('Enter')

  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await answers()).length).toBe(before + 1)

  const answer = (await answers()).at(-1)

  expect(answer?.method).toBe('clarify')
  expect(answer?.result).toEqual({ answer: 'Blue' })
})

test('answers a clarify in the reader’s own words', async ({ page }) => {
  await openApp(page)
  await ready(page)

  const before = (await answers()).length

  await raise('clarify', { question: 'What should it be called?', request_id: 'q-name' })
  await page.getByLabel('Or answer in your own words').fill('Something else entirely')
  await page.getByLabel('Or answer in your own words').press('Control+Enter')

  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await answers()).length).toBe(before + 1)
  expect((await answers()).at(-1)?.result).toEqual({ answer: 'Something else entirely' })
})

test('steps through a batch, and Skip answers a question with an empty string', async ({ page }) => {
  await openApp(page)
  await ready(page)

  const before = (await answers()).length

  await raise('clarify', {
    request_id: 'q-batch',
    questions: [
      { qid: 'size', question: 'Which size?', choices: ['S', 'M', 'L'] },
      { qid: 'note', question: 'Anything to add?' },
      { qid: 'extras', question: 'Which extras?', choices: ['a', 'b', 'c'], multi_select: true }
    ]
  })

  await expect(dialog(page)).toContainText('Question 1 of 3')
  await page.getByRole('radio', { name: 'M' }).check()
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(dialog(page)).toContainText('Question 2 of 3')
  await expect(dialog(page).getByText('Anything to add?')).toBeFocused()
  await page.getByRole('button', { name: 'Skip' }).click()

  await expect(dialog(page)).toContainText('Question 3 of 3')
  await page.getByRole('checkbox', { name: 'a' }).check()
  await page.getByRole('checkbox', { name: 'c' }).check()
  await page.getByRole('button', { name: 'Submit' }).click()

  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await answers()).length).toBe(before + 1)
  expect((await answers()).at(-1)?.result).toEqual({ answers: { size: 'M', note: '', extras: 'a, c' } })
})

test('Skip on a single question tells the bot there is no answer', async ({ page }) => {
  await openApp(page)
  await ready(page)

  const before = (await answers()).length

  await raise('clarify', { question: 'Do you mind?', choices: ['Yes', 'No'], request_id: 'q-skip' })
  await page.getByRole('button', { name: 'Skip' }).click()

  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(async () => (await answers()).length).toBe(before + 1)
  expect((await answers()).at(-1)?.result).toEqual({ answer: '' })
})

// ── what the page is while the layer is open ───────────────────────────────

test('puts the rest of the page out of reach while the layer is open, and back after', async ({ page }) => {
  await openApp(page)
  await ready(page)

  await raise('approval', { command: 'ls', choices: ['once', 'deny'], request_id: 'appr-inert' })
  await expect(dialog(page)).toBeVisible()

  // Behind the dialog nothing takes focus or a click.
  expect(await page.locator('.hm-app').evaluate(element => element.hasAttribute('inert'))).toBe(true)
  // It takes no focus, and a click on it lands on the layer: the field is inert.
  expect(
    await field(page).evaluate(element => {
      element.focus()

      const box = element.getBoundingClientRect()
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)

      return { focused: document.activeElement === element, covered: top !== element }
    })
  ).toEqual({ focused: false, covered: true })

  await dialog(page).getByRole('button', { name: 'Deny' }).click()
  await expect(dialog(page)).toHaveCount(0)
  expect(await page.locator('.hm-app').evaluate(element => element.hasAttribute('inert'))).toBe(false)
  await expect(field(page)).toBeVisible()
})

test('fits a phone: the dialog and the composer do not scroll the page sideways', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await openApp(page)
  await ready(page)

  const sideways = (): Promise<boolean> =>
    page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

  expect(await sideways()).toBe(false)

  await raise('clarify', {
    question: 'A long question that has to wrap on a narrow screen without making the page scroll sideways at all?',
    choices: ['A choice with quite a lot of words in it to make it wrap', 'Short'],
    request_id: 'q-narrow'
  })
  await expect(dialog(page)).toBeVisible()
  expect(await sideways()).toBe(false)

  const box = await dialog(page).boundingBox()

  expect(box?.x).toBeGreaterThanOrEqual(0)
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320)

  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(dialog(page)).toHaveCount(0)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`has no accessibility violation with the layer open, in the ${scheme} scheme, contrast included`, async ({
    page
  }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await openApp(page)
    await ready(page)

    // The composer, with a draft in it and a message waiting.
    await field(page).fill('a draft')
    expect(await violations(page)).toEqual([])

    await raise('approval', {
      command: 'find . -name "*.log" -mtime +30 -delete',
      description: 'Delete old logs',
      tool_name: 'run_command',
      request_id: `appr-axe-${scheme}`
    })
    await expect(dialog(page)).toBeVisible()
    expect(await violations(page)).toEqual([])
    await dialog(page).getByRole('button', { name: 'Deny' }).click()
    await expect(dialog(page)).toHaveCount(0)

    await raise('clarify', {
      request_id: `q-axe-${scheme}`,
      questions: [
        { qid: 'one', question: 'Pick some', choices: ['x', 'y'], multi_select: true },
        { qid: 'two', question: 'Why?' }
      ]
    })
    await expect(dialog(page)).toBeVisible()
    expect(await violations(page)).toEqual([])
    await page.getByRole('checkbox', { name: 'x' }).check()
    await page.getByRole('button', { name: 'Next' }).click()
    expect(await violations(page)).toEqual([])
    await page.getByRole('button', { name: 'Skip' }).click()
    await expect(dialog(page)).toHaveCount(0)
  })
}
