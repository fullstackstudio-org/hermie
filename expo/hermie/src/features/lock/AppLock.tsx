/**
 * The gate. Nothing below it is rendered while the app is locked.
 *
 * `children` is not hidden, not blurred and not covered — it is not mounted.
 * That is the whole of the guarantee, and it is a stronger one than an overlay
 * can make: an overlay leaves a live transcript, a live chat list and a live
 * connection one z-index away, all of them still fetching, still updating and
 * still in whatever snapshot the OS takes of the window. `__tests__/app-lock-gate.test.tsx`
 * asserts the absence rather than the covering, because "is it on top" is the
 * question that has a way of quietly becoming false.
 *
 * It sits ABOVE `GatewayProvider` in `app/App.tsx`, so a locked app holds no
 * socket either. The cost is honest and worth stating: unlocking re-mounts the
 * provider and re-dials. The stores are module-level and survive, so what is
 * paid is a reconnect, not the conversation.
 */
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { View } from 'react-native'

import { useTheme } from '../../ui/theme'
import { LockPlate } from './LockPlate'
import { useLockStore } from './store'

export interface AppLockProps {
  children: ReactNode
}

export function AppLock({ children }: AppLockProps) {
  const theme = useTheme()
  const ready = useLockStore(state => state.ready)
  const locked = useLockStore(state => state.machine.locked)
  const prompting = useLockStore(state => state.prompting)
  const enrolment = useLockStore(state => state.enrolment)
  const hydrate = useLockStore(state => state.hydrate)
  const unlock = useLockStore(state => state.unlock)
  const watchLifecycle = useLockStore(state => state.watchLifecycle)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => watchLifecycle(), [watchLifecycle])

  /*
    One frame of nothing, in the splash's own colour.

    The preference is on disk and disk is async, so there is a moment where the
    app does not yet know whether it is locked. Rendering the app through it
    would flash a transcript at exactly the person who asked for it not to be
    shown; rendering the plate through it would flash a lock screen at everyone
    who never turned one on. A field of the background colour is neither, and
    it is the colour the splash was already showing, so it is invisible.
  */
  if (!ready) {
    return <View style={{ flex: 1, backgroundColor: theme.elevation.e0 }} testID="lock-pending" />
  }

  if (locked) {
    return <LockPlate busy={prompting} onUnlock={() => void unlock()} stranded={enrolment === 'none'} />
  }

  return <>{children}</>
}
