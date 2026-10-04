/**
 * The editor's draft, and what it takes to save it: pure functions, so the rules are a table of cases and not a
 * walk through a form.
 *
 * What the editor checks is what a client can check without guessing, and the gateway's parser has the last word
 * (`cron.manage add` and `PUT` answer a refusal in its own sentence, which the editor shows as it is):
 *
 *  - the cron needs a name and instructions;
 *  - a schedule the reader changed has to build (`buildSchedule`);
 *  - a schedule the reader did NOT touch is not sent and not judged. `PUT` is a merge, so leaving it out keeps what
 *    the gateway has, and rewriting it would be wrong twice: a one-shot shown as `once in 2h` would be armed again
 *    from now, and a schedule this builder cannot express (six fields, named months) would be refused by a check
 *    the gateway itself does not make.
 */
import type { CronJob } from '../../core/cron/model'
import type { CronJobInput, CronJobUpdate } from '../../core/cron/controller'
import { buildSchedule, DEFAULT_SCHEDULE_DRAFT, draftFromSchedule, type ScheduleDraft } from '../../core/cron/schedule'
import { strings } from '../../generated/strings'

export interface EditorDraft {
  name: string
  prompt: string
  deliver: string
  /** '' is the launch profile, which is what an absent `profile` param means. */
  profile: string
  schedule: ScheduleDraft
}

export interface EditorErrors {
  name: string | null
  prompt: string | null
  schedule: string | null
}

export const emptyDraft = (): EditorDraft => ({
  name: '',
  prompt: '',
  deliver: 'local',
  profile: '',
  schedule: { ...DEFAULT_SCHEDULE_DRAFT }
})

/** The draft a cron opens the editor with; no cron is a new one. */
export const draftFor = (job: CronJob | null): EditorDraft =>
  job
    ? {
        name: job.name,
        prompt: job.prompt || job.promptPreview,
        deliver: job.deliver || 'local',
        profile: job.profile ?? '',
        schedule: draftFromSchedule(job.schedule)
      }
    : emptyDraft()

/** Did the reader change the schedule? A new cron always has one to send. */
export function scheduleChanged(draft: EditorDraft, job: CronJob | null): boolean {
  return job === null || JSON.stringify(draft.schedule) !== JSON.stringify(draftFor(job).schedule)
}

export function validateDraft(draft: EditorDraft, job: CronJob | null): EditorErrors {
  const schedule = scheduleChanged(draft, job) ? buildSchedule(draft.schedule) : null

  return {
    name: draft.name.trim() ? null : strings.cron.editor.nameRequired,
    prompt: draft.prompt.trim() ? null : strings.cron.editor.promptRequired,
    schedule: schedule && !schedule.ok ? schedule.error : null
  }
}

export const isValid = (errors: EditorErrors): boolean => !errors.name && !errors.prompt && !errors.schedule

/** What goes to the gateway for a draft that passed `validateDraft`: a create, or an update of what changed. */
export function saveFrom(
  draft: EditorDraft,
  job: CronJob | null
): { kind: 'create'; input: CronJobInput } | { kind: 'update'; input: CronJobUpdate } {
  const schedule = scheduleChanged(draft, job) ? buildSchedule(draft.schedule) : null
  const base = { name: draft.name.trim(), prompt: draft.prompt.trim(), deliver: draft.deliver }

  if (job === null) {
    return {
      kind: 'create',
      input: {
        ...base,
        schedule: schedule?.ok ? schedule.schedule : '',
        // Only ever sent on create: `PUT {updates}` cannot move a job between stores.
        profile: draft.profile || null
      }
    }
  }

  return { kind: 'update', input: { ...base, ...(schedule?.ok ? { schedule: schedule.schedule } : {}) } }
}
