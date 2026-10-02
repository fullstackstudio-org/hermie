import { startFakeGateway, type FakeGateway } from '@hermie/fake-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket as NodeWebSocket } from 'ws'

import {
  assertDesktopContract,
  defaultBackoffDelayMs,
  FIRST_SESSION_TIMEOUT_MS,
  GatewayConnection,
  OFFLINE_GRACE_MS,
  PROMPT_SUBMIT_TIMEOUT_MS,
  PROTOCOL_LADDER_FLOOR,
  RECONNECT_CAP_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  rpcTimeoutMs
} from './connection'
import { type CredentialProvider, NativePkceCredentials, SessionTokenCredentials } from './credentials'
import { exchangeCode, TokenCoordinator, type TokenSet, type TokenStore } from './native-auth'
import { buildAuthorizeUrl, createPkce, parseLoopbackRedirect, REDIRECT_URI } from './pkce'
import { DialPlanSocketFactory, type WebSocketConstructorLike } from './socket-factory'
import { type ConnectionStatus, GatewayError } from './types'
import { wsUrlFor } from './url'

const SocketImpl = NodeWebSocket as unknown as WebSocketConstructorLike

const live: { gateway: FakeGateway; connection?: GatewayConnection }[] = []

afterEach(async () => {
  for (const entry of live.splice(0)) {
    entry.connection?.stop()
    await entry.gateway.close()
  }
})

function memoryStore(initial: TokenSet | null = null): TokenStore {
  let stored = initial

  return {
    async load() {
      return stored
    },
    async save(tokens) {
      stored = tokens
    },
    async clear() {
      stored = null
    }
  }
}

/** Walk the real native PKCE round trip against the fake gateway. */
async function signIn(gateway: FakeGateway): Promise<TokenSet> {
  const pkce = createPkce()
  const authorize = new URL(
    buildAuthorizeUrl(gateway.url, {
      provider: 'self-hosted',
      challenge: pkce.challenge,
      state: pkce.state,
      redirectUri: REDIRECT_URI
    })
  )
  authorize.searchParams.set('auto', '1')

  const response = await fetch(authorize, { redirect: 'manual' })
  const location = response.headers.get('location')

  if (!location) {
    throw new Error(`The authorize endpoint did not redirect (HTTP ${response.status}).`)
  }

  const redirect = parseLoopbackRedirect(location)

  if ('error' in redirect) {
    throw new Error(`Sign-in failed: ${redirect.error}`)
  }

  expect(redirect.state).toBe(pkce.state)

  return exchangeCode(gateway.url, { code: redirect.code, verifier: pkce.verifier })
}

interface Harness {
  gateway: FakeGateway
  connection: GatewayConnection
  statuses: ConnectionStatus[]
  waitFor: (status: ConnectionStatus, timeoutMs?: number) => Promise<void>
  /**
   * Wait for something the gateway counted rather than for a status.
   *
   * `waitFor('ready')` returns instantly when the connection is already ready,
   * which makes it useless for "drop the socket and let it come back": the
   * assertion runs before the redial has even started. A counter only moves when
   * the work actually happened.
   */
  waitUntil: (label: string, reached: () => boolean, timeoutMs?: number) => Promise<void>
}

async function harness(options: {
  auth?: 'none' | 'token' | 'native'
  closeCode?: number
  heartbeatIntervalMs?: number
  streamDelayMs?: number
  offlineGraceMs?: number
  readyTimeoutMs?: number
  backoffDelayMs?: (attempt: number) => number
}): Promise<Harness> {
  const auth = options.auth ?? 'none'
  const gateway = await startFakeGateway({
    auth,
    ...(options.closeCode === undefined ? {} : { closeCode: options.closeCode }),
    ...(options.streamDelayMs === undefined ? {} : { streamDelayMs: options.streamDelayMs })
  })
  const entry: { gateway: FakeGateway; connection?: GatewayConnection } = { gateway }
  live.push(entry)

  let credentials
  let coordinator: TokenCoordinator | undefined

  if (auth === 'native') {
    const store = memoryStore(await signIn(gateway))
    coordinator = new TokenCoordinator({
      store,
      refresh: async tokens => {
        const { refreshTokens } = await import('./native-auth')

        return refreshTokens(gateway.url, tokens)
      }
    })
    credentials = new NativePkceCredentials({ baseUrl: gateway.url, coordinator })
  } else {
    credentials = new SessionTokenCredentials({ token: gateway.state.token })
  }

  const factory = new DialPlanSocketFactory(SocketImpl)
  const connection = new GatewayConnection({
    config: { baseUrl: gateway.url, authMode: auth === 'native' ? 'native_pkce' : 'session_token' },
    credentials,
    socketFactory: factory,
    backoffDelayMs: options.backoffDelayMs ?? (() => 10),
    readyTimeoutMs: options.readyTimeoutMs ?? 2000,
    connectTimeoutMs: 2000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 0,
    heartbeatDeadlineMs: options.heartbeatIntervalMs ? 5000 : 0,
    // The real grace is seconds long by design; these tests only care that it
    // is observed, and `the offline grace period` below covers its length.
    offlineGraceMs: options.offlineGraceMs ?? 10
  })
  entry.connection = connection

  const statuses: ConnectionStatus[] = []
  connection.onStatus(status => statuses.push(status))

  const waitFor = async (status: ConnectionStatus, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (connection.status === status) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, 5))
    }

    throw new Error(
      `Timed out waiting for "${status}"; the connection is "${connection.status}" ` +
        `(seen: ${statuses.join(' → ')}; last error: ${connection.lastError?.message ?? 'none'})`
    )
  }

  const waitUntil = async (label: string, reached: () => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (reached()) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, 5))
    }

    throw new Error(
      `Timed out waiting for ${label}; the connection is "${connection.status}" ` +
        `(seen: ${statuses.join(' → ')}; last error: ${connection.lastError?.message ?? 'none'})`
    )
  }

  return { gateway, connection, statuses, waitFor, waitUntil }
}

const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))

describe('GatewayConnection against the fake gateway', () => {
  it('dials, waits for gateway.ready and answers the heartbeat', async () => {
    const { connection, gateway, statuses, waitFor } = await harness({ auth: 'token', heartbeatIntervalMs: 25 })

    connection.start()
    await waitFor('ready')

    expect(statuses).toEqual(['disconnected', 'authenticating', 'connecting', 'ready'])
    expect(connection.replayEpoch).toBe(gateway.state.replayEpoch)
    expect(connection.lastReadyAt).toBeGreaterThan(0)

    await settle(120)
    // The vendored channel announces itself once per connection generation, and
    // then keeps the socket honest with `gateway.ping`.
    expect(gateway.state.methodLog).toContain('client.capabilities')
    expect(gateway.state.methodLog).toContain('gateway.ping')
    expect(connection.status).toBe('ready')

    const profiles = await connection.request('profiles.list', { include_sessions: true })
    expect(profiles.profiles?.map(profile => profile.name)).toEqual(['researcher', 'writer'])
  })

  it('mints one ticket per dial and never reuses one', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    connection.start()
    await waitFor('ready')
    expect(gateway.state.ticketsMinted).toBe(1)
    expect(gateway.state.ticketsConsumed).toBe(1)

    connection.pause()
    await waitFor('paused')
    connection.resume()
    await waitFor('ready')

    expect(gateway.state.ticketsMinted).toBe(2)
    expect(gateway.state.ticketsConsumed).toBe(2)
    expect(gateway.state.connections).toBe(2)
  })

  /**
   * A 4401 is the gateway refusing the TICKET, and upstream verifies no access
   * token at all on the upgrade path: `web_server_chat.py::_ws_auth_reason` looks
   * only at `?internal=`, the ticket subprotocol, `?ticket=` and the legacy
   * `?token=`, because the HTTP auth middleware does not run for WebSocket
   * routes. So a 4401 means the ticket was expired (30 s TTL), already consumed,
   * or unknown because the process-local ticket store was reset — never that the
   * bearer token is bad. On `/api/ws` it does not even carry a close reason.
   *
   * Hermie used to answer it by forcing a refresh-token rotation, which
   * diagnosed the one thing a 4401 cannot mean, and spent a rotation to do it.
   * A fresh ticket fixes all three real causes for one HTTP round trip.
   */
  it('answers a 4401 with a fresh ticket, not a token rotation', async () => {
    const { connection, gateway, statuses, waitFor } = await harness({ auth: 'native' })

    gateway.state.rejectNextUpgrades = 1

    connection.start()
    await waitFor('ready')

    expect(gateway.state.rejectedUpgrades).toBe(1)
    expect(gateway.state.ticketsMinted).toBe(2)
    expect(gateway.state.refreshCalls).toBe(0)
    expect(statuses).not.toContain('needs_signin')
  })

  /**
   * A second refusal of a ticket minted seconds earlier is no longer a ticket
   * story, so the credential the mint authenticated with becomes the suspect and
   * the rotation happens then — one dial later than before, and only once the
   * cheap explanation has been ruled out.
   */
  it('escalates to a rotation only when a freshly minted ticket is refused too', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    gateway.state.rejectNextUpgrades = 2

    connection.start()
    await waitFor('ready')

    expect(gateway.state.rejectedUpgrades).toBe(2)
    expect(gateway.state.refreshCalls).toBe(1)
    expect(connection.status).toBe('ready')
  })

  it('stops at needs_signin once a rotated credential is refused as well', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    gateway.state.rejectNextUpgrades = 3

    connection.start()
    await waitFor('needs_signin')

    expect(connection.lastError?.kind).toBe('auth')
    expect(gateway.state.rejectedUpgrades).toBe(3)
    expect(gateway.state.refreshCalls).toBe(1)

    // Terminal: no further dials.
    await settle(150)
    expect(gateway.state.rejectedUpgrades).toBe(3)
    expect(connection.status).toBe('needs_signin')
  })

  /**
   * The tally is called "consecutive" and has to mean it.
   *
   * It was only ever reset by a dial that reached `ready`, so two auth failures
   * with an ordinary outage between them counted as "twice in a row" however long
   * the gap was — and the second one signed the user out with the message that
   * the gateway had rejected the credentials twice, which it had not. A laptop
   * that roams between networks collects exactly this shape.
   */
  it('does not count auth failures either side of an outage as consecutive', async () => {
    const { connection, gateway, statuses, waitFor, waitUntil } = await harness({ auth: 'native' })

    // Two ticket refusals far enough apart to have an ordinary outage between
    // them: the first is absorbed by a fresh ticket, then a dial fails at the
    // mint for a reason that is nobody's credential, and only then does the
    // second refusal arrive.
    gateway.state.rejectNextUpgrades = 2
    connection.start()
    await waitFor('ready')
    expect(gateway.state.refreshCalls).toBe(1)

    gateway.state.failNextTicketMints = 1
    gateway.state.rejectNextUpgrades = 2
    gateway.dropSockets()

    await waitUntil('the mint to fail', () => gateway.state.ticketMintsFailed === 1)
    await waitUntil('the connection to come back', () => connection.status === 'ready')

    expect(statuses).not.toContain('needs_signin')
  })

  /**
   * Rotation is destructive at the identity provider, so a spent refresh token
   * must never go out twice: a provider with reuse detection answers a replay by
   * revoking the whole session, which is a sign-out the client causes itself.
   */
  it('never presents a refresh token it has already rotated away', async () => {
    const { connection, gateway, waitFor, waitUntil } = await harness({ auth: 'native' })

    gateway.state.rejectNextUpgrades = 2
    connection.start()
    await waitFor('ready')

    gateway.state.rejectNextUpgrades = 2
    gateway.dropSockets()
    await waitUntil('a second rotation', () => gateway.state.refreshCalls === 2)
    await waitUntil('the connection to come back', () => connection.status === 'ready')

    expect(gateway.state.refreshReuseAttempts).toBe(0)
  })

  it('treats a 4403 as a configuration problem and does not loop', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')
    expect(gateway.state.connections).toBe(1)

    gateway.closeSockets(4403, 'host not allowed')
    await waitFor('disconnected')

    expect(connection.lastError?.kind).toBe('config')
    expect(connection.lastError?.closeCode).toBe(4403)
    expect(connection.lastError?.message).toMatch(/dashboard\.public_url/)

    await settle(200)
    expect(gateway.state.connections).toBe(1)
    expect(connection.status).toBe('disconnected')
  })

  it('reconnects after an abrupt drop and replays the events it missed', async () => {
    const { connection, gateway, statuses, waitFor } = await harness({ auth: 'token', streamDelayMs: 1 })

    connection.start()
    await waitFor('ready')

    const profiles = await connection.request('profiles.list', { include_sessions: true })
    const sessionId = profiles.profiles?.[0]?.canonical_session?.id as string
    expect(sessionId).toBeTruthy()

    await connection.request('session.resume', { session_id: sessionId, omit_messages: true })

    const complete = new Promise<void>(resolve => {
      const off = connection.on('message.complete', () => {
        off()
        resolve()
      })
    })
    await connection.request('prompt.submit', { session_id: sessionId, text: 'hello' })
    await complete

    // The gateway goes away without a close frame; the client sees 1006.
    gateway.dropSockets()
    await waitFor('reconnecting')
    await waitFor('ready')

    expect(statuses.filter(status => status === 'ready')).toHaveLength(2)
    expect(gateway.state.connections).toBe(2)

    await settle(120)
    expect(gateway.state.eventsSinceCalls.length).toBeGreaterThanOrEqual(1)
    expect(gateway.state.eventsSinceCalls[0]?.last_seen).toBeGreaterThan(0)
  })

  it('runs a single refresh for two concurrent 401s', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    connection.start()
    await waitFor('ready')

    // Every stored access token stops working, but the refresh token still does.
    gateway.state.accessTokens.clear()

    const [first, second] = await Promise.all([connection.http.authMe(), connection.http.authMe()])

    expect(first.userId).toBe('tester@example.invalid')
    expect(second.userId).toBe('tester@example.invalid')
    expect(gateway.state.refreshCalls).toBe(1)
  })

  it('pauses without reconnecting and resumes immediately', async () => {
    const { connection, gateway, statuses, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')

    connection.pause()
    await waitFor('paused')
    await settle(150)

    expect(gateway.state.connections).toBe(1)
    expect(statuses).not.toContain('reconnecting')

    connection.resume()
    await waitFor('ready')
    expect(gateway.state.connections).toBe(2)
  })

  it('says offline when the device does, and keeps dialling anyway', async () => {
    const { connection, gateway, statuses, waitFor, waitUntil } = await harness({
      auth: 'token',
      offlineGraceMs: 10
    })

    connection.start()
    await waitFor('ready')

    // The report is wrong — this gateway is reachable — which is the whole
    // reason it is not allowed to stop the loop.
    connection.setOnline(false)
    await waitUntil('the socket to be rebuilt', () => gateway.state.connections === 2)
    await waitFor('ready')

    // Said out loud on the way past, so a reader is told which of the two it is.
    expect(statuses).toContain('offline')
  })

  /**
   * The state the owner could only leave by relaunching the app: a tailnet
   * interface goes away, the connectivity API reports "no network", and then
   * never reports anything again because the Wi-Fi it is watching never moved.
   *
   * Every dial in this test would have succeeded. None of them used to happen.
   */
  it('recovers from a connectivity report that never comes back', async () => {
    const { connection, gateway, waitFor, waitUntil } = await harness({ auth: 'token', offlineGraceMs: 10 })

    connection.start()
    await waitFor('ready')

    const socketsBefore = gateway.state.connections
    connection.setOnline(false)

    await waitUntil('a dial the report was supposed to have stopped', () => gateway.state.connections > socketsBefore)
    await waitFor('ready')

    expect(await connection.request('profiles.list', {})).toBeTruthy()
  })

  /**
   * The second unrecoverable one, and the more dangerous of the two because the
   * header kept saying the connection was up.
   *
   * Offline arrives while the socket is live, so the grace starts. The socket
   * then dies for real — and the close was thrown away, because the radio was
   * believed to be down. Online arrives inside the grace, the flap rule says
   * "the socket never came down, nothing to redial", and the connection sits on
   * `ready` over a dead socket until the process is killed.
   */
  it('redials when the socket dies inside the offline grace and the report flaps back', async () => {
    const { connection, gateway, waitFor, waitUntil } = await harness({ auth: 'token', offlineGraceMs: 400 })

    connection.start()
    await waitFor('ready')

    connection.setOnline(false)
    await settle(20)
    gateway.dropSockets()
    await settle(60)
    connection.setOnline(true)

    await waitUntil('the redial', () => gateway.state.connections > 1)
    await waitFor('ready')
    // Not the status: it stayed `ready` throughout, which is precisely why it
    // proves nothing here. A round trip is what the dead socket actually costs.
    expect(await connection.request('profiles.list', {})).toBeTruthy()
  })

  it('retryNow() skips the pending backoff, and leaves a stopped connection stopped', async () => {
    const delays: number[] = []
    const { connection, gateway, waitFor, waitUntil } = await harness({
      auth: 'token',
      backoffDelayMs: attempt => {
        delays.push(attempt)

        return 30_000
      }
    })

    connection.start()
    await waitFor('ready')

    const port = gateway.port
    const token = gateway.state.token
    await gateway.close()
    await waitFor('reconnecting')
    expect(delays.length).toBe(1)

    // Half a minute of backoff is pending; "Try now" must not wait it out.
    const restarted = await startFakeGateway({ auth: 'token', port, token })
    live.push({ gateway: restarted })
    connection.retryNow()
    await waitUntil('the redial to land', () => connection.status === 'ready', 3000)

    connection.stop()
    connection.retryNow()
    await settle(60)
    expect(connection.status).toBe('disconnected')
  })

  /**
   * "Try now" and a connectivity report both call `retryNow`, and neither knows
   * whether a dial is already running. A second dial beside a live socket finds
   * the socket open, waits for a `gateway.ready` that already came, and tears
   * the good socket down when that wait times out.
   */
  it('retryNow() leaves a live connection alone', async () => {
    const { connection, gateway, statuses, waitFor } = await harness({ auth: 'native', readyTimeoutMs: 100 })

    connection.start()
    await waitFor('ready')

    connection.retryNow()
    // Past the ready timeout a second dial would have waited out.
    await settle(300)

    expect(connection.status).toBe('ready')
    expect(gateway.state.connections).toBe(1)
    expect(gateway.state.ticketsMinted).toBe(1)
    expect(statuses).toEqual(['disconnected', 'authenticating', 'connecting', 'ready'])
  })

  it('retryNow() while a dial is in flight does not start a second one', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    connection.start()
    connection.retryNow()
    await waitFor('ready')
    await settle(60)

    expect(gateway.state.ticketsMinted).toBe(1)
    expect(gateway.state.connections).toBe(1)
  })

  it('keeps a terminal status when the app goes to the background', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    // Three: a fresh ticket for the first refusal, a rotation for the second, and
    // the third is what concludes the credential is genuinely not accepted.
    gateway.state.rejectNextUpgrades = 3

    connection.start()
    await waitFor('needs_signin')

    connection.pause()
    await settle(60)

    // `paused` here would erase the only account of why nothing is connected,
    // and the sign-in banner with it.
    expect(connection.status).toBe('needs_signin')
    expect(connection.lastError?.kind).toBe('auth')
  })

  it('gives a new credential a full attempt after a resume', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    // One rejection, absorbed by the refresh. The tally it left behind must not
    // outlive the sign-in that follows.
    gateway.state.rejectNextUpgrades = 1
    connection.start()
    await waitFor('ready')

    connection.resume()
    gateway.state.rejectNextUpgrades = 1
    gateway.dropSockets()
    await waitFor('ready')

    expect(connection.status).toBe('ready')
  })

  it('answers a server-to-client approval request', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')

    const seen: string[] = []
    connection.onRequest(request => {
      seen.push(request.method)
      request.respond({ choice: 'once' })

      return true
    })

    const answer = await gateway.requestApproval({
      session_id: 'stored-researcher',
      request_id: 'ap-1',
      command: 'rm -rf build',
      description: 'Remove the build directory',
      choices: ['once', 'session', 'always', 'deny']
    })

    expect(seen).toEqual(['approval'])
    expect(answer).toEqual({ choice: 'once' })
  })

  it('declines a server request nobody handles, so the backend is not left waiting', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')

    await expect(gateway.requestApproval({ session_id: 's', request_id: 'ap-2' })).rejects.toThrow(/-32601/)
  })

  it('delivers a pushed gateway event to a typed subscriber', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')

    const changed = new Promise<void>(resolve => {
      const off = connection.on('sessions.changed', () => {
        off()
        resolve()
      })
    })

    gateway.emit('sessions.changed', { payload: {} })
    await changed
  })

  it('lets a caller shorten the prompt.submit timeout', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token' })

    connection.start()
    await waitFor('ready')

    const profiles = await connection.request('profiles.list', { include_sessions: true })
    const sessionId = profiles.profiles?.[0]?.canonical_session?.id as string

    gateway.state.hangMethods.add('prompt.submit')

    const started = Date.now()
    await expect(
      connection.request('prompt.submit', { session_id: sessionId, text: 'hello' }, { timeoutMs: 80 })
    ).rejects.toThrow(/timed out/)

    // The default for this method is half an hour; the override has to win.
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('the offline grace period', () => {
  it('rides out a NetInfo flap without rebuilding anything', async () => {
    const { connection, gateway, statuses, waitFor } = await harness({ auth: 'token', offlineGraceMs: 200 })

    connection.start()
    await waitFor('ready')
    expect(gateway.state.connections).toBe(1)

    // A Wi-Fi/cellular handover: offline and back inside the grace.
    connection.setOnline(false)
    connection.setOnline(true)
    await settle(300)

    // The socket never came down, so there is no ticket to mint and no session
    // to rebuild — and the user never saw the connection blink.
    expect(connection.status).toBe('ready')
    expect(gateway.state.connections).toBe(1)
    expect(statuses).not.toContain('offline')
  })

  it('tears the socket down once the gap outlasts the grace', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'token', offlineGraceMs: 20 })

    connection.start()
    await waitFor('ready')

    connection.setOnline(false)
    await waitFor('offline')
    expect(gateway.state.connections).toBe(1)

    connection.setOnline(true)
    await waitFor('ready')
    expect(gateway.state.connections).toBe(2)
  })

  it('waits the full grace before giving up on a live socket', async () => {
    const { connection, waitFor } = await harness({ auth: 'token', offlineGraceMs: OFFLINE_GRACE_MS })

    connection.start()
    await waitFor('ready')

    vi.useFakeTimers()

    try {
      connection.setOnline(false)
      vi.advanceTimersByTime(OFFLINE_GRACE_MS - 1)

      expect(connection.status).toBe('ready')

      vi.advanceTimersByTime(2)

      expect(connection.status).toBe('offline')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the backoff it had earned when the gateway itself is unreachable', async () => {
    const attempts: number[] = []
    const { connection, gateway, waitFor } = await harness({
      auth: 'token',
      offlineGraceMs: 5,
      backoffDelayMs: attempt => {
        attempts.push(attempt)

        return 30
      }
    })

    connection.start()
    await waitFor('ready')

    // The gateway is gone, so the ladder climbs: this is not a radio problem.
    await gateway.close()
    await waitFor('reconnecting')

    const climbed = Date.now() + 2000

    while (attempts.length < 2 && Date.now() < climbed) {
      await settle(20)
    }

    expect(attempts.length).toBeGreaterThan(1)

    connection.setOnline(false)
    await waitFor('offline')

    const mark = attempts.length
    connection.setOnline(true)

    const resumed = Date.now() + 2000

    while (attempts.length === mark && Date.now() < resumed) {
      await settle(20)
    }

    // Starting from zero again would hammer an unreachable gateway once per
    // flap, which is exactly what the ladder exists to prevent.
    expect(attempts[mark]).toBeGreaterThan(0)
  })
})

/**
 * The grace belongs to the socket that was live when the report came. A drop
 * inside it used to leave the timer running, so it fired later and tore down
 * the socket the ladder had dialled since; and the end of the grace scheduled
 * the reconnect twice, once for the teardown it caused and once for itself.
 */
describe('the offline grace and a real drop', () => {
  it('a socket that dies inside the grace ends it, so the redialled socket is not torn down later', async () => {
    const { connection, gateway, statuses, waitFor, waitUntil } = await harness({ auth: 'token', offlineGraceMs: 400 })

    connection.start()
    await waitFor('ready')

    connection.setOnline(false)
    await settle(20)
    gateway.dropSockets()
    await waitUntil('the redial', () => gateway.state.connections === 2 && connection.status === 'ready')
    const seen = statuses.length

    // Well past where the grace would have ended.
    await settle(450)

    expect(gateway.state.connections).toBe(2)
    expect(connection.status).toBe('ready')
    expect(statuses.length).toBe(seen)
  })

  it('the end of the grace schedules one reconnect, with the no-network reason', async () => {
    const attempts: number[] = []
    const { connection, waitFor } = await harness({
      auth: 'token',
      offlineGraceMs: 20,
      backoffDelayMs: attempt => {
        attempts.push(attempt)

        return 30_000
      }
    })

    connection.start()
    await waitFor('ready')

    connection.setOnline(false)
    await waitFor('offline')
    await settle(30)

    expect(attempts).toEqual([0])
    expect(connection.lastError?.message).toBe('This device reports no network connection.')
  })

  /**
   * `withinGrace` in `setOnline` read "the grace timer is pending" as "the
   * socket is still up". Now that a drop ends the grace, a pending timer only
   * exists while the connection is `ready`, which `setOnline` checks anyway, so
   * the check is gone. What is left to pin is the case it used to get wrong.
   */
  it('coming back online after a drop inside the grace keeps the earned backoff and says so', async () => {
    const { connection, gateway, waitFor } = await harness({
      auth: 'token',
      offlineGraceMs: 400,
      backoffDelayMs: () => 30_000
    })

    connection.start()
    await waitFor('ready')

    connection.setOnline(false)
    gateway.dropSockets()
    await waitFor('offline')
    const connections = gateway.state.connections

    connection.setOnline(true)
    await settle(60)

    expect(connection.status).toBe('reconnecting')
    expect(gateway.state.connections).toBe(connections)
  })
})

/**
 * How far up the ladder a failure starts, and how far down a wait may fall.
 *
 * The reported defect was 18 dials in 24 seconds against an address that was
 * answering — a proxy in front of an unrelated site, refusing the ticket mint
 * with a 405. Two things made that possible: full jitter, which draws a wait
 * uniformly from zero, and a ladder that begins at 300 ms whatever it is that
 * failed. No gateway or socket is needed to pin either, so neither is used:
 * a credential provider that throws is the whole of the dial.
 */
describe('the reconnect ladder', () => {
  /** A connection whose every dial fails with `error`, reporting the rung used. */
  function ladder(error: GatewayError): { connection: GatewayConnection; rungs: number[] } {
    const rungs: number[] = []
    const credentials: CredentialProvider = {
      mode: 'session_token',
      async httpAuthHeaders() {
        return {}
      },
      async dialPlan() {
        throw error
      },
      async onRejected() {
        return 'reauth'
      },
      async signOut() {
        // Nothing is held.
      }
    }

    const connection = new GatewayConnection({
      config: { baseUrl: 'http://gateway.invalid', authMode: 'session_token' },
      credentials,
      socketFactory: new DialPlanSocketFactory(SocketImpl),
      backoffDelayMs: attempt => {
        rungs.push(attempt)

        // Long enough that the timer never fires inside the test: what is
        // under test is which rung was asked for, not the waiting.
        return 60_000
      }
    })

    return { connection, rungs }
  }

  const firstRung = async (error: GatewayError): Promise<number> => {
    const { connection, rungs } = ladder(error)

    try {
      connection.start()

      const deadline = Date.now() + 2000

      while (rungs.length === 0 && Date.now() < deadline) {
        await settle(10)
      }

      expect(rungs.length).toBeGreaterThan(0)

      return rungs[0] as number
    } finally {
      connection.stop()
    }
  }

  it('starts an answer that is not a gateway part-way up, because a 405 will not change in 300 ms', async () => {
    expect(
      await firstRung(new GatewayError('protocol', 'The address answered HTTP 405, but not as a Hermes gateway.'))
    ).toBe(PROTOCOL_LADDER_FLOOR)
  })

  it('keeps the fast first retries for a failure to reach anything at all', async () => {
    // The flaps that really do heal in a second. Making these wait would pay
    // for the fix above with the case that already worked.
    expect(await firstRung(new GatewayError('network', 'Could not reach the gateway.'))).toBe(0)
  })

  it('never waits anywhere near zero, whatever the jitter draws', () => {
    // Full jitter — the vendored default — is a uniform draw from [0, ceiling),
    // so a ladder that had climbed to 2.4 s still redialled 40 ms later.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ceiling = Math.min(RECONNECT_CAP_MS, 300 * 2 ** attempt)

      for (let draw = 0; draw < 200; draw += 1) {
        const delay = defaultBackoffDelayMs(attempt)

        expect(delay).toBeGreaterThanOrEqual(ceiling / 2)
        expect(delay).toBeLessThanOrEqual(ceiling)
      }
    }
  })

  it('still spreads the draws out, so a fleet does not redial in lockstep', () => {
    const draws = new Set(Array.from({ length: 200 }, () => defaultBackoffDelayMs(5)))

    expect(draws.size).toBeGreaterThan(100)
  })
})

describe('rpcTimeoutMs', () => {
  it('gives a prompt half an hour', () => {
    expect(rpcTimeoutMs('prompt.submit', true)).toBe(PROMPT_SUBMIT_TIMEOUT_MS)
  })

  it('gives the first session call after a connect a minute, and later ones the default', () => {
    expect(rpcTimeoutMs('session.resume', false)).toBe(FIRST_SESSION_TIMEOUT_MS)
    expect(rpcTimeoutMs('session.create', false)).toBe(FIRST_SESSION_TIMEOUT_MS)
    expect(rpcTimeoutMs('session.resume', true)).toBe(DEFAULT_RPC_TIMEOUT_MS)
  })

  it('gives everything else thirty seconds', () => {
    expect(rpcTimeoutMs('profiles.list', false)).toBe(DEFAULT_RPC_TIMEOUT_MS)
  })
})

/**
 * The fake gateway only ever speaks plain http, so every test above is already
 * a cleartext test. This one says so on purpose: a gateway on a tailnet is
 * reached over `http://` and `ws://`, and the whole sign-in round trip has to
 * survive that. What it pins is that nothing in the flow — the authorize URL,
 * the loopback redirect, the code exchange, the ticket or the dial — upgrades a
 * scheme behind the caller's back.
 */
describe('a gateway served in the clear', () => {
  it('signs in with PKCE and dials over http/ws, forcing no scheme anywhere', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    expect(gateway.url.startsWith('http://')).toBe(true)
    expect(wsUrlFor(gateway.url).startsWith('ws://')).toBe(true)
    expect(buildAuthorizeUrl(gateway.url, { challenge: 'c', state: 's' }).startsWith('http://')).toBe(true)
    // The redirect the web view intercepts is loopback http by RFC 8252, on
    // every gateway, whatever the gateway's own scheme is.
    expect(REDIRECT_URI.startsWith('http://127.0.0.1')).toBe(true)

    connection.start()
    await waitFor('ready')

    expect(gateway.state.ticketsConsumed).toBe(1)

    const profiles = await connection.request('profiles.list', { include_sessions: true })
    expect(profiles.profiles?.map(profile => profile.name)).toEqual(['researcher', 'writer'])
  })

  it('refreshes its tokens over http as well', async () => {
    const { connection, gateway, waitFor } = await harness({ auth: 'native' })

    // Two refusals in a row: one is a stale ticket and only re-mints.
    gateway.state.rejectNextUpgrades = 2

    connection.start()
    await waitFor('ready')

    expect(gateway.state.refreshCalls).toBe(1)
  })
})

describe('assertDesktopContract', () => {
  it('accepts contract 7 and above, as a number or a string', () => {
    expect(assertDesktopContract({ desktop_contract: 7 })).toBe(7)
    expect(assertDesktopContract({ desktop_contract: '9' })).toBe(9)
  })

  it('refuses an older contract', () => {
    expect(() => assertDesktopContract({ desktop_contract: 6 })).toThrow(/needs at least 7/)
  })

  it('refuses a gateway that reports no contract at all', () => {
    expect(() => assertDesktopContract({})).toThrow(/does not report a desktop contract/)
    expect(() => assertDesktopContract(null)).toThrow(/does not report a desktop contract/)
  })

  // A bot that has never spoken has a live session without a stored row, and
  // Hermes ≤ 0.21.3 resumes it as `{model, lazy: true, profile_name}` with no
  // contract at all. That is a new bot, not an old gateway.
  it('lets a lazy resume through on the contract this gateway reported before', () => {
    expect(assertDesktopContract({ lazy: true, model: 'x' }, 7)).toBe(7)
    expect(assertDesktopContract({ lazy: true, model: 'x' }, 9)).toBe(9)
  })

  it('lets a lazy resume through on trust when nothing is known yet', () => {
    expect(assertDesktopContract({ lazy: true, model: 'x' })).toBeNull()
    expect(assertDesktopContract({ lazy: true, model: 'x' }, null)).toBeNull()
  })

  it('still refuses a lazy resume when the contract seen before was too old', () => {
    expect(() => assertDesktopContract({ lazy: true, model: 'x' }, 6)).toThrow(/needs at least 7/)
  })

  it('does not let `lazy` excuse a resume that carries an old contract', () => {
    expect(() => assertDesktopContract({ lazy: true, desktop_contract: 5 }, 7)).toThrow(/desktop contract 5/)
  })
})
