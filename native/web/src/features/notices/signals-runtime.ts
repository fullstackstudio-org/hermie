/**
 * What the screens that show what the gateway says beside the transcript are given
 * by the page: the actions of the notices model, the connections model and the
 * session status model (`core/notices.ts`, `core/connections.ts`,
 * `core/session-status.ts`). What they show is read from the stores those models
 * write, like every other store.
 *
 * A context, like `SecureInputRuntimeContext`, and optional for the same reason: a
 * screen rendered with none draws what the stores hold and answers nothing.
 */
import { createContext, useContext } from 'react'

import type { ConnectionsModel } from '../../core/connections'
import type { NoticesModel } from '../../core/notices'
import type { SessionStatusModel } from '../../core/session-status'
import { openInNewTab } from '../../platform/open-link'

export interface SessionSignalsActions {
  notices: Pick<NoticesModel, 'dismiss'>
  connections: Pick<ConnectionsModel, 'markOpened' | 'skip' | 'cancel'>
  status: Pick<SessionStatusModel, 'dismissProgress'>
}

export const SessionSignalsRuntimeContext = createContext<SessionSignalsActions | null>(null)

export const useSessionSignalsRuntime = (): SessionSignalsActions | null => useContext(SessionSignalsRuntimeContext)

/**
 * Open an authorisation link the person pressed: a new tab with no opener and no
 * referrer (`platform/open-link.ts`). The link passed `authorisationLink` already.
 */
export function openAuthorisationLink(url: string): void {
  openInNewTab(url)
}
