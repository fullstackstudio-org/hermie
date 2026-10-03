/**
 * The page lifecycle (rules 1 to 5 in `gateway-client.ts`), driven by hand
 * against a connection that only records what it is told.
 *
 * Ported from the Expo app's `__tests__/mac-lifecycle.test.ts`, which pinned
 * `attachLifecycle` there. What carries over is its first and last cases: a
 * browser tab pauses when it goes to the background and resumes when it comes
 * back, and losing focus is not going to the background (the visibility seam
 * reports `hidden` only for a hidden page, never for a blurred window). The Mac
 * and desktop-shell cases have no counterpart: this client has neither branch.
 * New here: the 60-second grace, the hidden start, and the explained stops.
 */
import type { ConnectionStatus } from '@hermie/gateway-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeNetwork, fakeVisibility } from '../test-support/fake-watchers'
import { attachLifecycle, HIDDEN_GRACE_MS, type LifecycleConnection } from './gateway-client'

/** A connection that does what the package's does with its status, and nothing else. */
function recordingConnection() {
  const calls: string[] = []
  const connection: LifecycleConnection & { calls: string[]; status: ConnectionStatus; running: boolean } = {
    calls,
    status: 'disconnected',
    running: false,
    start() {
      calls.push('start')
      this.running = true
      this.status = 'ready'
    },
    pause() {
      calls.push('pause')

      // The package's rule: a connection that is not running is left as it is.
      if (this.running) {
        this.status = 'paused'
      }
    },
    resume() {
      calls.push('resume')
      this.running = true
      this.status = 'ready'
    },
    retryNow() {
      calls.push('retryNow')
    },
    setOnline(online) {
      calls.push(online ? 'online' : 'offline')
    }
  }

  return connection
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('attachLifecycle', () => {
  it('dials at once on a visible page, with the network reported first', () => {
    const connection = recordingConnection()

    attachLifecycle(connection, { visibility: fakeVisibility('visible'), network: fakeNetwork(true) })

    expect(connection.calls).toEqual(['online', 'start'])
  })

  it('does not dial a page that loads hidden until it is first shown', () => {
    const connection = recordingConnection()
    const visibility = fakeVisibility('hidden')

    attachLifecycle(connection, { visibility, network: fakeNetwork(true) })
    vi.advanceTimersByTime(HIDDEN_GRACE_MS * 2)

    expect(connection.calls).toEqual(['online'])

    visibility.set('visible')

    expect(connection.calls).toEqual(['online', 'start'])
  })

  it('keeps the socket through a short absence, and only cuts a pending backoff on return', () => {
    const connection = recordingConnection()
    const visibility = fakeVisibility('visible')

    attachLifecycle(connection, { visibility, network: fakeNetwork(true) })
    visibility.set('hidden')
    vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1)
    visibility.set('visible')
    vi.advanceTimersByTime(HIDDEN_GRACE_MS * 2)

    expect(connection.calls).toEqual(['online', 'start', 'retryNow'])
  })

  it('closes after more than the grace hidden, and dials again once shown', () => {
    const connection = recordingConnection()
    const visibility = fakeVisibility('visible')

    attachLifecycle(connection, { visibility, network: fakeNetwork(true) })
    visibility.set('hidden')
    vi.advanceTimersByTime(HIDDEN_GRACE_MS)

    expect(connection.calls).toEqual(['online', 'start', 'pause'])
    expect(connection.status).toBe('paused')

    visibility.set('visible')

    expect(connection.calls).toEqual(['online', 'start', 'pause', 'resume'])
    expect(connection.status).toBe('ready')

    // And the next absence is timed afresh.
    visibility.set('hidden')
    vi.advanceTimersByTime(HIDDEN_GRACE_MS)
    visibility.set('visible')

    expect(connection.calls.slice(-2)).toEqual(['pause', 'resume'])
  })

  it('honours a grace it is given', () => {
    const connection = recordingConnection()
    const visibility = fakeVisibility('visible')

    attachLifecycle(connection, { visibility, network: fakeNetwork(true), hiddenGraceMs: 5 })
    visibility.set('hidden')
    vi.advanceTimersByTime(5)

    expect(connection.calls).toContain('pause')
  })

  it.each(['needs_signin', 'incompatible'] as const)(
    'leaves a connection stopped as %s alone, hidden or shown',
    status => {
      const connection = recordingConnection()
      const visibility = fakeVisibility('visible')

      attachLifecycle(connection, { visibility, network: fakeNetwork(true) })
      connection.status = status
      connection.running = false
      visibility.set('hidden')
      vi.advanceTimersByTime(HIDDEN_GRACE_MS)
      visibility.set('visible')

      expect(connection.calls).not.toContain('pause')
      expect(connection.calls).not.toContain('resume')
      expect(connection.status).toBe(status)
    }
  )

  it('does not resume what it did not pause', () => {
    const connection = recordingConnection()
    const visibility = fakeVisibility('visible')

    attachLifecycle(connection, { visibility, network: fakeNetwork(true) })
    // Stopped by somebody else between the grace starting and ending.
    connection.running = false
    connection.status = 'disconnected'
    visibility.set('hidden')
    vi.advanceTimersByTime(HIDDEN_GRACE_MS)
    visibility.set('visible')

    expect(connection.calls).toEqual(['online', 'start', 'pause', 'retryNow'])
  })

  it('passes every network report on as advice, hidden or not', () => {
    const connection = recordingConnection()
    const visibility = fakeVisibility('hidden')
    const network = fakeNetwork(false)

    attachLifecycle(connection, { visibility, network })
    network.set(true)
    network.set(false)

    expect(connection.calls).toEqual(['offline', 'online', 'offline'])
  })

  it('lets go of everything on detach, the pending grace included', () => {
    const connection = recordingConnection()
    const visibility = fakeVisibility('visible')
    const network = fakeNetwork(true)
    const detach = attachLifecycle(connection, { visibility, network })

    visibility.set('hidden')
    detach()
    vi.advanceTimersByTime(HIDDEN_GRACE_MS)
    visibility.set('visible')
    network.set(false)

    expect(connection.calls).toEqual(['online', 'start'])
    expect(visibility.listeners).toBe(0)
    expect(network.listeners).toBe(0)
  })
})
