/**
 * A probe that lands somewhere else, and one that lands nowhere useful.
 *
 * Both of these come from the same afternoon on the owner's gateway.
 *
 * **The redirect.** `hermes.fullstackstudio.nl` had moved to
 * `hermes.provibr.net` and left a 301 behind. The iOS URL cache is keyed by
 * bundle identifier and OUTLIVES the app, so deleting Hermie and installing it
 * again did not clear it: the new install's very first onboarding probe was
 * answered out of that cache, reached the host the owner had left, and reported
 * "that is not a Hermes gateway" — naming the address they had typed, which was
 * correct. The probe now refuses to follow a redirect to a different host and
 * says where it was sent, so the wizard can offer that host instead.
 *
 * **The wording.** "answered, but not like a Hermes gateway" is true and, on
 * its own, useless in the two cases where it is most often read: a gateway that
 * is only reachable on a tailnet, probed from a device that is not on it, and a
 * public name whose DNS answers with somebody's front page. Both look identical
 * from here — a 200 with something that is not a gateway in it — and both have
 * the same first thing to check.
 *
 * The redirect cases run against two real servers, because "did fetch follow
 * it, and does `response.url` say where it ended up" is exactly the kind of
 * question a stub answers whichever way it was written.
 */
import { startFakeGateway } from '@hermie/fake-gateway'
import { describe, expect, it } from 'vitest'

import { requestText } from './fetch-json'
import { notHermesHint, probeGateway, resolveGatewayAddress } from './probe'
import { isGatewayError } from './types'

describe('an address that redirects somewhere else', () => {
  it('is refused, named, and nothing is read from it', async () => {
    const real = await startFakeGateway({ port: 0 })
    // The old domain, still answering, still pointing at the new one — which is
    // what the cached 301 reproduced months after the move. A different NAME
    // for the same loopback, because what the check is about is the host.
    const newHome = real.url.replace('127.0.0.1', 'localhost')
    const moved = await startFakeGateway({ port: 0, redirectTo: newHome })

    try {
      const error = await probeGateway(moved.url).catch((thrown: unknown) => thrown)

      expect(isGatewayError(error) && error.kind).toBe('redirect')
      expect(isGatewayError(error) && error.redirectedTo).toBe('localhost')
      // Not "not a Hermes gateway": the thing it reached IS one, and saying so
      // about the address the owner typed is what sent them looking at DNS.
      expect(isGatewayError(error) && error.message).toMatch(/redirected to/u)
    } finally {
      await Promise.all([real.close(), moved.close()])
    }
  })

  it('is still reported when the scheme-less fallback is what found it', async () => {
    const real = await startFakeGateway({ port: 0 })
    const moved = await startFakeGateway({ port: 0, redirectTo: real.url.replace('127.0.0.1', 'localhost') })

    try {
      /*
        No scheme, so https is tried first, fails to connect, and http finds the
        redirect. The resolver's rule is that the https failure is the one worth
        reading — but a redirect is not a failure to reach the address, it is
        the address saying it has moved, and reporting "could not reach it over
        https" instead sends the reader after a port they never asked about.
      */
      const error = await resolveGatewayAddress(new URL(moved.url).host).catch((thrown: unknown) => thrown)

      expect(isGatewayError(error) && error.kind).toBe('redirect')
      expect(isGatewayError(error) && error.redirectedTo).toBe('localhost')
    } finally {
      await Promise.all([real.close(), moved.close()])
    }
  })

  it('is refused when the new address names the old host after an `@` in its path', async () => {
    const real = await startFakeGateway({ port: 0 })
    const asked = new URL(real.url).hostname
    // A different host whose PATH ends in `@<the host that was asked>`. Only
    // the authority can carry credentials, so this lands on `localhost`.
    const elsewhere = `${real.url.replace('127.0.0.1', 'localhost').replace(/\/$/u, '')}/@${asked}`
    const moved = await startFakeGateway({ port: 0, redirectTo: elsewhere })

    try {
      const error = await probeGateway(moved.url).catch((thrown: unknown) => thrown)

      expect(isGatewayError(error) && error.kind).toBe('redirect')
      expect(isGatewayError(error) && error.redirectedTo).toBe('localhost')
    } finally {
      await Promise.all([real.close(), moved.close()])
    }
  })

  it('follows a redirect that stays on the same host without comment', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      // `/api/status/` → `/api/status` and http → https on one name are
      // ordinary. Only a change of HOST is a different server answering.
      const probe = await probeGateway(gateway.url)

      expect(typeof probe.authRequired).toBe('boolean')
    } finally {
      await gateway.close()
    }
  })
})

describe('every request', () => {
  it('goes out with the platform cache switched off', async () => {
    // The other half of the same fix: nothing new is stored, so no future
    // install inherits a redirect from this one. Asserted on the init rather
    // than on behaviour, because a cache that is working correctly is
    // indistinguishable from one that is empty.
    const seen: RequestInit[] = []

    await requestText('https://gateway.example/api/status', {
      fetchImpl: async (_url, init) => {
        seen.push(init ?? {})

        return new Response('{}', { status: 200 })
      }
    })

    expect(seen[0]?.cache).toBe('no-store')
  })
})

describe('"answered, but not like a Hermes gateway"', () => {
  const LANDING = '<!doctype html><html><body><h1>It works</h1></body></html>'

  it('says so plainly for a public host that answered with JSON of its own', () => {
    expect(notHermesHint('https://api.example.com', '{"ok":true}')).toBe('')
  })

  it('names the network when the host is only reachable on one', () => {
    for (const address of [
      'http://192.168.1.10:9120',
      'http://gateway.ts.net',
      'http://100.101.102.103',
      'nas.local'
    ]) {
      expect(notHermesHint(address, '{"ok":true}')).toMatch(/private network or tailnet/u)
    }
  })

  /**
   * The device IS loopback, so "make sure this device is connected to it" is
   * advice nobody can act on. A gateway meant to be on `localhost` and not
   * answering is a process that is not running.
   */
  it('does not ask whether this device is on its own loopback', () => {
    expect(notHermesHint('http://localhost:9119', '{"ok":true}')).toBe('')
    expect(notHermesHint('http://127.0.0.1:9119', LANDING)).toBe(
      'This looks like a landing page, not a Hermes gateway.'
    )
  })

  /**
   * A public name answering with somebody's front page says nothing at all
   * about a tailnet. It used to be told otherwise, which sent readers to check
   * a VPN for what was a typo or a proxy's default host.
   */
  it('says only what it saw when a public host answered with a page', () => {
    expect(notHermesHint('https://hermes.example.com', LANDING)).toBe(
      'This looks like a landing page, not a Hermes gateway.'
    )
  })

  it('adds the network sentence behind it when the host is on a network of its own', () => {
    const hint = notHermesHint('http://gateway.ts.net', LANDING)

    expect(hint).toMatch(/^This looks like a landing page, not a Hermes gateway\./u)
    expect(hint).toMatch(/private network or tailnet/u)
  })

  it('reaches the failure the reader actually sees', async () => {
    const error = await probeGateway(
      'https://hermes.example.com',
      {},
      async () => new Response(LANDING, { status: 200, headers: { 'content-type': 'text/html' } })
    ).catch((thrown: unknown) => thrown)

    expect(isGatewayError(error) && error.kind).toBe('not_hermes')
    // On the error as well as in the message: every screen writes its own
    // sentence for a KIND, and the part that is specific to this failure has to
    // survive that.
    expect(isGatewayError(error) && error.hint).toMatch(/landing page/u)
  })

  it('leaves an ordinary "not a gateway" alone on a public host', async () => {
    const error = await probeGateway(
      'https://hermes.example.com',
      {},
      async () => new Response('{"something":"else"}', { status: 200 })
    ).catch((thrown: unknown) => thrown)

    expect(isGatewayError(error) && error.kind).toBe('not_hermes')
    expect(isGatewayError(error) && error.hint).toBeUndefined()
  })
})
