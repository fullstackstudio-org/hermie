/**
 * The connection, in one line, on every layout.
 *
 * Rules it keeps, from the native apps' line:
 *
 *  - **Connected is silent.** The presence bead on every row already says a bot
 *    can be reached; a line that only ever says "yes" is a line nobody reads.
 *    A page that is hidden is `paused` and says nothing either: it is not
 *    something the reader has to know.
 *  - **It is static.** Nothing animates here; the only moving thing in the
 *    client is a bot asking for the reader.
 *  - **Signed out is the one state you can act on**, so it carries a button
 *    (`signIn`: the gateway's own sign-in page), and a gateway too old for the
 *    client says so in a sentence. Those two are alerts; the transient states
 *    (connecting, reconnecting, offline) are polite status text.
 *
 * It reads one store and fetches nothing.
 */
import type { ConnectionStatus } from '@hermie/gateway-client'
import type { ReactElement } from 'react'
import { useStore } from 'zustand'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { connectionStore } from '../../state/connection'
import { Icon } from '../../ui/icons'
import { Button, PresenceBead } from '../../ui/primitives'

export interface ConnectionLineProps {
  /** Go to the gateway's own sign-in page (`signIn()` of the boot). */
  onSignIn: () => void
  /** Show this state instead of the live one (tests and the dev gallery). */
  status?: ConnectionStatus
}

export function ConnectionLine({ onSignIn, status: forced }: ConnectionLineProps): ReactElement | null {
  useLocale()

  const live = useStore(connectionStore, state => state.status)
  const status = forced ?? live
  const labels = strings.app.connection.status

  switch (status) {
    case 'ready':
    case 'paused':
      return null

    case 'needs_signin':
      return (
        <div className="hm-status" data-status={status} role="alert">
          <Icon name="alert" size={18} />
          <span className="hm-status__text">{strings.app.signedOut.title}</span>
          <Button variant="quiet" onClick={onSignIn}>
            {strings.app.signedOut.signIn}
          </Button>
        </div>
      )

    case 'incompatible':
      return (
        <div className="hm-status" data-status={status} role="alert">
          <Icon name="alert" size={18} />
          <span className="hm-status__text">{strings.app.errors.incompatible}</span>
        </div>
      )

    case 'offline':
      return (
        <div className="hm-status" data-status={status} role="status">
          <Icon name="wifiOff" size={18} />
          <span className="hm-status__text">{labels.offline}</span>
        </div>
      )

    case 'reconnecting':
      return (
        <div className="hm-status" data-status={status} role="status">
          <PresenceBead state="offline" size="inline" />
          <span className="hm-status__text">{labels.reconnecting}</span>
        </div>
      )

    // `disconnected` is the store's state before the first dial; to the reader it is connecting.
    case 'disconnected':
    case 'probing':
    case 'authenticating':
    case 'connecting':
      return (
        <div className="hm-status" data-status={status} role="status">
          <PresenceBead state="offline" size="inline" />
          <span className="hm-status__text">{labels.connecting}</span>
        </div>
      )
  }
}
