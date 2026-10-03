/**
 * A chat's line while the gateway is still loading the conversation behind a
 * resume (`session.resume_progress`, `core/session-status.ts`): "still loading"
 * while it is, and the gateway's reason when it could not, with a Close button.
 * Gone once the load is complete (the chat controller then reads the chat again).
 *
 * Under the chat's header, like the chat's other banners. The reason is the
 * gateway's text, cleaned by the model and shown as plain text.
 */
import type { ReactElement } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'

import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { type SessionStatusState, sessionStatusStore } from '../../state/session-status'
import { Button } from '../../ui/primitives'
import { useSessionSignalsRuntime } from './signals-runtime'

export interface ResumeProgressLineProps {
  /** The chat's key in the chat store. */
  chatKey: string
  store?: StoreApi<SessionStatusState>
}

export function ResumeProgressLine({
  chatKey,
  store = sessionStatusStore
}: ResumeProgressLineProps): ReactElement | null {
  useLocale()

  const progress = useStore(store, state => state.resumeProgress[chatKey])
  const runtime = useSessionSignalsRuntime()

  if (!progress) {
    return null
  }

  if (progress.status === 'loading') {
    return (
      <p className="hm-chat__banner" role="status" aria-busy="true" data-resume-progress="loading">
        {webStrings.resumeProgress.loading}
      </p>
    )
  }

  return (
    <div className="hm-chat__banner" data-tone="danger" role="alert" data-resume-progress="failed">
      <p>
        {webStrings.resumeProgress.failed}
        {progress.message ? ` ${webStrings.resumeProgress.reason({ reason: progress.message })}` : ''}
      </p>
      <Button variant="quiet" onClick={() => runtime?.status.dismissProgress(chatKey)}>
        {webStrings.resumeProgress.close}
      </Button>
    </div>
  )
}
