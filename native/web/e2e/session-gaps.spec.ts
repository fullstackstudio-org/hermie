/**
 * The session gaps (plan W-16), in a real browser against the fake gateway
 * serving the built client.
 *
 *  - **A truncated replay.** The socket is cut, and the replay that makes the
 *    reconnect lossless answers `truncated: true` (`POST /__fake/truncate-next-replay`),
 *    which says the gateway's ring no longer holds everything after the page's
 *    watermark. The page reads the chat again in full (`session.history` goes out
 *    again) and the transcript holds every turn once: nothing missing, nothing
 *    doubled. A replay that vouches for itself reads nothing again.
 *  - **The gateway's notices** (`notification.show` / `.clear`) are drawn over the
 *    page as plain text, and go when the gateway clears them or the reader closes
 *    them.
 *  - **A connector authorisation** (`connection.request`) is a sheet that names the
 *    host each link goes to and counts down to the gateway's deadline; a link opens
 *    in a new tab only when pressed; a `javascript:` link is offered as nothing to
 *    press; the gateway settling the operation closes the sheet.
 *    "Not now" and "Stop waiting" reach the fake's `connection.respond`, which refuses any
 *    key the gateway's strict contract does not list, and the sheet follows its update.
 *  - **Resume progress** (`session.resume_progress`) is a line on the chat while
 *    the gateway loads it, and gone once the load is complete.
 */
import { BOT, expect, type Gateway, test } from './fixtures'

/** Chromium and WebKit say so on the console when a socket is cut without a close frame. */
const DROPPED_SOCKET = /WebSocket connection to .* failed/u

/** The stored id of the bot's chat on the fake gateway, which is what events are addressed by. */
function sessionIdOf(gateway: Gateway, profile = BOT): string {
  const session = [...gateway.fake.state.sessions.values()].find(entry => entry.profile === profile)

  if (!session) {
    throw new Error(`the fake gateway has no chat for ${profile}`)
  }

  return session.storedId
}

const historyReads = (gateway: Gateway): number =>
  gateway.fake.state.methodLog.filter(method => method === 'session.history').length

test.describe('a truncated replay', () => {
  test('reads the chat again in full after the reconnect, and shows every turn once', async ({
    app,
    diagnostics,
    gateway
  }) => {
    await app.open()
    await app.ready()
    await app.send('summarise the notes')
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })
    await expect(app.transcript.locator('.hm-bubble[data-kind="assistant"]').last()).not.toBeEmpty()

    const before = historyReads(gateway)
    const connections = (await gateway.state()).connections

    gateway.fake.state.truncateNextReplay = true
    diagnostics.allow(DROPPED_SOCKET)
    expect(await gateway.dropSockets()).toBeGreaterThan(0)

    await expect.poll(async () => (await gateway.state()).connections).toBeGreaterThan(connections)
    // The replay was answered truncated, and the page went back for the whole conversation.
    await expect.poll(() => gateway.fake.state.truncateNextReplay).toBe(false)
    await expect.poll(() => historyReads(gateway)).toBeGreaterThan(before)

    await app.ready()
    await expect(
      app.transcript.locator('.hm-bubble[data-kind="user"]', { hasText: 'summarise the notes' })
    ).toHaveCount(1)

    // And the chat is a live one: what arrives now is shown, once.
    await gateway.inject({ user: 'Anything new?', assistant: 'Nothing new, thank you.' })
    await expect(app.transcript.getByText('Nothing new, thank you.')).toHaveCount(1)
  })

  test('brings back a turn that ran while the socket was down, once', async ({ app, diagnostics, gateway }) => {
    await app.open()
    await app.ready()
    await app.send('summarise the notes')
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })

    const before = historyReads(gateway)

    // The browser goes offline, so the turn lands while nobody is listening.
    diagnostics.allow(DROPPED_SOCKET)
    diagnostics.allow(/ERR_INTERNET_DISCONNECTED|WebSocket/u)
    await app.page.context().setOffline(true)
    await gateway.dropSockets()
    await expect.poll(async () => (await gateway.state()).openSockets).toBe(0)
    await gateway.inject({ user: 'The night shift says all green.', assistant: 'Thanks, noted.' })
    gateway.fake.state.truncateNextReplay = true
    await app.page.context().setOffline(false)

    await expect.poll(() => historyReads(gateway), { timeout: 30_000 }).toBeGreaterThan(before)
    await expect(app.transcript.getByText('The night shift says all green.')).toHaveCount(1)
    await expect(app.transcript.getByText('Thanks, noted.')).toHaveCount(1)
    await expect(
      app.transcript.locator('.hm-bubble[data-kind="user"]', { hasText: 'summarise the notes' })
    ).toHaveCount(1)
  })

  test('reads nothing again when the replay vouches for itself', async ({ app, diagnostics, gateway }) => {
    await app.open()
    await app.ready()
    await app.send('summarise the notes')
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })

    const replays = gateway.fake.state.eventsSinceCalls.length
    const connections = (await gateway.state()).connections

    diagnostics.allow(DROPPED_SOCKET)
    expect(await gateway.dropSockets()).toBeGreaterThan(0)
    await expect.poll(async () => (await gateway.state()).connections).toBeGreaterThan(connections)
    await expect.poll(() => gateway.fake.state.eventsSinceCalls.length).toBeGreaterThan(replays)
    await app.ready()

    const after = historyReads(gateway)

    // Give a stray re-read every chance to go out: a round trip the page makes for something else.
    await gateway.inject({ user: 'Ping?', assistant: 'Pong.' })
    await expect(app.transcript.getByText('Pong.')).toHaveCount(1)
    expect(historyReads(gateway)).toBe(after)
  })
})

test.describe('what the gateway says beside the transcript', () => {
  test('draws a notice over the page as plain text, until the gateway clears it or the reader closes it', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const notices = app.page.getByRole('list', { name: 'Notices from the gateway' })

    gateway.fake.emit('notification.show', {
      sessionId: sessionIdOf(gateway),
      payload: { text: 'Credits are **low** <img src=x>', level: 'warn', kind: 'sticky', key: 'credits' }
    })
    gateway.fake.emit('notification.show', {
      payload: { text: 'Still starting the agent', level: 'info', kind: 'sticky', key: 'boot' }
    })

    await expect(notices.getByRole('alert')).toHaveText('From Researcher: Credits are **low** <img src=x>')
    await expect(notices.getByRole('status')).toHaveText('Still starting the agent')
    await expect(app.page.locator('.hm-notices img')).toHaveCount(0)

    gateway.fake.emit('notification.clear', { payload: { key: 'boot' } })
    await expect(notices.getByRole('status')).toHaveCount(0)

    await notices.getByRole('button', { name: /^Close the notice: Credits/u }).click()
    await expect(notices).toHaveCount(0)
  })

  test('shows a connector authorisation as a sheet with its hosts and a countdown, and opens a link only when pressed', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const opened: string[] = []

    await app.page
      .context()
      .route('https://auth.example/**', route =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Authorise</title>' })
      )
    app.page.context().on('page', page => opened.push(page.url()))

    const sessionId = sessionIdOf(gateway)

    gateway.fake.emit('connection.request', {
      sessionId,
      payload: {
        op_id: 'op-1',
        tool_call_id: 'tc-1',
        deadline_at: Date.now() / 1000 + 300,
        timeout_seconds: 300,
        targets: [
          {
            name: 'github',
            kind: 'connector',
            action: 'authorize',
            state: 'pending',
            connect_url: 'https://auth.example/connect/github'
          },
          { name: 'evil', kind: 'mcp', action: 'install', state: 'pending', connect_url: 'javascript:alert(1)' }
        ]
      }
    })

    const sheet = app.dialog

    await expect(sheet.getByRole('heading', { name: 'Researcher wants to connect a service' })).toBeVisible()
    await expect(sheet.getByText('Opens auth.example')).toBeVisible()
    await expect(sheet.getByText(/^Time left: [45]:\d\d$/u)).toBeVisible()
    await expect(sheet.getByText(/only https links to a named host are opened/u)).toBeVisible()
    await expect(sheet.getByRole('button', { name: /^Authorise evil/u })).toHaveCount(0)
    expect(opened).toEqual([])

    const popup = app.page.context().waitForEvent('page')

    await sheet.getByRole('button', { name: 'Authorise github at auth.example (opens a new tab)' }).click()
    const tab = await popup

    await tab.waitForLoadState()
    expect(tab.url()).toBe('https://auth.example/connect/github')
    // No way back into the page that opened it.
    expect(await tab.evaluate(() => window.opener)).toBeNull()
    await tab.close()
    await expect(sheet.getByText(/^Opened\./u)).toBeVisible()

    gateway.fake.emit('connection.update', {
      sessionId,
      payload: { op_id: 'op-1', seq: 2, targets: [{ name: 'github', state: 'connected' }] }
    })
    await expect(sheet.getByText('Connected', { exact: true })).toBeVisible()

    gateway.fake.emit('connection.update', {
      sessionId,
      payload: { op_id: 'op-1', seq: 3, settled: true, settled_by: 'all_resolved' }
    })
    await expect(app.page.getByRole('dialog')).toHaveCount(0)
  })

  test('answers "Not now" and "Stop waiting" in exactly the shape the gateway’s contract takes', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const sessionId = sessionIdOf(gateway)
    const runtimeId = [...gateway.fake.state.sessions.values()].find(entry => entry.storedId === sessionId)?.id
    const deadlineAt = Math.floor(Date.now() / 1000) + 300

    // An operation the fake holds open, so its strict `connection.respond` has something to move.
    gateway.fake.state.connectorOps.set('op-7', {
      opId: 'op-7',
      sessionId,
      seq: 0,
      deadlineAt,
      settled: false,
      settledBy: null,
      reads: 0,
      woken: false,
      targets: [
        {
          name: 'github',
          kind: 'connector',
          action: 'authorize',
          state: 'pending',
          connectUrl: null,
          detail: null,
          resolvesTo: 'connected'
        },
        {
          name: 'linear',
          kind: 'connector',
          action: 'authorize',
          state: 'pending',
          connectUrl: null,
          detail: null,
          resolvesTo: 'connected'
        }
      ]
    })
    gateway.fake.emit('connection.request', {
      sessionId,
      payload: {
        op_id: 'op-7',
        seq: 0,
        tool_call_id: 'tc-7',
        deadline_at: deadlineAt,
        timeout_seconds: 300,
        targets: [
          { name: 'github', kind: 'connector', action: 'authorize', state: 'pending' },
          { name: 'linear', kind: 'connector', action: 'authorize', state: 'pending' }
        ]
      }
    })

    const sheet = app.dialog
    const github = sheet.getByRole('listitem').filter({ hasText: 'github' })

    await sheet.getByRole('button', { name: 'Not now: github' }).click()
    await expect(github.getByText('Skipped', { exact: true })).toBeVisible()
    await expect(sheet.getByText(/did not reach the gateway/u)).toHaveCount(0)

    await sheet.getByRole('button', { name: 'Stop waiting' }).click()
    await expect(app.page.getByRole('dialog')).toHaveCount(0)

    expect(gateway.fake.state.connectionResponses).toEqual([
      {
        profile: BOT,
        owner: { type: 'session', session_id: runtimeId },
        op_id: 'op-7',
        result: { targets: [{ name: 'github', status: 'skipped' }] }
      },
      {
        profile: BOT,
        owner: { type: 'session', session_id: runtimeId },
        op_id: 'op-7',
        result: { settled_by: 'continue' }
      }
    ])
  })

  test('puts a line on the chat while the gateway loads it, and takes it away once the load is complete', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const sessionId = sessionIdOf(gateway)

    gateway.fake.emit('session.resume_progress', { sessionId, payload: { phase: 'history', status: 'loading' } })
    await expect(app.page.getByText('The gateway is still loading this conversation…')).toBeVisible()

    gateway.fake.emit('session.resume_progress', {
      sessionId,
      payload: { phase: 'history', status: 'complete', message_count: 2 }
    })
    await expect(app.page.getByText('The gateway is still loading this conversation…')).toHaveCount(0)
  })
})
