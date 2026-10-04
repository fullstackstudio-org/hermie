/**
 * The heartbeat while a chat is on screen, and which notifications are already
 * dealt with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPushStore } from '../../state/push'
import { aboutOnScreen, aboutRequest, closeNotifications, PushHeartbeat } from './seen'

describe('PushHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stamps at once when a chat comes on screen, then every interval, and stops when the page is hidden', () => {
    const store = createPushStore()
    let now = 1_000
    const heartbeat = new PushHeartbeat({ store, now: () => now, intervalMs: 60_000 })

    heartbeat.setOpenChat('scout')
    expect(store.getState().seen).toEqual({ bot: 'scout', at: 1_000 })

    now = 1_060
    vi.advanceTimersByTime(60_000)
    expect(store.getState().seen).toEqual({ bot: 'scout', at: 1_060 })

    heartbeat.setVisible(false)
    now = 1_200
    vi.advanceTimersByTime(180_000)
    expect(store.getState().seen?.at).toBe(1_060)

    heartbeat.setVisible(true)
    expect(store.getState().seen).toEqual({ bot: 'scout', at: 1_200 })
  })

  it('says which chat, and says nothing while none is on screen', () => {
    const store = createPushStore()
    const heartbeat = new PushHeartbeat({ store, now: () => 5, intervalMs: 10 })

    heartbeat.setOpenChat('writer')
    expect(store.getState().seen?.bot).toBe('writer')

    heartbeat.setOpenChat(null)
    store.getState().beat('cleared', 0)
    vi.advanceTimersByTime(100)
    expect(store.getState().seen).toEqual({ bot: 'cleared', at: 0 })

    heartbeat.stop()
    heartbeat.setOpenChat('scout')
    expect(store.getState().seen?.bot).toBe('cleared')
  })
})

describe('what is already dealt with', () => {
  it('is a notification about the chat on screen, not one about its other conversations', () => {
    const chat = { bot: 'scout', conversation: '' }

    expect(aboutOnScreen({ bot: 'scout', type: 'message', sessionKind: 'canonical' }, chat)).toBe(true)
    expect(aboutOnScreen({ bot: 'scout', type: 'message' }, chat)).toBe(true)
    expect(aboutOnScreen({ bot: 'scout', type: 'message', sessionKind: 'branch', sessionId: 'b1' }, chat)).toBe(false)
    expect(aboutOnScreen({ bot: 'writer', type: 'message' }, chat)).toBe(false)
  })

  it('is, for a conversation in the viewer, a notification about that conversation', () => {
    const viewer = { bot: 'scout', conversation: 'b1' }

    expect(aboutOnScreen({ bot: 'scout', sessionKind: 'branch', sessionId: 'b1' }, viewer)).toBe(true)
    expect(aboutOnScreen({ bot: 'scout', type: 'request', sessionId: 'runtime', sessionKey: 'b1' }, viewer)).toBe(true)
    expect(aboutOnScreen({ bot: 'scout', sessionKind: 'canonical' }, viewer)).toBe(false)
  })

  it('is a notification about a request that closed', () => {
    expect(aboutRequest({ bot: 'scout', requestId: 'appr-1' }, 'appr-1')).toBe(true)
    expect(aboutRequest({ bot: 'scout', request: 'appr-1' }, 'appr-1')).toBe(true)
    expect(aboutRequest({ bot: 'scout', requestId: 'appr-2' }, 'appr-1')).toBe(false)
    expect(aboutRequest({ bot: 'scout' }, '')).toBe(false)
  })

  it('is closed, and a browser that cannot list them is not an error', async () => {
    const one = { data: { bot: 'scout' }, close: vi.fn() }
    const two = { data: { bot: 'writer' }, close: vi.fn() }

    expect(
      await closeNotifications(
        async () => [one, two],
        data => aboutRequest(data, 'x') || data === one.data
      )
    ).toBe(1)
    expect(one.close).toHaveBeenCalled()
    expect(two.close).not.toHaveBeenCalled()
    expect(
      await closeNotifications(
        async () => {
          throw new Error('no worker')
        },
        () => true
      )
    ).toBe(0)
  })
})
