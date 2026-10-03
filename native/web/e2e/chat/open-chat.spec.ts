/**
 * The chat screen in a real browser, against the fake gateway, on the built client.
 *
 * Nothing here is the development harness: the page is the production build
 * (`vite build`, minified, under the document's own policy) served at
 * `<gateway>/dashboard-plugins/hermie/app/index.html` by the fake gateway's
 * dashboard route, signed in through the gateway's own `/auth/password-login`,
 * with 2,000 rows of back-history in the bot's chat (`historyRows`). What it
 * checks, each in the page itself:
 *
 *  - **Opening.** The chat opens at the bottom, and the reader's position does
 *    not move while it fills in: the gap below the newest row is zero in every
 *    frame from the first one that has rows, and the row at the bottom does not
 *    change. Again from the cache (a reload), which paints first and is replaced
 *    by what the gateway says.
 *  - **Streaming.** A reply streams into the open chat (events published from the
 *    gateway, as it would stream them) and the view stays pinned in every frame;
 *    the transcript is `aria-busy` meanwhile and a finished reply is announced
 *    once, not every delta.
 *  - **Reading above the bottom.** Scrolled up, the row being read does not move
 *    while the reply grows below it, "Jump to latest" appears with a count, and
 *    pressing it goes to the newest row and puts focus on the transcript.
 *  - **Accessibility.** axe, contrast included (jsdom has no layout, so the unit
 *    suite cannot), in light and dark.
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
import { expect, type Page, test } from '@playwright/test'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)

const BOT = 'researcher'
/** Half a CSS pixel is the list's own rounding slop (`HOLD_SLOP`). */
const SLOP = 0.5

let gateway: FakeGateway
let workDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'hermie-chat-e2e-'))

  // The page the gateway serves is `<assets>/app/index.html`: the build goes straight there.
  execFileSync('npx', ['vite', 'build', '--outDir', join(workDir, 'assets', 'app'), '--emptyOutDir'], {
    cwd: root,
    stdio: 'pipe'
  })

  gateway = await startFakeGateway({ auth: 'cookie', historyRows: 2000, pluginAssets: join(workDir, 'assets') })
})

test.afterAll(async () => {
  await gateway?.close()
  rmSync(workDir, { recursive: true, force: true })
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

const transcript = (page: Page) => page.getByRole('log')

/** What the page measures of the transcript, frame by frame, from the moment `watch` is called. */
interface Watch {
  frames: number
  /** Frames in which the transcript held rows. */
  framesWithRows: number
  /** The largest distance from the newest row's bottom to the scrollport's bottom, over frames with rows, while pinned. */
  worstGap: number
  /** The keys of the row at the bottom, in the order they were first seen. */
  bottomKeys: string[]
  /** How many rows the transcript held at the last frame. */
  rows: number
}

declare global {
  var hermieChatWatch: { stop(): Watch } | undefined
}

/**
 * Samples the transcript on every animation frame. It runs in the page (as an init
 * script, so it is there from the first frame of the document, or evaluated into a
 * page that is already open) and so refers to nothing outside itself.
 */
function recorder(pinned: boolean): void {
  const result: Watch = { frames: 0, framesWithRows: 0, worstGap: 0, bottomKeys: [], rows: 0 }
  let handle = 0

  const sample = (): void => {
    result.frames += 1

    const log = document.querySelector<HTMLElement>('[role="log"]')
    const rows = log?.querySelectorAll<HTMLElement>('[data-row-key]') ?? []

    result.rows = rows.length

    if (log && rows.length > 0) {
      result.framesWithRows += 1

      const gap = log.scrollHeight - log.clientHeight - log.scrollTop
      const bottom = rows[rows.length - 1]?.dataset.rowKey ?? ''

      if (pinned) {
        result.worstGap = Math.max(result.worstGap, Math.abs(gap))
      }

      if (result.bottomKeys[result.bottomKeys.length - 1] !== bottom) {
        result.bottomKeys.push(bottom)
      }
    }

    handle = requestAnimationFrame(sample)
  }

  handle = requestAnimationFrame(sample)
  globalThis.hermieChatWatch = {
    stop() {
      cancelAnimationFrame(handle)

      return result
    }
  }
}

const stopWatch = (page: Page): Promise<Watch> => page.evaluate(() => globalThis.hermieChatWatch!.stop())

/** The stored id of the bot's chat on the fake gateway, which is what events are addressed by. */
function sessionIdOf(profile: string): string {
  const session = [...gateway.state.sessions.values()].find(entry => entry.profile === profile)

  if (!session) {
    throw new Error(`the fake gateway has no chat for ${profile}`)
  }

  return session.storedId
}

/** Stream a reply into the bot's chat, as the gateway would: start, deltas, complete. */
async function streamReply(page: Page, options: { paragraphs: number; everyMs: number }): Promise<string> {
  const sessionId = sessionIdOf(BOT)
  const session =
    gateway.state.sessions.get(sessionId) ??
    [...gateway.state.sessions.values()].find(entry => entry.storedId === sessionId)
  let text = ''

  // A gateway writes the turn down as it runs; a client that reads the tail finds it.
  session?.messages.push({
    role: 'user',
    text: 'Tell me more.',
    row_id: session.messages.length + 1,
    timestamp: Math.floor(Date.now() / 1000)
  })
  gateway.emit('message.start', { sessionId })

  for (let index = 0; index < options.paragraphs; index += 1) {
    const delta = `Paragraph ${index + 1} of the reply, long enough to wrap on a narrow pane and so to make the transcript grow as it streams in. `

    text += `${delta}\n\n`
    gateway.emit('message.delta', { sessionId, payload: { text: `${delta}\n\n` } })
    await page.waitForTimeout(options.everyMs)
  }

  session?.messages.push({
    role: 'assistant',
    text,
    row_id: (session?.messages.length ?? 0) + 1,
    timestamp: Math.floor(Date.now() / 1000)
  })
  gateway.emit('message.complete', { sessionId, payload: { text, status: 'ok' } })

  return text
}

test('opens the bot’s chat at the bottom and does not move while it fills in, from the gateway and from the cache', async ({
  page
}) => {
  // From the first frame of the document, so nothing of the opening is missed.
  await page.addInitScript(recorder, true)
  await openApp(page)

  await expect(transcript(page)).toBeVisible()
  await expect.poll(async () => await transcript(page).locator('[data-row-key]').count()).toBeGreaterThan(100)
  // Let the rest of the open (the replay, the tail, the avatars) land while it is being watched.
  await page.waitForTimeout(1500)

  const opened = await stopWatch(page)

  expect(opened.framesWithRows).toBeGreaterThan(30)
  expect(opened.worstGap).toBeLessThanOrEqual(SLOP)
  // The newest row is the same one from the first frame that had rows to the last.
  expect(opened.bottomKeys).toHaveLength(1)

  // Only a page of the history is held at first; the rest is behind the top.
  expect(opened.rows).toBeLessThan(2000)
  await expect(transcript(page)).toHaveAttribute('aria-label', /Conversation with /)

  // The same chat again: painted from what was kept in the browser, then replaced by what the gateway says.
  await page.reload()
  await expect(transcript(page)).toBeVisible()
  await expect.poll(async () => await transcript(page).locator('[data-row-key]').count()).toBeGreaterThan(100)
  await page.waitForTimeout(1500)

  const again = await stopWatch(page)

  expect(again.worstGap).toBeLessThanOrEqual(SLOP)
  expect(again.bottomKeys).toHaveLength(1)
})

test('keeps the view pinned while a reply streams in, says it is busy and announces the finished reply once', async ({
  page
}) => {
  await openApp(page)
  await expect.poll(async () => await transcript(page).locator('[data-row-key]').count()).toBeGreaterThan(100)
  await page.waitForTimeout(500)

  const announcement = page.locator('.hm-chat__announce')

  await page.evaluate(recorder, true)

  const streaming = streamReply(page, { paragraphs: 40, everyMs: 40 })

  await expect(transcript(page)).toHaveAttribute('aria-busy', 'true')
  expect(await announcement.textContent()).toBe('')

  // Midway: still nothing said aloud, and the reply is on screen.
  await page.waitForTimeout(600)
  expect(await announcement.textContent()).toBe('')
  await expect(page.getByText('Paragraph 1 of the reply').first()).toBeVisible()

  await streaming
  await expect(transcript(page)).not.toHaveAttribute('aria-busy', 'true')
  await expect(announcement).toContainText(' replied: Paragraph 1 of the reply')
  await page.waitForTimeout(300)

  const watched = await stopWatch(page)

  expect(watched.worstGap).toBeLessThanOrEqual(SLOP)
  expect(watched.framesWithRows).toBeGreaterThan(60)
  // The newest row moved on as the reply arrived (the dots, then the reply), and the view followed it.
  expect(watched.bottomKeys.length).toBeGreaterThan(1)
  await expect(page.getByRole('button', { name: /Jump to latest/ })).toHaveCount(0)
})

test('lets the reader read above the bottom, offers "jump to latest" with a count, and goes there on request', async ({
  page
}) => {
  await openApp(page)
  await expect.poll(async () => await transcript(page).locator('[data-row-key]').count()).toBeGreaterThan(100)
  await page.waitForTimeout(500)
  await expect(page.getByRole('button', { name: /Jump to latest/ })).toHaveCount(0)

  // Up into the middle of what has been loaded.
  await transcript(page).evaluate(log => {
    log.scrollTop = Math.max(0, (log.scrollHeight - log.clientHeight) / 2)
  })
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()

  // The row being read: the first whose bottom is below the top of the scrollport.
  const reading = () =>
    transcript(page).evaluate(log => {
      const top = log.getBoundingClientRect().top
      const row = [...log.querySelectorAll<HTMLElement>('[data-row-key]')].find(
        candidate => candidate.getBoundingClientRect().bottom > top + 1
      )

      return row ? { key: row.dataset.rowKey ?? '', offset: row.getBoundingClientRect().top - top } : null
    })

  const before = await reading()

  expect(before).not.toBeNull()

  await streamReply(page, { paragraphs: 12, everyMs: 30 })
  // A second reply arrives whole: two more messages for the count.
  await fetch(`${gateway.url}/__fake/inject`, {
    method: 'POST',
    body: JSON.stringify({ profile: BOT, user: 'And one more thing.', assistant: 'Noted, thank you.' })
  })

  await expect(page.getByRole('button', { name: /Jump to latest.*[1-9]\d* new/ })).toBeVisible()
  await page.waitForTimeout(300)

  const after = await reading()

  expect(after?.key).toBe(before?.key)
  expect(Math.abs((after?.offset ?? 0) - (before?.offset ?? 0))).toBeLessThanOrEqual(SLOP)

  await page.getByRole('button', { name: /Jump to latest/ }).click()

  await expect(page.getByRole('button', { name: /Jump to latest/ })).toHaveCount(0)
  await expect(transcript(page)).toBeFocused()

  // At the newest row. A browser that draws the rows it skipped on the way down may need a frame or two to say how tall they are.
  await expect
    .poll(() => transcript(page).evaluate(log => Math.abs(log.scrollHeight - log.clientHeight - log.scrollTop)))
    .toBeLessThanOrEqual(SLOP)
  await expect(transcript(page).getByText('Noted, thank you.')).toBeVisible()
})

test('loads older history when the reader reaches the top, and keeps the row they were on', async ({ page }) => {
  await openApp(page)
  await expect.poll(async () => await transcript(page).locator('[data-row-key]').count()).toBeGreaterThan(100)
  await page.waitForTimeout(500)

  const held = await transcript(page).locator('[data-row-key]').count()

  await transcript(page).evaluate(log => {
    log.scrollTop = 0
  })
  await expect
    .poll(async () => await transcript(page).locator('[data-row-key]').count(), { timeout: 15_000 })
    .toBeGreaterThan(held)
  await page.waitForTimeout(500)

  // Still reading the top of the older page, not thrown to the bottom or to the very first row.
  const gap = await transcript(page).evaluate(log => log.scrollHeight - log.clientHeight - log.scrollTop)

  expect(gap).toBeGreaterThan(200)
})

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

for (const scheme of ['light', 'dark'] as const) {
  test(`has no accessibility violation on the chat screen in the ${scheme} scheme, contrast included`, async ({
    page
  }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await openApp(page)
    await expect.poll(async () => await transcript(page).locator('[data-row-key]').count()).toBeGreaterThan(100)
    // A tool line opened, so the detail is on the page as well.
    await page.locator('.hm-tool__line').first().click()
    await page.waitForTimeout(300)

    expect(await violations(page)).toEqual([])
  })
}
