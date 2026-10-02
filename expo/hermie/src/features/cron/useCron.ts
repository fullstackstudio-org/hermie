/**
 * Gives the cron controller a lifetime.
 *
 * It is built per live connection and torn down with it, the way
 * `ChatRuntime` does for the chat controllers. The difference is scope: this
 * one is owned by the Routines screen rather than by the app, because a
 * `cron.changed` subscription is only worth holding while somebody is looking
 * at routines.
 */
import { useEffect, useState } from 'react'

import { useGateway } from '../../gateway'
import { chatGatewayFor } from '../../gateway/link'
import { useCronStore } from '../../store/cron'
import { CronController } from './cron-controller'

export function useCronController(): CronController | null {
  const { connection, http } = useGateway()
  const [controller, setController] = useState<CronController | null>(null)

  useEffect(() => {
    if (!connection) {
      useCronStore.getState().reset()
      setController(null)

      return
    }

    const next = new CronController({ gateway: chatGatewayFor(connection), http, store: useCronStore })

    next.start()
    setController(next)

    return () => {
      next.stop()
      setController(null)
    }
  }, [connection, http])

  return controller
}
