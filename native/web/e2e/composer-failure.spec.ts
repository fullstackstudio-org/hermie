/**
 * What the composer says when a send is refused, in a real browser against the fake gateway serving the built
 * client.
 *
 *  - **A long refusal** (the gateway's words can be any length) is one paragraph of at most six lines that
 *    scrolls, so the composer stays a few lines tall and the transcript above it keeps its room.
 *  - **A chat that is open in another Hermes window or terminal** (`SESSION_NOT_OWNED`, 4090) gets a sentence of
 *    our own, the gateway's details on one line, and "Start new chat", which starts a new conversation as `/new`
 *    does and leaves the refused words in the empty field. Nothing is sent again by itself.
 */
import { BOT, expect, type Gateway, seriousViolations, test } from './fixtures'

/** The stored id of the bot's chat on the fake gateway, which is what the fake refuses a prompt on. */
function storedIdOf(gateway: Gateway, profile = BOT): string {
  const session = [...gateway.fake.state.sessions.values()].find(entry => entry.profile === profile)

  if (!session) {
    throw new Error(`the fake gateway has no chat for ${profile}`)
  }

  return session.storedId
}

const promptsSent = (gateway: Gateway): number =>
  gateway.fake.state.methodLog.filter(method => method === 'prompt.submit').length

test.describe('a long refusal', () => {
  test('is capped at a few lines and scrolls, so it cannot make the composer tall', async ({ app, gateway }) => {
    await app.open()
    await app.ready()
    gateway.fake.state.promptFailure = 'The gateway could not carry this message, and says so at length. '.repeat(300)

    await app.send('precious words')

    const failure = app.page.locator('.hm-composer__failure')

    await expect(failure).toBeVisible()
    await expect(app.field).toHaveValue('precious words')

    const { client, scroll } = await failure.evaluate(element => ({
      client: element.clientHeight,
      scroll: element.scrollHeight
    }))

    // Six lines of text at most, and the rest is there to scroll to.
    expect(client).toBeLessThan(160)
    expect(scroll).toBeGreaterThan(client * 4)

    const composer = await app.page.locator('.hm-composer').boundingBox()

    expect(composer?.height ?? Infinity).toBeLessThan(360)
  })
})

test.describe('a chat that is open in another window', () => {
  test('says so, never sends again by itself, and starts a new chat with the words in the field', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()
    gateway.fake.state.ownedElsewhere.set(storedIdOf(gateway), 'session 20260923_143304_1025bb opened by cli 4m ago.')

    await app.send('precious words')

    const alert = app.page.getByRole('alert')

    await expect(alert).toContainText('This chat is open in another Hermes window or terminal')
    await expect(alert).not.toContainText('Details:')
    await expect(app.page.getByText('Details: session 20260923_143304_1025bb opened by cli 4m ago.')).toBeVisible()
    // The words are back in the field, and the gateway was asked once.
    await expect(app.field).toHaveValue('precious words')
    expect(promptsSent(gateway)).toBe(1)

    // The reader clears the field; the refused words come back with the new chat, in the empty field.
    await app.field.fill('')
    await app.page.getByRole('button', { name: 'Start new chat' }).click()

    await expect(app.page.getByRole('button', { name: 'Start new chat' })).toHaveCount(0)
    await expect(app.field).toHaveValue('precious words')
    expect(promptsSent(gateway)).toBe(1)
    expect(gateway.fake.state.methodLog).toContain('session.create')

    // Nothing was sent by the click; sending is the reader's, and the new chat is not held elsewhere.
    await app.field.press('Enter')
    await expect(app.transcript.locator('.hm-bubble[data-kind="user"]', { hasText: 'precious words' })).toHaveCount(1)
    await expect(app.transcript.locator('.hm-bubble[data-kind="assistant"]').last()).not.toBeEmpty({ timeout: 20_000 })
    expect(promptsSent(gateway)).toBe(2)
  })
})

test.describe('accessibility', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious violation under a long refusal or the open-elsewhere notice (${scheme})`, async ({
      app,
      gateway,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await app.open()
      await app.ready()

      gateway.fake.state.promptFailure = 'The gateway could not carry this message, and says so at length. '.repeat(300)
      await app.send('precious words')
      await expect(page.locator('.hm-composer__failure')).toBeVisible()
      expect(await seriousViolations(page, `long-refusal-${scheme}`)).toEqual([])

      gateway.fake.state.promptFailure = null
      gateway.fake.state.ownedElsewhere.set(storedIdOf(gateway), 'session 20260923_143304_1025bb opened by cli 4m ago.')
      await app.field.press('Enter')
      await expect(page.getByRole('button', { name: 'Start new chat' })).toBeVisible()
      expect(await seriousViolations(page, `owned-elsewhere-${scheme}`)).toEqual([])
    })
  }
})
