/**
 * A routine run is read through the chat engine, not through a second one.
 *
 * The point of these two tests is that `session.history` rows for a cron
 * session go through `rowsToItems` → `visibleItems` → `TranscriptList` exactly
 * as a conversation's do, and that nothing offers to continue the run: a cron
 * session has no live agent behind it.
 */
import { screen, waitFor } from '@testing-library/react-native'

import { renderScreen } from './support/render'
import { CronRunScreen, cronJobFromRow, type CronController, type CronRun } from '../src/features/cron'

const JOB = cronJobFromRow({
  job_id: 'job-heartbeat',
  name: 'VM heartbeat',
  schedule: 'every 2h',
  prompt_preview: 'Check the VM.',
  enabled: true
})

const RUN: CronRun = {
  id: 'cron_job-heartbeat_1700000000',
  startedAt: Math.floor(Date.now() / 1000) - 3_600,
  endedAt: null,
  lastActive: Math.floor(Date.now() / 1000) - 3_600,
  status: 'ok',
  messageCount: 3,
  preview: 'Done.',
  title: 'VM heartbeat'
}

const ROWS = [
  { role: 'user', text: 'Check the VM and report.', row_id: 1, timestamp: 1_700_000_000 },
  { role: 'assistant', text: 'Disk is at 41%, nothing unusual.', row_id: 2, timestamp: 1_700_000_012 }
]

function controllerWith(rows: unknown[]): CronController {
  return {
    loadRunTranscript: jest.fn(async () => rows)
  } as unknown as CronController
}

it('reads the run with its own session id and renders the transcript', async () => {
  const controller = controllerWith(ROWS)

  renderScreen(<CronRunScreen controller={controller} job={JOB} onClose={jest.fn()} run={RUN} />)

  expect(await screen.findByText('Check the VM and report.')).toBeTruthy()
  expect(screen.getByText('Disk is at 41%, nothing unusual.')).toBeTruthy()
  expect(controller.loadRunTranscript).toHaveBeenCalledWith(RUN.id, null)
})

it('says the run is read-only and offers no composer', async () => {
  renderScreen(<CronRunScreen controller={controllerWith(ROWS)} job={JOB} onClose={jest.fn()} run={RUN} />)

  await screen.findByText('Check the VM and report.')

  expect(screen.getByText('Read-only: a cron run cannot be continued from here.')).toBeTruthy()
  expect(screen.queryByTestId('composer-input')).toBeNull()
})

it('says so when the run has no transcript', async () => {
  renderScreen(<CronRunScreen controller={controllerWith([])} job={JOB} onClose={jest.fn()} run={RUN} />)

  await waitFor(() => expect(screen.getByText('This run recorded no messages.')).toBeTruthy())
})

/**
 * A run session is titled with its job's name, so the SUBTITLE used to print
 * that name twice in two sizes — the same stutter the crons list and Activity
 * were cured of. The subtitle earns its line only where the run calls itself
 * something else.
 *
 * `PageChrome`'s own back control is a second, expected place the name shows
 * up now (HERM-105/109): it always names the page one level up — the job's
 * detail screen, titled with the job's name — regardless of what the run
 * itself is called, so it is not the stutter this test is about.
 */
it('does not print the job’s name under a run that is already called that', async () => {
  renderScreen(<CronRunScreen controller={controllerWith(ROWS)} job={JOB} onClose={jest.fn()} run={RUN} />)

  await screen.findByText('Check the VM and report.')

  // Twice: once as the title, once as the back control's label — and no third
  // time as a subtitle repeating what the title already says.
  expect(screen.getAllByText(JOB.name)).toHaveLength(2)

  renderScreen(
    <CronRunScreen
      controller={controllerWith(ROWS)}
      job={JOB}
      onClose={jest.fn()}
      run={{ ...RUN, title: 'Manual re-run' }}
    />
  )

  // The back label, plus the subtitle earning its line because the run is
  // called something else now.
  await waitFor(() => expect(screen.getAllByText(new RegExp(JOB.name, 'u')).length).toBe(2))
})
