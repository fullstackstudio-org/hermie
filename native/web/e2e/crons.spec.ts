/**
 * The Crons pages and the Activity timeline in a real browser, against the fake gateway serving the built client.
 *
 *  - **The list.** Reached from the sidebar with the keyboard; every cron of every profile (the fake keeps one in
 *    `researcher`'s own store, which the socket's list cannot see), active apart from paused, the schedule in words,
 *    the last result and the error that went with it. Pause and Resume are the gateway's: the socket sees the
 *    change, and the row moves between the groups.
 *  - **One cron.** The full prompt, where it delivers (with the chat it delivers into), the run history newest first
 *    with each run a link, and a run that opens read-only with its transcript. Run now adds a run; Delete asks first.
 *  - **The editor.** What is missing is said under the field and nothing is sent; the gateway's own refusal of a
 *    schedule is shown and keeps what was typed; a valid cron is created in the gateway and the reader lands on it;
 *    an edit sends only what changed.
 *  - **Activity.** The timeline of what the bots said to each other, a row a link into the chat where it happened.
 *  - **Axe**, serious and critical, in light and dark, on each page.
 */
import type { Page } from '@playwright/test'

import { expect, type Gateway, seriousViolations, test } from './fixtures'

interface FakeCronJob {
  id: string
  name: string
  schedule: string
  prompt: string
  enabled: boolean
  profile: string
  runs: unknown[]
}

const jobsOf = (gateway: Gateway): FakeCronJob[] => gateway.fake.state.cronJobs as unknown as FakeCronJob[]

const jobNamed = (gateway: Gateway, name: string): FakeCronJob => {
  const job = jobsOf(gateway).find(entry => entry.name === name)

  if (!job) {
    throw new Error(`the fake gateway has no cron named ${name}`)
  }

  return job
}

const mainPane = (page: Page) => page.getByRole('main')
const rowOf = (page: Page, name: string) => mainPane(page).getByRole('listitem').filter({ hasText: name }).first()

/** The sidebar's way to the Crons, by keyboard: focus it and press Return, as a keyboard reader does. */
async function openCronsByKeyboard(page: Page): Promise<void> {
  const link = page.getByRole('link', { name: 'Crons', exact: true })

  await link.focus()
  await expect(link).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/crons$/u)
}

test.describe('the list', () => {
  test('is reached from the sidebar by keyboard and draws every cron of every profile', async ({ app, page }) => {
    await app.open()
    await app.ready()
    await openCronsByKeyboard(page)

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Crons')
    await expect(mainPane(page).getByRole('heading', { name: 'ACTIVE' })).toBeVisible()
    await expect(mainPane(page).getByRole('heading', { name: 'PAUSED' })).toBeVisible()

    const heartbeat = rowOf(page, 'VM heartbeat')

    await expect(heartbeat).toContainText('Every 2 hours')
    await expect(heartbeat).toContainText(/next: in 2 hours/u)
    await expect(heartbeat).toContainText('Success')

    const digest = rowOf(page, 'Weekly digest')

    await expect(digest).toContainText('Every Friday at 4:30 PM')
    await expect(digest).toContainText('Failed')
    await expect(digest).toContainText("Cron job 'Weekly digest' has no model configured.")

    // Owned by a bot's own store: only the REST list can see it.
    await expect(rowOf(page, 'Source scan')).toContainText('Profile: researcher')
    await expect(rowOf(page, 'Inbox cleanup')).toContainText('Paused')
  })

  test('pauses and resumes a cron on the gateway, and the row moves between the groups', async ({
    app,
    page,
    gateway
  }) => {
    await app.open('#/crons')

    const row = rowOf(page, 'VM heartbeat')

    await row.getByRole('button', { name: 'Pause: VM heartbeat' }).click()
    await expect(mainPane(page).getByText('VM heartbeat is paused.')).toBeVisible()
    await expect(
      mainPane(page).getByRole('region', { name: 'PAUSED' }).getByRole('link', { name: 'VM heartbeat' })
    ).toBeVisible()
    expect(jobNamed(gateway, 'VM heartbeat').enabled).toBe(false)

    await rowOf(page, 'VM heartbeat').getByRole('button', { name: 'Resume: VM heartbeat' }).click()
    await expect(mainPane(page).getByText('VM heartbeat is active again.')).toBeVisible()
    await expect(
      mainPane(page).getByRole('region', { name: 'ACTIVE' }).getByRole('link', { name: 'VM heartbeat' })
    ).toBeVisible()
    expect(jobNamed(gateway, 'VM heartbeat').enabled).toBe(true)
  })

  test('says the scheduler is not running when the gateway says so', async ({ app, page, gateway }) => {
    gateway.fake.state.cronGatewayRunning = false
    await app.open('#/crons')

    await expect(mainPane(page).getByText(/Crons will not run/u)).toBeVisible()
  })

  test('follows a change made elsewhere, without a reload', async ({ app, page, gateway }) => {
    await app.open('#/crons')
    await expect(rowOf(page, 'VM heartbeat')).toBeVisible()

    // Another client creates one over REST: the gateway broadcasts `cron.changed`.
    const created = await fetch(`${gateway.url}/api/cron/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookieOf(page, gateway) },
      body: JSON.stringify({ name: 'From elsewhere', schedule: 'every 3h', prompt: 'Hello.', deliver: 'local' })
    })

    expect(created.ok).toBe(true)
    await expect(rowOf(page, 'From elsewhere')).toBeVisible()
  })
})

async function cookieOf(page: Page, gateway: Gateway): Promise<string> {
  return (await page.context().cookies(gateway.url)).map(entry => `${entry.name}=${entry.value}`).join('; ')
}

test.describe('one cron', () => {
  test('shows the full prompt, the delivery with its chat, and a run history of links', async ({ app, page }) => {
    await app.open('#/crons')
    await rowOf(page, 'VM heartbeat').getByRole('link', { name: 'VM heartbeat' }).click()

    await expect(page).toHaveURL(/#\/crons\/job-heartbeat$/u)
    await expect(mainPane(page).getByRole('heading', { name: 'VM heartbeat', level: 2 })).toBeVisible()
    await expect(
      mainPane(page).getByText('Check the VM, summarize disk and memory, and flag anything unusual.')
    ).toBeVisible()
    await expect(mainPane(page).getByText('Every 2 hours').first()).toBeVisible()

    const runs = mainPane(page)
      .getByRole('list')
      .filter({ has: page.getByRole('link', { name: /^View run/u }) })

    await expect(runs.getByRole('listitem')).toHaveCount(2)
    // Newest first; the run that did not finish says so.
    await expect(runs.getByRole('listitem').first()).toContainText('Done — nothing needs your attention.')
    await expect(runs.getByRole('listitem').last()).toContainText('The check did not complete.')
    await expect(runs.getByRole('listitem').last()).toContainText('Interrupted')

    await page.getByRole('link', { name: 'Crons', exact: true }).first().click()
    await rowOf(page, 'Weekly digest').getByRole('link', { name: 'Weekly digest' }).click()
    await expect(mainPane(page).getByText('Bot Chat (researcher)')).toBeVisible()
    await mainPane(page)
      .getByRole('link', { name: /^Open the chat with/u })
      .click()
    await expect(page).toHaveURL(/#\/chat\/researcher$/u)
  })

  test('opens a run read-only, with its transcript, and nothing is resumed', async ({ app, page, gateway }) => {
    await app.open('#/crons/job-heartbeat')
    await mainPane(page)
      .getByRole('link', { name: /^View run/u })
      .first()
      .click()

    await expect(page).toHaveURL(/#\/crons\/job-heartbeat\/runs\/cron_job-heartbeat_\d+$/u)
    await expect(mainPane(page).getByText(/Read-only: a cron run cannot be continued/u)).toBeVisible()
    await expect(
      mainPane(page).getByText('Check the VM, summarize disk and memory, and flag anything unusual.')
    ).toBeVisible()
    // The chat's own views drew it: the run's tool call is a tool card.
    await expect(
      mainPane(page)
        .getByText(/read_file/u)
        .first()
    ).toBeVisible()
    expect(JSON.stringify(await gateway.state().then(state => state.methodLog))).not.toContain('session.resume')

    await mainPane(page).getByRole('link', { name: 'VM heartbeat' }).first().click()
    await expect(page).toHaveURL(/#\/crons\/job-heartbeat$/u)
  })

  test('runs now, which adds a run to the history', async ({ app, page, gateway }) => {
    await app.open('#/crons/job-cleanup')

    await expect(mainPane(page).getByText('This cron has not run yet.')).toBeVisible()
    await mainPane(page).getByRole('button', { name: 'Run now' }).click()

    await expect(mainPane(page).getByText('Inbox cleanup is running now.')).toBeVisible()
    await expect(mainPane(page).getByRole('link', { name: /^View run/u })).toHaveCount(1)
    expect(jobNamed(gateway, 'Inbox cleanup').runs).toHaveLength(1)
  })

  test('asks before it deletes, then goes back to the list', async ({ app, page, gateway }) => {
    await app.open('#/crons/job-digest')

    await mainPane(page).getByRole('button', { name: 'Delete cron' }).click()
    await expect(mainPane(page).getByText(/The schedule is removed from the gateway/u)).toBeVisible()
    await mainPane(page).getByRole('button', { name: 'Keep it' }).click()
    expect(jobsOf(gateway).some(job => job.name === 'Weekly digest')).toBe(true)

    await mainPane(page).getByRole('button', { name: 'Delete cron' }).click()
    await mainPane(page).getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(page).toHaveURL(/#\/crons$/u)
    await expect(mainPane(page).getByText('Weekly digest was deleted.')).toBeVisible()
    await expect(rowOf(page, 'Weekly digest')).toHaveCount(0)
    expect(jobsOf(gateway).some(job => job.name === 'Weekly digest')).toBe(false)
  })
})

test.describe('the editor', () => {
  test('says what is missing, and sends nothing', async ({ app, page, gateway }) => {
    await app.open('#/crons/new')

    const before = jobsOf(gateway).length

    await mainPane(page).getByRole('button', { name: 'Save cron' }).click()
    await expect(mainPane(page).getByText('Give the cron a name.')).toBeVisible()
    await expect(mainPane(page).getByText('Write the instructions the bot should follow.')).toBeVisible()
    await expect(mainPane(page).getByRole('textbox', { name: 'Name' })).toBeFocused()

    await mainPane(page).getByRole('textbox', { name: 'Name' }).fill('Odd')
    await mainPane(page).getByRole('textbox', { name: 'Instructions' }).fill('Do it.')
    await mainPane(page).getByRole('spinbutton', { name: 'Every' }).fill('0')
    await mainPane(page).getByRole('button', { name: 'Save cron' }).click()
    await expect(mainPane(page).getByText(/how many minutes, hours or days/u)).toBeVisible()
    expect(jobsOf(gateway)).toHaveLength(before)
  })

  test('shows the gateway’s own refusal of a schedule and keeps what was typed', async ({ app, page, gateway }) => {
    await app.open('#/crons/new')

    const before = jobsOf(gateway).length

    await mainPane(page).getByRole('textbox', { name: 'Name' }).fill('Odd')
    await mainPane(page).getByRole('textbox', { name: 'Instructions' }).fill('Do it.')
    // The builder takes a date shaped like a date; the gateway's parser knows that month is not one.
    await mainPane(page).getByRole('radio', { name: 'Once' }).check()
    await mainPane(page).getByRole('textbox', { name: 'When' }).fill('2026-13-45')
    await mainPane(page).getByRole('button', { name: 'Save cron' }).click()

    await expect(mainPane(page).getByRole('alert')).toContainText(
      "The gateway refused the cron: Invalid timestamp '2026-13-45'"
    )
    await expect(page).toHaveURL(/#\/crons\/new$/u)
    await expect(mainPane(page).getByRole('textbox', { name: 'Name' })).toHaveValue('Odd')
    expect(jobsOf(gateway)).toHaveLength(before)

    // Mended, it goes through.
    await mainPane(page).getByRole('textbox', { name: 'When' }).fill('in 2h')
    await mainPane(page).getByRole('button', { name: 'Save cron' }).click()
    await expect(page).toHaveURL(/#\/crons\/job-/u)
    expect(jobsOf(gateway)).toHaveLength(before + 1)
  })

  test('creates a cron in the profile and delivery chosen, and lands on it', async ({ app, page, gateway }) => {
    await app.open('#/crons/new')

    await mainPane(page).getByRole('textbox', { name: 'Name' }).fill('Nightly sweep')
    await mainPane(page).getByRole('textbox', { name: 'Instructions' }).fill('Sweep the logs.')
    await mainPane(page).getByRole('radio', { name: 'Daily' }).check()
    await mainPane(page).getByLabel('Time').fill('18:30')
    await mainPane(page).getByRole('checkbox', { name: 'Monday' }).check()
    await mainPane(page).getByRole('checkbox', { name: 'Friday' }).check()
    await expect(mainPane(page).getByText('Every Monday and Friday at 6:30 PM')).toBeVisible()
    await expect(mainPane(page).getByText('Sends to the gateway as: every monday, friday at 6:30pm')).toBeVisible()
    await mainPane(page).getByLabel('Delivers to').selectOption('bot-chat:researcher')
    await mainPane(page).getByLabel('Profile').selectOption('writer')
    await mainPane(page).getByRole('button', { name: 'Save cron' }).click()

    await expect(page).toHaveURL(/#\/crons\/job-/u)
    await expect(mainPane(page).getByRole('heading', { name: 'Nightly sweep', level: 2 })).toBeVisible()
    await expect(mainPane(page).getByText('Nightly sweep was created.')).toBeVisible()

    const job = jobNamed(gateway, 'Nightly sweep')

    expect(job).toMatchObject({
      schedule: 'every monday, friday at 6:30pm',
      prompt: 'Sweep the logs.',
      profile: 'writer'
    })
  })

  test('edits a cron, sending only what changed', async ({ app, page, gateway }) => {
    await app.open('#/crons/job-heartbeat')
    await mainPane(page).getByRole('link', { name: 'Edit' }).click()

    await expect(page).toHaveURL(/#\/crons\/job-heartbeat\/edit$/u)
    await expect(mainPane(page).getByRole('textbox', { name: 'Instructions' })).toHaveValue(
      'Check the VM, summarize disk and memory, and flag anything unusual.'
    )
    await mainPane(page).getByRole('textbox', { name: 'Name' }).fill('Heartbeat, renamed')
    await mainPane(page).getByRole('button', { name: 'Save cron' }).click()

    await expect(page).toHaveURL(/#\/crons\/job-heartbeat$/u)
    await expect(mainPane(page).getByText('Heartbeat, renamed was saved.')).toBeVisible()
    expect(jobsOf(gateway).find(job => job.id === 'job-heartbeat')).toMatchObject({
      name: 'Heartbeat, renamed',
      schedule: 'every 2h'
    })

    // And the schedule, changed on purpose, is the gateway's to recompute.
    await mainPane(page).getByRole('link', { name: 'Edit' }).click()
    await mainPane(page).getByRole('spinbutton', { name: 'Every' }).fill('15')
    await mainPane(page).getByLabel('Unit').selectOption('minutes')
    await mainPane(page).getByRole('button', { name: 'Save cron' }).click()
    await expect(page).toHaveURL(/#\/crons\/job-heartbeat$/u)
    expect(jobsOf(gateway).find(job => job.id === 'job-heartbeat')?.schedule).toBe('every 15m')
  })

  test('shows the refusal of an edit in the gateway’s words', async ({ app, page, diagnostics }) => {
    // The browser itself logs the 400 the gateway answers an edit it refuses with.
    diagnostics.allow(/status of 400/u)
    await app.open('#/crons/job-heartbeat/edit')
    await mainPane(page).getByRole('radio', { name: 'Once' }).check()
    await mainPane(page).getByRole('textbox', { name: 'When' }).fill('2026-13-45')
    await mainPane(page).getByRole('button', { name: 'Save cron' }).click()

    await expect(mainPane(page).getByRole('alert')).toContainText('Invalid timestamp')
    await expect(page).toHaveURL(/#\/crons\/job-heartbeat\/edit$/u)
  })
})

test.describe('activity', () => {
  test('is reached from the sidebar and draws what the bots said to each other, newest first', async ({
    app,
    page
  }) => {
    await app.open()
    await app.ready()

    const link = page.getByRole('link', { name: 'Activity', exact: true })

    await link.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#\/activity$/u)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Activity')
    await expect(mainPane(page).getByRole('heading', { name: 'Today' })).toBeVisible()

    // The researcher asked the writer to draft the announcement, and the writer's run of questions is there too.
    const row = mainPane(page).getByRole('link').filter({ hasText: 'Can you draft the announcement?' }).first()

    await expect(row).toContainText('→')
    await expect(mainPane(page).locator('.hm-activity__counter')).toHaveCount(3)
  })

  test('opens the chat where a row happened, at the message', async ({ app, page }) => {
    await app.open('#/activity')

    await mainPane(page).getByRole('link').filter({ hasText: 'Can you draft the announcement?' }).first().click()

    await expect(page).toHaveURL(/#\/chat\/researcher$/u)
    await expect(app.transcript.getByText('Can you draft the announcement?').first()).toBeVisible()
  })
})

test.describe('axe', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no serious violation on the Crons pages and the timeline (${scheme})`, async ({ app, page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await app.open('#/crons')
      await expect(rowOf(page, 'VM heartbeat')).toBeVisible()
      expect(await seriousViolations(page, `crons-list-${scheme}`)).toEqual([])

      await rowOf(page, 'VM heartbeat').getByRole('link', { name: 'VM heartbeat' }).click()
      await expect(
        mainPane(page)
          .getByRole('link', { name: /^View run/u })
          .first()
      ).toBeVisible()
      expect(await seriousViolations(page, `crons-detail-${scheme}`)).toEqual([])

      await mainPane(page).getByRole('button', { name: 'Delete cron' }).click()
      expect(await seriousViolations(page, `crons-delete-${scheme}`)).toEqual([])
      await mainPane(page).getByRole('button', { name: 'Keep it' }).click()

      await mainPane(page).getByRole('link', { name: 'Edit' }).click()
      await expect(mainPane(page).getByRole('textbox', { name: 'Instructions' })).toBeVisible()
      await mainPane(page).getByRole('button', { name: 'Save cron' }).click()
      expect(await seriousViolations(page, `crons-editor-${scheme}`)).toEqual([])

      await page.goto(page.url().replace(/#.*$/u, '#/crons/job-heartbeat'))
      await mainPane(page)
        .getByRole('link', { name: /^View run/u })
        .first()
        .click()
      await expect(mainPane(page).getByText(/Read-only/u)).toBeVisible()
      expect(await seriousViolations(page, `crons-run-${scheme}`)).toEqual([])

      await page.goto(page.url().replace(/#.*$/u, '#/activity'))
      await expect(mainPane(page).getByRole('heading', { name: 'Today' })).toBeVisible()
      expect(await seriousViolations(page, `activity-${scheme}`)).toEqual([])
    })
  }
})
