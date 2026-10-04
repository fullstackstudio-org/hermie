/**
 * The crons list: every cron on the gateway, whichever profile owns it, split into the ones that are on and the
 * ones that are paused.
 *
 * A row says what the cron is called, when it runs (in words: `describeSchedule`), when it next runs (or last ran,
 * for a paused one), whether it is on, and how its last run went; its name is the link to the cron, and
 * Pause/Resume is the one thing a row does itself. Everything else (run now, edit, delete) is on the cron's own
 * page, where its instructions and its delivery target are in front of the reader.
 *
 * Above the list, the one thing that is not about a single cron: `gateway_running === false` means the scheduler
 * process is down, so every cron below is a plan rather than a promise. States (loading, failed, empty) are said in
 * words, in a live region that exists before it speaks.
 */
import { type ReactElement, useId } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from 'zustand'

import {
  cronRowWhen,
  cronStatusOf,
  lastErrorSummary,
  relativeTime,
  statusWord,
  type CronJob
} from '../../core/cron/model'
import { describeSchedule } from '../../core/cron/schedule'
import { messageOf } from '../../core/cron/controller'
import { displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { cronWebStrings } from '../../i18n/cron-strings'
import { useLocale } from '../../i18n/use-locale'
import { cronState } from './list-model'
import { cronStore } from '../../state/cron'
import { Button } from '../../ui/primitives'
import { cronHref, cronNewHref } from '../shell/router'
import { cronName, StatusMark, useCronPage } from './cron-bits'

export function CronList(): ReactElement {
  useLocale()

  const { controller, say } = useCronPage()
  const { jobs, loaded, error, gatewayRunning, busy } = useStore(
    cronStore,
    useShallow(state => ({
      jobs: state.jobs,
      loaded: state.loaded,
      error: state.error,
      gatewayRunning: state.gatewayRunning,
      busy: state.busy
    }))
  )
  const state = cronState({ hasController: controller !== null, loaded, error, count: jobs.length })
  const active = jobs.filter(job => cronStatusOf(job) !== 'paused')
  const paused = jobs.filter(job => cronStatusOf(job) === 'paused')

  const toggle = (job: CronJob, pausing: boolean): void => {
    void (pausing ? controller?.pause(job) : controller?.resume(job))
      ?.then(() =>
        say({
          tone: 'done',
          text: (pausing ? cronWebStrings.outcome.paused : cronWebStrings.outcome.resumed)({ name: cronName(job) })
        })
      )
      .catch((cause: unknown) =>
        say({ tone: 'failed', text: cronWebStrings.outcome.failed({ message: messageOf(cause) }) })
      )
  }

  return (
    <section className="hm-cron-list" aria-label={strings.cron.title}>
      <div className="hm-cron-list__top">
        <p className="hm-cron-list__lead">{strings.cron.subtitle}</p>
        <a className="hm-button" href={cronNewHref()}>
          {strings.cron.list.add}
        </a>
      </div>

      {gatewayRunning === false ? (
        <p className="hm-cron-page__notice" data-tone="warn" role="status">
          {strings.cron.gatewayBanner}
        </p>
      ) : null}

      {state === 'loading' ? (
        <p className="hm-cron-page__state" role="status">
          {strings.cron.list.loading}
        </p>
      ) : null}

      {state === 'failed' ? (
        <div className="hm-cron-page__state" data-tone="danger" role="alert">
          <p>{strings.cron.list.failed({ reason: error ?? '' })}</p>
          <Button variant="quiet" onClick={() => void controller?.refresh().catch(() => undefined)}>
            {strings.app.common.retry}
          </Button>
        </div>
      ) : null}

      {state === 'empty' ? <p className="hm-cron-page__state">{strings.cron.list.empty}</p> : null}

      {active.length > 0 ? (
        <Section title={strings.cron.sections.active}>
          {active.map(job => (
            <Row key={job.id} job={job} busy={busy[job.id] === true} onToggle={toggle} />
          ))}
        </Section>
      ) : null}

      {paused.length > 0 ? (
        <Section title={strings.cron.sections.paused}>
          {paused.map(job => (
            <Row key={job.id} job={job} busy={busy[job.id] === true} onToggle={toggle} />
          ))}
        </Section>
      ) : null}
    </section>
  )
}

/** A titled group of rows. */
function Section({ title, children }: { title: string; children: ReactElement[] }): ReactElement {
  const id = useId()

  return (
    <section className="hm-cron-list__group" aria-labelledby={id}>
      <h2 className="hm-cron-list__group-title" id={id}>
        {title}
      </h2>
      <ul className="hm-cron-list__rows">{children}</ul>
    </section>
  )
}

interface RowProps {
  job: CronJob
  busy: boolean
  onToggle: (job: CronJob, pausing: boolean) => void
}

function Row({ job, busy, onToggle }: RowProps): ReactElement {
  const status = cronStatusOf(job)
  const paused = status === 'paused'
  const name = cronName(job)
  const when = cronRowWhen(job)
  const result = job.lastRunAt
    ? [strings.cron.list.lastRun({ when: relativeTime(job.lastRunAt) ?? '' }), statusWord(job.lastStatus)]
    : null
  const error = displayText(lastErrorSummary(job.lastError), 200)
  const action = paused ? strings.cron.detail.resume : strings.cron.detail.pause

  return (
    <li className="hm-cron-row" data-status={status} data-job={job.id}>
      <div className="hm-cron-row__main">
        <p className="hm-cron-row__name">
          <a href={cronHref(job.id)}>
            <bdi>{name}</bdi>
          </a>
        </p>
        <p className="hm-cron-row__schedule">{displayText(describeSchedule(job.schedule), 160)}</p>
        <p className="hm-cron-row__meta">
          <StatusMark status={status} />
          <span>
            {when.label}: {when.value}
          </span>
        </p>
        <p className="hm-cron-row__meta">{result ? result.filter(Boolean).join(' · ') : strings.cron.list.neverRun}</p>
        {error && !paused ? (
          <p className="hm-cron-row__error" data-tone="danger">
            {error}
          </p>
        ) : null}
        {job.profile ? (
          <p className="hm-cron-row__profile">
            <bdi>{strings.cron.list.profile({ name: displayText(job.profile, 64) })}</bdi>
          </p>
        ) : null}
      </div>
      <Button
        variant="quiet"
        disabled={busy}
        aria-label={cronWebStrings.actionFor({ action, name })}
        onClick={() => onToggle(job, !paused)}
      >
        {action}
      </Button>
    </li>
  )
}
