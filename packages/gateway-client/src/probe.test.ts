import { describe, expect, it, vi } from 'vitest'

import { type FrontDoor, NO_FRONT_DOOR } from './front-door'
import { PROBE_TIMEOUT_MS, probeGateway, resolveGatewayAddress } from './probe'
import { GatewayError } from './types'

const ACCESS: FrontDoor = {
  kind: 'cloudflare_access',
  clientId: 'abc',
  clientSecret: 'shh',
  origin: 'https://gw.example.test'
}

type Route = { status?: number; body?: unknown; text?: string; throws?: Error }

/** A fetch stand-in that answers by pathname. */
function stubFetch(routes: Record<string, Route>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const route = routes[url.pathname]

    if (!route) {
      return new Response('not found', { status: 404 })
    }

    if (route.throws) {
      throw route.throws
    }

    const body = route.text ?? JSON.stringify(route.body ?? {})

    return new Response(body, { status: route.status ?? 200 })
  }) as typeof fetch
}

const gatedStatus = {
  version: '0.21.3',
  auth_required: true,
  auth_providers: ['self-hosted'],
  auth_flows: ['cookie', 'native_pkce']
}

describe('probeGateway', () => {
  it('reads an ungated gateway without asking for providers', async () => {
    let providersAsked = false
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))

      if (url.pathname === '/api/auth/providers') {
        providersAsked = true
      }

      return new Response(JSON.stringify({ version: '0.21.3', auth_required: false, auth_flows: [] }), { status: 200 })
    }) as typeof fetch

    const result = await probeGateway('http://localhost:9119', {}, fetchImpl)

    expect(result).toEqual({
      version: '0.21.3',
      authRequired: false,
      authFlows: [],
      providers: [],
      supportsNativePkce: false
    })
    expect(providersAsked).toBe(false)
  })

  it('reads a gated gateway and its providers', async () => {
    const result = await probeGateway(
      'https://example.test',
      {},
      stubFetch({
        '/api/status': { body: gatedStatus },
        '/api/auth/providers': {
          body: { providers: [{ name: 'self-hosted', display_name: 'Self-Hosted OIDC', supports_password: false }] }
        }
      })
    )

    expect(result.authRequired).toBe(true)
    expect(result.supportsNativePkce).toBe(true)
    expect(result.version).toBe('0.21.3')
    expect(result.providers).toEqual([
      { name: 'self-hosted', displayName: 'Self-Hosted OIDC', supportsPassword: false }
    ])
  })

  it('treats a 503 from the provider scan as "no providers", not a failure', async () => {
    const result = await probeGateway(
      'https://example.test',
      {},
      stubFetch({ '/api/status': { body: gatedStatus }, '/api/auth/providers': { status: 503, body: {} } })
    )

    expect(result.authRequired).toBe(true)
    expect(result.providers).toEqual([])
  })

  it('sends the extra headers on every call', async () => {
    const seen: Record<string, string>[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>)

      return new Response(JSON.stringify(String(input).includes('providers') ? { providers: [] } : gatedStatus), {
        status: 200
      })
    }) as typeof fetch

    await probeGateway('https://example.test', { 'CF-Access-Client-Id': 'abc' }, fetchImpl)

    expect(seen).toHaveLength(2)
    expect(seen.every(headers => headers['CF-Access-Client-Id'] === 'abc')).toBe(true)
  })

  it.each([
    ['a 404', { '/api/status': { status: 404, text: 'nope' } }],
    ['a non-JSON body', { '/api/status': { status: 200, text: '<html>hello</html>' } }],
    ['JSON without auth_required', { '/api/status': { status: 200, body: { version: '1' } } }]
  ])('classifies %s as not_hermes', async (_label, routes) => {
    await expect(
      probeGateway('https://example.test', {}, stubFetch(routes as Record<string, Route>))
    ).rejects.toMatchObject({ kind: 'not_hermes' })
  })

  it('classifies a 401 on /api/status as an access-proxy problem', async () => {
    await expect(
      probeGateway('https://example.test', {}, stubFetch({ '/api/status': { status: 401, text: '' } }))
    ).rejects.toMatchObject({ kind: 'auth', status: 401 })
  })

  it('classifies a 5xx as a server problem', async () => {
    await expect(
      probeGateway('https://example.test', {}, stubFetch({ '/api/status': { status: 502, text: '' } }))
    ).rejects.toMatchObject({ kind: 'server', status: 502 })
  })

  it('classifies a certificate failure as tls', async () => {
    await expect(
      probeGateway(
        'https://example.test',
        {},
        stubFetch({ '/api/status': { throws: new Error('unable to verify the first certificate') } })
      )
    ).rejects.toMatchObject({ kind: 'tls' })
  })

  it('classifies the iOS secure-connection error code as tls', async () => {
    await expect(
      probeGateway('https://example.test', {}, stubFetch({ '/api/status': { throws: new Error('code=-1200') } }))
    ).rejects.toMatchObject({ kind: 'tls' })
  })

  it('classifies an unreachable host as network', async () => {
    await expect(
      probeGateway(
        'https://example.test',
        {},
        stubFetch({ '/api/status': { throws: new Error('getaddrinfo ENOTFOUND') } })
      )
    ).rejects.toMatchObject({ kind: 'network' })
  })

  it('classifies a silent gateway as a timeout', async () => {
    vi.useFakeTimers()

    try {
      const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as typeof fetch

      const probe = probeGateway('https://example.test', {}, fetchImpl)
      const assertion = expect(probe).rejects.toMatchObject({ kind: 'timeout' })
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses an address that is not http(s) before it touches the network', async () => {
    await expect(probeGateway('ws://example.test')).rejects.toBeInstanceOf(GatewayError)
  })
})

describe('resolveGatewayAddress', () => {
  const ungated = { version: '0.21.3', auth_required: false, auth_flows: [] }

  /** Answers as a gateway on ONE scheme and fails to connect on the other. */
  function stubScheme(answersOn: 'http:' | 'https:', failure = new Error('connect ECONNREFUSED')): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))

      if (url.protocol !== answersOn) {
        throw failure
      }

      return new Response(JSON.stringify(ungated), { status: 200 })
    }) as typeof fetch
  }

  it('keeps https when the address has no scheme and https answers', async () => {
    const result = await resolveGatewayAddress('example.test', {}, stubScheme('https:'))

    expect(result.baseUrl).toBe('https://example.test')
    expect(result.foundOverHttp).toBe(false)
    expect(result.version).toBe('0.21.3')
  })

  it('falls back to http when the address has no scheme and nothing answers on https', async () => {
    const result = await resolveGatewayAddress('hermes.tail9f3c.ts.net', {}, stubScheme('http:'))

    expect(result.baseUrl).toBe('http://hermes.tail9f3c.ts.net')
    expect(result.foundOverHttp).toBe(true)
  })

  it('keeps a port and a path prefix across the fallback', async () => {
    const result = await resolveGatewayAddress('192.168.2.250:9119/hermes', {}, stubScheme('http:'))

    expect(result.baseUrl).toBe('http://192.168.2.250:9119/hermes')
    expect(result.foundOverHttp).toBe(true)
  })

  it('never downgrades an address the user typed https:// on', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(new URL(String(input)).protocol)

      throw new Error('connect ECONNREFUSED')
    }) as typeof fetch

    await expect(resolveGatewayAddress('https://example.test', {}, fetchImpl)).rejects.toMatchObject({
      kind: 'network'
    })
    expect(seen).toEqual(['https:'])
  })

  it('does not probe https at all when the user typed http://', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(new URL(String(input)).protocol)

      return new Response(JSON.stringify(ungated), { status: 200 })
    }) as typeof fetch

    const result = await resolveGatewayAddress('http://192.168.2.250:9119', {}, fetchImpl)

    expect(result.baseUrl).toBe('http://192.168.2.250:9119')
    expect(result.foundOverHttp).toBe(false)
    expect(seen).toEqual(['http:'])
  })

  it('does not fall back when the certificate was rejected — that is a real https server', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(new URL(String(input)).protocol)

      throw new Error('unable to verify the first certificate')
    }) as typeof fetch

    await expect(resolveGatewayAddress('example.test', {}, fetchImpl)).rejects.toMatchObject({ kind: 'tls' })
    expect(seen).toEqual(['https:'])
  })

  it.each([
    // iOS 27, measured: React Native passes the localized description through.
    ['iOS', 'A TLS error caused the secure connection to fail.'],
    // OkHttp, where a plain-HTTP peer looks like a protocol violation.
    ['Android', 'javax.net.ssl.SSLException: Unable to parse TLS packet header'],
    ['Node', 'write EPROTO ... wrong version number']
  ])('does fall back when the %s TLS error is a peer that never spoke TLS', async (_platform, message) => {
    const seen: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      seen.push(url.protocol)

      if (url.protocol === 'https:') {
        throw new Error(message)
      }

      return new Response(JSON.stringify(ungated), { status: 200 })
    }) as typeof fetch

    const result = await resolveGatewayAddress('192.168.2.250:9119', {}, fetchImpl)

    expect(result.baseUrl).toBe('http://192.168.2.250:9119')
    expect(result.foundOverHttp).toBe(true)
    expect(seen).toEqual(['https:', 'http:'])
  })

  it.each([
    ['a 404', 404, 'not_hermes'],
    ['an access proxy', 401, 'auth'],
    ['an unhealthy gateway', 502, 'server']
  ])('does not fall back when https answered with %s', async (_label, status, kind) => {
    const seen: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(new URL(String(input)).protocol)

      return new Response('', { status })
    }) as typeof fetch

    await expect(resolveGatewayAddress('example.test', {}, fetchImpl)).rejects.toMatchObject({ kind })
    expect(seen).toEqual(['https:'])
  })

  it('reports the https failure when neither scheme answers', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input))

      throw new Error(url.protocol === 'https:' ? 'getaddrinfo ENOTFOUND' : 'connect ECONNREFUSED')
    }) as typeof fetch

    await expect(resolveGatewayAddress('example.test', {}, fetchImpl)).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('https://example.test')
    })
  })

  it('sends an ordinary extra header on both attempts', async () => {
    const seen: { protocol: string; header: string | undefined }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ protocol: url.protocol, header: headers['X-Proxy-Key'] })

      if (url.protocol === 'https:') {
        throw new Error('connect ECONNREFUSED')
      }

      return new Response(JSON.stringify(ungated), { status: 200 })
    }) as typeof fetch

    await resolveGatewayAddress('192.168.2.250:9119', { 'X-Proxy-Key': 'abc' }, fetchImpl)

    expect(seen).toEqual([
      { protocol: 'https:', header: 'abc' },
      { protocol: 'http:', header: 'abc' }
    ])
  })

  it.each([
    ['the preset', {}, ACCESS],
    ['hand-typed rows', { 'CF-Access-Client-Id': 'abc', 'CF-Access-Client-Secret': 'shh' }, NO_FRONT_DOOR],
    ['one hand-typed half', { 'cf-access-client-secret': 'shh' }, NO_FRONT_DOOR]
  ])('puts a front door from %s on https and never falls back to http', async (_label, headers, frontDoor) => {
    const seen: { protocol: string; secret: string | undefined }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const sent = new Headers(init?.headers)
      seen.push({ protocol: url.protocol, secret: sent.get('CF-Access-Client-Secret') ?? undefined })

      throw new Error('connect ECONNREFUSED')
    }) as typeof fetch

    await expect(resolveGatewayAddress('gw.example.test', headers, fetchImpl, frontDoor)).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('https://gw.example.test')
    })
    expect(seen).toEqual([{ protocol: 'https:', secret: 'shh' }])
  })

  it('takes the pair off an http:// address the reader typed, and keeps everything else', async () => {
    const seen: Record<string, string>[] = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers)))

      return new Response(JSON.stringify(ungated), { status: 200 })
    }) as typeof fetch

    await resolveGatewayAddress(
      'http://192.168.2.250:9119',
      { 'CF-Access-Client-Id': 'abc', 'X-Proxy-Key': 'kept' },
      fetchImpl,
      ACCESS
    )

    expect(seen).toEqual([{ accept: 'application/json', 'x-proxy-key': 'kept' }])
  })
})
