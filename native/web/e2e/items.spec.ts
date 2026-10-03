/**
 * The transcript's item views that are not bubbles, in a real browser, against
 * the fake gateway serving the built client.
 *
 *  - **A cron delivery** (the fixture chat carries one): a card, not the owner's
 *    bubble, open at the default level with the report on it, folding on a
 *    click.
 *  - **A bot-to-bot message** (a teammate's message in the history): one closed
 *    aside on the left that opens on a click to the message, and links to the
 *    teammate's chat because this gateway has that bot. The link goes there; the
 *    row itself does not.
 *  - **Both in both colour schemes through axe**, with the aside and the card
 *    open: no serious violation (contrast included, which jsdom cannot judge).
 */
import { BOT, expect, seriousViolations, test } from './fixtures'

const TEAMMATE_MESSAGE = 'The draft is ready, see the notes.'

test.describe('the item views', () => {
  test.beforeEach(async ({ gateway }) => {
    // Written before the chat is opened, so it arrives as history and is projected as one.
    await gateway.inject({
      user: `Message from \u{1F916} Writer (@writer): ${TEAMMATE_MESSAGE}`,
      assistant: 'Thanks, I will read it.'
    })
  })

  test('a cron delivery is a card, open at the default level, that folds on a click', async ({ app }) => {
    await app.open()

    const line = app.transcript.getByRole('button', { name: /Source scan/u })

    await expect(line).toHaveAttribute('aria-expanded', 'true')
    await expect(app.transcript.locator('.hm-cron__body')).toBeVisible()
    // Not the owner's bubble: the scheduler is not a person.
    await expect(app.transcript.locator('.hm-msg[data-side="own"]', { hasText: 'Cronjob' })).toHaveCount(0)

    await line.click()

    await expect(line).toHaveAttribute('aria-expanded', 'false')
    await expect(app.transcript.locator('.hm-cron__body')).toHaveCount(0)
  })

  test('a teammate’s message is a closed aside that opens, and its link goes to the teammate’s chat', async ({
    app,
    page
  }) => {
    await app.open()

    const aside = app.transcript.locator('.hm-dm[data-kind="bot_dm_in"]')
    const line = aside.getByRole('button')

    await expect(line).toHaveAttribute('aria-expanded', 'false')
    await expect(line).toContainText('From @writer')
    await expect(app.transcript.locator('.hm-bubble', { hasText: TEAMMATE_MESSAGE })).toHaveCount(0)

    await line.click()

    await expect(line).toHaveAttribute('aria-expanded', 'true')
    await expect(aside.locator('.hm-dm__body')).toContainText(TEAMMATE_MESSAGE)

    await aside.getByRole('link', { name: /writer/u }).click()

    await expect(page).toHaveURL(/#\/chat\/writer$/u)
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`the open aside and the cron card have no serious accessibility violation in the ${scheme} scheme`, async ({
      app,
      page
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await app.open(`#/chat/${BOT}`)
      await app.ready()

      await app.transcript.locator('.hm-dm[data-kind="bot_dm_in"]').getByRole('button').click()
      await expect(app.transcript.locator('.hm-dm__body')).toBeVisible()
      await expect(app.transcript.locator('.hm-cron__body')).toBeVisible()

      expect(await seriousViolations(page, `items-${scheme}`)).toEqual([])
    })
  }
})
