/**
 * What a bot asks of the reader (an approval, a question) in a real browser,
 * against the fake gateway serving the built client.
 *
 * The request layer is a modal dialog over the chat. What this proves:
 *
 *  - **Approving and denying.** The prompt "approve" raises an approval on the
 *    gateway; the answer it receives is read back from `/__fake/state`
 *    (`serverRequestAnswers`). With the keyboard alone: focus lands on the
 *    dialog, not on a button; Return and Escape do nothing; Tab stays inside;
 *    the buttons wake a moment after it appears; the chosen one answers and focus
 *    returns to the field.
 *  - **Where it comes from.** A request for a bot whose chat is not on screen
 *    still shows, and names the bot. Several are shown one at a time, oldest
 *    first, with how many are behind.
 *  - **A clarify**, raised through `/__fake/request`: a single question (choice,
 *    words of the reader's own, Skip answering `''`), and a batch of questions
 *    stepped through.
 *  - **Withdrawn.** When the gateway stops waiting, the dialog closes.
 *  - **Restored.** A request raised while no page was looking comes back when the
 *    chat is resumed, and so does one still open when the page is reloaded; both
 *    can still be answered.
 *  - **The page behind it** is inert and out of the tab order while it is open,
 *    and the dialog fits a 320 px phone without scrolling the page sideways.
 *
 * Every spec opens the chat first and only then raises the request: a request
 * raised before the chat is attached is the "restored" case, tested on its own.
 */
import { BOT, expect, goTo, test } from './fixtures'

const approvalParams = (id: string, command: string): Record<string, unknown> => ({
  command,
  choices: ['once', 'deny'],
  request_id: id
})

test.describe('approving', () => {
  test('from the keyboard alone: the prompt raises one, Escape does not close it, focus comes back', async ({
    app,
    browserName,
    gateway,
    page
  }) => {
    // Safari on macOS tabs to links and form fields only; Option+Tab is its key for every control.
    const reachEverything = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab'

    await app.open()
    await app.ready()

    const before = (await gateway.answers()).length

    await app.field.focus()
    await page.keyboard.type('please approve this one')
    await page.keyboard.press('Enter')

    await expect(app.dialog).toBeVisible()
    await expect(app.dialog).toHaveAccessibleName('Allow this command?')
    await expect(app.dialog).toContainText('rm -rf ./build')
    await expect(app.dialog).toContainText('Remove the build directory')
    await expect(app.dialog).toContainText('From Researcher')
    await expect(app.dialog.getByRole('button')).toHaveText([
      'Allow once',
      'Allow for this session',
      'Always allow',
      'Deny'
    ])

    // Focus is on the dialog, not on a button: a Return meant for the field presses nothing.
    await expect(app.dialog).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(app.dialog).toBeVisible()
    expect((await gateway.answers()).length).toBe(before)

    // The page behind it is out of reach: Tab stays inside the dialog.
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab')
      expect(await app.dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    }

    // The buttons wake a moment after the dialog appears (a click already on its way answers nothing).
    await expect(page.getByRole('button', { name: 'Allow once' })).toBeEnabled()

    // Tab to Allow once (past the command, a scroll region that takes focus) and press it.
    await app.dialog.focus()

    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press(reachEverything)

      if (
        await page.getByRole('button', { name: 'Allow once' }).evaluate(element => element === document.activeElement)
      ) {
        break
      }
    }

    await expect(page.getByRole('button', { name: 'Allow once' })).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await gateway.answers()).length).toBe(before + 1)

    const answer = (await gateway.answers()).at(-1)

    expect(answer?.method).toBe('approval')
    expect(answer?.result).toEqual({ choice: 'once' })
    // Focus is back in the field the reader was typing in, and the turn the approval parked goes on to its end.
    await expect(app.field).toBeFocused()
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })
  })

  test('denies, and the gateway is answered with the refusal', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    const before = (await gateway.answers()).length

    await app.send('approve this too')
    await expect(app.dialog).toBeVisible()
    await app.dialog.getByRole('button', { name: 'Deny' }).click()

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await gateway.answers()).length).toBe(before + 1)
    expect((await gateway.answers()).at(-1)?.result).toEqual({ choice: 'deny' })
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })
  })

  test('shows an approval for a bot whose chat is not on screen, and names it', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    await goTo(page, '#/chat/writer')
    await expect(page.getByRole('textbox', { name: 'Message Writer' })).toBeVisible()

    const before = (await gateway.answers()).length

    await gateway.raise('approval', {
      command: 'ls -la',
      description: 'List the directory',
      choices: ['once', 'deny'],
      request_id: 'appr-elsewhere'
    })

    await expect(app.dialog).toBeVisible()
    await expect(app.dialog).toContainText('From Researcher')
    await expect(app.dialog).toContainText('ls -la')
    // The heading behind it is the writer's: the layer is over a chat that is not the one asking.
    await expect(page.getByRole('heading', { level: 1, includeHidden: true })).toHaveText('Writer')

    await app.dialog.getByRole('button', { name: 'Allow once' }).click()
    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await gateway.answers()).length).toBe(before + 1)
    expect((await gateway.answers()).at(-1)?.result).toEqual({ choice: 'once' })
  })

  test('shows what is waiting one at a time, oldest first, and says how many are behind', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    const before = (await gateway.answers()).length

    await gateway.raise('approval', approvalParams('appr-1', 'first command'))
    await expect(app.dialog).toContainText('first command')
    await gateway.raise('approval', approvalParams('appr-2', 'second command'))
    await expect(app.dialog).toContainText('1 more waiting')
    await expect(app.dialog).toContainText('first command')

    await app.dialog.getByRole('button', { name: 'Allow once' }).click()
    await expect(app.dialog).toContainText('second command')
    await expect(app.dialog).not.toContainText('more waiting')
    await app.dialog.getByRole('button', { name: 'Deny' }).click()

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await gateway.answers()).length).toBe(before + 2)
    expect((await gateway.answers()).slice(-2).map(answer => answer.result)).toEqual([
      { choice: 'once' },
      { choice: 'deny' }
    ])
  })
})

test.describe('withdrawn and restored', () => {
  test('closes when the gateway withdraws the request', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    await gateway.raise('approval', approvalParams('appr-w', 'will be withdrawn'))
    await expect(app.dialog).toContainText('will be withdrawn')

    expect(await gateway.withdraw('cancelled')).toBe(1)
    await expect(app.dialog).toHaveCount(0)
    // Nothing was answered: the gateway stopped waiting, the reader did not choose.
    expect(await gateway.answers()).toEqual([])
    // And the field is back in reach.
    await expect(app.field).toBeEnabled()
  })

  test('restores a request raised while no page was looking, when the chat is resumed', async ({
    app,
    gateway,
    page
  }) => {
    await app.signIn()
    await page.goto('about:blank')
    await gateway.raise('clarify', { question: 'Still there?', choices: ['Yes', 'No'], request_id: 'q-restore' })
    await page.goto(gateway.appUrl(`#/chat/${BOT}`))

    await expect(app.dialog).toContainText('Still there?')
    await page.getByRole('radio', { name: 'Yes' }).check()
    await page.getByRole('button', { name: 'Submit' }).click()
    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await gateway.answers()).at(-1)?.result).toEqual({ answer: 'Yes' })
  })

  test('asks again after a reload while it is still open, and the answer still reaches the gateway', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await app.ready()

    await gateway.raise('approval', approvalParams('appr-reload', 'survives a reload'))
    await expect(app.dialog).toContainText('survives a reload')

    await page.reload()
    await expect(app.dialog).toContainText('survives a reload')
    await app.dialog.getByRole('button', { name: 'Allow once' }).click()

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await gateway.answers()).at(-1)?.result).toEqual({ choice: 'once' })
    // Answered once: it is not asked a third time.
    await page.reload()
    await expect(app.field).toBeVisible()
    await expect(app.dialog).toHaveCount(0)
  })
})

test.describe('a question', () => {
  test('answers a clarify with a choice, with the keyboard alone', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    const before = (await gateway.answers()).length

    await gateway.raise('clarify', {
      question: 'Which colour?',
      choices: ['Red', 'Blue', 'Green'],
      request_id: 'q-colour'
    })

    await expect(app.dialog).toHaveAccessibleName('Before I continue')
    await expect(app.dialog).toContainText('Which colour?')
    await expect(app.dialog).toContainText('From Researcher')
    await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled()

    // The arrow keys move a radio group; Tab leaves it.
    await page.getByRole('radio', { name: 'Red' }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('radio', { name: 'Blue' })).toBeChecked()
    await page.getByRole('button', { name: 'Submit' }).focus()
    await page.keyboard.press('Enter')

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await gateway.answers()).length).toBe(before + 1)

    const answer = (await gateway.answers()).at(-1)

    expect(answer?.method).toBe('clarify')
    expect(answer?.result).toEqual({ answer: 'Blue' })
  })

  test('answers a clarify in the reader’s own words', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    const before = (await gateway.answers()).length

    await gateway.raise('clarify', { question: 'What should it be called?', request_id: 'q-name' })
    await page.getByLabel('Or answer in your own words').fill('Something else entirely')
    await page.getByLabel('Or answer in your own words').press('Control+Enter')

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await gateway.answers()).length).toBe(before + 1)
    expect((await gateway.answers()).at(-1)?.result).toEqual({ answer: 'Something else entirely' })
  })

  test('steps through a batch, and Skip answers a question with an empty string', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    const before = (await gateway.answers()).length

    await gateway.raise('clarify', {
      request_id: 'q-batch',
      questions: [
        { qid: 'size', question: 'Which size?', choices: ['S', 'M', 'L'] },
        { qid: 'note', question: 'Anything to add?' },
        { qid: 'extras', question: 'Which extras?', choices: ['a', 'b', 'c'], multi_select: true }
      ]
    })

    await expect(app.dialog).toContainText('Question 1 of 3')
    await page.getByRole('radio', { name: 'M' }).check()
    await page.getByRole('button', { name: 'Next' }).click()

    await expect(app.dialog).toContainText('Question 2 of 3')
    await expect(app.dialog.getByText('Anything to add?')).toBeFocused()
    await page.getByRole('button', { name: 'Skip' }).click()

    await expect(app.dialog).toContainText('Question 3 of 3')
    await page.getByRole('checkbox', { name: 'a' }).check()
    await page.getByRole('checkbox', { name: 'c' }).check()
    await page.getByRole('button', { name: 'Submit' }).click()

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await gateway.answers()).length).toBe(before + 1)
    expect((await gateway.answers()).at(-1)?.result).toEqual({ answers: { size: 'M', note: '', extras: 'a, c' } })
  })

  test('Skip on a single question tells the bot there is no answer', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    const before = (await gateway.answers()).length

    await gateway.raise('clarify', { question: 'Do you mind?', choices: ['Yes', 'No'], request_id: 'q-skip' })
    await page.getByRole('button', { name: 'Skip' }).click()

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await gateway.answers()).length).toBe(before + 1)
    expect((await gateway.answers()).at(-1)?.result).toEqual({ answer: '' })
  })
})

test.describe('the page behind the dialog', () => {
  test('is out of reach while it is open, and back after', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    await gateway.raise('approval', approvalParams('appr-inert', 'ls'))
    await expect(app.dialog).toBeVisible()

    // Behind the dialog nothing takes focus or a click.
    expect(await page.locator('.hm-app').evaluate(element => element.hasAttribute('inert'))).toBe(true)
    // It takes no focus, and a click on it lands on the layer: the field is inert.
    expect(
      await app.field.evaluate(element => {
        element.focus()

        const box = element.getBoundingClientRect()
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)

        return { focused: document.activeElement === element, covered: top !== element }
      })
    ).toEqual({ focused: false, covered: true })

    await app.dialog.getByRole('button', { name: 'Deny' }).click()
    await expect(app.dialog).toHaveCount(0)
    expect(await page.locator('.hm-app').evaluate(element => element.hasAttribute('inert'))).toBe(false)
    await expect(app.field).toBeVisible()
  })

  test('fits a phone: the dialog and the composer do not scroll the page sideways', async ({ app, gateway, page }) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await app.open()
    await app.ready()

    const sideways = (): Promise<boolean> =>
      page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)

    expect(await sideways()).toBe(false)

    await gateway.raise('clarify', {
      question: 'A long question that has to wrap on a narrow screen without making the page scroll sideways at all?',
      choices: ['A choice with quite a lot of words in it to make it wrap', 'Short'],
      request_id: 'q-narrow'
    })
    await expect(app.dialog).toBeVisible()
    expect(await sideways()).toBe(false)

    const box = await app.dialog.boundingBox()

    expect(box?.x).toBeGreaterThanOrEqual(0)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320)

    await page.getByRole('button', { name: 'Skip' }).click()
    await expect(app.dialog).toHaveCount(0)
  })
})
