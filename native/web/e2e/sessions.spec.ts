/**
 * A bot's other conversations and the search over every bot's messages, in a
 * real browser, against the fake gateway serving the built client.
 *
 *  - **A branch.** A branch is made on the gateway with `session.branch` (over a
 *    socket of the test's own, signed in with a ticket of the same session, as
 *    another client of the reader's would), then reached the way a reader
 *    reaches it: the chat's "Conversations" link, the Branches group, Open. It
 *    opens read-only at `#/chat/<bot>/s/<id>` with the branch's own history, a
 *    line that says so, no composer, and a way back to the chat; reading it
 *    changes nothing on the gateway. Renamed and deleted from the same page,
 *    Delete after a question.
 *  - **Starting anew.** "New conversation" on the same page asks first, then
 *    puts the Bot Chat away under Past conversations and opens the new one.
 *  - **A search hit.** Words typed in the chats field are searched in every
 *    bot's messages after a pause; the hit in the bot's chat is a link that opens
 *    the chat scrolled to the row with the words, marked, and said once. A row
 *    deep in a long history is reached by paging back.
 *  - **Axe**, serious and critical, in light and dark, on the Conversations page,
 *    the viewer and the field with a hit under it.
 */
import type { BrowserContext, Page } from '@playwright/test'

import { BOT, expect, type Gateway, rowCount, seriousViolations, test } from './fixtures'

/** The protocol and the ticket's prefix a gateway socket is opened with (`@hermie/gateway-client`, `credentials.ts`). */
const WS_PROTOCOL = 'hermes-gateway-v1'
const TICKET_PREFIX = 'hermes-gateway-ticket.'

/** The bot's Bot Chat on the fake gateway. */
function canonicalOf(gateway: Gateway, profile = BOT) {
  const session = [...gateway.fake.state.sessions.values()].find(
    entry => entry.profile === profile && entry.title === 'Bot Chat'
  )

  if (!session) {
    throw new Error(`the fake gateway has no Bot Chat for ${profile}`)
  }

  return session
}

/**
 * One JSON-RPC call on a socket of the test's own, signed in as the page is
 * (the session cookie mints a ticket): what another client of the same reader
 * would send. The socket is closed again as soon as the answer is in.
 */
async function rpc(
  gateway: Gateway,
  context: BrowserContext,
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const cookie = (await context.cookies(gateway.url)).map(entry => `${entry.name}=${entry.value}`).join('; ')
  const minted = await fetch(`${gateway.url}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}'
  })

  expect(minted.ok, `ws-ticket answered ${minted.status}`).toBe(true)

  const { ticket } = (await minted.json()) as { ticket: string }
  const socket = new WebSocket(gateway.fake.wsUrl, [WS_PROTOCOL, `${TICKET_PREFIX}${ticket}`])

  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener('error', () => reject(new Error(`the socket for ${method} failed`)))
      socket.addEventListener('open', () =>
        socket.send(`${JSON.stringify({ jsonrpc: '2.0', id: 'e2e-1', method, params })}\n`)
      )
      socket.addEventListener('message', event => {
        for (const line of String(event.data).split('\n')) {
          if (!line.trim()) {
            continue
          }

          const frame = JSON.parse(line) as { id?: unknown; result?: Record<string, unknown>; error?: unknown }

          if (frame.id === 'e2e-1') {
            if (frame.error) {
              reject(new Error(`${method}: ${JSON.stringify(frame.error)}`))
            } else {
              resolve(frame.result ?? {})
            }
          }
        }
      })
    })
  } finally {
    socket.close()
  }
}

/** A message in the bot's chat, written down by the gateway as a turn run elsewhere would be. */
function writeDown(gateway: Gateway, rows: { role: 'user' | 'assistant'; text: string }[]): void {
  const session = canonicalOf(gateway)
  const now = Math.floor(Date.now() / 1000)

  for (const row of rows) {
    session.messages.push({ ...row, row_id: session.messages.length + 1, timestamp: now })
  }
}

/** What the gateway's search answers for these words in this bot, as the page will ask it. */
async function searchHits(gateway: Gateway, context: BrowserContext, query: string): Promise<unknown[]> {
  const cookie = (await context.cookies(gateway.url)).map(entry => `${entry.name}=${entry.value}`).join('; ')
  const response = await fetch(
    `${gateway.url}/api/sessions/search?${new URLSearchParams({ q: query, profile: BOT, limit: '5' })}`,
    { headers: { cookie } }
  )

  return ((await response.json()) as { results: unknown[] }).results
}

const field = (page: Page) => page.getByRole('searchbox', { name: 'Search chats' })
const branchesGroup = (page: Page) => page.getByRole('region', { name: 'Branches' })

test.describe('a branch', () => {
  test('is listed on the bot’s Conversations page and opens read-only, with a way back', async ({
    app,
    page,
    gateway,
    context
  }) => {
    await app.open()
    await app.ready()

    const canonical = canonicalOf(gateway)
    const branch = await rpc(gateway, context, 'session.branch', {
      session_id: canonical.id,
      name: 'Branch · the cheaper flight',
      count: 2
    })
    const branchId = String(branch.stored_session_id)

    // From the chat, the way a reader goes.
    await page.getByRole('link', { name: 'Conversations' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Conversations')
    await expect(page.getByRole('region', { name: 'Current conversation' })).toContainText('Bot Chat')
    // The Bot Chat carries no action at all.
    await expect(page.getByRole('region', { name: 'Current conversation' }).getByRole('button')).toHaveCount(0)

    const row = branchesGroup(page).getByRole('listitem').filter({ hasText: 'Branch · the cheaper flight' })

    await expect(row).toBeVisible()
    await row.getByRole('link', { name: 'Open' }).click()

    await expect(page).toHaveURL(new RegExp(`#/chat/${BOT}/s/${encodeURIComponent(branchId)}$`, 'u'))
    await expect(page.getByText('You are reading an earlier conversation. It cannot be answered.')).toBeVisible()
    // The branch's own history: the first two messages of the chat it was taken from.
    await expect(app.transcript.getByText('Introduce yourself in one line.')).toBeVisible()
    await expect(app.transcript.getByText(`I am ${BOT}, at your service.`)).toBeVisible()
    await expect(app.field).toHaveCount(0)

    // Reading it changed nothing on the gateway: the Bot Chat is still the Bot Chat, the branch still the branch.
    expect(canonicalOf(gateway).storedId).toBe(canonical.storedId)
    expect(gateway.fake.state.sessions.get(branchId)?.title).toBe('Branch · the cheaper flight')

    await page.getByRole('link', { name: 'Back to the chat' }).click()
    await expect(page).toHaveURL(new RegExp(`#/chat/${BOT}$`, 'u'))
    await expect(app.field).toBeVisible()
  })

  test('is renamed and deleted from the Conversations page, after a question', async ({
    app,
    page,
    gateway,
    context
  }) => {
    await app.open(`#/chat/${BOT}`)
    await app.ready()
    await rpc(gateway, context, 'session.branch', {
      session_id: canonicalOf(gateway).id,
      name: 'Branch · first idea',
      count: 1
    })

    await page.getByRole('link', { name: 'Conversations' }).click()

    const row = branchesGroup(page).getByRole('listitem')

    await row.getByRole('button', { name: 'Rename' }).click()
    await page.getByRole('textbox', { name: 'Rename conversation' }).fill('Branch · second idea')
    await page.getByRole('textbox', { name: 'Rename conversation' }).press('Enter')
    await expect(page.getByText('The conversation has a new name.')).toBeVisible()
    await expect(row).toContainText('Branch · second idea')

    await row.getByRole('button', { name: 'Delete' }).click()
    await expect(row).toContainText('will be removed from the gateway. This cannot be undone.')
    await row.getByRole('button', { name: 'Delete' }).click()

    await expect(page.getByText('The conversation was deleted.')).toBeVisible()
    await expect(branchesGroup(page)).toHaveCount(0)
    expect([...gateway.fake.state.sessions.values()].some(entry => entry.title === 'Branch · second idea')).toBe(false)
  })
})

test.describe('starting anew', () => {
  test('asks, puts the Bot Chat away under Past conversations and opens the new one', async ({
    app,
    page,
    gateway
  }) => {
    await app.open(`#/chat/${BOT}/conversations`)
    await expect(page.getByText('Nothing but the current conversation.')).toBeVisible()

    await page.getByRole('button', { name: 'New conversation' }).click()
    await expect(page.getByText(/moves to Past conversations/u)).toBeVisible()
    await page.getByRole('button', { name: 'Start a new conversation' }).click()

    await expect(page).toHaveURL(new RegExp(`#/chat/${BOT}$`, 'u'))
    await expect(app.field).toBeVisible()
    await expect
      .poll(() =>
        [...gateway.fake.state.sessions.values()]
          .filter(entry => entry.profile === BOT)
          .map(entry => entry.title)
          .some(title => title.startsWith('Bot Chat · '))
      )
      .toBe(true)

    await page.getByRole('link', { name: 'Conversations' }).click()
    await expect(page.getByRole('region', { name: 'Past conversations' })).toContainText('Bot Chat · ')
  })
})

test.describe('a search hit', () => {
  test('opens the bot’s chat at the row with the words, marked', async ({ app, page, gateway, context }) => {
    writeDown(gateway, [
      { role: 'user', text: 'Where did we leave the zanzibar itinerary?' },
      { role: 'assistant', text: 'In the shared folder, under trips.' }
    ])
    await app.signIn()
    await expect.poll(async () => (await searchHits(gateway, context, 'zanzibar')).length).toBe(1)

    await page.goto(gateway.appUrl('#/'))
    await field(page).fill('zanzibar')

    const hits = page.getByRole('region', { name: 'IN MESSAGES' })
    const hit = hits.getByRole('link')

    await expect(hit).toHaveCount(1)
    await expect(hit).toHaveAttribute('href', `#/chat/${BOT}`)
    await expect(hit.locator('mark')).toHaveText(/zanzibar/iu)
    await expect(hits.getByRole('status')).toHaveText('Only the best match per chat is shown.')

    await hit.click()

    const found = app.transcript.locator('[data-found="true"]')

    await expect(found).toHaveCount(1)
    await expect(found).toContainText('zanzibar itinerary')
    await expect(found).toBeInViewport()
  })

  test.describe('deep in a long history', () => {
    test.use({ gatewayOptions: { historyRows: 1200 } })

    test('pages back until the row is there', async ({ app, page, gateway, context }) => {
      // The oldest code row of the history: `attempt2 = ...`, matched as a phrase so `attempt22` is not it.
      const query = '"attempt2 ="'

      await app.signIn()
      await expect.poll(async () => (await searchHits(gateway, context, query)).length).toBe(1)

      await page.goto(gateway.appUrl('#/'))
      await field(page).fill(query)
      // Every bot has the same history here: the researcher's hit.
      await page
        .getByRole('region', { name: 'IN MESSAGES' })
        .getByRole('link', { name: /^Researcher/u })
        .click()

      const found = app.transcript.locator('[data-found="true"]')

      await expect(found).toContainText('attempt2 =', { timeout: 30_000 })
      await expect(found).toBeInViewport()
      // The chat opened on its last 200 rows; reaching the oldest code row took the older pages behind them.
      expect(await rowCount(app)).toBeGreaterThan(600)
    })
  })
})

test.describe('accessibility', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious violation on the Conversations page, the viewer and the search (${scheme})`, async ({
      app,
      page,
      gateway,
      context
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await app.open()
      await app.ready()

      const branch = await rpc(gateway, context, 'session.branch', {
        session_id: canonicalOf(gateway).id,
        name: 'Branch · axe',
        count: 2
      })

      await page.getByRole('link', { name: 'Conversations' }).click()
      await expect(branchesGroup(page)).toContainText('Branch · axe')
      expect(await seriousViolations(page, `conversations-${scheme}`)).toEqual([])

      await page.goto(gateway.appUrl(`#/chat/${BOT}/s/${encodeURIComponent(String(branch.stored_session_id))}`))
      await expect(page.getByRole('link', { name: 'Back to the chat' })).toBeVisible()
      await expect(app.transcript.getByText('Introduce yourself in one line.')).toBeVisible()
      expect(await seriousViolations(page, `viewer-${scheme}`)).toEqual([])

      await field(page).fill('service')
      await expect(page.getByRole('region', { name: 'IN MESSAGES' }).getByRole('link').first()).toBeVisible()
      expect(await seriousViolations(page, `search-${scheme}`)).toEqual([])
    })
  }
})
