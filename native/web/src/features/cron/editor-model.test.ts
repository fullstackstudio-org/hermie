/**
 * The editor's rules as a table: what a new cron needs, what an edit sends, and the schedule the reader did not touch
 * staying out of both the check and the update.
 */
import { describe, expect, it } from 'vitest'

import { cronJobFromRow } from '../../core/cron/model'
import { draftFor, emptyDraft, isValid, saveFrom, scheduleChanged, validateDraft } from './editor-model'
import { cronState } from './list-model'

const stored = (patch: Record<string, unknown> = {}) =>
  cronJobFromRow({
    id: 'j1',
    name: 'Briefing',
    schedule: 'every 2h',
    prompt: 'Summarize.',
    deliver: 'bot-chat:researcher',
    profile: 'researcher',
    ...patch
  })

describe('validateDraft for a new cron', () => {
  it('asks for a name and instructions', () => {
    const errors = validateDraft(emptyDraft(), null)

    expect(errors.name).toBe('Give the cron a name.')
    expect(errors.prompt).toBe('Write the instructions the bot should follow.')
    expect(isValid(errors)).toBe(false)
  })

  it('treats whitespace as nothing', () => {
    const errors = validateDraft({ ...emptyDraft(), name: '   ', prompt: '\n' }, null)

    expect(errors.name).not.toBeNull()
    expect(errors.prompt).not.toBeNull()
  })

  it('judges the schedule: an interval that is not a number is refused in words', () => {
    const draft = { ...emptyDraft(), name: 'A', prompt: 'B' }

    expect(isValid(validateDraft(draft, null))).toBe(true)
    expect(validateDraft({ ...draft, schedule: { ...draft.schedule, intervalValue: 'x' } }, null).schedule).toContain(
      'minutes, hours or days'
    )
    expect(
      validateDraft({ ...draft, schedule: { ...draft.schedule, mode: 'cron', cronExpression: '* *' } }, null).schedule
    ).toContain('five fields')
  })
})

describe('saveFrom a new cron', () => {
  it('sends everything, trimmed, with the profile it is created in', () => {
    const draft = {
      ...emptyDraft(),
      name: ' Nightly ',
      prompt: ' Sweep. ',
      profile: 'researcher',
      deliver: 'bot-chat:researcher'
    }

    expect(saveFrom(draft, null)).toEqual({
      kind: 'create',
      input: {
        name: 'Nightly',
        prompt: 'Sweep.',
        deliver: 'bot-chat:researcher',
        schedule: 'every 30m',
        profile: 'researcher'
      }
    })
  })

  it('creates in the launch profile when none is chosen', () => {
    const save = saveFrom({ ...emptyDraft(), name: 'a', prompt: 'b' }, null)

    expect(save.kind === 'create' && save.input.profile).toBeNull()
  })
})

describe('an edit', () => {
  it('opens on what the cron has, the full prompt included', () => {
    expect(draftFor(stored())).toMatchObject({
      name: 'Briefing',
      prompt: 'Summarize.',
      deliver: 'bot-chat:researcher',
      profile: 'researcher',
      schedule: { mode: 'interval', intervalValue: '2', intervalUnit: 'hours' }
    })
  })

  it('does not send, or judge, a schedule the reader left alone', () => {
    // A schedule the builder cannot express would be refused by a check the gateway itself does not make.
    const job = stored({ schedule: '0 9 * * * *' })
    const draft = { ...draftFor(job), name: 'Renamed' }

    expect(scheduleChanged(draft, job)).toBe(false)
    expect(validateDraft(draft, job).schedule).toBeNull()
    expect(saveFrom(draft, job)).toEqual({
      kind: 'update',
      input: { name: 'Renamed', prompt: 'Summarize.', deliver: 'bot-chat:researcher' }
    })
  })

  it('does not re-arm a one-shot that shows as `once in 2h`', () => {
    const job = stored({ schedule: 'once in 2h' })

    expect(saveFrom(draftFor(job), job)).toEqual({
      kind: 'update',
      input: expect.not.objectContaining({ schedule: expect.anything() })
    })
  })

  it('sends the schedule once the reader changed it, and never the profile', () => {
    const job = stored()
    const draft = draftFor(job)
    const changed = { ...draft, schedule: { ...draft.schedule, intervalValue: '4' } }

    expect(scheduleChanged(changed, job)).toBe(true)
    expect(saveFrom(changed, job)).toEqual({
      kind: 'update',
      input: { name: 'Briefing', prompt: 'Summarize.', deliver: 'bot-chat:researcher', schedule: 'every 4h' }
    })
  })

  it('refuses a changed schedule that does not build', () => {
    const job = stored()
    const draft = draftFor(job)

    expect(
      validateDraft({ ...draft, schedule: { ...draft.schedule, intervalValue: '0' } }, job).schedule
    ).not.toBeNull()
  })
})

describe('the list’s state', () => {
  it('tells loading, failed, empty and ready apart', () => {
    const base = { hasController: true, loaded: true, error: null, count: 2 }

    expect(cronState({ ...base, loaded: false })).toBe('loading')
    expect(cronState({ ...base, error: 'HTTP 500' })).toBe('failed')
    expect(cronState({ ...base, count: 0 })).toBe('empty')
    expect(cronState(base)).toBe('ready')
  })

  it('says a failure even where there are rows, and never loads where there is nobody to ask', () => {
    expect(cronState({ hasController: true, loaded: true, error: 'x', count: 3 })).toBe('failed')
    expect(cronState({ hasController: false, loaded: false, error: null, count: 0 })).toBe('empty')
  })
})
