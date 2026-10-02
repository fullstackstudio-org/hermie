import { AuthTimeline, type AuthTimelineSnapshot } from '@hermie/gateway-client'

import { keyValueStore } from '../platform/key-value-store'
import type { GatewayNamespace } from './namespace'
import { useConnectionStore } from './store'

/**
 * Where the auth ring lives between launches.
 *
 * The key-value store, not the secret store, and deliberately: the ring holds
 * event names, status codes, close codes and a remaining-lifetime reading — the
 * kind of thing you would happily print in a support log, which is the same test
 * `config.ts` applies to the gateway address. Nothing in it is a credential, and
 * putting it behind the keychain would only mean a biometric prompt stood between
 * the owner and the explanation.
 *
 * It has to survive a restart to be worth having at all: a sign-out is usually
 * followed by one, and a ring that does not outlive it cannot explain the thing it
 * exists to explain.
 *
 * One ring PER GATEWAY, which is the only reading that makes the events mean
 * anything: "the gateway rejected the saved sign-in" is a sentence about one
 * gateway, and two gateways sharing a ring would interleave one machine's
 * refresh failures with another's and offer the mixture as an explanation.
 */
export const AUTH_TIMELINE_KEY = 'hermie.gateway.auth_timeline'

/**
 * The app's single auth ring: restored from disk, then persisted and published to
 * the connection store on every event.
 *
 * Published as well as persisted because the two readers are React — the
 * developer screen's timeline block and the signed-out card's sentence — and a
 * mutable ring is not something they can subscribe to.
 */
export async function createPersistentAuthTimeline(ns: GatewayNamespace): Promise<AuthTimeline> {
  const key = ns.key(AUTH_TIMELINE_KEY)
  const timeline = new AuthTimeline({
    sink: snapshot => {
      useConnectionStore.getState().setAuthTimeline(snapshot)
      // Fire and forget: a failed write costs the account of a later sign-out,
      // which is not worth failing a dial over.
      void keyValueStore.setJson(key, snapshot).catch(() => undefined)
    }
  })

  try {
    timeline.restore(await keyValueStore.getJson<AuthTimelineSnapshot>(key))
  } catch {
    // An unreadable ring is an empty ring; it must never hold up a launch.
  }

  useConnectionStore.getState().setAuthTimeline(timeline.snapshot())

  return timeline
}
