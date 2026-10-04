import { JsonRpcGatewayClient } from '@hermes/shared/json-rpc-gateway'
import { describe, expect, it, vi } from 'vitest'

import { DialPlanSocketFactory, type WebSocketConstructorLike, withoutQuery } from './socket-factory'

describe('a dial URL in an error text', () => {
  it('loses its query and fragment, where a session token rides', () => {
    expect(withoutQuery('wss://gw.example/api/ws?token=secret#x')).toBe('wss://gw.example/api/ws')
    expect(withoutQuery('wss://gw.example/api/ws')).toBe('wss://gw.example/api/ws')
  })

  it('is named without its query by the vendored client too (the sync script’s rewrite)', async () => {
    const client = new JsonRpcGatewayClient()

    await expect(client.connect('https://gw.example/api/ws?token=secret')).rejects.toThrow(
      'got "https://gw.example/api/ws"'
    )
    await expect(client.connect('https://gw.example/api/ws?token=secret')).rejects.not.toThrow(/secret/u)
  })
})

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

  it('never names the query of either URL in that refusal: a session token rides there', () => {
    const factory = new DialPlanSocketFactory(Impl)
    factory.arm({ url: 'ws://a/api/ws?token=secret-one' })

    let message = ''

    try {
      factory.create('ws://b/api/ws?token=secret-two')
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('armed for ws://a/api/ws but asked to dial ws://b/api/ws.')
    expect(message).not.toMatch(/secret|token=/u)
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
