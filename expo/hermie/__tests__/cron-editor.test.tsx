/**
 * The routine editor sheet: what it refuses to send, and what it sends.
 *
 * The one rule behind all of it is that a routine with a half-built schedule
 * must never reach the gateway. `parse_schedule` raises on a string it cannot
 * read and the create call fails with a Python message; catching it here costs
 * one check and turns it into a sentence next to the field.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { renderScreen } from './support/render'
import { CronEditorSheet, cronJobFromRow, type CronDeliveryTarget } from '../src/features/cron'

const TARGETS: CronDeliveryTarget[] = [
  { id: 'local', name: 'Local (save only)', homeTargetSet: true },
  { id: 'bot-chat:researcher', name: 'Bot chat · researcher', homeTargetSet: true }
]

const onSave = jest.fn()
const onCancel = jest.fn()

const open = (props = {}) =>
  renderScreen(<CronEditorSheet job={null} onCancel={onCancel} onSave={onSave} targets={TARGETS} visible {...props} />)

beforeEach(() => {
  onSave.mockReset()
  onCancel.mockReset()
})

it('will not save without a name or instructions', () => {
  open()

  fireEvent.press(screen.getByTestId('cron-editor-save'))

  expect(onSave).not.toHaveBeenCalled()
  expect(screen.getByText('Give the cron a name.')).toBeTruthy()
  expect(screen.getByText('Write the instructions the bot should follow.')).toBeTruthy()
})

it('will not save a schedule the gateway could not parse', () => {
  open()

  fireEvent.changeText(screen.getByTestId('cron-editor-name'), 'Morning briefing')
  fireEvent.changeText(screen.getByTestId('cron-editor-prompt'), 'Summarize overnight updates.')
  fireEvent.press(screen.getByTestId('schedule-mode-cron'))
  fireEvent.changeText(screen.getByTestId('schedule-cron'), '0 9 * *')
  fireEvent.press(screen.getByTestId('cron-editor-save'))

  expect(onSave).not.toHaveBeenCalled()
  expect(screen.getByTestId('schedule-error')).toBeTruthy()
})

it('sends the built schedule, the trimmed fields and the chosen target', () => {
  open()

  fireEvent.changeText(screen.getByTestId('cron-editor-name'), '  Morning briefing  ')
  fireEvent.changeText(screen.getByTestId('cron-editor-prompt'), '  Summarize overnight updates.  ')
  fireEvent.press(screen.getByTestId('cron-editor-deliver-bot-chat:researcher'))
  fireEvent.press(screen.getByTestId('schedule-mode-daily'))
  fireEvent.changeText(screen.getByTestId('schedule-time'), '08:00')
  fireEvent.press(screen.getByTestId('schedule-weekday-1'))
  fireEvent.press(screen.getByTestId('cron-editor-save'))

  expect(onSave).toHaveBeenCalledWith({
    name: 'Morning briefing',
    prompt: 'Summarize overnight updates.',
    deliver: 'bot-chat:researcher',
    // No picker was offered and none was chosen, so the create runs unscoped:
    // the launch profile's cron store, which is what the gateway defaults to.
    profile: null,
    schedule: 'every monday at 8am'
  })
})

it('previews the exact string the gateway will parse', () => {
  open()

  expect(screen.getByTestId('schedule-preview')).toHaveTextContent('Sends to the gateway as: every 30m')
})

it('opens an existing routine on the mode that wrote its schedule', () => {
  const job = cronJobFromRow({
    job_id: 'job-digest',
    name: 'Weekly digest',
    schedule: 'weekdays at 9am',
    prompt: 'Write the digest.',
    deliver: 'local',
    enabled: true
  })

  open({ job })

  expect(screen.getByTestId('cron-editor-name').props.value).toBe('Weekly digest')
  expect(screen.getByTestId('cron-editor-prompt').props.value).toBe('Write the digest.')
  expect(screen.getByTestId('schedule-time').props.value).toBe('09:00')
  expect(screen.getByTestId('schedule-preview')).toHaveTextContent('Sends to the gateway as: weekdays at 9am')
})

it('surfaces what the gateway said when a save was refused', () => {
  open({ error: "Invalid schedule 'soon'" })

  expect(screen.getByTestId('cron-editor-error')).toHaveTextContent(
    "The gateway refused the cron: Invalid schedule 'soon'"
  )
})
