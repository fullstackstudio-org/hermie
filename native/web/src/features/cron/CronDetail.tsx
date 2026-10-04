/**
 * One cron: what it does, when it next runs, where it delivers, the actions, and the run history under them.
 *
 * Everything on it is the gateway's answer, in particular `next_run_at`, shown as the gateway sent it (relative:
 * the scheduler owns the timezone and the DST rules). The full prompt only exists on the HTTP detail read, so the
 * page asks for it on arrival and draws the list row's preview until it lands.
 *
 * Which actions ask first: Delete (there is no undo) does, inline, as on the Conversations page. Run now, Pause,
 * Resume and Edit do not: each is undone by the next click or changes nothing the reader cannot see, and on this
 * page the reader has the instructions and the delivery target in front of them.
 *
 * The history is the cron's run sessions, newest first. Each is a link to the run's own read-only page, and a cron
 * that delivers into a bot's chat links to that chat, where the report arrived.
 */
import { type ReactElement, useEffect, useId, useState } from 'react'
import { useStore } from 'zustand'

import { messageOf } from '../../core/cron/controller'
import {
  cronStatusOf,
  deliveredBot,
  epochMs,
  lastErrorSummary,
  relativeEpoch,
  relativeTime,
  runSucceeded,
  statusWord,
  type CronJob,
  type CronRun
} from '../../core/cron/model'
import { describeSchedule } from '../../core/cron/schedule'
import { BOT_NAME_LIMIT, displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { cronWebStrings } from '../../i18n/cron-strings'
import { formatDateTime } from '../../i18n/format'
import { useLocale } from '../../i18n/use-locale'
import { botsStore } from '../../state/bots'
import { cronStore } from '../../state/cron'
import { Button } from '../../ui/primitives'
import { WithName } from '../requests/with-name'
import { chatHref, cronEditHref, cronRunHref, cronsHref } from '../shell/router'
import { CRON_PROMPT_LIMIT, cronName, StatusMark, useCronPage } from './cron-bits'

export function CronDetail({ job }: { job: CronJob }): ReactElement {
  useLocale()

  const { controller, say, go } = useCronPage()
  const detail = useStore(cronStore, state => state.details[job.id]) ?? job
  const runs = useStore(cronStore, state => state.runs[job.id])
  const busy = useStore(cronStore, state => state.busy[job.id] === true)
  const targets = useStore(cronStore, state => state.deliveryTargets)
  const deliveredName = useStore(botsStore, state => {
    const bot = deliveredBot(detail)

    return bot === null ? null : (state.byName[bot]?.displayName ?? (state.byName[bot] ? bot : null))
  })
  const [runsError, setRunsError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const titleId = useId()

  // The full cron and its history: on arrival, and again whenever the list says the cron changed (it ran, it was
  // paused, its next run moved). Keyed on the row's own values and not on the row: a detail read writes the row back
  // into the list, and a row that is a new object every time would read again for ever.
  useEffect(() => {
    setRunsError(null)
    void controller?.loadDetail(job).catch(() => undefined)
    void controller?.loadRuns(job).catch((cause: unknown) => setRunsError(messageOf(cause)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    controller,
    job.id,
    job.profile,
    job.enabled,
    job.state,
    job.nextRunAt,
    job.lastRunAt,
    job.lastStatus,
    job.lastError
  ])

  const status = cronStatusOf(detail)
  const paused = status === 'paused'
  const name = cronName(detail)
  const nextRun = relativeTime(detail.nextRunAt)
  const lastRun = relativeTime(detail.lastRunAt)
  const error = displayText(lastErrorSummary(detail.lastError), 400)
  const prompt = displayText(detail.prompt || detail.promptPreview, CRON_PROMPT_LIMIT)
  const deliverName = targets.find(target => target.id === detail.deliver)?.name ?? detail.deliver

  /** One action: say what came of it where it was asked, and refuse in words. */
  const act = (work: () => Promise<unknown>, done: string, options?: { carry?: boolean; then?: () => void }): void => {
    void work()
      .then(() => {
        say({ tone: 'done', text: done }, options?.carry ? { carry: true } : undefined)
        options?.then?.()
      })
      .catch((cause: unknown) =>
        say({ tone: 'failed', text: cronWebStrings.outcome.failed({ message: messageOf(cause) }) })
      )
  }

  return (
    <article className="hm-cron" aria-labelledby={titleId}>
      <p className="hm-cron__back">
        <a href={cronsHref()}>{strings.cron.detail.back}</a>
      </p>
      <h2 className="hm-cron__title" id={titleId}>
        <bdi>{name}</bdi>
      </h2>
      <p className="hm-cron__schedule">{displayText(describeSchedule(detail.schedule), 160)}</p>

      <section className="hm-cron__summary" aria-label={strings.cron.detail.nextRun}>
        <p className="hm-cron__eyebrow">{strings.cron.detail.nextRun}</p>
        <p className="hm-cron__next">{nextRun ?? strings.cron.list.noNextRun}</p>
        <p>
          <StatusMark status={status} />
        </p>
        {error ? (
          <p className="hm-cron__error" data-tone="danger">
            {error}
          </p>
        ) : null}
      </section>

      <section className="hm-cron__section" aria-labelledby={`${titleId}-prompt`}>
        <h3 className="hm-cron__heading" id={`${titleId}-prompt`}>
          {strings.cron.detail.instructions}
        </h3>
        <p className="hm-cron__prompt" dir="auto">
          {prompt || strings.cron.detail.noPrompt}
        </p>
      </section>

      <section className="hm-cron__section" aria-labelledby={`${titleId}-details`}>
        <h3 className="hm-cron__heading" id={`${titleId}-details`}>
          {strings.cron.detail.details}
        </h3>
        <dl className="hm-cron__facts">
          <Fact label={strings.cron.detail.scheduleLabel} value={detail.schedule || strings.cron.detail.unknown} />
          <Fact
            label={strings.cron.detail.deliverLabel}
            value={<bdi>{displayText(deliverName, 120) || strings.cron.detail.unknown}</bdi>}
            note={
              deliveredName === null ? null : (
                <a href={chatHref(deliveredBotName(detail))}>
                  <WithName
                    phrase={shown => cronWebStrings.deliveredChat({ name: shown })}
                    name={displayText(deliveredName, BOT_NAME_LIMIT)}
                  />
                </a>
              )
            }
          />
          <Fact
            label={strings.cron.detail.repeatLabel}
            value={detail.repeat === null ? strings.cron.detail.repeatForever : String(detail.repeat)}
          />
          <Fact label={strings.cron.detail.lastRunLabel} value={lastRun ?? strings.cron.list.neverRun} />
          <Fact
            label={strings.cron.detail.lastStatusLabel}
            value={statusWord(detail.lastStatus) ?? strings.cron.detail.unknown}
          />
          {detail.model ? <Fact label={strings.cron.detail.modelLabel} value={displayText(detail.model, 120)} /> : null}
          {detail.skills.length > 0 ? (
            <Fact label={strings.cron.detail.skillsLabel} value={displayText(detail.skills.join(', '), 240)} />
          ) : null}
          {detail.pausedReason ? (
            <Fact label={strings.cron.detail.pausedReasonLabel} value={displayText(detail.pausedReason, 240)} />
          ) : null}
          {detail.profile ? (
            <Fact label={strings.cron.editor.profile} value={<bdi>{displayText(detail.profile, 64)}</bdi>} />
          ) : null}
        </dl>
      </section>

      <section className="hm-cron__section" aria-labelledby={`${titleId}-actions`}>
        <h3 className="hm-cron__heading" id={`${titleId}-actions`}>
          {strings.cron.detail.actions}
        </h3>

        {confirming ? (
          <div className="hm-cron__confirm" role="group" aria-label={strings.cron.confirmDelete.eyebrow}>
            <p data-tone="danger">
              <WithName phrase={shown => strings.cron.confirmDelete.title({ name: shown })} name={name} />
            </p>
            <p>{strings.cron.confirmDelete.body}</p>
            <div className="hm-cron__buttons">
              <Button
                className="hm-button--danger"
                disabled={busy}
                onClick={() => {
                  setConfirming(false)
                  act(() => controller?.remove(job) ?? Promise.resolve(), cronWebStrings.outcome.deleted({ name }), {
                    carry: true,
                    then: () => go(cronsHref())
                  })
                }}
              >
                {strings.cron.confirmDelete.confirm}
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                {strings.cron.confirmDelete.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <div className="hm-cron__buttons" role="group" aria-label={cronWebStrings.actionsLabel({ name })}>
            <Button
              disabled={busy}
              onClick={() =>
                act(() => controller?.runNow(job) ?? Promise.resolve(), cronWebStrings.outcome.started({ name }))
              }
            >
              {busy ? strings.cron.detail.running : strings.cron.detail.runNow}
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() =>
                paused
                  ? act(() => controller?.resume(job) ?? Promise.resolve(), cronWebStrings.outcome.resumed({ name }))
                  : act(() => controller?.pause(job) ?? Promise.resolve(), cronWebStrings.outcome.paused({ name }))
              }
            >
              {paused ? strings.cron.detail.resume : strings.cron.detail.pause}
            </Button>
            <a className="hm-button" data-variant="quiet" href={cronEditHref(job.id)}>
              {strings.cron.detail.edit}
            </a>
            <Button variant="quiet" className="hm-button--danger" disabled={busy} onClick={() => setConfirming(true)}>
              {strings.cron.detail.delete}
            </Button>
          </div>
        )}
      </section>

      <section className="hm-cron__section" aria-labelledby={`${titleId}-runs`}>
        <h3 className="hm-cron__heading" id={`${titleId}-runs`}>
          {strings.cron.detail.runHistory}
        </h3>
        {runsError !== null ? (
          <p data-tone="danger" role="alert">
            {strings.cron.detail.runsFailed({ reason: runsError })}
          </p>
        ) : runs === undefined ? (
          <p className="hm-cron-page__state" role="status">
            {strings.cron.detail.loadingRuns}
          </p>
        ) : runs.length === 0 ? (
          <p className="hm-cron-page__state">{strings.cron.detail.noRuns}</p>
        ) : (
          <ul className="hm-cron__runs">
            {runs.map(run => (
              <Run key={run.id} job={job} run={run} />
            ))}
          </ul>
        )}
      </section>
    </article>
  )
}

/** The bot whose chat a cron delivers into (`deliveredBot`); only called where there is one. */
const deliveredBotName = (job: Pick<CronJob, 'deliver' | 'profile'>): string => deliveredBot(job) ?? ''

function Fact({
  label,
  value,
  note
}: {
  label: string
  value: ReactElement | string
  note?: ReactElement | null
}): ReactElement {
  return (
    <div className="hm-cron__fact">
      <dt>{label}</dt>
      <dd>
        {value}
        {note ? <span className="hm-cron__fact-note">{note}</span> : null}
      </dd>
    </div>
  )
}

function Run({ job, run }: { job: CronJob; run: CronRun }): ReactElement {
  const ok = runSucceeded(run)
  const started = run.startedAt ?? run.lastActive
  const ms = epochMs(started)
  const when = relativeEpoch(started) ?? run.id
  const preview = displayText(run.preview, 160)

  return (
    <li className="hm-cron-run" data-run={run.id} data-ok={ok ? 'true' : 'false'}>
      <p className="hm-cron-run__top">
        <StatusMark status={ok ? 'ok' : 'failed'} />
        <time
          dateTime={ms === null ? undefined : new Date(ms).toISOString()}
          title={ms === null ? undefined : formatDateTime(ms)}
        >
          {when}
        </time>
        {!ok ? <span>{statusWord(run.status)}</span> : null}
      </p>
      {preview ? (
        <p className="hm-cron-run__preview" dir="auto">
          {preview}
        </p>
      ) : null}
      <p className="hm-cron-run__meta">{strings.chat.sessions.messages({ count: run.messageCount })}</p>
      <a
        className="hm-cron-run__link"
        href={cronRunHref(job.id, run.id)}
        aria-label={cronWebStrings.actionFor({ action: cronWebStrings.viewRun, name: when })}
      >
        {cronWebStrings.viewRun}
      </a>
    </li>
  )
}
