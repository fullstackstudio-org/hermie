/**
 * Settings, About: which build of the client this is, and the licences it ships under.
 *
 * The version and commit are the build's own (`build-info.ts`, injected at build time), the same two a
 * bug report names. The licence list is `licenses.json`, served beside the page and read when the page
 * opens (`core/licences.ts`); it lists the packages that ship inside the web client, each with the
 * licence it declares and the text it carries, one disclosure per package. A build without the file, or
 * one that cannot be fetched, says so with a Try again; nothing else on the page depends on it.
 */
import { type ReactElement, useCallback, useEffect, useId, useState } from 'react'

import { clientVersion, sourceCommit } from '../../build-info'
import { type LicenceList, loadLicences } from '../../core/licences'
import { displayText } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { Button } from '../../ui/primitives'
import { Fact, SettingsPage } from './controls'
import { useSettingsRuntime } from './settings-runtime'

type Licences = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; list: LicenceList }

/** What a failed read says of itself: short, and plain text. */
const FAILURE_LIMIT = 120

export function About(): ReactElement {
  useLocale()

  const runtime = useSettingsRuntime()
  const url = runtime?.licencesUrl ?? 'licenses.json'
  const headingId = useId()
  const [licences, setLicences] = useState<Licences>({ status: 'loading' })
  /** Bumped by Try again: the read depends on it. */
  const [attempt, setAttempt] = useState(0)
  const words = sheetStrings.settings.about

  useEffect(() => {
    const controller = new AbortController()

    setLicences({ status: 'loading' })

    loadLicences(url, undefined, controller.signal).then(
      list => {
        if (!controller.signal.aborted) {
          setLicences({ status: 'ready', list })
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setLicences({
            status: 'failed',
            message: displayText(error instanceof Error ? error.message : String(error), FAILURE_LIMIT)
          })
        }
      }
    )

    return () => controller.abort()
  }, [url, attempt])

  const retry = useCallback(() => setAttempt(count => count + 1), [])

  return (
    <SettingsPage title={strings.app.settings.categories.about}>
      <dl className="hm-facts">
        <Fact label={strings.app.settings.version}>{clientVersion}</Fact>
        <Fact label={words.commit} mono>
          {sourceCommit}
        </Fact>
      </dl>

      <h3 className="hm-settings-page__heading" id={headingId}>
        {strings.app.settings.licences}
      </h3>
      <p className="hm-settings-page__text">{strings.app.settings.licencesHint}</p>

      {licences.status === 'loading' ? (
        <p className="hm-settings-page__text" role="status">
          {strings.app.settings.licencesLoading}
        </p>
      ) : licences.status === 'failed' ? (
        <>
          <p className="hm-settings-page__text" role="alert">
            {strings.app.settings.licencesFailed({ message: licences.message })}
          </p>
          <div className="hm-settings-page__actions">
            <Button variant="quiet" onClick={retry}>
              {strings.app.settings.licencesRetry}
            </Button>
          </div>
        </>
      ) : licences.list.packages.length === 0 ? (
        <p className="hm-settings-page__text">{words.licencesNone}</p>
      ) : (
        <>
          <p className="hm-settings-page__text">{words.licencesIntro({ count: licences.list.packages.length })}</p>
          <ul className="hm-licences" aria-labelledby={headingId}>
            {licences.list.packages.map(entry => (
              <li key={`${entry.name}@${entry.version}`} className="hm-licences__item">
                <details>
                  <summary className="hm-licences__summary">
                    <span className="hm-licences__name">
                      {displayText(entry.name, 128)} {displayText(entry.version, 64)}
                    </span>
                    <span className="hm-licences__id">
                      {displayText(entry.licence, 64) || strings.app.settings.licencesUndeclared}
                    </span>
                  </summary>
                  {entry.repository ? (
                    <p className="hm-licences__source">
                      {words.source}: {displayText(entry.repository, 200)}
                    </p>
                  ) : null}
                  {entry.text ? (
                    <pre className="hm-licences__text">{entry.text}</pre>
                  ) : (
                    <p className="hm-settings-page__text">{strings.app.settings.licencesNoText}</p>
                  )}
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </SettingsPage>
  )
}
