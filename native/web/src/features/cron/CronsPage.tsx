/**
 * Crons: `#/crons`, and the pages that hang off it.
 *
 * ```
 * #/crons                    the list (CronList)
 * #/crons/new                a new cron (CronEditor)
 * #/crons/<job>              one cron: what it does and its run history (CronDetail)
 * #/crons/<job>/edit         that cron's editor (CronEditor)
 * #/crons/<job>/runs/<run>   one run, read-only (RunView, a chunk of its own)
 * ```
 *
 * The Expo app's Crons feature, on the web's shell. This component is what the sub-pages share: the controller (made
 * here from the page's two transports, started on mount and stopped on leaving), the state it fills, and the one
 * line that says what just happened. It stays mounted while the route moves between its pages, so an outcome can
 * be said on the page the action ends on (`carry`).
 *
 * The list is the gateway's own answer for every profile, and the job a route names is looked up in it: a route
 * carries a job's id and not its profile, and a cron's profile is what every detail read and every mutation needs.
 *
 * Everything drawn from the gateway (a name, a prompt, an error) is its text: cleaned and bounded
 * (`displayText`), isolated in `<bdi>` where it sits in a sentence, and drawn as characters.
 */
import { type ReactElement, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { CronController } from '../../core/cron/controller'
import { cronJobFor } from '../../core/cron/model'
import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { cronWebStrings } from '../../i18n/cron-strings'
import { type HashRouter, pageHashRouter } from '../../platform/hash-router'
import { connectionStore } from '../../state/connection'
import { cronStore } from '../../state/cron'
import { cronsHref, formatRoute, type Route } from '../shell/router'
import { type CronNotice, CronPageContextValue, type CronPageContext } from './cron-bits'
import { CronDetail } from './CronDetail'
import { CronEditor } from './CronEditor'
import { CronList } from './CronList'
import { useCronRuntime } from './cron-runtime'
import './cron.css'

/** A run's transcript draws the chat's item views, so it is a chunk of its own inside this one. */
const RunView = lazy(() => import('./RunView').then(module => ({ default: module.RunView })))

export interface CronsPageProps {
  route: Extract<Route, { name: 'crons' }>
  /** The page's address, unless a test hands in its own. */
  router?: HashRouter
}

export function CronsPage({ route, router = pageHashRouter }: CronsPageProps): ReactElement {
  useLocale()

  const runtime = useCronRuntime()
  const controller = useMemo(
    () => (runtime ? new CronController({ transport: runtime.transport, store: cronStore }) : null),
    [runtime]
  )
  const ready = useStore(connectionStore, state => state.status === 'ready')
  const jobs = useStore(cronStore, state => state.jobs)
  const loaded = useStore(cronStore, state => state.loaded)
  const [notice, setNotice] = useState<(CronNotice & { carry: boolean }) | null>(null)

  // Follow `cron.changed`, and take a first reading, for as long as a Crons route is on screen.
  useEffect(() => {
    controller?.start()

    return () => controller?.stop()
  }, [controller])

  // The socket's half of the list (is the scheduler up?) needs the connection: read again when it arrives.
  const wasReady = useRef(false)

  useEffect(() => {
    if (ready && !wasReady.current) {
      void controller?.refresh().catch(() => undefined)
    }

    wasReady.current = ready
  }, [controller, ready])

  // What was said belongs to the page it was said on, and to the one the action led to; not to the pages after.
  const href = formatRoute(route)

  useEffect(() => {
    setNotice(current => (current?.carry ? { ...current, carry: false } : null))
  }, [href])

  const say = useCallback((next: CronNotice, options?: { carry?: boolean }) => {
    setNotice({ ...next, carry: options?.carry === true })
  }, [])

  const go = useCallback((hash: string) => router.navigate(hash), [router])

  const context = useMemo<CronPageContext>(() => ({ controller, say, go }), [controller, say, go])
  const job = route.job === undefined ? null : cronJobFor(jobs, route.job)

  return (
    <CronPageContextValue.Provider value={context}>
      <div className="hm-main__body hm-cron-page">
        {/* Present before it speaks, so a screen reader hears each outcome once; a refusal is an alert. */}
        <p className={notice?.tone === 'done' ? 'hm-cron-page__notice' : 'hm-sr'} role="status">
          {notice?.tone === 'done' ? notice.text : ''}
        </p>
        {notice?.tone === 'failed' ? (
          <p className="hm-cron-page__notice" data-tone="danger" role="alert">
            {notice.text}
          </p>
        ) : null}

        {route.view === 'new' ? (
          <CronEditor job={null} />
        ) : route.job === undefined ? (
          <CronList />
        ) : job === null ? (
          <p className="hm-cron-page__state" role={loaded || !controller ? undefined : 'status'}>
            {loaded || !controller ? (
              <>
                {cronWebStrings.notFound} <a href={cronsHref()}>{strings.cron.detail.back}</a>
              </>
            ) : (
              strings.cron.detail.loading
            )}
          </p>
        ) : route.view === 'edit' ? (
          <CronEditor key={job.id} job={job} />
        ) : route.view === 'run' && route.run !== undefined ? (
          <Suspense fallback={<p className="hm-cron-page__state">{strings.cron.run.loading}</p>}>
            <RunView key={route.run} job={job} runId={route.run} />
          </Suspense>
        ) : (
          <CronDetail key={job.id} job={job} />
        )}
      </div>
    </CronPageContextValue.Provider>
  )
}
