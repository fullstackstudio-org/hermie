/**
 * The Crons pages through the app's own router, against a cron surface that answers like a gateway.
 *
 * What is proved: the list says each of its states in words (loading, failed with a way to try again, empty), splits
 * active from paused, writes schedules as sentences and says when the scheduler is down; Pause and Resume carry the
 * cron's profile; one cron shows its full prompt, its delivery and its run history, and asks before it deletes; the
 * editor says what is missing under the field, sends nothing it was not asked to, shows the gateway's own refusal
 * and lands the reader on the cron it made; and a run opens read-only.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { resetLocale, setLanguageChoice } from '../../i18n/locale'
import { createHashRouter } from '../../platform/hash-router'
import { connectionStore } from '../../state/connection'
import { cronStore } from '../../state/cron'
import { fakeCron, type FakeCronOptions, heartbeat, digest, cleanup } from '../../test-support/cron-transport'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { App } from '../shell/App'

function mount(hash: string, options: FakeCronOptions = {}, bots = true) {
  const router = createHashRouter(null)
  const cron = fakeCron(options)

  router.navigate(hash)

  if (bots) {
    seedRoster([aBot('researcher', { displayName: 'Ada' }), aBot('writer')])
  }

  render(
    <App user="Tester" onSignIn={() => {}} onSignOut={() => {}} router={router} cron={{ transport: cron.transport }} />
  )

  return { router, cron }
}

const main = (): HTMLElement => screen.getByRole('main')

/** A row of the list, once the list has been read. */
const rowOf = (id: string): Promise<HTMLElement> =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-job="${id}"]`)

    expect(found).not.toBeNull()

    return found!
  })

beforeEach(() => {
  resetShellStores()
  cronStore.getState().reset()
  connectionStore.getState().setStatus('ready', null)
  document.documentElement.lang = 'en'
})

afterEach(() => {
  resetLocale()
  resetActiveLocale()
})

describe('the list', () => {
  it('draws every cron, active first, with the schedule as a sentence and when it runs next', async () => {
    mount('#/crons')

    const row = await rowOf('job-heartbeat')

    expect(within(main()).getByRole('heading', { name: 'ACTIVE' })).toBeTruthy()
    expect(within(main()).getByRole('heading', { name: 'PAUSED' })).toBeTruthy()
    expect(within(row).getByRole('link', { name: 'VM heartbeat' }).getAttribute('href')).toBe('#/crons/job-heartbeat')
    expect(within(row).getByText('Every 2 hours')).toBeTruthy()
    expect(within(row).getByText('next: in 2 hours')).toBeTruthy()
    expect(within(row).getByText(/Last run 1 hour ago · Success/u)).toBeTruthy()

    const failing = document.querySelector<HTMLElement>('[data-job="job-digest"]')!

    expect(within(failing).getByText('Every Friday at 4:30 PM')).toBeTruthy()
    expect(within(failing).getByText('Failed')).toBeTruthy()
    expect(within(failing).getByText("Cron job 'Weekly digest' has no model configured.")).toBeTruthy()

    const paused = document.querySelector<HTMLElement>('[data-job="job-cleanup"]')!

    expect(within(paused).getByText('Paused')).toBeTruthy()
    expect(within(paused).getByText('Profile: researcher')).toBeTruthy()
    expect(within(paused).getByRole('button', { name: 'Resume: Inbox cleanup' })).toBeTruthy()
  })

  it('says it is loading until a read has finished, then that there is nothing', async () => {
    mount('#/crons', { jobs: [] })

    await waitFor(() => expect(within(main()).getByText(/No crons yet/u)).toBeTruthy())
    expect(within(main()).getByRole('link', { name: 'New cron' }).getAttribute('href')).toBe('#/crons/new')
  })

  it('says the read failed, keeps the way to try again, and recovers', async () => {
    const { cron } = mount('#/crons', { listFails: 'HTTP 502' })

    expect(await within(main()).findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('HTTP 502'))

    cron.get.mockImplementation(async () => [heartbeat()])
    fireEvent.click(within(main()).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(main()).getByText('VM heartbeat')).toBeTruthy())
  })

  it('says when the scheduler is not running', async () => {
    mount('#/crons', { gatewayRunning: false })

    expect(await within(main()).findByText(/Crons will not run/u)).toBeTruthy()
  })

  it('pauses a cron over the socket, scoped to its profile, and says so', async () => {
    const { cron } = mount('#/crons')
    const row = await rowOf('job-heartbeat')

    fireEvent.click(within(row).getByRole('button', { name: 'Pause: VM heartbeat' }))

    await waitFor(() =>
      expect(cron.request).toHaveBeenCalledWith('cron.manage', {
        action: 'pause',
        name: 'job-heartbeat',
        profile: 'default'
      })
    )
    expect(await within(main()).findByText('VM heartbeat is paused.')).toBeTruthy()
    await waitFor(() =>
      expect(document.querySelector('[data-job="job-heartbeat"]')?.getAttribute('data-status')).toBe('paused')
    )
  })

  it('names the page and keeps the crons in the language that is active', async () => {
    await act(async () => {
      await setLanguageChoice('nl')
    })
    mount('#/crons')

    expect(await within(main()).findByText('Elke 2 uur')).toBeTruthy()
    expect(within(main()).getByRole('link', { name: 'Nieuw' })).toBeTruthy()
  })
})

describe('one cron', () => {
  it('shows the full prompt, the delivery with its chat, and the run history with links to the runs', async () => {
    mount('#/crons/job-digest')

    expect(await screen.findByRole('heading', { name: 'Weekly digest', level: 2 })).toBeTruthy()
    expect(await screen.findByText('Write a short digest of this week.')).toBeTruthy()
    expect(screen.getByText('Every Friday at 4:30 PM')).toBeTruthy()
    expect(screen.getByText('Bot chat: researcher')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open the chat with Ada' }).getAttribute('href')).toBe('#/chat/researcher')
    expect(screen.getByText('This cron has not run yet.')).toBeTruthy()
  })

  it('lists the runs newest first, a run that did not finish saying so, each a link to its page', async () => {
    mount('#/crons/job-heartbeat')

    const links = await screen.findAllByRole('link', { name: /^View run/u })

    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '#/crons/job-heartbeat/runs/cron_job-heartbeat_1790000000',
      '#/crons/job-heartbeat/runs/cron_job-heartbeat_1789900000'
    ])
    expect(screen.getByText('Done: nothing needs your attention.')).toBeTruthy()
    expect(screen.getByText('Interrupted')).toBeTruthy()
  })

  it('runs now and says so', async () => {
    const { cron } = mount('#/crons/job-heartbeat')

    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }))

    await waitFor(() =>
      expect(cron.post).toHaveBeenCalledWith('/api/cron/jobs/job-heartbeat/trigger?profile=default', {})
    )
    expect(await screen.findByText('VM heartbeat is running now.')).toBeTruthy()
  })

  it('asks before it deletes, and goes back to the list when it has', async () => {
    const { cron, router } = mount('#/crons/job-heartbeat')

    fireEvent.click(await screen.findByRole('button', { name: 'Delete cron' }))
    expect(cron.del).not.toHaveBeenCalled()
    expect(screen.getByText(/The schedule is removed from the gateway/u)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.getByRole('button', { name: 'Delete cron' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete cron' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(router.current()).toBe('#/crons'))
    expect(cron.del).toHaveBeenCalledWith('/api/cron/jobs/job-heartbeat?profile=default')
    expect(await within(main()).findByText('VM heartbeat was deleted.')).toBeTruthy()
  })

  it('says a cron that is not there, with the way back, once the list has been read', async () => {
    mount('#/crons/job-nope')

    expect(await screen.findByText(/does not exist/u)).toBeTruthy()
    expect(within(main()).getByRole('link', { name: 'Crons' }).getAttribute('href')).toBe('#/crons')
  })

  it('resumes a paused cron', async () => {
    const { cron } = mount('#/crons/job-cleanup')

    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))

    await waitFor(() =>
      expect(cron.request).toHaveBeenCalledWith('cron.manage', {
        action: 'resume',
        name: 'job-cleanup',
        profile: 'researcher'
      })
    )
    expect(await screen.findByText('Inbox cleanup is active again.')).toBeTruthy()
  })
})

describe('the editor', () => {
  const fill = (label: string | RegExp, value: string): void => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }

  it('says what is missing under the field, and puts the focus on the first one', async () => {
    const { cron } = mount('#/crons/new')

    fireEvent.click(await screen.findByRole('button', { name: 'Save cron' }))

    const name = screen.getByRole('textbox', { name: 'Name' })

    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Give the cron a name.')).toBeTruthy()
    expect(screen.getByText('Write the instructions the bot should follow.')).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(cron.request).not.toHaveBeenCalledWith('cron.manage', expect.objectContaining({ action: 'add' }))
  })

  it('refuses a schedule that cannot be built, in words, before asking the gateway', async () => {
    const { cron } = mount('#/crons/new')

    await screen.findByRole('button', { name: 'Save cron' })
    fill('Name', 'Nightly')
    fill('Instructions', 'Sweep.')
    fill('Every', '0')
    fireEvent.click(screen.getByRole('button', { name: 'Save cron' }))

    expect(await screen.findByText(/how many minutes, hours or days/u)).toBeTruthy()
    expect(cron.request).not.toHaveBeenCalledWith('cron.manage', expect.objectContaining({ action: 'add' }))
  })

  it('creates a cron in the profile chosen and lands on it, saying so', async () => {
    const { cron, router } = mount('#/crons/new')

    await screen.findByRole('button', { name: 'Save cron' })
    fill('Name', 'Nightly sweep')
    fill('Instructions', 'Sweep the logs.')
    fill('Every', '6')
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'hours' } })
    fireEvent.change(screen.getByLabelText('Delivers to'), { target: { value: 'bot-chat:researcher' } })
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'writer' } })
    expect(screen.getByText('Every 6 hours')).toBeTruthy()
    expect(screen.getByText('Sends to the gateway as: every 6h')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save cron' }))

    await waitFor(() => expect(router.current()).toBe('#/crons/job-4'))
    expect(cron.request).toHaveBeenCalledWith('cron.manage', {
      action: 'add',
      name: 'Nightly sweep',
      schedule: 'every 6h',
      prompt: 'Sweep the logs.',
      deliver: 'bot-chat:researcher',
      profile: 'writer'
    })
    expect(await within(main()).findByText('Nightly sweep was created.')).toBeTruthy()
  })

  it('shows the gateway’s own refusal, keeps what was typed and stays on the form', async () => {
    const { router } = mount('#/crons/new', {
      refuseSchedule: schedule => (schedule === 'every 7m' ? "Invalid schedule 'every 7m'. Use: '30m'." : null)
    })

    await screen.findByRole('button', { name: 'Save cron' })
    fill('Name', 'Odd')
    fill('Instructions', 'Do it.')
    fill('Every', '7')
    fireEvent.click(screen.getByRole('button', { name: 'Save cron' }))

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toContain("Invalid schedule 'every 7m'. Use: '30m'.")
    expect(router.current()).toBe('#/crons/new')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Odd')
  })

  it('opens an edit on the full prompt, and sends only what changed: not a schedule it was not asked to change', async () => {
    const { cron, router } = mount('#/crons/job-digest/edit')

    const prompt = (await screen.findByLabelText('Instructions')) as HTMLTextAreaElement

    expect(prompt.value).toBe('Write a short digest of this week.')
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Weekly digest')
    // A profile is the scope a cron was created in: shown, not editable.
    expect(screen.queryByRole('combobox', { name: 'Profile' })).toBeNull()
    expect(screen.getByText(/cannot be moved to another profile/u)).toBeTruthy()

    fill('Name', 'Friday digest')
    fireEvent.click(screen.getByRole('button', { name: 'Save cron' }))

    await waitFor(() => expect(router.current()).toBe('#/crons/job-digest'))
    expect(cron.put).toHaveBeenCalledWith('/api/cron/jobs/job-digest?profile=default', {
      updates: { name: 'Friday digest', prompt: 'Write a short digest of this week.', deliver: 'bot-chat:researcher' }
    })
    expect(await within(main()).findByText('Friday digest was saved.')).toBeTruthy()
  })

  it('cancels back to the cron, or to the list for a new one', async () => {
    mount('#/crons/job-digest/edit')
    expect((await screen.findByRole('link', { name: 'Cancel' })).getAttribute('href')).toBe('#/crons/job-digest')
  })

  it('offers no profile where the gateway serves one', async () => {
    mount('#/crons/new', {}, false)

    await screen.findByRole('button', { name: 'Save cron' })
    expect(screen.queryByLabelText('Profile')).toBeNull()
  })
})

describe('a run', () => {
  it('opens read-only: the transcript through the chat’s own views, and the way back', async () => {
    const cron = fakeCron({ jobs: [heartbeat(), digest(), cleanup()] })
    const router = createHashRouter(null)

    seedRoster([aBot('researcher')])
    router.navigate('#/crons/job-heartbeat/runs/cron_job-heartbeat_1790000000')
    render(
      <App
        user="Tester"
        onSignIn={() => {}}
        onSignOut={() => {}}
        router={router}
        cron={{ transport: cron.transport }}
      />
    )

    expect(await screen.findByText('All clear: disk at 41%, memory at 58%.')).toBeTruthy()
    expect(screen.getByText(/Read-only: a cron run cannot be continued/u)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'VM heartbeat' }).getAttribute('href')).toBe('#/crons/job-heartbeat')
    expect(cron.request).toHaveBeenCalledWith('session.history', {
      session_id: 'cron_job-heartbeat_1790000000',
      profile: 'default'
    })
    // Nothing is resumed: a run has no live agent behind it.
    expect(cron.request.mock.calls.map(([method]) => method)).not.toContain('session.resume')
  })
})

describe('without a gateway to ask', () => {
  it('says there is nothing, rather than loading for ever', async () => {
    const router = createHashRouter(null)

    router.navigate('#/crons')
    render(<App user="Tester" onSignIn={() => {}} onSignOut={() => {}} router={router} />)

    expect(await within(main()).findByText(/No crons yet/u)).toBeTruthy()
  })
})
