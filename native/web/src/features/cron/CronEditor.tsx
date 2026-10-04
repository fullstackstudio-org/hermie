/**
 * The cron editor: `#/crons/new` and `#/crons/<job>/edit`.
 *
 * A page rather than a sheet, as everything else on the web client is. Three groups (what it does, when, where it
 * goes), native controls, every field labelled, and a mistake said in words under the field it is in. A refused
 * save keeps the reader's words and says the gateway's reason in an alert (`editor.saveFailed`): the gateway's
 * parser has the last word on a schedule, and its sentence is the one that says what it would have taken.
 *
 * An edit asks for the full cron first (the list row only previews the prompt) and draws the form once it has
 * arrived, so the first thing in the prompt field is the prompt and not a preview that is saved over it.
 *
 * Which fields are sent is `editor-model.ts`'s: a schedule the reader did not touch stays out of the update.
 */
import { type FormEvent, type ReactElement, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { messageOf } from '../../core/cron/controller'
import type { CronJob } from '../../core/cron/model'
import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { cronWebStrings } from '../../i18n/cron-strings'
import { useLocale } from '../../i18n/use-locale'
import { botsStore } from '../../state/bots'
import { cronStore } from '../../state/cron'
import { Button } from '../../ui/primitives'
import { cronHref, cronsHref } from '../shell/router'
import { cronName, useCronPage } from './cron-bits'
import { draftFor, type EditorDraft, isValid, saveFrom, validateDraft } from './editor-model'
import { ScheduleFields } from './ScheduleFields'

export function CronEditor({ job }: { job: CronJob | null }): ReactElement {
  useLocale()

  const { controller } = useCronPage()
  const detail = useStore(cronStore, state => (job ? state.details[job.id] : undefined))
  const [loadFailed, setLoadFailed] = useState<string | null>(null)

  // An edit starts from the full cron. Without a gateway to ask, or when the read fails, the list row is all there is.
  useEffect(() => {
    if (job && controller) {
      void controller.loadDetail(job).catch((cause: unknown) => setLoadFailed(messageOf(cause)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, job?.id, job?.profile])

  const source = job === null ? null : (detail ?? (controller === null || loadFailed !== null ? job : undefined))

  if (source === undefined) {
    return (
      <p className="hm-cron-page__state" role="status">
        {strings.cron.detail.loading}
      </p>
    )
  }

  return <EditorForm job={source} />
}

function EditorForm({ job }: { job: CronJob | null }): ReactElement {
  const { controller, say, go } = useCronPage()
  const id = useId()
  const form = useRef<HTMLFormElement>(null)
  const targets = useStore(cronStore, state => state.deliveryTargets)
  const bots = useStore(botsStore, state => state.bots)
  const [draft, setDraft] = useState<EditorDraft>(() => draftFor(job))
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const errors = validateDraft(draft, job)
  const heading = job ? strings.cron.editor.editTitle : strings.cron.editor.createTitle

  // A single-profile gateway gets no picker rather than a picker with one option.
  const profiles = useMemo(() => (bots.length > 1 ? bots : []), [bots])

  // `local` is on every gateway and listed even before the targets have answered; the cron's own target is listed
  // whatever the gateway says, so saving never swaps it for another.
  const options = useMemo(() => {
    const listed = targets.length > 0 ? targets : [{ id: 'local', name: strings.cron.editor.deliverLocal }]

    return listed.some(target => target.id === draft.deliver)
      ? listed
      : [...listed, { id: draft.deliver, name: draft.deliver }]
  }, [targets, draft.deliver])

  const set = (patch: Partial<EditorDraft>): void => setDraft(current => ({ ...current, ...patch }))

  const submit = (event: FormEvent): void => {
    event.preventDefault()

    if (saving) {
      return
    }

    setTouched(true)
    setRefusal(null)

    if (!isValid(errors) || !controller) {
      // The first field that is wrong takes the focus, so a keyboard or a screen reader lands on what to fix.
      queueMicrotask(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())

      return
    }

    const save = saveFrom(draft, job)
    const name = cronName({ name: draft.name.trim(), id: job?.id ?? '' })

    setSaving(true)
    void (async () => {
      try {
        if (save.kind === 'update' && job) {
          await controller.update(job, save.input)
          say({ tone: 'done', text: cronWebStrings.outcome.saved({ name }) }, { carry: true })
          go(cronHref(job.id))
        } else if (save.kind === 'create') {
          const created = await controller.create(save.input)

          say({ tone: 'done', text: cronWebStrings.outcome.created({ name }) }, { carry: true })
          go(created ? cronHref(created) : cronsHref())
        }
      } catch (cause) {
        setRefusal(messageOf(cause))
      } finally {
        setSaving(false)
      }
    })()
  }

  return (
    <form className="hm-cron-form" ref={form} onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <p className="hm-cron__back">
        <a href={job ? cronHref(job.id) : cronsHref()}>{job ? cronName(job) : strings.cron.detail.back}</a>
      </p>
      <h2 className="hm-cron__title" id={`${id}-title`}>
        {heading}
      </h2>

      <fieldset className="hm-fieldset">
        <legend className="hm-fieldset__legend">{strings.cron.editor.what}</legend>

        <div className="hm-field">
          <label className="hm-field__label" htmlFor={`${id}-name`}>
            {strings.cron.editor.name}
          </label>
          <input
            id={`${id}-name`}
            className="hm-field__input"
            type="text"
            autoComplete="off"
            placeholder={strings.cron.editor.namePlaceholder}
            value={draft.name}
            onChange={event => set({ name: event.target.value })}
            aria-invalid={touched && errors.name !== null}
            aria-describedby={touched && errors.name ? `${id}-name-error` : undefined}
            aria-required="true"
          />
          {touched && errors.name ? (
            <p className="hm-field__error" id={`${id}-name-error`}>
              {errors.name}
            </p>
          ) : null}
        </div>

        <div className="hm-field">
          <label className="hm-field__label" htmlFor={`${id}-prompt`}>
            {strings.cron.editor.prompt}
          </label>
          <textarea
            id={`${id}-prompt`}
            className="hm-field__input hm-field__input--area"
            rows={6}
            placeholder={strings.cron.editor.promptPlaceholder}
            value={draft.prompt}
            onChange={event => set({ prompt: event.target.value })}
            aria-invalid={touched && errors.prompt !== null}
            aria-describedby={touched && errors.prompt ? `${id}-prompt-error` : undefined}
            aria-required="true"
          />
          {touched && errors.prompt ? (
            <p className="hm-field__error" id={`${id}-prompt-error`}>
              {errors.prompt}
            </p>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="hm-fieldset">
        <legend className="hm-fieldset__legend">{strings.cron.editor.schedule}</legend>
        <ScheduleFields draft={draft.schedule} onChange={schedule => set({ schedule })} showErrors={touched} />
        <p className="hm-field__hint">{strings.cron.editor.nextRunHint}</p>
      </fieldset>

      <fieldset className="hm-fieldset">
        <legend className="hm-fieldset__legend">{strings.cron.editor.where}</legend>

        <div className="hm-field">
          <label className="hm-field__label" htmlFor={`${id}-deliver`}>
            {strings.cron.editor.deliver}
          </label>
          <select
            id={`${id}-deliver`}
            className="hm-field__input"
            value={draft.deliver}
            onChange={event => set({ deliver: event.target.value })}
          >
            {options.map(target => (
              <option key={target.id} value={target.id}>
                {displayText(target.name, 120) || target.id}
              </option>
            ))}
          </select>
        </div>

        {profiles.length > 0 ? (
          job ? (
            <div className="hm-field">
              <p className="hm-field__label">{strings.cron.editor.profile}</p>
              <p>
                <bdi>{displayText(job.profile ?? '', BOT_NAME_LIMIT) || strings.cron.editor.profileDefault}</bdi>
              </p>
              <p className="hm-field__hint">{strings.cron.editor.profileLocked}</p>
            </div>
          ) : (
            <div className="hm-field">
              <label className="hm-field__label" htmlFor={`${id}-profile`}>
                {strings.cron.editor.profile}
              </label>
              <select
                id={`${id}-profile`}
                className="hm-field__input"
                value={draft.profile}
                onChange={event => set({ profile: event.target.value })}
                aria-describedby={`${id}-profile-hint`}
              >
                <option value="">{strings.cron.editor.profileDefault}</option>
                {profiles.map(bot => (
                  <option key={bot.name} value={bot.name}>
                    {displayText(bot.displayName, BOT_NAME_LIMIT) || bot.name}
                  </option>
                ))}
              </select>
              <p className="hm-field__hint" id={`${id}-profile-hint`}>
                {strings.cron.editor.profileHint}
              </p>
            </div>
          )
        ) : null}
      </fieldset>

      {refusal !== null ? (
        <p className="hm-field__error" role="alert">
          {strings.cron.editor.saveFailed({ reason: refusal })}
        </p>
      ) : null}

      <div className="hm-cron__buttons">
        <Button type="submit" disabled={saving}>
          {saving ? strings.cron.editor.saving : strings.cron.editor.save}
        </Button>
        <a className="hm-button" data-variant="quiet" href={job ? cronHref(job.id) : cronsHref()}>
          {strings.cron.editor.cancel}
        </a>
      </div>
    </form>
  )
}
