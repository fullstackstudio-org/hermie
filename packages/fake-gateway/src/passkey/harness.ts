import { createHash, randomBytes } from 'node:crypto'

import { WebSocket } from 'ws'

import { startFakeGateway, type FakeGateway, type FakeGatewayOptions } from '../server'
import { b64u } from './encoding'

/**
 * What the passkey tests share: a gateway that knows the level, people signed in to it by cookie or by
 * bearer, live connections with a ticket (the identity a connection is minted for), and a few typed calls.
 * Test support only; nothing here is part of the fake's own surface.
 */

export interface Account {
  username: string
  password: string
  userId: string
  displayName: string
  /** The key every credential of this person is stored under. */
  key: string
}

export const ALICE: Account = account('alice', 'Alice Example')
export const BOB: Account = account('bob', 'Bob Example')

function account(username: string, displayName: string): Account {
  const userId = `${username}@example.invalid`

  return { username, password: 'hunter2', userId, displayName, key: `self-hosted:${userId}` }
}

export interface Harness {
  gateway: FakeGateway
  url: string
  close(): Promise<void>
}

const live: Harness[] = []
const sockets: WebSocket[] = []

/** Everything a test opened, closed. Call it from `afterEach`. */
export async function closeAll(): Promise<void> {
  for (const socket of sockets.splice(0)) {
    socket.terminate()
  }

  while (live.length) {
    await live.pop()?.close()
  }
}

export async function startPasskeyGateway(options: FakeGatewayOptions = {}): Promise<Harness> {
  const gateway = await startFakeGateway({
    port: 0,
    auth: 'cookie',
    accounts: [
      { username: ALICE.username, password: ALICE.password, userId: ALICE.userId, displayName: ALICE.displayName },
      { username: BOB.username, password: BOB.password, userId: BOB.userId, displayName: BOB.displayName }
    ],
    passkey: true,
    ...options
  })
  const harness: Harness = { gateway, url: gateway.url, close: () => gateway.close() }

  live.push(harness)

  return harness
}

export const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })

/** Sign `who` in with a password and return the `Cookie` header for it. */
export async function cookieFor(harness: Harness, who: Account): Promise<string> {
  const response = await post(`${harness.url}/auth/password-login`, { username: who.username, password: who.password })
  const cookie = /hermes_session_at=[^;]+/u.exec(response.headers.get('set-cookie') ?? '')?.[0]

  if (!cookie) {
    throw new Error(`could not sign ${who.username} in (${response.status})`)
  }

  return cookie
}

/** Sign in the way the native app does (PKCE) and return the `Authorization` header. */
export async function bearerFor(harness: Harness): Promise<string> {
  const verifier = b64u(randomBytes(32))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorize = new URL(`${harness.url}/auth/native/authorize`)

  authorize.searchParams.set('code_challenge', challenge)
  authorize.searchParams.set('code_challenge_method', 'S256')
  authorize.searchParams.set('redirect_uri', 'http://127.0.0.1:1/callback')
  authorize.searchParams.set('state', 'x')
  authorize.searchParams.set('auto', '1')

  const redirect = await fetch(authorize, { redirect: 'manual' })
  const code = new URL(redirect.headers.get('location') ?? '').searchParams.get('code')
  const token = (await (await post(`${harness.url}/auth/native/token`, { code, code_verifier: verifier })).json()) as {
    access_token: string
  }

  return `Bearer ${token.access_token}`
}

/** A JSON object whose shape the test checks itself. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>

export interface Frame {
  id?: string | number
  method?: string
  params?: Json
  result?: Json
  error?: { code: number; message: string; data?: Record<string, unknown> }
}

/** A live connection, minted for whoever the headers sign in, with every frame it receives. */
export interface Connection {
  socket: WebSocket
  frames: Frame[]
  call(method: string, params?: Record<string, unknown>): Promise<Frame>
  /** The first frame matching `predicate`, waiting for it. */
  next(predicate: (frame: Frame) => boolean, label?: string): Promise<Frame>
  events(type: string): Frame[]
  confirms(): Frame[]
  cancels(): Record<string, unknown>[]
}

export async function connect(
  harness: Harness,
  headers: Record<string, string> | null = null,
  query = ''
): Promise<Connection> {
  let protocols = ['hermes-gateway-v1']

  if (headers) {
    const minted = (await (await post(`${harness.url}/api/auth/ws-ticket`, {}, headers)).json()) as { ticket: string }

    protocols = ['hermes-gateway-v1', `hermes-gateway-ticket.${minted.ticket}`]
  }

  const socket = new WebSocket(`${harness.gateway.wsUrl}${query}`, protocols)
  const frames: Frame[] = []

  sockets.push(socket)
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

  let sequence = 0
  const waitFor = async (predicate: (frame: Frame) => boolean, label: string): Promise<Frame> => {
    const deadline = Date.now() + 5000

    for (;;) {
      const found = frames.find(predicate)

      if (found) {
        return found
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${label}`)
      }

      await new Promise(resolve => setTimeout(resolve, 3))
    }
  }

  return {
    socket,
    frames,
    next: (predicate, label = 'a frame') => waitFor(predicate, label),
    async call(method, params = {}) {
      sequence += 1

      const id = `c-${sequence}`

      socket.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)

      return waitFor(frame => frame.id === id && frame.method === undefined, method)
    },
    events: type => frames.filter(frame => frame.method === 'event' && frame.params?.type === type),
    confirms: () => frames.filter(frame => frame.method === 'confirm'),
    cancels: () =>
      frames
        .filter(frame => frame.method === 'event' && frame.params?.type === 'request.cancel')
        .map(frame => frame.params?.payload as Record<string, unknown>)
  }
}

/** `/__fake/state`, parsed. */
export async function stateOf(harness: Harness): Promise<Json> {
  return (await (await fetch(`${harness.url}/__fake/state`)).json()) as Json
}

export async function until(label: string, reached: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000

  while (Date.now() < deadline) {
    if (await reached()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 3))
  }

  throw new Error(`Timed out waiting for ${label}`)
}
