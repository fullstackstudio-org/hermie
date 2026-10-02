import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSocketFactory, headerlessWebSocket, PlatformWebSocket } from './socket'

/** Records what a DOM-shaped constructor was called with. */
class RecordingSocket extends EventTarget {
  static calls: unknown[][] = []

  constructor(...args: unknown[]) {
    super()
    RecordingSocket.calls.push(args)
  }
}

afterEach(() => {
  RecordingSocket.calls = []
  vi.unstubAllGlobals()
})

describe('the browser socket', () => {
  it('passes the URL and the subprotocols, and drops the headers a browser cannot send', () => {
    const Impl = headerlessWebSocket(RecordingSocket as never)

    const socket = new Impl('ws://gateway.example.com/api/ws', ['hermes-gateway-v1', 'hermes-gateway-ticket.t1'], {
      headers: { 'x-ignored': '1' }
    })

    expect(socket).toBeInstanceOf(RecordingSocket)
    expect(RecordingSocket.calls).toEqual([
      ['ws://gateway.example.com/api/ws', ['hermes-gateway-v1', 'hermes-gateway-ticket.t1']]
    ])
  })

  it('dials through the factory with the armed plan, once', () => {
    const factory = createSocketFactory(undefined, headerlessWebSocket(RecordingSocket as never))

    factory.arm({
      url: 'ws://gateway.example.com/api/ws',
      protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.t1']
    })
    factory.create('ws://gateway.example.com/api/ws')

    expect(RecordingSocket.calls).toHaveLength(1)
    expect(() => factory.create('ws://gateway.example.com/api/ws')).toThrow(/without an armed plan/u)
  })

  it('resolves the page’s WebSocket when it dials, not at import', () => {
    vi.stubGlobal('WebSocket', RecordingSocket)

    new PlatformWebSocket('ws://gateway.example.com/api/ws', ['hermes-gateway-v1'])

    expect(RecordingSocket.calls).toEqual([['ws://gateway.example.com/api/ws', ['hermes-gateway-v1']]])
  })
})
