/**
 * `POST /__fake/request`, the control surface that makes `clarify` reachable.
 *
 * Two of the three question shapes a client has to survive could already be
 * raised by typing a sentence into a chat — "approve" parks the turn on an
 * approval, "delegate" fans out. `clarify` could only be raised by a test
 * holding the gateway object, so the clarify sheet was the one question card no
 * manual pass had ever opened, and every web QA pass so far has said so.
 *
 * Two things are pinned, and the second is the one that keeps it usable: the
 * request reaches an attached socket as a server→client JSON-RPC call, and the
 * HTTP call ANSWERS rather than parking until somebody clicks the sheet.
 */
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startFakeGateway } from './server'

const openSocket = async (url: string): Promise<WebSocket> => {
  const socket = new WebSocket(url, ['hermes-gateway-v1'])

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  return socket
}

/** The next server→client request frame to arrive, whatever else is on the wire. */
const nextRequest = (socket: WebSocket): Promise<{ id: string; method: string; params: Record<string, unknown> }> =>
  new Promise(resolve => {
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as {
        id?: string
        method?: string
        params?: Record<string, unknown>
      }

      if (frame.id !== undefined && frame.method !== undefined) {
        resolve({ id: frame.id, method: frame.method, params: frame.params ?? {} })
      }
    })
  })

describe('POST /__fake/request', () => {
  it('raises a clarify on an attached client and answers straight away', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      const arrived = nextRequest(socket)

      const response = await fetch(`${gateway.url}/__fake/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: 'researcher',
          method: 'clarify',
          params: { question: 'Which branch?', choices: ['main', 'next'] }
        })
      })

      // Answered, with the question still open: the endpoint raises, it does
      // not wait for the reader.
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ raised: 'clarify' })

      const request = await arrived

      expect(request.method).toBe('clarify')
      expect(request.params).toMatchObject({ question: 'Which branch?', choices: ['main', 'next'] })
      expect(typeof request.params.session_id).toBe('string')
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })

  it('queues an approval with a queue id until it is answered, as the real gateway does', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      const arrived = nextRequest(socket)

      await fetch(`${gateway.url}/__fake/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: 'researcher',
          method: 'approval',
          params: { request_id: 'appr-raised', command: 'ls', choices: ['once', 'deny'] }
        })
      })

      const request = await arrived

      expect([...gateway.state.pendingApprovals.keys()]).toContain('appr-raised')

      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { choice: 'deny' } }))
      await expect.poll(() => [...gateway.state.pendingApprovals.keys()]).not.toContain('appr-raised')
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })

  it('withdraws every open request on /__fake/withdraw-requests, with a request.cancel', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      const arrived = nextRequest(socket)
      const cancelled = new Promise<Record<string, unknown>>(resolve => {
        socket.on('message', raw => {
          const frame = JSON.parse(String(raw)) as { method?: string; params?: { type?: string; payload?: object } }

          if (frame.method === 'event' && frame.params?.type === 'request.cancel') {
            resolve(frame.params.payload as Record<string, unknown>)
          }
        })
      })

      await fetch(`${gateway.url}/__fake/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'researcher', method: 'clarify', params: { question: 'Which?' } })
      })
      const request = await arrived

      const response = await fetch(`${gateway.url}/__fake/withdraw-requests`, { method: 'POST', body: '{}' })

      expect(await response.json()).toEqual({ withdrawn: 1 })
      expect(await cancelled).toEqual({ id: request.id, method: 'clarify', reason: 'withdrawn' })
      expect(gateway.state.openServerRequests.size).toBe(0)
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })

  it('says which profile it could not find rather than raising on the wrong chat', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      const response = await fetch(`${gateway.url}/__fake/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'nobody', method: 'clarify' })
      })

      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ detail: expect.stringContaining('nobody') })
    } finally {
      await gateway.close()
    }
  })
})

/**
 * Every kind of server→client request the web client has to answer, raised from
 * outside the process.
 *
 * `/__fake/request` takes any method name, which is why these pass without a
 * line of server code for `secret`, `sudo` and the vault prompts: the cases are
 * the proof that each one makes the whole round trip — raised on an attached
 * socket, answered, the answer recorded where a test in another process can read
 * it — and that `request.cancel` withdraws each of them. The `confirm` cases are
 * the exception, because that request is gated on a level the client has to offer.
 */
const raise = (gateway: { url: string }, method: string, params: Record<string, unknown> = {}): Promise<Response> =>
  fetch(`${gateway.url}/__fake/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'researcher', method, params })
  })

const stateOf = async (gateway: { url: string }): Promise<Record<string, unknown>> =>
  (await (await fetch(`${gateway.url}/__fake/state`)).json()) as Record<string, unknown>

/** Send `client.capabilities` and wait for its answer, the way a client does before it can be asked anything. */
const advertise = (socket: WebSocket, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
  new Promise(resolve => {
    const id = `caps-${Math.random()}`

    socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { id?: string; result?: Record<string, unknown> }

      if (frame.id === id) {
        resolve(frame.result ?? {})
      }
    })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'client.capabilities', params }))
  })

/** The `request.cancel` payload that arrives on a socket. */
const nextCancel = (socket: WebSocket): Promise<Record<string, unknown>> =>
  new Promise(resolve => {
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { method?: string; params?: { type?: string; payload?: object } }

      if (frame.method === 'event' && frame.params?.type === 'request.cancel') {
        resolve(frame.params.payload as Record<string, unknown>)
      }
    })
  })

describe.each([
  ['secret', { env_var: 'API_KEY', prompt: 'Paste the key' }, { value: 'sk-test' }],
  ['sudo', { command: 'apt update' }, { value: 'hunter2' }],
  ['vault.code', { site: 'example.com', hint: 'sent by SMS' }, { value: '123456' }],
  [
    'vault.save_login',
    { origin: 'https://example.com', site: 'example.com' },
    { value: '{"identifier":"a","password":"b"}' }
  ],
  ['vault.unlock_prompt', { backend: 'bitwarden', display_name: 'Vault' }, { value: 'master' }]
])('%s through /__fake/request', (method, params, answer) => {
  it('is raised on an attached client, answered, and the answer is recorded in /__fake/state', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      const arrived = nextRequest(socket)
      const response = await raise(gateway, method, params)

      expect(await response.json()).toMatchObject({ raised: method })

      const request = await arrived

      expect(request.method).toBe(method)
      expect(request.params).toMatchObject(params)
      expect(await stateOf(gateway)).toMatchObject({ openServerRequests: [request.id] })

      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: answer }))
      await expect
        .poll(async () => (await stateOf(gateway)).serverRequestAnswers)
        .toEqual([{ id: request.id, method, result: answer }])
      expect((await stateOf(gateway)).openServerRequests).toEqual([])
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })

  it('records a JSON-RPC error answer as the error, not as a result', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      const arrived = nextRequest(socket)

      await raise(gateway, method, params)

      const request = await arrived
      const error = { code: 4000, message: 'this client cannot answer that' }

      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error }))
      await expect
        .poll(async () => (await stateOf(gateway)).serverRequestAnswers)
        .toEqual([{ id: request.id, method, error }])
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })

  it('is withdrawn with a request.cancel naming its method', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      const arrived = nextRequest(socket)
      const cancelled = nextCancel(socket)

      await raise(gateway, method, params)

      const request = await arrived
      const withdrawn = await fetch(`${gateway.url}/__fake/withdraw-requests`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'timeout' })
      })

      expect(await withdrawn.json()).toEqual({ withdrawn: 1 })
      expect(await cancelled).toEqual({ id: request.id, method, reason: 'timeout' })
      expect((await stateOf(gateway)).openServerRequests).toEqual([])
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })
})

describe('confirm through /__fake/request', () => {
  const params = { title: 'Pay the plumber', summary: 'Pay 10 EUR to the plumber.', level: 'plain' }

  it('round-trips with a client that offered the level, and the answer is recorded', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      await advertise(socket, { server_requests: true, confirm: ['plain'] })

      const arrived = nextRequest(socket)
      const response = await raise(gateway, 'confirm', params)

      expect(response.status).toBe(200)

      const request = await arrived
      const answer = { decision: 'confirm', method: 'plain' }

      expect(request.method).toBe('confirm')
      expect(request.params).toMatchObject(params)

      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: answer }))
      await expect
        .poll(async () => (await stateOf(gateway)).serverRequestAnswers)
        .toEqual([{ id: request.id, method: 'confirm', result: answer }])
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })

  it('is withdrawn with a request.cancel like every other request', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      await advertise(socket, { server_requests: true, confirm: ['plain'] })

      const arrived = nextRequest(socket)
      const cancelled = nextCancel(socket)

      await raise(gateway, 'confirm', params)

      const request = await arrived

      await fetch(`${gateway.url}/__fake/withdraw-requests`, { method: 'POST', body: '{}' })
      expect(await cancelled).toEqual({ id: request.id, method: 'confirm', reason: 'withdrawn' })
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })

  it('refuses a level the client did not offer, says so, and raises nothing', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      // A browser: it offers `plain` and nothing stronger.
      await advertise(socket, { server_requests: true, confirm: ['plain'] })

      const response = await raise(gateway, 'confirm', { ...params, level: 'device_auth' })

      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        detail: 'No connected client offered the "device_auth" confirm level in client.capabilities; nothing was sent'
      })
      expect((await stateOf(gateway)).openServerRequests).toEqual([])
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })

  it('refuses when no client offered any level, and treats a missing level as `plain`', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      await advertise(socket, { server_requests: true })

      const { level: _level, ...unlevelled } = params
      const refused = await raise(gateway, 'confirm', unlevelled)

      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ detail: expect.stringContaining('"plain"') })

      await advertise(socket, { server_requests: true, confirm: ['plain'] })

      expect((await raise(gateway, 'confirm', unlevelled)).status).toBe(200)
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })

  it('reaches only the connections that offered the level', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const browser = await openSocket(gateway.wsUrl)
    const native = await openSocket(gateway.wsUrl)

    try {
      await advertise(browser, { server_requests: true, confirm: ['plain'] })
      await advertise(native, { server_requests: true, confirm: ['plain', 'device_auth'] })

      const seenByBrowser: string[] = []

      browser.on('message', raw => {
        const frame = JSON.parse(String(raw)) as { method?: string }

        if (frame.method === 'confirm') {
          seenByBrowser.push(frame.method)
        }
      })

      const arrived = nextRequest(native)

      expect((await raise(gateway, 'confirm', { ...params, level: 'device_auth' })).status).toBe(200)
      expect((await arrived).method).toBe('confirm')

      // Give a frame the browser should not have been sent time to arrive.
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(seenByBrowser).toEqual([])
    } finally {
      browser.terminate()
      native.terminate()
      await gateway.close()
    }
  })

  it('forgets a level when its connection goes', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const socket = await openSocket(gateway.wsUrl)

    try {
      await advertise(socket, { server_requests: true, confirm: ['plain'] })
      socket.terminate()
      await expect.poll(async () => (await stateOf(gateway)).openSockets).toBe(0)

      expect((await raise(gateway, 'confirm', params)).status).toBe(409)
    } finally {
      await gateway.close()
    }
  })
})
