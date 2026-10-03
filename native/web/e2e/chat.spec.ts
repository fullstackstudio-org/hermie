/**
 * Reading and sending in a chat, in a real browser, against the fake gateway
 * serving the built client.
 *
 * Four groups, each with what it proves:
 *
 *  - **The list and opening a chat.** The roster is a link per bot with its last
 *    words; a link opens the chat in the main pane (heading, a log named for the
 *    bot, the history), the unread mark goes when it is opened, and the list is
 *    one tab stop that the arrow keys move along.
 *  - **Sending and stopping.** Return sends, the reader's own bubble is painted
 *    at once, the reply streams in (`aria-busy`) and the field is empty again;
 *    Shift+Return breaks the line; Stop mid-stream reaches the gateway
 *    (`runningSessions` empties) and no word arrives after; a message sent while a
 *    reply runs is a chip that can be taken back or deleted; a draft is kept per
 *    chat, across leaving it and across a reload and is not kept once sent. A
 *    reply the gateway streams from elsewhere is shown as it arrives and announced
 *    once.
 *  - **A dropped socket.** Mid-reply, the connection is cut without a close frame
 *    and the reply still completes, once: one reader's bubble, one reply of
 *    exactly the words the gateway sent. Idle, the page reconnects and a message
 *    that arrives afterwards is shown once.
 *  - **A long history.** 2,000 rows behind the chat: it opens at the bottom and
 *    does not move while it fills in (from the gateway and from the cache), stays
 *    pinned while a reply streams, lets the reader read above the bottom without
 *    the row they are on moving, offers "Jump to latest" with a count, and loads
 *    older history at the top without losing the row.
 *
 * Nothing here waits for a time to pass. The page is waited for through what it
 * shows (auto-waiting locators), the gateway through what it reports
 * (`/__fake/state`), and "has it stopped moving" is asked of the page in frames
 * (`settled`).
 */
import { type App, BOT, expect, type Gateway, goTo, parts, replyOf, rowCount, settled, test } from './fixtures'
import type { Page } from '@playwright/test'

/** Resolves once the page has painted `count` more frames: how a producer paces itself against a page. */
const frames = (page: Page, count = 1): Promise<void> =>
  page.evaluate(
    wanted =>
      new Promise<void>(resolve => {
        let left = wanted

        const tick = (): void => {
          left -= 1

          if (left <= 0) {
            resolve()
          } else {
            requestAnimationFrame(tick)
          }
        }

        requestAnimationFrame(tick)
      }),
    count
  )

/** The stored id of the bot's chat on the fake gateway, which is what events are addressed by. */
function sessionIdOf(gateway: Gateway, profile: string): string {
  const session = [...gateway.fake.state.sessions.values()].find(entry => entry.profile === profile)

  if (!session) {
    throw new Error(`the fake gateway has no chat for ${profile}`)
  }

  return session.storedId
}

/**
 * Stream a reply into the bot's chat as another client's turn would: the
 * gateway writes the turn down, then publishes start, a delta per paragraph and
 * complete, one delta every `framesBetween` frames of the page.
 */
async function streamReply(
  gateway: Gateway,
  page: Page,
  options: { paragraphs: number; framesBetween: number }
): Promise<string> {
  const sessionId = sessionIdOf(gateway, BOT)
  const session = [...gateway.fake.state.sessions.values()].find(entry => entry.storedId === sessionId)
  let text = ''

  session?.messages.push({
    role: 'user',
    text: 'Tell me more.',
    row_id: session.messages.length + 1,
    timestamp: Math.floor(Date.now() / 1000)
  })
  gateway.fake.emit('message.start', { sessionId })

  for (let index = 0; index < options.paragraphs; index += 1) {
    const delta = `Paragraph ${index + 1} of the reply, long enough to wrap on a narrow pane and so to make the transcript grow as it streams in. `

    text += `${delta}\n\n`
    gateway.fake.emit('message.delta', { sessionId, payload: { text: `${delta}\n\n` } })
    await frames(page, options.framesBetween)
  }

  session?.messages.push({
    role: 'assistant',
    text,
    row_id: (session?.messages.length ?? 0) + 1,
    timestamp: Math.floor(Date.now() / 1000)
  })
  gateway.fake.emit('message.complete', { sessionId, payload: { text, status: 'ok' } })

  return text
}

// ── the list and opening a chat ─────────────────────────────────────────────

test.describe('the chat list and opening a chat', () => {
  test('lists the bots with their last words, and opens a chat in the main pane', async ({ app, page }) => {
    await app.open('#/')

    const chats = page.getByRole('navigation', { name: 'Chats' })

    await expect(chats.getByRole('link')).toHaveCount(2)
    await expect(chats.getByRole('link', { name: /^Researcher/u })).toContainText('Retry semantics')
    await expect(chats.getByRole('link', { name: /^Writer/u })).toContainText('Writes things down.')
    await expect(page.getByRole('heading', { level: 1, name: 'Hermie' })).toBeVisible()
    await expect(page.getByText('Pick a conversation to start reading.')).toBeVisible()

    await chats.getByRole('link', { name: /^Researcher/u }).click()

    await expect(page).toHaveURL(app.page.url().replace(/#.*$/u, '') + `#/chat/${BOT}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Researcher' })).toBeVisible()
    await expect(app.transcript).toHaveAccessibleName('Conversation with Researcher')
    await expect(app.transcript).toContainText('Introduce yourself in one line.')
    await expect(app.transcript).toContainText('I am researcher, at your service.')
    // The reply with a table, a list, a code block and a quote: drawn as the structure it is. In the reply's
    // bubble: the cron report in the same chat is Markdown too, with a table of its own.
    const replies = app.transcript.locator('.hm-bubble[data-kind="assistant"]')

    await expect(replies.getByRole('table')).toBeVisible()
    await expect(replies.getByRole('button', { name: 'Copy code' })).toBeVisible()
    await expect(app.field).toBeVisible()

    // Another chat, and back with the browser's own button.
    await chats.getByRole('link', { name: /^Writer/u }).click()
    await expect(page.getByRole('textbox', { name: 'Message Writer' })).toBeVisible()
    await expect(app.transcript).toHaveAccessibleName('Conversation with Writer')
    await page.goBack()
    await expect(page.getByRole('heading', { level: 1, name: 'Researcher' })).toBeVisible()
  })

  test('takes the unread mark off a chat when it is opened', async ({ app, page }) => {
    await app.open('#/')

    const row = page.getByRole('link', { name: /^Researcher/u })

    await expect(row).toHaveAccessibleName(/, New/u)
    await row.click()
    await expect(app.transcript).toContainText('I am researcher, at your service.')
    await expect(row).not.toHaveAccessibleName(/, New/u)
    // The other chat is not touched.
    await expect(page.getByRole('link', { name: /^Writer/u })).toHaveAccessibleName(/, New/u)
  })

  test('is one tab stop that the arrow keys move along, and Enter opens the row', async ({ app, page }) => {
    await app.open('#/')

    const researcher = page.getByRole('link', { name: /^Researcher/u })
    const writer = page.getByRole('link', { name: /^Writer/u })

    await expect(researcher).toBeVisible()
    await researcher.focus()
    await page.keyboard.press('ArrowDown')
    await expect(writer).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(researcher).toBeFocused()
    await page.keyboard.press('End')
    await expect(writer).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(page.getByRole('heading', { level: 1, name: 'Writer' })).toBeVisible()
    await expect(app.transcript).toHaveAccessibleName('Conversation with Writer')
  })

  test('fits one pane on a phone: the list first, the chat with a way back', async ({ app, page }) => {
    await page.setViewportSize({ width: 375, height: 700 })
    await app.open('#/')

    await expect(page.getByRole('link', { name: /^Researcher/u })).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    ).toBe(true)

    await page.getByRole('link', { name: /^Researcher/u }).click()
    await expect(app.transcript).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Chats' })).toBeHidden()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    ).toBe(true)
  })
})

// ── sending and stopping ────────────────────────────────────────────────────

test.describe('sending and stopping', () => {
  // Slow enough that a turn of twenty-odd frames takes a few seconds: a test can act in the middle of it.
  // Each long reply says its own name in every part, so a test can tell ITS reply from another. Anything
  // else gets a one-word answer.
  test.use({
    gatewayOptions: {
      streamDelayMs: 120,
      scenario: {
        replies: [
          { match: 'alpha', deltas: parts('Alpha') },
          { match: 'bravo', deltas: parts('Bravo') },
          { match: 'charlie', deltas: parts('Charlie') },
          { deltas: ['Fine. '] }
        ]
      }
    }
  })

  test('sends with Return, paints the reader’s bubble, streams the reply in and empties the field', async ({ app }) => {
    await app.open()
    await app.ready()

    await app.send('tell me the alpha story')

    // The reader's own bubble, at once, and the field is ready for the next message.
    await expect(app.transcript.locator('.hm-bubble[data-kind="user"]').last()).toContainText('tell me the alpha story')
    await expect(app.field).toHaveValue('')

    // The reply streams into the open chat: the log is busy meanwhile, and words arrive before it is over.
    await expect(app.transcript).toHaveAttribute('aria-busy', 'true')
    await expect(replyOf(app, 'Alpha')).toBeVisible()
    await expect(replyOf(app, 'Alpha')).not.toContainText('Alpha part 24.')
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })
    await expect(replyOf(app, 'Alpha')).toContainText('Alpha part 24.')
  })

  test('breaks the line on Shift+Return and sends nothing', async ({ app }) => {
    await app.open()
    await app.ready()

    await app.field.fill('first line')
    await app.field.press('Shift+Enter')
    await app.field.pressSequentially('second line')

    await expect(app.field).toHaveValue('first line\nsecond line')
    await expect(app.transcript.locator('.hm-bubble[data-kind="user"]', { hasText: 'second line' })).toHaveCount(0)
    // The field grew to hold the second line.
    expect(await app.field.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(50)
  })

  test('stops a reply in the middle: the interrupt reaches the gateway and no word arrives after it', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await app.ready()
    await expect(app.stopButton).toHaveCount(0)

    await app.send('tell me the bravo story')
    await expect(replyOf(app, 'Bravo')).toBeVisible()
    await expect(app.stopButton).toBeVisible()
    await app.stopButton.click()

    await expect(app.stopButton).toHaveCount(0)
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')
    await expect.poll(() => gateway.running()).toEqual([])

    // The gateway has stopped streaming; a few dozen frames cover the interval between two of its frames.
    const said = await replyOf(app, 'Bravo').innerText()

    await frames(page, 40)
    expect(await replyOf(app, 'Bravo').innerText()).toBe(said)
    expect(said).not.toContain('Bravo part 24.')
    // The partial reply was really said, so it stays, and the field takes the next message.
    expect(said).toContain('Bravo part 1.')

    await app.send('and a short one')
    await expect(app.transcript.locator('.hm-bubble[data-kind="user"]').last()).toContainText('and a short one')
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })
  })

  test('parks what is sent while a reply runs as a chip, which can be taken back or deleted', async ({ app }) => {
    await app.open()
    await app.ready()

    await app.send('tell me the charlie story')
    await expect(app.stopButton).toBeVisible()

    await app.send('and then this')
    await app.send('and this as well')

    const queue = app.page.getByRole('list', { name: 'Messages waiting to be sent' })

    await expect(queue.getByRole('listitem')).toHaveCount(2)
    await expect(queue).toContainText('and then this')
    // Parked is not sent: no bubble for it yet.
    await expect(app.transcript.locator('.hm-bubble[data-kind="user"]', { hasText: 'and then this' })).toHaveCount(0)

    await queue.getByRole('button', { name: /^Delete: and then this/u }).click()
    await expect(queue.getByRole('listitem')).toHaveCount(1)

    await queue.getByRole('button', { name: /^Edit: and this as well/u }).click()
    await expect(app.field).toHaveValue('and this as well')
    await expect(queue).toHaveCount(0)

    await app.stopButton.click()
    await expect(app.stopButton).toHaveCount(0)
  })

  test('keeps the draft per chat, across leaving the chat and across a reload, and drops it once sent', async ({
    app,
    page
  }) => {
    await app.open()
    await app.ready()

    await app.field.fill('half a thought')
    await goTo(page, '#/chat/writer')
    await expect(page.getByRole('textbox', { name: 'Message Writer' })).toHaveValue('')
    await page.getByRole('textbox', { name: 'Message Writer' }).fill('something for the writer')

    await goTo(page, `#/chat/${BOT}`)
    await expect(app.field).toHaveValue('half a thought')

    await page.reload()
    await expect(app.field).toHaveValue('half a thought')

    await goTo(page, '#/chat/writer')
    await expect(page.getByRole('textbox', { name: 'Message Writer' })).toHaveValue('something for the writer')

    // Sent is not kept.
    await goTo(page, `#/chat/${BOT}`)
    await app.ready()
    await app.field.fill('half a thought')
    await app.field.press('Enter')
    await expect(app.transcript.locator('.hm-bubble[data-kind="user"]').last()).toContainText('half a thought')
    await page.reload()
    await expect(app.field).toHaveValue('')
  })
})

test.describe('a reply that streams in from the gateway', () => {
  test('is shown as it arrives, says it is busy meanwhile and is announced once, when it is whole', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await expect(app.transcript).toContainText('I am researcher, at your service.')
    await app.ready()

    const announcement = page.locator('.hm-chat__announce')
    const streaming = streamReply(gateway, page, { paragraphs: 30, framesBetween: 3 })

    await expect(app.transcript).toHaveAttribute('aria-busy', 'true')
    expect(await announcement.textContent()).toBe('')

    // Midway: the reply is on screen, still busy, and nothing has been said aloud.
    await expect(page.getByText('Paragraph 10 of the reply')).toBeVisible()
    await expect(app.transcript).toHaveAttribute('aria-busy', 'true')
    expect(await announcement.textContent()).toBe('')

    await streaming
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')
    await expect(announcement).toContainText(' replied: Paragraph 1 of the reply')
    await expect(page.getByText('Paragraph 30 of the reply')).toBeVisible()
    // One reply of thirty paragraphs, not a bubble per delta.
    await expect(
      app.transcript.locator('.hm-bubble[data-kind="assistant"]', { hasText: 'Paragraph 1 of' })
    ).toHaveCount(1)
  })
})

// ── a dropped socket ────────────────────────────────────────────────────────

/** What WebKit logs when a socket is cut under a page: the thing the test did, not a fault of the page. */
const DROPPED_SOCKET = /WebSocket connection to .* failed/u

test.describe('a dropped socket', () => {
  test.use({
    gatewayOptions: {
      streamDelayMs: 120,
      scenario: { replies: [{ match: 'alpha', deltas: parts('Alpha') }, { deltas: ['Fine. '] }] }
    }
  })

  test('mid-reply, the reply still completes, once: no second bubble and no repeated word', async ({
    app,
    diagnostics,
    gateway
  }) => {
    await app.open()
    await app.ready()
    const before = (await gateway.state()).connections

    await app.send('tell me the alpha story')
    await expect(replyOf(app, 'Alpha')).toBeVisible()
    await expect(replyOf(app, 'Alpha')).not.toContainText('Alpha part 12.')

    // Cut without a close frame, as a proxy restart or a lost route does. (WebKit says so on the console.)
    diagnostics.allow(DROPPED_SOCKET)
    expect(await gateway.dropSockets()).toBeGreaterThan(0)

    // The page dials again with a fresh ticket and takes up the turn where it left off.
    await expect.poll(async () => (await gateway.state()).connections).toBeGreaterThan(before)
    await expect(replyOf(app, 'Alpha')).toContainText('Alpha part 24.', { timeout: 30_000 })
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })

    // One reader's bubble, one reply, and the words are exactly the ones the gateway sent, in order.
    await expect(
      app.transcript.locator('.hm-bubble[data-kind="user"]', { hasText: 'tell me the alpha story' })
    ).toHaveCount(1)
    await expect(app.transcript.locator('.hm-bubble[data-kind="assistant"]', { hasText: 'Alpha part 1.' })).toHaveCount(
      1
    )
    // (The bubble ends with its time, which is not the gateway's word.)
    const said = (await replyOf(app, 'Alpha').innerText())
      .replace(/\s+/gu, ' ')
      .replace(/ \d{1,2}:\d{2}( [AP]M)?$/u, '')

    expect(said.trim()).toBe(parts('Alpha').join('').trim())
  })

  test('while idle, the page reconnects, and a message that arrives afterwards is shown once', async ({
    app,
    diagnostics,
    gateway
  }) => {
    await app.open()
    await app.ready()
    const before = (await gateway.state()).connections

    diagnostics.allow(DROPPED_SOCKET)
    expect(await gateway.dropSockets()).toBeGreaterThan(0)
    await expect.poll(async () => (await gateway.state()).connections).toBeGreaterThan(before)
    await expect.poll(async () => (await gateway.state()).openSockets).toBeGreaterThan(0)

    await gateway.inject({ user: 'Anything new?', assistant: 'Nothing new, thank you.' })
    await expect(app.transcript.getByText('Nothing new, thank you.')).toHaveCount(1)
    await expect(app.transcript.getByText('Anything new?')).toHaveCount(1)

    // And it still talks: the connection is a working one.
    await app.send('hello again')
    await expect(app.transcript.locator('.hm-bubble[data-kind="assistant"]').last()).toContainText('Fine.')
  })
})

// ── a long history ──────────────────────────────────────────────────────────

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

/** Half a CSS pixel is the list's own rounding slop (`HOLD_SLOP`). */
const SLOP = 0.5

test.describe('a chat with a long history', () => {
  test.use({ gatewayOptions: { historyRows: 2000 } })

  /** The page has stopped taking in the chat: the rows held and the calls the gateway has heard are not changing. */
  const quiet = (app: App, gateway: Gateway) => async () => [
    await rowCount(app),
    (await gateway.state()).methodLog.length
  ]

  test('opens at the bottom and does not move while it fills in, from the gateway and from the cache', async ({
    app,
    gateway,
    page
  }) => {
    // From the first frame of the document, so nothing of the opening is missed.
    await page.addInitScript(recorder, true)
    await app.open()

    await expect(app.transcript).toBeVisible()
    await expect.poll(() => rowCount(app)).toBeGreaterThan(100)
    // Let the rest of the open (the replay, the tail, the avatars) land while it is being watched.
    await settled(page, quiet(app, gateway), 40)

    const opened = await stopWatch(page)

    expect(opened.framesWithRows).toBeGreaterThan(30)
    expect(opened.worstGap).toBeLessThanOrEqual(SLOP)
    // The newest row is the same one from the first frame that had rows to the last.
    expect(opened.bottomKeys).toHaveLength(1)

    // Only a page of the history is held at first; the rest is behind the top.
    expect(opened.rows).toBeLessThan(2000)
    await expect(app.transcript).toHaveAttribute('aria-label', /Conversation with /)

    // The same chat again: painted from what was kept in the browser, then replaced by what the gateway says.
    await page.reload()
    await expect(app.transcript).toBeVisible()
    await expect.poll(() => rowCount(app)).toBeGreaterThan(100)
    await settled(page, quiet(app, gateway), 40)

    const again = await stopWatch(page)

    expect(again.worstGap).toBeLessThanOrEqual(SLOP)
    expect(again.bottomKeys).toHaveLength(1)
  })

  test('keeps the view pinned while a reply streams in, and follows the newest row', async ({ app, gateway, page }) => {
    await app.open()
    await expect.poll(() => rowCount(app)).toBeGreaterThan(100)
    await settled(page, quiet(app, gateway), 40)

    await page.evaluate(recorder, true)

    await streamReply(gateway, page, { paragraphs: 40, framesBetween: 2 })
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true')
    await expect(page.getByText('Paragraph 40 of the reply')).toBeVisible()
    await settled(page, quiet(app, gateway), 20)

    const watched = await stopWatch(page)

    expect(watched.worstGap).toBeLessThanOrEqual(SLOP)
    expect(watched.framesWithRows).toBeGreaterThan(60)
    // The newest row moved on as the reply arrived (the dots, then the reply), and the view followed it.
    expect(watched.bottomKeys.length).toBeGreaterThan(1)
    await expect(page.getByRole('button', { name: /Jump to latest/ })).toHaveCount(0)
  })

  test('lets the reader read above the bottom, offers "jump to latest" with a count, and goes there on request', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await expect.poll(() => rowCount(app)).toBeGreaterThan(100)
    await settled(page, quiet(app, gateway), 40)
    await expect(page.getByRole('button', { name: /Jump to latest/ })).toHaveCount(0)

    // Up into the middle of what has been loaded.
    await app.transcript.evaluate(log => {
      log.scrollTop = Math.max(0, (log.scrollHeight - log.clientHeight) / 2)
    })
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()

    // The row being read: the first whose bottom is below the top of the scrollport.
    const reading = () =>
      app.transcript.evaluate(log => {
        const top = log.getBoundingClientRect().top
        const row = [...log.querySelectorAll<HTMLElement>('[data-row-key]')].find(
          candidate => candidate.getBoundingClientRect().bottom > top + 1
        )

        return row ? { key: row.dataset.rowKey ?? '', offset: row.getBoundingClientRect().top - top } : null
      })

    const before = await reading()

    expect(before).not.toBeNull()

    await streamReply(gateway, page, { paragraphs: 12, framesBetween: 2 })
    // A second reply arrives whole: two more messages for the count.
    await gateway.inject({ user: 'And one more thing.', assistant: 'Noted, thank you.' })

    await expect(page.getByRole('button', { name: /Jump to latest.*[1-9]\d* new/ })).toBeVisible()
    await settled(page, reading, 20)

    const after = await reading()

    expect(after?.key).toBe(before?.key)
    expect(Math.abs((after?.offset ?? 0) - (before?.offset ?? 0))).toBeLessThanOrEqual(SLOP)

    await page.getByRole('button', { name: /Jump to latest/ }).click()

    await expect(page.getByRole('button', { name: /Jump to latest/ })).toHaveCount(0)
    await expect(app.transcript).toBeFocused()

    // At the newest row. A browser that draws the rows it skipped on the way down may need a frame or two to say how tall they are.
    await expect
      .poll(() => app.transcript.evaluate(log => Math.abs(log.scrollHeight - log.clientHeight - log.scrollTop)))
      .toBeLessThanOrEqual(SLOP)
    await expect(app.transcript.getByText('Noted, thank you.')).toBeVisible()
  })

  test('loads older history when the reader reaches the top, and keeps the row they were on', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await expect.poll(() => rowCount(app)).toBeGreaterThan(100)
    await settled(page, quiet(app, gateway), 40)

    const held = await rowCount(app)

    await app.transcript.evaluate(log => {
      log.scrollTop = 0
    })
    await expect.poll(() => rowCount(app), { timeout: 15_000 }).toBeGreaterThan(held)
    // (A browser that lays out fifteen hundred rows slowly paints a frame in a fifth of a second: ten of them is enough.)
    await settled(page, quiet(app, gateway), 10)

    // Still reading the top of the older page, not thrown to the bottom or to the very first row.
    const gap = await app.transcript.evaluate(log => log.scrollHeight - log.clientHeight - log.scrollTop)

    expect(gap).toBeGreaterThan(200)
  })

  test('colours the listings near the reader and leaves the rest plain, with none seen plain while scrolling', async ({
    app,
    gateway,
    page
  }) => {
    // The history has a listing in every fourth row. Colouring all of them made every full style and
    // layout pass of a long chat several times dearer in WebKit; only the ones near the reader are.
    await app.open()
    await expect.poll(() => rowCount(app)).toBeGreaterThan(100)
    await settled(page, quiet(app, gateway), 40)

    /** Listings in the transcript: how many, how many coloured, and how many in view drawn plain. */
    const listings = () =>
      app.transcript.evaluate(log => {
        const view = log.getBoundingClientRect()
        const blocks = [...log.querySelectorAll<HTMLElement>('pre.md-code-body')].filter(block =>
          block.querySelector('code.language-ts')
        )
        const inView = blocks.filter(block => {
          const box = block.getBoundingClientRect()

          return box.height > 0 && box.bottom > view.top && box.top < view.bottom
        })

        return {
          total: blocks.length,
          coloured: blocks.filter(block => block.querySelector('.md-hl')).length,
          inView: inView.length,
          plainInView: inView.filter(block => !block.querySelector('.md-hl')).length
        }
      })

    await expect.poll(async () => (await listings()).plainInView).toBe(0)

    const opened = await listings()

    expect(opened.inView).toBeGreaterThan(0)
    expect(opened.total).toBeGreaterThan(40)
    // The ones in view and a viewport either side, not the whole history.
    expect(opened.coloured).toBeLessThan(opened.total / 2)

    // Scroll up a tenth of a viewport a frame (six viewports a second, a quick read). Each frame is looked at right after its scroll, before
    // anything else has run: what is in view then is what that frame paints. No listing in it is plain.
    const scrolled = await app.transcript.evaluate(
      log =>
        new Promise<{ seen: number; plain: number }>(resolve => {
          let frames = 0
          let seen = 0
          let plain = 0
          const step = (): void => {
            log.scrollTop -= log.clientHeight / 10

            const view = log.getBoundingClientRect()

            for (const block of log.querySelectorAll<HTMLElement>('pre.md-code-body')) {
              const box = block.getBoundingClientRect()

              if (
                box.height > 0 &&
                box.bottom > view.top &&
                box.top < view.bottom &&
                block.querySelector('code.language-ts')
              ) {
                seen += 1
                plain += block.querySelector('.md-hl') ? 0 : 1
              }
            }

            frames += 1

            if (frames >= 90 || log.scrollTop === 0) {
              resolve({ seen, plain })
            } else {
              requestAnimationFrame(step)
            }
          }

          requestAnimationFrame(step)
        })
    )

    expect(scrolled.seen).toBeGreaterThan(20)
    expect(scrolled.plain).toBe(0)
  })
})
