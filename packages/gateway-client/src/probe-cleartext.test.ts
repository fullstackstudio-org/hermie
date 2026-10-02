/**
 * The scheme-less fallback, and what it is allowed to carry.
 *
 * An address typed without a scheme is probed over https first and, when that
 * gets no answer at all, over http (ADR-0014). The fallback used to reuse the
 * header map built for the https attempt, so on a network that blocks 443 a
 * configured Cloudflare Access service token went out in the clear to the same
 * name. These run against a real plain-http server on loopback: the https
 * attempt fails its handshake against it exactly as it would against a gateway
 * served in the clear, and what the server records is what crossed the wire.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { type AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import { CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, type FrontDoor } from './front-door'
import { resolveGatewayAddress } from './probe'
import { isGatewayError } from './types'

const SECRET = 'cf-secret-value-nobody-may-print'

const ACCESS: FrontDoor = {
  kind: 'cloudflare_access',
  clientId: 'abc123.access',
  clientSecret: SECRET,
  origin: 'https://127.0.0.1'
}

/** An ungated gateway in the clear, keeping every request's headers. */
async function cleartextGateway(): Promise<{
  host: string
  seen: IncomingHttpHeaders[]
  close: () => Promise<void>
}> {
  const seen: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: '0.21.3', auth_required: false, auth_flows: [] }))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  const { port } = server.address() as AddressInfo

  return {
    host: `127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

const frontDoorNames = (headers: IncomingHttpHeaders): string[] =>
  Object.keys(headers).filter(name => name.startsWith('cf-access-'))

describe('the http fallback', () => {
  it('still runs, and still carries an ordinary typed header, when there is no front door', async () => {
    const gateway = await cleartextGateway()

    try {
      const result = await resolveGatewayAddress(gateway.host, { 'X-Proxy-Key': 'typed' })

      expect(result.foundOverHttp).toBe(true)
      expect(gateway.seen.length).toBeGreaterThan(0)
      expect(gateway.seen.every(headers => headers['x-proxy-key'] === 'typed')).toBe(true)
    } finally {
      await gateway.close()
    }
  })

  it('is not attempted at all when the Cloudflare Access preset is configured', async () => {
    const gateway = await cleartextGateway()

    try {
      const error = await resolveGatewayAddress(gateway.host, {}, fetch, ACCESS).catch((thrown: unknown) => thrown)

      // The https failure, reported as itself, and nothing reached the server.
      expect(isGatewayError(error)).toBe(true)
      expect(isGatewayError(error) && error.message).toContain(`https://${gateway.host}`)
      expect(gateway.seen).toEqual([])
    } finally {
      await gateway.close()
    }
  })

  it('is not attempted when the pair was typed by hand among the custom headers', async () => {
    const gateway = await cleartextGateway()

    try {
      const error = await resolveGatewayAddress(gateway.host, {
        [CF_ACCESS_CLIENT_ID]: 'abc123.access',
        [CF_ACCESS_CLIENT_SECRET]: SECRET
      }).catch((thrown: unknown) => thrown)

      expect(isGatewayError(error)).toBe(true)
      expect(gateway.seen).toEqual([])
    } finally {
      await gateway.close()
    }
  })
})

describe('an address typed with http://', () => {
  it('reaches the gateway without the front-door pair, from the preset or from the typed headers', async () => {
    const gateway = await cleartextGateway()

    try {
      await resolveGatewayAddress(
        `http://${gateway.host}`,
        { [CF_ACCESS_CLIENT_ID]: 'typed.access', [CF_ACCESS_CLIENT_SECRET]: 'typed-secret', 'X-Proxy-Key': 'typed' },
        fetch,
        ACCESS
      )

      expect(gateway.seen.length).toBeGreaterThan(0)
      expect(gateway.seen.map(frontDoorNames)).toEqual(gateway.seen.map(() => []))
      expect(JSON.stringify(gateway.seen)).not.toContain(SECRET)
      expect(JSON.stringify(gateway.seen)).not.toContain('typed-secret')
      // Everything else the reader typed still goes: only the pair is withheld.
      expect(gateway.seen.every(headers => headers['x-proxy-key'] === 'typed')).toBe(true)
    } finally {
      await gateway.close()
    }
  })
})
