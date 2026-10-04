/**
 * The small pieces the Crons pages share: how a gateway's text is drawn, the status mark, and the page's one
 * place that says what just happened.
 */
import { createContext, type ReactElement, useContext } from 'react'

import { displayText, NAME_LIMIT } from '../../core/requests/secure-input'
import { type CronJob, cronStatusLabel, type CronStatus } from '../../core/cron/model'
import type { CronController } from '../../core/cron/controller'

/** The longest cron name drawn, in code points. */
export const CRON_NAME_LIMIT = NAME_LIMIT

/** The longest prompt drawn, in code points. */
export const CRON_PROMPT_LIMIT = 4_000

/** A cron's name as it is drawn: cleaned and bounded, and the id where the gateway sent no name. */
export const cronName = (job: Pick<CronJob, 'name' | 'id'>): string =>
  displayText(job.name, CRON_NAME_LIMIT) || displayText(job.id, CRON_NAME_LIMIT)

/**
 * A status as a dot and a word. The word is the information; the dot is decoration, so a status is never colour
 * alone (WCAG 1.4.1).
 */
export function StatusMark({ status }: { status: CronStatus }): ReactElement {
  return (
    <span className="hm-cron-status" data-status={status}>
      <span className="hm-cron-status__dot" aria-hidden="true" />
      {cronStatusLabel(status)}
    </span>
  )
}

/** What the page says after something was done (polite) or refused (an alert). */
export interface CronNotice {
  tone: 'done' | 'failed'
  text: string
}

/** What the pages under `CronsPage` are given beside their route. */
export interface CronPageContext {
  /** Null where the page was given no gateway (a test of the frame). */
  controller: CronController | null
  /** Say what happened. `carry` keeps it across the route change this action is about to cause. */
  say(notice: CronNotice, options?: { carry?: boolean }): void
  /** Go to another route of the page. */
  go(hash: string): void
}

export const CronPageContextValue = createContext<CronPageContext | null>(null)

export function useCronPage(): CronPageContext {
  const value = useContext(CronPageContextValue)

  if (!value) {
    throw new Error('useCronPage was called outside the Crons page.')
  }

  return value
}
