/**
 * The sidebar's line when the gateway has not said who the reader is
 * (`core/session-status.ts`, rule 1): it answered without naming an account, or it
 * could not be asked. Then nothing on the page can tell the reader's own messages
 * from a colleague's, and the reader is told so rather than shown a transcript
 * that attributes nothing without a word. Nothing when the identity is known.
 */
import type { ReactElement } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'

import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { type SessionStatusState, sessionStatusStore } from '../../state/session-status'

export function IdentityNote({
  store = sessionStatusStore
}: {
  store?: StoreApi<SessionStatusState>
}): ReactElement | null {
  useLocale()

  const kind = useStore(store, state => state.identity.kind)

  if (kind === 'known' || kind === 'unknown') {
    return null
  }

  return (
    <p className="hm-sidebar__identity" role="status" data-identity={kind}>
      {kind === 'anonymous' ? webStrings.identity.anonymous : webStrings.identity.failed}
    </p>
  )
}
