import { describe, expect, it, vi } from 'vitest'

import { DialPlanSocketFactory, type WebSocketConstructorLike } from './socket-factory'

class RecordingSocket extends EventTarget {
  static built: RecordingSocket[] = []

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers?: Record<string, string> }
  ) {
    super()
    RecordingSocket.built.push(this)
  }
}

const Impl = RecordingSocket as unknown as WebSocketConstructorLike

describe('DialPlanSocketFactory', () => {
  it('refuses to dial without an armed plan', () => {
    const factory = new DialPlanSocketFactory(Impl)

    expect(() => factory.create('ws://x/api/ws')).toThrow(/without an armed plan/)
  })

  it('refuses to dial a URL it was not armed for', () => {
    const factory = new DialPlanSocketFactory(Impl)
    factory.arm({ url: 'ws://a/api/ws' })

    expect(() => factory.create('ws://b/api/ws')).toThrow(/armed for ws:\/\/a/)
  })

  it('passes protocols and headers through to the constructor', () => {
    RecordingSocket.built = []
    const factory = new DialPlanSocketFactory(Impl)
    factory.arm({
      url: 'ws://a/api/ws',
      protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.abc'],
      headers: { 'CF-Access-Client-Id': 'x' }
    })
    factory.create('ws://a/api/ws')

    const built = RecordingSocket.built[0]
    expect(built?.url).toBe('ws://a/api/ws')
    expect(built?.protocols).toEqual(['hermes-gateway-v1', 'hermes-gateway-ticket.abc'])
    expect(built?.options).toEqual({ headers: { 'CF-Access-Client-Id': 'x' } })
  })

  it('omits the options argument when there are no headers', () => {
    RecordingSocket.built = []
    const factory = new DialPlanSocketFactory(Impl)
    factory.arm({ url: 'ws://a/api/ws', headers: {} })
    factory.create('ws://a/api/ws')

    expect(RecordingSocket.built[0]?.options).toBeUndefined()
  })

  it('consumes the plan so a single-use ticket cannot be dialled twice', () => {
    const factory = new DialPlanSocketFactory(Impl)
    factory.arm({ url: 'ws://a/api/ws' })
    factory.create('ws://a/api/ws')

    expect(factory.armed).toBe(false)
    expect(() => factory.create('ws://a/api/ws')).toThrow(/without an armed plan/)
  })

  it('disarm drops a plan that was never dialled', () => {
    const factory = new DialPlanSocketFactory(Impl)
    factory.arm({ url: 'ws://a/api/ws' })
    factory.disarm()

    expect(factory.armed).toBe(false)
  })

  /**
   * The connection reads the last close code as the verdict on the dial in
   * flight. A socket it closed or replaced can report its close late, and a
   * 4403 from it used to be taken as the answer to the next dial.
   */
  it('forwards a close only from the socket it built last, and not once released', () => {
    RecordingSocket.built = []
    const onClose = vi.fn()
    const factory = new DialPlanSocketFactory(Impl, onClose)
    factory.arm({ url: 'ws://a/api/ws' })
    const first = factory.create('ws://a/api/ws') as unknown as RecordingSocket
    factory.arm({ url: 'ws://a/api/ws' })
    const second = factory.create('ws://a/api/ws') as unknown as RecordingSocket

    first.dispatchEvent(Object.assign(new Event('close'), { code: 4403, reason: 'stale' }))
    expect(onClose).not.toHaveBeenCalled()

    factory.release()
    second.dispatchEvent(Object.assign(new Event('close'), { code: 1005, reason: '' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('forwards the close code and reason', () => {
    RecordingSocket.built = []
    const onClose = vi.fn()
    const factory = new DialPlanSocketFactory(Impl, onClose)
    factory.arm({ url: 'ws://a/api/ws' })
    const socket = factory.create('ws://a/api/ws') as unknown as RecordingSocket

    // `CloseEvent` is not a global before Node 23; a plain Event with the same fields is enough here.
    socket.dispatchEvent(Object.assign(new Event('close'), { code: 4401, reason: 'unauthorized' }))

    expect(onClose).toHaveBeenCalledWith({ code: 4401, reason: 'unauthorized' })
  })
})
