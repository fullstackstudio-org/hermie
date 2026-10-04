import { describe, expect, it, vi } from 'vitest'

import { type ChannelFactory, type ChannelLike, createTabChannel, tabChannelName } from './tab-channel'

/** Channels on one in-memory bus, delivering like `BroadcastChannel`: to every other open instance of the name. */
function fakeBus() {
  const open = new Set<{ name: string; listeners: Set<(event: MessageEvent) => void>; closed: boolean }>()
  const posted: { name: string; message: unknown }[] = []

  const factory: ChannelFactory = name => {
    const self = { name, listeners: new Set<(event: MessageEvent) => void>(), closed: false }

    open.add(self)

    const channel: ChannelLike = {
      postMessage(message) {
        posted.push({ name, message })

        for (const other of open) {
          if (other !== self && other.name === name && !other.closed) {
            for (const listener of other.listeners) {
              listener(new MessageEvent('message', { data: message }))
            }
          }
        }
      },
      addEventListener: (_type, listener) => void self.listeners.add(listener),
      removeEventListener: (_type, listener) => void self.listeners.delete(listener),
      close() {
        self.closed = true
        open.delete(self)
      }
    }

    return channel
  }

  return { factory, posted, open }
}

describe('the tab channel', () => {
  it('tells the other tab on the same gateway, and not itself', () => {
    const bus = fakeBus()
    const first = createTabChannel('/hermes', bus.factory)
    const second = createTabChannel('/hermes', bus.factory)
    const heardByFirst = vi.fn()
    const heardBySecond = vi.fn()

    first.onForget(heardByFirst)
    second.onForget(heardBySecond)
    first.announceForget()

    expect(heardBySecond).toHaveBeenCalledTimes(1)
    expect(heardByFirst).not.toHaveBeenCalled()
    // The message says what to do and nothing else: no token, no identity.
    expect(bus.posted).toEqual([{ name: 'hermie:/hermes:session', message: { type: 'forget' } }])
  })

  it('keeps gateways behind different prefixes apart', () => {
    const bus = fakeBus()
    const here = createTabChannel('/hermes', bus.factory)
    const elsewhere = createTabChannel('/other', bus.factory)
    const heard = vi.fn()

    elsewhere.onForget(heard)
    here.announceForget()

    expect(heard).not.toHaveBeenCalled()
    expect(tabChannelName('/')).toBe('hermie:/:session')
  })

  it('ignores anything that is not its message', () => {
    const bus = fakeBus()
    const listener = createTabChannel('/', bus.factory)
    const stranger = bus.factory(tabChannelName('/'))!
    const heard = vi.fn()

    listener.onForget(heard)

    for (const message of [null, 'forget', { type: 'other' }, { kind: 'forget' }, 42]) {
      stranger.postMessage(message)
    }

    expect(heard).not.toHaveBeenCalled()
  })

  it('stops hearing once unsubscribed or closed', () => {
    const bus = fakeBus()
    const first = createTabChannel('/', bus.factory)
    const second = createTabChannel('/', bus.factory)
    const heard = vi.fn()
    const stop = second.onForget(heard)

    stop()
    first.announceForget()
    second.onForget(heard)
    second.close()
    first.announceForget()

    expect(heard).not.toHaveBeenCalled()
  })

  it('does nothing, and does not throw, where the browser has no channel', () => {
    const channel = createTabChannel('/', () => null)
    const heard = vi.fn()

    channel.onForget(heard)

    expect(() => channel.announceForget()).not.toThrow()
    expect(() => channel.close()).not.toThrow()
    expect(heard).not.toHaveBeenCalled()
  })
})
