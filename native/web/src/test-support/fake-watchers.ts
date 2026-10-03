/**
 * The page's visibility and network, turned by hand: what the lifecycle in
 * `core/gateway-client.ts` listens to, without a document or a window.
 */
import type { NetworkWatcher } from '../platform/net-info'
import type { Visibility, VisibilityWatcher } from '../platform/visibility'

export interface FakeVisibility extends VisibilityWatcher {
  /** Change the answer; listeners hear a change, never a repeat (as the real seam). */
  set(next: Visibility): void
  /** How many listeners are subscribed. */
  readonly listeners: number
}

export function fakeVisibility(initial: Visibility): FakeVisibility {
  let current = initial
  const listeners = new Set<(next: Visibility) => void>()

  return {
    current: () => current,
    subscribe(onChange) {
      listeners.add(onChange)

      return () => listeners.delete(onChange)
    },
    set(next) {
      if (next !== current) {
        current = next
        listeners.forEach(listener => listener(next))
      }
    },
    get listeners() {
      return listeners.size
    }
  }
}

export interface FakeNetwork extends NetworkWatcher {
  /** Report a change to every listener. */
  set(online: boolean): void
  /** How many listeners are subscribed. */
  readonly listeners: number
}

export function fakeNetwork(initial: boolean): FakeNetwork {
  let online = initial
  const listeners = new Set<(online: boolean) => void>()

  return {
    subscribe(onChange) {
      listeners.add(onChange)
      // Called once at once, as the real seam does.
      onChange(online)

      return () => listeners.delete(onChange)
    },
    kind: async () => 'unknown',
    set(next) {
      online = next
      listeners.forEach(listener => listener(next))
    },
    get listeners() {
      return listeners.size
    }
  }
}
