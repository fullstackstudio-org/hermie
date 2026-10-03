/**
 * The absorbed-failure ring. The Expo app tests it only through the chat
 * controller (`onRpcFailure`); the pure half is pinned here so a change to the
 * parsing shows up before W-7b's controller tests do.
 */
import { describe, expect, it } from 'vitest'

import { describeRpcFailure, pushRpcFailure, RPC_FAILURE_RING_SIZE, type RpcFailure } from './rpc-failures'

describe('describing a failure', () => {
  it('reads the gateway’s code and message out of a serialized JSON-RPC error', () => {
    const error = new Error(JSON.stringify({ code: 4018, message: 'skill command: use command.dispatch for /docx' }))

    expect(describeRpcFailure('complete.slash', error, 42)).toEqual({
      at: 42,
      method: 'complete.slash',
      code: 4018,
      message: 'skill command: use command.dispatch for /docx'
    })
  })

  it('keeps a transport failure’s own words and names no code', () => {
    const failure = describeRpcFailure('session.resume', new Error('WebSocket closed'), 1)

    expect(failure).toEqual({ at: 1, method: 'session.resume', message: 'WebSocket closed' })
    expect(failure).not.toHaveProperty('code')
  })

  it('trims a long message and folds escaped newlines', () => {
    const long = `first\\nsecond ${'x'.repeat(400)}`
    const failure = describeRpcFailure('commands.catalog', new Error(`{"code": -32000, "message": "${long}"}`), 1)

    expect(failure.code).toBe(-32000)
    expect(failure.message.startsWith('first second')).toBe(true)
    expect(failure.message).toHaveLength(300)
  })

  it('takes what is not an error as text', () => {
    expect(describeRpcFailure('m', 'refused', 1).message).toBe('refused')
    expect(describeRpcFailure('m', undefined, 1).message).toBe('')
  })
})

describe('the ring', () => {
  it('drops from the front past its size and never edits the ring it was given', () => {
    let ring: RpcFailure[] = []
    const first = ring

    for (let index = 0; index < RPC_FAILURE_RING_SIZE + 1; index += 1) {
      ring = pushRpcFailure(ring, { at: index, method: 'm', message: '' })
    }

    expect(first).toEqual([])
    expect(ring).toHaveLength(RPC_FAILURE_RING_SIZE)
    expect(ring[0]?.at).toBe(1)
  })
})
