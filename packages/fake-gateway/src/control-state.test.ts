/**
 * The control routes a client in another process needs to run a black-box
 * test: read the counters (`GET /__fake/state`), drop every socket
 * (`POST /__fake/drop-sockets`), and make the next upgrades fail auth
 * (`POST /__fake/reject-upgrades`). The TypeScript tests hold the gateway
 * object and read `state` directly; the native integration tests cannot.
 */
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startFakeGateway } from './server'

interface Frame {
  id?: string
  method?: string
  params?: { type?: string }
}

/** A socket and every frame it receives, from before `open` on. */
const openSocket = async (url: string): Promise<{ socket: WebSocket; frames: Frame[] }> => {
  const socket = new WebSocket(url, ['hermes-gateway-v1'])
  const frames: Frame[] = []

  socket.on('message', raw => {
    for (const line of String(raw).split('\n')) {
      if (line.trim()) {
        frames.push(JSON.parse(line) as Frame)
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  return { socket, frames }
}

const closed = (socket: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: String(reason) })))

const until = async (label: string, reached: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000

  while (Date.now() < deadline) {
    if (reached()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 5))
  }

  throw new Error(`Timed out waiting for ${label}`)
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('GET /__fake/state', () => {
  it('reads back the counters, the method log and the answers to server requests', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const { socket, frames } = await openSocket(gateway.wsUrl)

    try {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: 'profiles.list', params: {} }))
      await until('the answer', () => frames.some(frame => frame.id === 'r1'))

      await post(`${gateway.url}/__fake/request`, { profile: 'researcher', method: 'clarify', params: {} })
      await until('the clarify', () => frames.some(frame => frame.method === 'clarify'))
      const clarify = frames.find(frame => frame.method === 'clarify')
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: clarify?.id, result: { answer: 'main' } }))
      await until('the answer to be recorded', () => gateway.state.serverRequestAnswers.length === 1)

      const response = await fetch(`${gateway.url}/__fake/state`)
      const body = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(200)
      expect(body).toMatchObject({ connections: 1, openSockets: 1, rejectedUpgrades: 0, ticketsMinted: 0 })
      expect(body.methodLog).toEqual(['profiles.list'])
      expect(body.openServerRequests).toEqual([])
      expect(body.serverRequestAnswers).toEqual([{ id: clarify?.id, method: 'clarify', result: { answer: 'main' } }])
    } finally {
      socket.terminate()
      await gateway.close()
    }
  })
})

describe('POST /__fake/drop-sockets', () => {
  it('drops every socket without a close frame when no code is given', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const { socket } = await openSocket(gateway.wsUrl)
    const ended = closed(socket)

    try {
      const response = await post(`${gateway.url}/__fake/drop-sockets`, {})

      expect(await response.json()).toEqual({ dropped: 1 })
      expect((await ended).code).toBe(1006)
    } finally {
      await gateway.close()
    }
  })

  it('closes with the code and reason it is given', async () => {
    const gateway = await startFakeGateway({ port: 0 })
    const { socket } = await openSocket(gateway.wsUrl)
    const ended = closed(socket)

    try {
      await post(`${gateway.url}/__fake/drop-sockets`, { code: 4403, reason: 'host not allowed' })

      expect(await ended).toEqual({ code: 4403, reason: 'host not allowed' })
    } finally {
      await gateway.close()
    }
  })
})

describe('POST /__fake/reject-upgrades', () => {
  it('fails the next upgrades with the close code, then lets the next one through', async () => {
    const gateway = await startFakeGateway({ port: 0, closeCode: 4401 })

    try {
      await post(`${gateway.url}/__fake/reject-upgrades`, { count: 1 })

      const { socket: refused } = await openSocket(gateway.wsUrl)
      expect(await closed(refused)).toEqual({ code: 4401, reason: 'unauthorized' })

      const { socket: accepted, frames } = await openSocket(gateway.wsUrl)
      await until('gateway.ready', () => frames.some(frame => frame.params?.type === 'gateway.ready'))

      const state = (await (await fetch(`${gateway.url}/__fake/state`)).json()) as Record<string, unknown>
      expect(state).toMatchObject({ rejectedUpgrades: 1, rejectNextUpgrades: 0, connections: 1 })

      accepted.terminate()
    } finally {
      await gateway.close()
    }
  })
})
