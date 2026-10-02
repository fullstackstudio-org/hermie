/**
 * The routine detail screen, against a hand-written controller.
 *
 * The screen owns no gateway knowledge, so what is worth asserting is that each
 * button reaches the right controller call, that Pause flips to Resume from the
 * store's state rather than from a local toggle, and that Delete goes through a
 * confirmation first.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'

import { renderScreen } from './support/render'
import {
  type CronController,
  CronDetailScreen,
  type CronJob,
  cronJobFromRow,
  cronRunFromRow
} from '../src/features/cron'
import { useCronStore } from '../src/store/cron'

const job = (overrides: Record<string, unknown> = {}): CronJob =>
  cronJobFromRow({
    job_id: 'job-heartbeat',
    name: 'VM heartbeat',
    schedule: 'every 2h',
    prompt_preview: 'Check the VM.',
    deliver: 'local',
    enabled: true,
    state: 'active',
    next_run_at: new Date(Date.now() + 7_200_000).toISOString(),
    last_run_at: new Date(Date.now() - 3_600_000).toISOString(),
    last_status: 'ok',
    ...overrides
  })

function fakeController() {
  return {
    loadDetail: jest.fn(async () => job()),
    loadRuns: jest.fn(async () => []),
    loadRunTranscript: jest.fn(async () => []),
    pause: jest.fn(async () => undefined),
    resume: jest.fn(async () => undefined),
    runNow: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined)
  }
}

const render = (controller: ReturnType<typeof fakeController>, target: CronJob = job(), props = {}) =>
  renderScreen(
    <CronDetailScreen
      controller={controller as unknown as CronController}
      job={target}
      onClose={jest.fn()}
      onDeleted={jest.fn()}
      onEdit={jest.fn()}
      onOpenRun={jest.fn()}
      {...props}
    />
  )

beforeEach(() => {
  useCronStore.getState().reset()
})

it('carries one back control, labelled with the Crons list it returns to', async () => {
  const controller = fakeController()
  const onClose = jest.fn()
  render(controller, job(), { onClose })

  const back = screen.getByTestId('page-back')

  expect(back.props.accessibilityLabel).toBe('Crons')

  fireEvent.press(back)
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('reads the full job and its runs when it opens', async () => {
  const controller = fakeController()
  render(controller)

  await waitFor(() => expect(controller.loadDetail).toHaveBeenCalled())
  expect(controller.loadRuns).toHaveBeenCalled()
})

it('runs the routine now', async () => {
  const controller = fakeController()
  render(controller)

  fireEvent.press(screen.getByTestId('cron-run-now'))

  await waitFor(() => expect(controller.runNow).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-heartbeat' })))
})

it('pauses an active routine', async () => {
  const controller = fakeController()
  render(controller)

  expect(screen.getByTestId('cron-toggle-pause')).toHaveTextContent('Pause')
  fireEvent.press(screen.getByTestId('cron-toggle-pause'))

  await waitFor(() => expect(controller.pause).toHaveBeenCalled())
  expect(controller.resume).not.toHaveBeenCalled()
})

it('offers Resume for a paused routine', async () => {
  const controller = fakeController()
  const paused = job({ enabled: false, state: 'paused', next_run_at: null })
  controller.loadDetail = jest.fn(async () => paused)
  render(controller, paused)

  expect(screen.getByTestId('cron-toggle-pause')).toHaveTextContent('Resume')
  fireEvent.press(screen.getByTestId('cron-toggle-pause'))

  await waitFor(() => expect(controller.resume).toHaveBeenCalled())
})

it('asks before it deletes', async () => {
  const controller = fakeController()
  const onDeleted = jest.fn()
  render(controller, job(), { onDeleted })

  fireEvent.press(screen.getByTestId('cron-delete'))

  expect(controller.remove).not.toHaveBeenCalled()
  expect(screen.getByText('Delete “VM heartbeat”?')).toBeTruthy()

  fireEvent.press(screen.getByTestId('cron-delete-confirm'))

  await waitFor(() => expect(controller.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-heartbeat' })))
  await waitFor(() => expect(onDeleted).toHaveBeenCalled())
})

it('paints the detail read once it lands, prompt and all', async () => {
  const controller = fakeController()
  controller.loadDetail = jest.fn(async () => {
    const full = job({ prompt: 'Check the VM, summarize disk and memory.' })

    useCronStore.getState().setDetail(full)

    return full
  })
  render(controller)

  await waitFor(() =>
    expect(screen.getByTestId('cron-detail-prompt')).toHaveTextContent('Check the VM, summarize disk and memory.')
  )
})

it('opens a run', async () => {
  const controller = fakeController()
  const onOpenRun = jest.fn()
  const run = {
    id: 'cron_job-heartbeat_1700000000',
    title: 'VM heartbeat',
    status: 'ok',
    started_at: Math.floor(Date.now() / 1000) - 3_600,
    ended_at: null,
    last_active: Math.floor(Date.now() / 1000) - 3_600,
    message_count: 3,
    preview: 'Done.'
  }
  controller.loadRuns = jest.fn(async () => {
    useCronStore.getState().setRuns('job-heartbeat', [
      {
        id: run.id,
        startedAt: run.started_at,
        endedAt: null,
        lastActive: run.last_active,
        status: 'ok',
        messageCount: 3,
        preview: 'Done.',
        title: 'VM heartbeat'
      }
    ])

    return []
  })
  render(controller, job(), { onOpenRun })

  const row = await screen.findByLabelText('VM heartbeat')

  fireEvent.press(row)

  expect(onOpenRun).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }))
})

/**
 * Two fields the gateway sends in a shape the reader did not expect, both found
 * by comparing the fake gateway with `hermes serve` rather than by a failure.
 */
describe('reading the gateway’s own shapes', () => {
  /**
   * A `/runs` row is a session row, and the sessions table has NO status column
   * — the outcome is `end_reason`. Reading `status` alone meant every run in the
   * history rendered as the "ok" the screen falls back to, including the ones
   * that were interrupted, and nothing anywhere said otherwise.
   */
  it('takes a run’s outcome from end_reason, which is the column that exists', () => {
    const base = { id: 'cron_job-heartbeat_1', title: 'VM heartbeat', started_at: 1, ended_at: 2, message_count: 3 }

    expect(cronRunFromRow({ ...base, end_reason: 'interrupted' }).status).toBe('interrupted')
    expect(cronRunFromRow({ ...base, end_reason: 'done' }).status).toBe('done')
    // A build that does send `status` is still read, and wins: it is the more
    // specific answer where both are present.
    expect(cronRunFromRow({ ...base, end_reason: 'done', status: 'error' }).status).toBe('error')
    expect(cronRunFromRow(base).status).toBeNull()
  })

  /**
   * `last_fire_error` is `{at, detail}`, not a string: the scheduler stamps when
   * it could not START the job. Read as a string it was dropped silently, so a
   * cron that never got off the ground showed no error at all here.
   */
  it('reads a missed fire out of the object the scheduler records it as', () => {
    const missed = job({
      last_error: null,
      last_fire_error: { at: '2026-09-20T03:00:00Z', detail: 'The scheduler was not running at 03:00.' }
    })

    expect(missed.lastError).toBe('The scheduler was not running at 03:00.')

    // A string still works, and a real error beside it still wins.
    expect(job({ last_error: null, last_fire_error: 'plain string' }).lastError).toBe('plain string')
    expect(job({ last_error: 'boom', last_fire_error: { detail: 'missed' } }).lastError).toBe('boom')
  })
})
