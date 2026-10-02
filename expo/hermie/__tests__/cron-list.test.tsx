/**
 * The Crons list, driven end to end through the real controller and store with
 * a hand-written connection underneath. What is worth pinning here is the
 * reading of the gateway's answer rather than the pixels: which surface the
 * list comes off, which section a job lands in, that `gateway_running: false`
 * raises the banner, and that a scheduler exception is shown as its first
 * sentence rather than as a stack.
 *
 * The rows are in the STORED job shape, which is what the REST routes answer
 * with and which differs from the socket's `_format_job` rows in more than the
 * key for the id: the schedule is a parsed object with the readable form beside
 * it, and `repeat` is a counter rather than a rendered phrase.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'

import { renderScreen } from './support/render'
import { type CronJob, cronJobFor, cronJobFromRow, cronJobName, cronRowWhen, CronScreen } from '../src/features/cron'
import { useBotsStore } from '../src/store/bots'
import { useCronStore } from '../src/store/cron'

const mockRequest = jest.fn()
const mockHttpGet = jest.fn()
const mockHttpPost = jest.fn()

// One frozen value, the way `GatewayProvider` hands one out: the connection and
// its `http` are refs there, and a fresh object per render would restart the
// controller on every paint.
jest.mock('../src/gateway', () => {
  const http = {
    get: (...args: unknown[]) => mockHttpGet(...args),
    post: (...args: unknown[]) => mockHttpPost(...args)
  }
  const connection = {
    request: (...args: unknown[]) => mockRequest(...args),
    on: () => () => undefined,
    onAny: () => () => undefined,
    onRequest: () => () => undefined,
    onStatus: () => () => undefined,
    http
  }

  return { useGateway: () => ({ connection, http }) }
})

/** A stored cron job, as `_annotate_cron_job` hands one to the dashboard. */
const storedJob = (overrides: Record<string, unknown>) => ({
  schedule: { kind: 'interval', display: 'every 2h', seconds: 7200 },
  schedule_display: 'every 2h',
  prompt: 'Check the VM.',
  deliver: 'local',
  enabled: true,
  state: 'scheduled',
  next_run_at: null,
  last_run_at: null,
  last_status: null,
  last_error: null,
  repeat: { times: null, completed: 0 },
  skills: [],
  profile: 'default',
  profile_name: 'default',
  is_default_profile: true,
  ...overrides
})

const JOBS = [
  storedJob({
    id: 'job-heartbeat',
    name: 'VM heartbeat',
    next_run_at: new Date(Date.now() + 7_200_000).toISOString(),
    last_run_at: new Date(Date.now() - 3_600_000).toISOString(),
    last_status: 'ok'
  }),
  storedJob({
    id: 'job-digest',
    name: 'Weekly digest',
    schedule: { kind: 'cron', display: 'weekdays at 9am', expr: '0 9 * * 1-5' },
    schedule_display: 'weekdays at 9am',
    last_run_at: new Date(Date.now() - 7_200_000).toISOString(),
    last_status: 'error',
    last_error: "RuntimeError: Cron job 'Weekly digest' has no model configured. Set one with `hermes cron edit`."
  }),
  // The one the old code could not see: it lives in a bot's own cron store, so
  // the socket list — which reads the launch profile's store — never mentions it.
  storedJob({
    id: 'job-inbox-scan',
    name: 'Source scan',
    schedule_display: 'every 4h',
    deliver: 'bot-chat:researcher',
    profile: 'researcher',
    profile_name: 'researcher',
    is_default_profile: false,
    last_status: 'ok'
  }),
  storedJob({
    id: 'job-cleanup',
    name: 'Inbox cleanup',
    schedule_display: 'every day at 6pm',
    enabled: false,
    state: 'paused',
    paused_at: new Date(Date.now() - 86_400_000).toISOString(),
    paused_reason: 'Paused from the desktop app'
  })
]

function answerWith(gatewayRunning: boolean): void {
  mockRequest.mockImplementation(async (method: string) => {
    if (method === 'cron.manage') {
      // The scheduler flag and nothing else: on a real gateway this answer is
      // the launch profile's jobs, which is precisely what must not be listed.
      return { success: true, jobs: [], count: 0, gateway_running: gatewayRunning }
    }

    return {}
  })
}

beforeEach(() => {
  useCronStore.getState().reset()
  useBotsStore.getState().setBots([])
  mockRequest.mockReset()
  mockHttpGet.mockReset()
  mockHttpPost.mockReset()
  mockHttpPost.mockResolvedValue({})
  mockHttpGet.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/cron/jobs')) {
      return JOBS
    }

    return { targets: [{ id: 'local', name: 'Local (save only)' }] }
  })
  answerWith(true)
})

it('reads the list over HTTP for every profile, not off the socket', async () => {
  renderScreen(<CronScreen />)

  await waitFor(() => expect(mockHttpGet).toHaveBeenCalledWith('/api/cron/jobs?profile=all'))
})

it('lists a cron that lives in a bot profile, and says whose it is', async () => {
  renderScreen(<CronScreen />)

  expect(await screen.findByText('Source scan')).toBeTruthy()
  // The row wears the profile as a CHIP — §6.11 — so it is the bare name on the
  // screen. "Profile: researcher" stays in the row's accessibility label, which
  // is what somebody reading it out gets.
  expect(screen.getByTestId('cron-profile-job-inbox-scan')).toHaveTextContent('researcher')
  expect(screen.getByTestId('cron-profile-job-heartbeat')).toHaveTextContent('default')
  expect(screen.getByLabelText('Source scan, Profile: researcher')).toBeTruthy()
})

it('leaves the profile off every row when they all share one', async () => {
  mockHttpGet.mockImplementation(async (path: string) =>
    path.startsWith('/api/cron/jobs')
      ? JOBS.filter(job => job.profile === 'default')
      : { targets: [{ id: 'local', name: 'Local (save only)' }] }
  )
  renderScreen(<CronScreen />)

  await screen.findByText('VM heartbeat')

  // A column of "Profile: default" tells nobody anything.
  expect(screen.queryByTestId('cron-profile-job-heartbeat')).toBeNull()
})

it('still asks the socket for the scheduler flag, and only for that', async () => {
  renderScreen(<CronScreen />)

  await waitFor(() => expect(mockRequest).toHaveBeenCalled())

  // `include_disabled` rides along because the flag is attached to a non-empty
  // job list; a gateway whose jobs are all paused would otherwise never say.
  expect(mockRequest).toHaveBeenCalledWith('cron.manage', { action: 'list', include_disabled: true }, undefined)
})

it('renders the list even when the socket cannot answer the scheduler flag', async () => {
  mockRequest.mockRejectedValue(new Error('socket closed'))
  renderScreen(<CronScreen />)

  expect(await screen.findByText('VM heartbeat')).toBeTruthy()
  // Unknown, which is not the same as "not running": no banner either way.
  expect(screen.queryByTestId('cron-gateway-banner')).toBeNull()
})

it('splits the list into Active and Paused', async () => {
  renderScreen(<CronScreen />)

  expect(await screen.findByText('VM heartbeat')).toBeTruthy()
  expect(screen.getByText('ACTIVE')).toBeTruthy()
  expect(screen.getByText('PAUSED')).toBeTruthy()
  expect(screen.getByText('Inbox cleanup')).toBeTruthy()

  // The paused job carries the paused dot, not the "never run" one.
  expect(screen.getAllByTestId('cron-status-paused')).toHaveLength(1)
  expect(screen.getAllByTestId('cron-status-ok')).toHaveLength(2)
  expect(screen.getAllByTestId('cron-status-failed')).toHaveLength(1)
})

it('reads the schedule out of the stored job, where it is an object', async () => {
  renderScreen(<CronScreen />)

  // `schedule` on a stored row is the parsed spec; the readable form is beside
  // it, and taking the wrong one leaves the row blank.
  // The schedule shares its line with the delivery target, and the next run is a
  // labelled pair in the row's right-hand column.
  expect(await screen.findByText('Every 2 hours · @local')).toBeTruthy()
  expect(screen.getByText('in 2h')).toBeTruthy()
  // Nothing scheduled must not read as "now".
  expect(screen.getAllByText('Not scheduled').length).toBeGreaterThan(0)
})

it('shows the first sentence of a scheduler exception, not the class name', async () => {
  renderScreen(<CronScreen />)

  const error = await screen.findByTestId('cron-error-job-digest')

  expect(error).toHaveTextContent("Cron job 'Weekly digest' has no model configured.")
  expect(error).not.toHaveTextContent('RuntimeError')
})

it('raises the banner when the scheduler process is down', async () => {
  answerWith(false)
  renderScreen(<CronScreen />)

  expect(await screen.findByText('Crons will not run: the Hermes gateway process is not running')).toBeTruthy()
})

it('keeps the banner down while the gateway says the scheduler is up', async () => {
  renderScreen(<CronScreen />)

  await screen.findByText('VM heartbeat')

  expect(screen.queryByTestId('cron-gateway-banner')).toBeNull()
})

it('explains a failed list read instead of showing an empty list', async () => {
  mockHttpGet.mockRejectedValue(new Error('socket closed'))
  renderScreen(<CronScreen />)

  expect(await screen.findByText('Could not load the crons: socket closed')).toBeTruthy()
})

/**
 * Every mutation has to name the profile.
 *
 * `cron.manage` binds HERMES_HOME to it and looks nowhere else, so a pause
 * without it does not pause the wrong job — it reports no such job. The HTTP
 * routes do search, which is worse in its own way: two profiles that named a
 * cron the same thing make the unscoped call a coin toss.
 */
describe('mutations carry the owning profile', () => {
  const openScanRow = async () => {
    renderScreen(<CronScreen />)
    fireEvent.press(await screen.findByTestId('cron-row-job-inbox-scan'))

    return screen.findByText('Run now')
  }

  it('scopes pause to the profile the job came from', async () => {
    await openScanRow()

    fireEvent.press(screen.getByText('Pause'))

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(
        'cron.manage',
        { action: 'pause', name: 'job-inbox-scan', profile: 'researcher' },
        undefined
      )
    )
  })

  it('scopes the detail read and Run now to it too', async () => {
    await openScanRow()

    await waitFor(() => expect(mockHttpGet).toHaveBeenCalledWith('/api/cron/jobs/job-inbox-scan?profile=researcher'))

    fireEvent.press(screen.getByText('Run now'))

    await waitFor(() =>
      expect(mockHttpPost).toHaveBeenCalledWith('/api/cron/jobs/job-inbox-scan/trigger?profile=researcher', {})
    )
  })
})

/**
 * Creating a cron picks its store, because that is the only way to create one
 * for a bot: the profile is the scope the create runs under, not a field on the
 * job. The picker only appears where there is a choice to make.
 */
describe('the editor chooses a profile on create', () => {
  beforeEach(() => {
    useBotsStore.getState().setBots([
      {
        name: 'researcher',
        displayName: 'Researcher',
        description: '',
        model: '',
        provider: '',
        isDefault: false,
        hasAvatar: false,
        uiMetaRevision: 0
      },
      {
        name: 'writer',
        displayName: 'Writer',
        description: '',
        model: '',
        provider: '',
        isDefault: false,
        hasAvatar: false,
        uiMetaRevision: 0
      }
    ])
  })

  it('sends the chosen profile with the create', async () => {
    renderScreen(<CronScreen />)

    await screen.findByText('VM heartbeat')
    fireEvent.press(screen.getByTestId('cron-create'))

    fireEvent.changeText(screen.getByTestId('cron-editor-name'), 'Nightly sweep')
    fireEvent.changeText(screen.getByTestId('cron-editor-prompt'), 'Sweep the logs.')
    fireEvent.press(screen.getByTestId('cron-editor-profile-researcher'))
    fireEvent.press(screen.getByTestId('cron-editor-save'))

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(
        'cron.manage',
        expect.objectContaining({ action: 'add', name: 'Nightly sweep', profile: 'researcher' }),
        undefined
      )
    )
  })
})

/**
 * The `+` in the chats list is labelled New cron.
 *
 * It navigated to this screen and stopped there, leaving the reader to find
 * the same `+` again at the bottom of the list — a button that promises a
 * thing and delivers the page that thing lives on. It is the same button on
 * every platform, so this is not a browser defect; it was found in a browser.
 */
describe('naming a job from an id alone', () => {
  /*
    The inverse of the transcript's own lookup, which goes from a cron card's
    NAME to an id. This direction is what an id arriving from outside the list
    needs — a notification payload's `jobId`, a route parameter — and it has to
    be able to answer "nothing", because the crons list is read by the Crons
    screen's own controller and before that screen has been opened once this app
    genuinely does not know what the id refers to.
  */
  const jobs = [
    { id: 'job-1', name: 'Morning digest' },
    { id: 'job-2', name: 'Nightly backup' }
  ] as CronJob[]

  it('finds the job an id names', () => {
    expect(cronJobFor(jobs, 'job-2')?.name).toBe('Nightly backup')
    expect(cronJobName(jobs, 'job-1')).toBe('Morning digest')
  })

  it('answers nothing rather than something for an id it cannot place', () => {
    // Empty, and NOT the id: a caller that printed what came back would put
    // `job-9` on a lock screen, which says less than "a scheduled run" would.
    expect(cronJobName(jobs, 'job-9')).toBe('')
    expect(cronJobFor(jobs, 'job-9')).toBeNull()
  })

  it('answers nothing before the list has been read at all', () => {
    expect(cronJobName([], 'job-1')).toBe('')
    expect(cronJobName(jobs, '')).toBe('')
  })
})

describe('opening the crons screen on a new job', () => {
  it('has the editor up on the first render', () => {
    renderScreen(<CronScreen initialCreate />)

    expect(screen.getByTestId('cron-editor')).toBeTruthy()
  })

  it('leaves it shut otherwise', () => {
    renderScreen(<CronScreen />)

    expect(screen.queryByTestId('cron-editor')).toBeNull()
  })
})

/**
 * HERM-109: which of NEXT and LAST a row shows, and the word for a next run
 * that has already slipped by. Pure, against `cronRowWhen` directly — the
 * fixtures above already prove the row PAINTS whatever this returns.
 */
describe('cronRowWhen — the row’s NEXT/LAST label (HERM-109)', () => {
  const NOW = Date.parse('2026-09-22T12:00:00Z')

  it('shows LAST for a paused job, never NEXT … ago off a stale next_run_at', () => {
    const paused = cronJobFromRow(
      storedJob({
        id: 'job-paused',
        name: 'Paused job',
        enabled: false,
        state: 'paused',
        // Stale: the gateway left this populated from before the pause.
        next_run_at: new Date(NOW - 3_600_000).toISOString(),
        last_run_at: new Date(NOW - 7 * 3_600_000).toISOString()
      })
    )

    expect(cronRowWhen(paused, NOW)).toEqual({ label: 'last', value: '7h ago' })
  })

  it('falls back to — for a paused job that has never run', () => {
    const paused = cronJobFromRow(
      storedJob({
        id: 'job-paused-fresh',
        name: 'Paused, never run',
        enabled: false,
        state: 'paused',
        next_run_at: null,
        last_run_at: null
      })
    )

    expect(cronRowWhen(paused, NOW)).toEqual({ label: 'last', value: '—' })
  })

  it('says Overdue for an active job whose next run has slipped into the past', () => {
    const late = cronJobFromRow(
      storedJob({
        id: 'job-late',
        name: 'Running late',
        next_run_at: new Date(NOW - 60_000).toISOString()
      })
    )

    expect(cronRowWhen(late, NOW)).toEqual({ label: 'next', value: 'Overdue' })
  })

  it('is unchanged for an active job with a future next run', () => {
    const scheduled = cronJobFromRow(
      storedJob({
        id: 'job-scheduled',
        name: 'On time',
        next_run_at: new Date(NOW + 7_200_000).toISOString()
      })
    )

    expect(cronRowWhen(scheduled, NOW)).toEqual({ label: 'next', value: 'in 2h' })
  })

  it('is unchanged for an active job with no next run but a past one', () => {
    const ranOnce = cronJobFromRow(
      storedJob({
        id: 'job-ran-once',
        name: 'Ran once',
        next_run_at: null,
        last_run_at: new Date(NOW - 2 * 3_600_000).toISOString()
      })
    )

    expect(cronRowWhen(ranOnce, NOW)).toEqual({ label: 'last', value: '2h ago' })
  })
})
