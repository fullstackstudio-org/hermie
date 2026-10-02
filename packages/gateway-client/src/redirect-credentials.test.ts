/**
 * A credential never rides a redirect.
 *
 * Measured before this existed, on Node 22: a 302 from the gateway's address to
 * another host was followed, and the second host received
 * `CF-Access-Client-Secret` and `X-Hermes-Session-Token` — only `Authorization`
 * is stripped by the platform. OkHttp on Android does the same and also goes
 * from https to http. So every request that carries anything worth stealing
 * goes out with `redirect: 'manual'`, and a redirect is a `redirect` failure.
 *
 * The cross-host cases run against two real servers and assert on what the
 * SECOND one received, because "did fetch follow it, and with which headers"
 * is exactly what a stub answers whichever way it was written. The platforms
 * that cannot be run here — a browser's opaque redirect, React Native's
 * after-the-fact `response.url` — are described with doubles of the shape each
 * platform hands back.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthTimeline } from './auth-timeline'
import { mintWsTicket, SESSION_TOKEN_HEADER, SessionTokenCredentials } from './credentials'
import { redirectSeen, requestText } from './fetch-json'
import { CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } from './front-door'
import { GatewayHttp } from './http'
import { exchangeCode, refreshTokens } from './native-auth'
import { probeGateway } from './probe'
import { classifyProbeFailure } from './probe-hints'
import { type GatewayError, isGatewayError } from './types'

const SECRET = 'front-door-secret-nobody-may-receive'
const TOKEN = 'session-token-nobody-may-receive'
const BEARER = 'bearer-nobody-may-receive'

interface Recorded {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ port: number; server: Server }> {
  const server = createServer(handler)

  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))

  return { port: (server.address() as AddressInfo).port, server }
}

/** The host a redirect sends things to: records every request, answers like a gateway would. */
async function elsewhere(): Promise<{ origin: string; seen: Recorded[] }> {
  const seen: Recorded[] = []
  const { port } = await listen((req, res) => {
    let body = ''

    req.on('data', chunk => {
      body += String(chunk)
    })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ticket: 'stolen',
          access_token: 'a',
          refresh_token: 'r',
          auth_required: false,
          auth_flows: [],
          providers: []
        })
      )
    })
  })

  // `localhost`, not `127.0.0.1`: a different NAME for the same loopback, which
  // is what makes it a different host to every client involved.
  return { origin: `http://localhost:${port}`, seen }
}

/** The configured gateway: answers every request with `status` pointing at `target`. */
async function redirecting(target: string, status = 302): Promise<string> {
  const { port } = await listen((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(status, { location: `${target}${req.url ?? '/'}` })
      res.end()
    })
  })

  return `http://127.0.0.1:${port}`
}

async function failure(promise: Promise<unknown>): Promise<GatewayError> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error
  )

  expect(isGatewayError(thrown)).toBe(true)

  return thrown as GatewayError
}

describe('an authenticated REST call that is redirected to another host', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`is not followed on a ${status}, and the other host receives nothing`, async () => {
      const other = await elsewhere()
      const http = new GatewayHttp({
        baseUrl: await redirecting(other.origin, status),
        credentials: new SessionTokenCredentials({ token: TOKEN }),
        extraHeaders: { [CF_ACCESS_CLIENT_ID]: 'id.access', [CF_ACCESS_CLIENT_SECRET]: SECRET }
      })

      const error = await failure(http.post('/api/sessions', { title: 'x' }))

      expect(error.kind).toBe('redirect')
      expect(error.redirectedTo).toBe('localhost')
      expect(error.redirectedOrigin).toBe(other.origin)
      expect(other.seen).toEqual([])
    })
  }

  it('does not follow the redirect for a picture either', async () => {
    const other = await elsewhere()
    const http = new GatewayHttp({
      baseUrl: await redirecting(other.origin),
      credentials: new SessionTokenCredentials({ token: TOKEN }),
      extraHeaders: { [CF_ACCESS_CLIENT_SECRET]: SECRET }
    })

    expect(await http.fetchAuthenticatedPicture('/api/auth/picture?id=1')).toEqual({ kind: 'error' })
    expect(other.seen).toEqual([])
  })
})

describe('the WebSocket ticket mint', () => {
  it('is not followed across hosts, records why, and the other host receives nothing', async () => {
    const other = await elsewhere()
    const timeline = new AuthTimeline({ now: () => 0 })

    const error = await failure(
      mintWsTicket({
        baseUrl: await redirecting(other.origin, 307),
        headers: { authorization: `Bearer ${BEARER}`, [CF_ACCESS_CLIENT_SECRET]: SECRET },
        timeline
      })
    )

    expect(error.kind).toBe('redirect')
    expect(other.seen).toEqual([])
    expect(timeline.snapshot().events.map(event => [event.event, event.kind])).toEqual([['ticket.failed', 'redirect']])
  })
})

describe('the token endpoints', () => {
  it('do not replay a refresh token to another host on a 307', async () => {
    const other = await elsewhere()
    const base = await redirecting(other.origin, 307)

    expect((await failure(refreshTokens(base, { refreshToken: 'refresh-secret', provider: 'p' }))).kind).toBe(
      'redirect'
    )
    expect((await failure(exchangeCode(base, { code: 'c', verifier: 'v' }))).kind).toBe('redirect')
    expect(other.seen).toEqual([])
  })
})

describe('the probe', () => {
  it('with front-door headers attached, does not follow a redirect at all', async () => {
    const other = await elsewhere()

    const error = await failure(
      probeGateway(await redirecting(other.origin), { [CF_ACCESS_CLIENT_ID]: 'id', [CF_ACCESS_CLIENT_SECRET]: SECRET })
    )

    expect(error.kind).toBe('redirect')
    expect(error.redirectedTo).toBe('localhost')
    expect(other.seen).toEqual([])
  })

  it('without any header of its own, follows far enough to say where the address went', async () => {
    const other = await elsewhere()

    const error = await failure(probeGateway(await redirecting(other.origin)))

    // Followed (nothing to carry), and the answer is still not read.
    expect(error.kind).toBe('redirect')
    expect(error.redirectedOrigin).toBe(other.origin)
    expect(other.seen.map(request => request.url)).toEqual(['/api/status'])
  })

  it('refuses a redirect to another port on the same host, and offers that address', async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"auth_required":false}')
    })
    const target = `http://127.0.0.1:${port}`

    const error = await failure(probeGateway(await redirecting(target)))

    expect(error.kind).toBe('redirect')
    expect(error.redirectedTo).toBe('127.0.0.1')
    expect(error.redirectedOrigin).toBe(target)
    expect(error.message).toMatch(/which is a different address/u)
    expect(classifyProbeFailure(error, { address: 'http://127.0.0.1:1' }).actions).toEqual([
      { kind: 'use_host', host: '127.0.0.1', origin: target }
    ])
  })

  it('follows a redirect that stays within one origin', async () => {
    const { port } = await listen((req, res) => {
      if (req.url === '/api/status') {
        res.writeHead(301, { location: '/api/status/' })
        res.end()

        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"auth_required":false,"version":"1.0.0"}')
    })

    expect((await probeGateway(`http://127.0.0.1:${port}`)).version).toBe('1.0.0')
  })

  it('refuses https to http on the same name, and says so', async () => {
    // The shape every platform that followed hands back: `response.url` is
    // where the answer actually came from. Before this, only the HOST was
    // compared, so this was accepted and the stored address stayed https.
    const fetchImpl = vi.fn(async (url: string) => {
      const response = new Response('{"auth_required":false}', { status: 200 })

      Object.defineProperty(response, 'url', { value: url.replace('https://', 'http://') })

      return response
    }) as unknown as typeof fetch

    const error = await failure(probeGateway('https://gateway.example', {}, fetchImpl))

    expect(error.kind).toBe('redirect')
    expect(error.redirectedTo).toBe('gateway.example')
    expect(error.redirectedOrigin).toBe('http://gateway.example')
    expect(error.message).toMatch(/which is not https/u)
  })

  it('normalizes a raw address itself', async () => {
    const asked: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      asked.push(url)

      return new Response('{"auth_required":false}', { status: 200 })
    }) as unknown as typeof fetch

    await probeGateway('  Gateway.Example:9119/prefix/  ', {}, fetchImpl)

    expect(asked).toEqual(['https://gateway.example:9119/prefix/api/status'])
  })
})

describe('the platforms that cannot be run here', () => {
  it('a browser: an opaque redirect is a redirect, with nowhere to name', async () => {
    const text = vi.fn(async () => '{"stolen":true}')
    const fetchImpl = vi.fn(async () => ({
      type: 'opaqueredirect',
      status: 0,
      ok: false,
      url: '',
      headers: new Headers(),
      text
    })) as unknown as typeof fetch

    const error = await failure(requestText('https://gateway.example/api/x', { fetchImpl }))

    expect(error.kind).toBe('redirect')
    expect(error.redirectedTo).toBeUndefined()
    expect(text).not.toHaveBeenCalled()
  })

  it('every credentialed call asks the platform not to follow', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))

    await requestText('https://gateway.example/api/x', { fetchImpl: fetchImpl as unknown as typeof fetch })

    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual')
  })

  it('React Native: an answer from another origin is refused before its body is read', async () => {
    for (const landed of [
      'https://other.example/api/x',
      'http://gateway.example/api/x',
      'https://gateway.example:8443/api/x'
    ]) {
      const text = vi.fn(async () => '{"stolen":true}')
      const fetchImpl = vi.fn(async () => ({
        type: 'default',
        status: 200,
        ok: true,
        url: landed,
        headers: new Headers(),
        text
      })) as unknown as typeof fetch

      const error = await failure(
        new GatewayHttp({
          baseUrl: 'https://gateway.example',
          credentials: new SessionTokenCredentials({ token: TOKEN }),
          fetchImpl
        }).get('/api/x')
      )

      expect(error.kind).toBe('redirect')
      expect(error.redirectedOrigin).toBe(new URL(landed).origin)
      expect(text).not.toHaveBeenCalled()
    }
  })

  it('Android: the target the guard moved out of `Location` is still named', () => {
    const headers = new Headers({ 'x-hermie-refused-location': 'https://other.example:8443/api/x' })

    expect(
      redirectSeen({ status: 302, url: 'https://gateway.example/api/x', headers }, 'https://gateway.example/api/x')
    ).toEqual({ target: 'https://other.example:8443/api/x' })
  })

  it('a 304 is not a redirect, and neither is an answer from the origin that was asked', () => {
    expect(redirectSeen({ status: 304 }, 'https://gateway.example/a')).toBeNull()
    expect(redirectSeen({ status: 200, url: 'https://gateway.example:443/b' }, 'https://gateway.example/a')).toBeNull()
    expect(redirectSeen({ status: 200, url: '' }, 'https://gateway.example/a')).toBeNull()
  })

  it('the session-token header is the one a follow would have carried', () => {
    // Pinned so the assertion above about "the other host receives nothing"
    // is about the header Node does NOT strip by itself.
    expect(SESSION_TOKEN_HEADER).toBe('X-Hermes-Session-Token')
  })
})
