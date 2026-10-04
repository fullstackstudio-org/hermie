/**
 * A fake gateway on a free port and one socket to it, with a `call(method, params)` that resolves with the
 * result or rejects with the error frame (its `code` on the error). For the tests of one method family that
 * need the real server and nothing else.
 */
import { WebSocket } from 'ws'

import { startFakeGateway } from '../server'

export type Call = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

export async function withGateway<T>(run: (call: Call) => Promise<T>): Promise<T> {
  const gateway = await startFakeGateway({ port: 0 })

  try {
    const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    try {
      let id = 0

      return await run(
        (method, params = {}) =>
          new Promise((resolve, reject) => {
            const frameId = `rpc-${(id += 1)}`
            const onMessage = (data: unknown) => {
              const frame = JSON.parse(String(data)) as {
                id?: string
                result?: Record<string, unknown>
                error?: { code?: number; message?: string }
              }

              if (frame.id !== frameId) {
                return
              }

              socket.off('message', onMessage)

              if (frame.error) {
                reject(Object.assign(new Error(frame.error.message ?? 'rpc error'), { code: frame.error.code }))

                return
              }

              resolve(frame.result ?? {})
            }

            socket.on('message', onMessage)
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: frameId, method, params }))
          })
      )
    } finally {
      socket.close()
    }
  } finally {
    await gateway.close()
  }
}
