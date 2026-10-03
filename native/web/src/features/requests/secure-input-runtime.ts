/**
 * What the secret, sudo and vault sheets and the chat's notice are given by the
 * page: the secure input model's actions (`core/requests/secure-input.ts`). What
 * they show is read from `state/secure-input.ts`, like every other store.
 *
 * A context, like `PasskeyRuntimeContext`, and optional for the same reason: a
 * screen rendered with none draws what the store holds and answers nothing.
 */
import { createContext, useContext } from 'react'

import type { SecureInputModel } from '../../core/requests/secure-input'

/** The model methods a screen calls. */
export type SecureInputActions = Pick<SecureInputModel, 'answer' | 'skip' | 'dismissNotice'>

export const SecureInputRuntimeContext = createContext<SecureInputActions | null>(null)

export const useSecureInputRuntime = (): SecureInputActions | null => useContext(SecureInputRuntimeContext)
