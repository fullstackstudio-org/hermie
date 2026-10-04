/**
 * `client.capabilities`.
 *
 * The method is what a client says it can answer. The fake records every call so
 * a black-box test can read back what the client under test actually sent —
 * `confirm` levels included — and answers with every kind of request it can
 * raise. A client that offered no `confirm` keeps getting the answer it always
 * got, with no `confirm` member.
 *
 * The same call carries `requests`, the interactive methods (`input.form`, `input.file`, `review.draft`,
 * `review.diff`) the client can show: recorded and echoed as the gateway accepted them, and only together with
 * `server_requests: true`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

const gateways: FakeGateway[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate()
  }

  while (gateways.length) {
    await gateways.pop()?.close()
  }
})

const connect = async (
  options: Parameters<typeof startFakeGateway>[0] = {}
): Promise<{
  gateway: FakeGateway
  call: (method: string, params?: object) => Promise<Record<string, unknown>>
}> => {
  const gateway = await startFakeGateway({ port: 0, ...options })
  gateways.push(gateway)

  const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  let id = 0

  return {
    gateway,
    call: (method, params = {}) =>
      new Promise(resolve => {
        const frameId = `rpc-${(id += 1)}`

        socket.on('message', raw => {
          const frame = JSON.parse(String(raw)) as { id?: string; result?: Record<string, unknown> }

          if (frame.id === frameId) {
            resolve(frame.result ?? {})
          }
        })
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: frameId, method, params }))
      })
  }
}

const INTERACTIVE = ['input.form', 'input.file', 'review.draft', 'review.diff']
const KINDS = [
  'approval',
  'clarify',
  'secret',
  'sudo',
  'vault.code',
  'vault.save_login',
  'vault.unlock_prompt',
  ...INTERACTIVE
]

describe('client.capabilities', () => {
  it('lists every request kind the web client has to handle', async () => {
    const { call } = await connect()

    expect(await call('client.capabilities', { server_requests: true })).toEqual({
      server_requests: KINDS,
      confirm_fields: false
    })
  })

  it('adds `confirm` once the client offers a level, and echoes the levels it took', async () => {
    const { call } = await connect()

    expect(await call('client.capabilities', { server_requests: true, confirm: ['plain'] })).toEqual({
      server_requests: [...KINDS, 'confirm'],
      confirm: ['plain'],
      confirm_fields: false
    })
  })

  it('answers an empty `confirm` list with the list and no `confirm` request kind', async () => {
    const { call } = await connect()

    expect(await call('client.capabilities', { server_requests: true, confirm: [] })).toEqual({
      server_requests: KINDS,
      confirm: [],
      confirm_fields: false
    })
  })

  it('ignores entries in `confirm` that are not level names', async () => {
    const { call } = await connect()

    const answer = await call('client.capabilities', {
      server_requests: true,
      confirm: ['plain', 7, '', null, 'plain']
    })

    expect(answer.confirm).toEqual(['plain'])
  })

  it('records every call in /__fake/state, as the client sent it', async () => {
    const { gateway, call } = await connect()

    await call('client.capabilities', { server_requests: true })
    await call('client.capabilities', { server_requests: true, confirm: ['plain'] })

    const state = (await (await fetch(`${gateway.url}/__fake/state`)).json()) as Record<string, unknown>

    expect(state.clientCapabilities).toEqual([
      { server_requests: true, confirm: [] },
      { server_requests: true, confirm: ['plain'] }
    ])
    expect(gateway.state.clientCapabilities).toEqual(state.clientCapabilities)
  })

  it('counts levels only together with `server_requests`, as the real gateway does', async () => {
    const { gateway, call } = await connect()

    await call('client.capabilities', { confirm: ['plain'] })

    expect(gateway.state.clientCapabilities).toEqual([{ server_requests: false, confirm: [] }])
  })

  it('echoes the interactive methods it accepted, and nothing when the call carried no `requests`', async () => {
    const { gateway, call } = await connect()

    expect(await call('client.capabilities', { server_requests: true })).not.toHaveProperty('requests')
    expect(
      await call('client.capabilities', { server_requests: true, requests: ['review.draft', 'input.form', 'nope', 7] })
    ).toEqual({ server_requests: KINDS, confirm_fields: false, requests: ['input.form', 'review.draft'] })
    expect(gateway.state.clientCapabilities).toEqual([
      { server_requests: true, confirm: [] },
      { server_requests: true, confirm: [], requests: ['input.form', 'review.draft'] }
    ])
  })

  it('echoes `[]` for `requests` without `server_requests: true`, and for an empty list', async () => {
    const { gateway, call } = await connect()

    expect(await call('client.capabilities', { requests: INTERACTIVE })).toEqual({
      server_requests: KINDS,
      confirm_fields: false,
      requests: []
    })
    expect(await call('client.capabilities', { server_requests: true, requests: [] })).toEqual({
      server_requests: KINDS,
      confirm_fields: false,
      requests: []
    })
    expect(gateway.state.clientCapabilities.map(entry => entry.requests)).toEqual([[], []])
  })

  it('carries `requests` next to `confirm` in one call, on a gateway that knows the passkey level too', async () => {
    const { call } = await connect({ passkey: true })

    const answer = await call('client.capabilities', {
      server_requests: true,
      confirm: ['plain'],
      requests: INTERACTIVE
    })

    expect(answer).toMatchObject({ confirm: ['plain'], requests: INTERACTIVE })
    expect(answer.server_requests).toEqual(expect.arrayContaining([...INTERACTIVE, 'confirm']))
  })

  it('stays in the method log like every other call', async () => {
    const { gateway, call } = await connect()

    await call('client.capabilities', { server_requests: true })

    expect(gateway.state.methodLog).toContain('client.capabilities')
  })
})
