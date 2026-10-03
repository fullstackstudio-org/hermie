/**
 * What the confirm sheet and the passkeys settings page are given by the page:
 * the passkey model's actions (`core/passkey/model.ts`). Its state is read from
 * `state/passkeys.ts`, like every other store.
 *
 * A context, like `ChatRuntimeContext`, and optional for the same reason: a
 * screen rendered with none (a test of the shell) draws what the store holds and
 * acts on nothing.
 */
import { createContext, useContext } from 'react'

import type { PasskeyModel } from '../../core/passkey/model'

/** The model methods a screen calls. */
export type PasskeyActions = Pick<
  PasskeyModel,
  | 'confirm'
  | 'decline'
  | 'dismiss'
  | 'expire'
  | 'dismissNotice'
  | 'refresh'
  | 'enrol'
  | 'mintInvite'
  | 'revoke'
  | 'forgetPin'
>

export const PasskeyRuntimeContext = createContext<PasskeyActions | null>(null)

export const usePasskeyRuntime = (): PasskeyActions | null => useContext(PasskeyRuntimeContext)
