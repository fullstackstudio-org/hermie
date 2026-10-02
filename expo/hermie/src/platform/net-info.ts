/**
 * "Is there a network", as the connection's dial ladder asks it.
 *
 * A seam rather than a direct `NetInfo` call because the browser build has no
 * `@react-native-community/netinfo` — `net-info.web.ts` answers the same
 * question with `navigator.onLine`, which is a weaker but honest answer.
 *
 * The contract is one subscription that reports the current value immediately
 * and then on every change, and returns its own unsubscribe. `isConnected` is
 * `null` while the OS is still deciding, which counts as online: a cold start
 * should not sit out its first dial waiting for an answer.
 */
import NetInfo from '@react-native-community/netinfo'

import type { NetworkKind, NetworkWatcher } from './platform-contracts'

export type { NetworkKind, NetworkWatcher } from './platform-contracts'

/**
 * NetInfo's `type` reduced to the four values anything here branches on.
 *
 * Only `cellular` carries a decision, so everything that is not wifi or
 * cellular collapses into `other` and everything unreadable into `unknown`.
 * `none` — no interface at all — is `other` rather than `unknown`: it is a real
 * answer, and it is one the probe's hint must not read as "on mobile data".
 */
function asKind(type: string): NetworkKind {
  if (type === 'wifi' || type === 'cellular') {
    return type
  }

  return type === 'unknown' ? 'unknown' : 'other'
}

export const networkWatcher: NetworkWatcher = {
  subscribe(onChange) {
    return NetInfo.addEventListener(state => onChange(state.isConnected !== false))
  },

  async kind() {
    try {
      return asKind((await NetInfo.fetch()).type)
    } catch {
      // A native module that will not answer is not a reason to fail the
      // sentence this is for; it is a reason to say nothing extra.
      return 'unknown'
    }
  }
}
