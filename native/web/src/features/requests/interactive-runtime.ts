/**
 * What the interactive sheets and the chat's notice are given by the page: the
 * interactive model's actions (`core/requests/interactive.ts`). What they show is
 * read from `state/interactive.ts`, like every other store.
 *
 * A context, like `SecureInputRuntimeContext`, and optional for the same reason: a
 * screen rendered with none draws what the store holds and answers nothing.
 */
import { createContext, useContext } from 'react'

import type { InteractiveModel } from '../../core/requests/interactive'

/** The model methods a screen calls. */
export type InteractiveActions = Pick<InteractiveModel, 'answer' | 'skip' | 'cannotShow' | 'dismissNotice'>

export const InteractiveRuntimeContext = createContext<InteractiveActions | null>(null)

export const useInteractiveRuntime = (): InteractiveActions | null => useContext(InteractiveRuntimeContext)
