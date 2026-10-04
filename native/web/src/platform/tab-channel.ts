/**
 * The page's other tabs on the same gateway: one message, `forget`.
 *
 * Signing out, or forgetting the session token of a gateway without sign-in,
 * clears what this browser keeps for the gateway, and the copy says "in this
 * browser". Another tab of the same client would otherwise keep its socket and
 * its credentials and write transcripts back into the store just cleared. So
 * the tab that leaves says so on a `BroadcastChannel`, and every other tab on
 * the same base path stops its session, drops its credentials, clears the same
 * state and goes back to the prompt (or the signed-out screen), writing nothing
 * more.
 *
 * The channel is named per base path (`hermie:<namespace>:session`), so two
 * gateways behind different prefixes on one host never hear each other. A
 * channel never delivers to the instance that posted, so a tab does not hear
 * its own message. The message carries nothing but its type: no token, no
 * identity. Anything else that arrives on the channel is ignored. A browser
 * without `BroadcastChannel` gets a channel that does nothing; its other tabs
 * then stop at their next dial, when the gateway refuses them.
 */

/** The part of a `BroadcastChannel` this uses, so a test can hand in its own. */
export interface ChannelLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  close(): void
}

/** Opens the channel of a name, or `null` where the browser has none. */
export type ChannelFactory = (name: string) => ChannelLike | null

export interface TabChannel {
  /** Tell the other tabs on this gateway to stop and forget. */
  announceForget(): void
  /** Called when another tab announced it. Returns the unsubscribe. */
  onForget(listener: () => void): () => void
  close(): void
}

/** The channel's name for a base path's storage namespace. */
export const tabChannelName = (namespace: string): string => `hermie:${namespace}:session`

const FORGET = 'forget'

const pageChannel: ChannelFactory = name => {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null
  } catch {
    return null
  }
}

const isForget = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && (data as { type?: unknown }).type === FORGET

export function createTabChannel(namespace: string, factory: ChannelFactory = pageChannel): TabChannel {
  const channel = factory(tabChannelName(namespace))
  const listeners = new Set<() => void>()

  const onMessage = (event: MessageEvent): void => {
    if (!isForget(event.data)) {
      return
    }

    for (const listener of [...listeners]) {
      listener()
    }
  }

  channel?.addEventListener('message', onMessage)

  return {
    announceForget() {
      try {
        channel?.postMessage({ type: FORGET })
      } catch {
        // A channel that is already closed: nothing to tell.
      }
    },
    onForget(listener) {
      listeners.add(listener)

      return () => void listeners.delete(listener)
    },
    close() {
      listeners.clear()
      channel?.removeEventListener('message', onMessage)
      channel?.close()
    }
  }
}
