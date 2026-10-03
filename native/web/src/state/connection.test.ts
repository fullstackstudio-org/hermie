import { GatewayError } from '@hermie/gateway-client'
import { describe, expect, it } from 'vitest'

import { RPC_FAILURE_RING_SIZE } from '../core/rpc-failures'
import { createConnectionStore } from './connection'

describe('the connection store', () => {
  it('starts disconnected, and keeps a status with the error that explains it', () => {
    const store = createConnectionStore()
    const error = new GatewayError('network', 'The gateway did not answer.')

    expect(store.getState().status).toBe('disconnected')

    store.getState().setStatus('reconnecting', error)

    expect(store.getState()).toMatchObject({ status: 'reconnecting', lastError: error })
  })

  it('keeps the newest absorbed failures, oldest first, up to the ring size', () => {
    const store = createConnectionStore()

    for (let index = 0; index < RPC_FAILURE_RING_SIZE + 3; index += 1) {
      store.getState().noteRpcFailure({ at: index, method: 'complete.slash', message: `failure ${index}` })
    }

    const ring = store.getState().rpcFailures

    expect(ring).toHaveLength(RPC_FAILURE_RING_SIZE)
    expect(ring[0]?.at).toBe(3)
    expect(ring.at(-1)?.at).toBe(RPC_FAILURE_RING_SIZE + 2)
  })

  it('puts the status back on reset and keeps the auth ring, which explains the sign-out it ran for', () => {
    const store = createConnectionStore()
    const snapshot = { events: [{ at: 1, event: 'signin.required' as const }], lastSignOut: null }

    store.getState().setStatus('needs_signin', null)
    store.getState().setAuthTimeline(snapshot)
    store.getState().reset()

    expect(store.getState().status).toBe('disconnected')
    expect(store.getState().lastError).toBeNull()
    expect(store.getState().authTimeline).toEqual(snapshot)
  })
})
