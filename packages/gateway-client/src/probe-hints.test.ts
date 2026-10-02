/**
 * The two gaps in what a failed probe used to be able to say.
 *
 * One: an address that only answers on somebody's own network, which used to
 * come back as "that is not a Hermes gateway" — a sentence that sends the
 * reader to check an address that was right. Two: a redirect, which named the
 * host it reached and then left the reader to retype it.
 *
 * The hard part of both is NOT firing. A "check your VPN" told to somebody
 * whose gateway is simply switched off is worse than no sentence at all, so
 * most of what is below is the cases that earn nothing.
 */
import { describe, expect, it } from 'vitest'

import { classifyProbeFailure, type NetworkKind } from './probe-hints'
import { GatewayError } from './types'

const notHermes = (sawLandingPage: boolean) => new GatewayError('not_hermes', 'answered oddly', { sawLandingPage })
const unreachable = () => new GatewayError('network', 'could not reach it')

const verdict = (error: unknown, address: string, network?: NetworkKind) =>
  classifyProbeFailure(error, { address, ...(network ? { network } : {}) })

describe('a web page from an address only one network can reach', () => {
  it.each([
    ['https://10.0.0.4:9119', 'RFC 1918'],
    ['http://100.71.2.9:9119', 'a Tailscale CGNAT address'],
    ['https://hermes.tailnet-name.ts.net', 'a MagicDNS name'],
    ['http://hermes.internal', 'a Headscale private suffix'],
    ['http://hermes.local', 'mDNS'],
    ['http://hermes', 'a name with no dots in it'],
    ['http://169.254.4.4', 'link-local']
  ])('says the address only answers on a private network for %s (%s)', address => {
    expect(verdict(notHermes(true), address).hint).toBe('private_network')
  })

  it('reports the landing page separately, because it is a different fact', () => {
    expect(verdict(notHermes(true), 'https://10.0.0.4')).toEqual({
      hint: 'private_network',
      landingPage: true,
      actions: []
    })
  })

  it('says nothing about a network when the body was not a page', () => {
    // JSON that is not a gateway's JSON. Something is answering, and it is not
    // the shape of being on the wrong network.
    expect(verdict(notHermes(false), 'https://10.0.0.4').hint).toBe('none')
  })

  it('says nothing about a network for a public host, whatever came back', () => {
    const answer = verdict(notHermes(true), 'https://hermes.example.com')

    expect(answer.hint).toBe('none')
    expect(answer.landingPage).toBe(true)
  })

  it('says nothing for loopback, where there is no network to join', () => {
    // The device IS that network. "Check you are connected to it" is advice
    // nobody can act on; a gateway that should be on localhost and is not is a
    // process that is not running.
    expect(verdict(notHermes(true), 'http://localhost:9119').hint).toBe('none')
    expect(verdict(notHermes(true), 'http://127.0.0.1:9119').hint).toBe('none')
  })
})

describe('nothing answered at all', () => {
  it('says the address only answers on a private network when the device is on cellular', () => {
    expect(verdict(unreachable(), 'https://hermes.tailnet-name.ts.net', 'cellular').hint).toBe('private_network')
  })

  it.each<NetworkKind>(['wifi', 'other', 'unknown'])('says nothing on %s, where a dead gateway is as likely', kind => {
    expect(verdict(unreachable(), 'https://hermes.tailnet-name.ts.net', kind).hint).toBe('none')
  })

  it('treats an unreported network as no information rather than as "not cellular"', () => {
    expect(verdict(unreachable(), 'https://hermes.tailnet-name.ts.net').hint).toBe('none')
  })

  it('says nothing on cellular for a public host, which may simply be down', () => {
    expect(verdict(unreachable(), 'https://hermes.example.com', 'cellular').hint).toBe('none')
  })

  it('says nothing on cellular for loopback', () => {
    expect(verdict(unreachable(), 'http://localhost:9119', 'cellular').hint).toBe('none')
  })

  /*
    The case this deliberately does NOT cover, pinned so that the omission is a
    decision rather than an oversight: a Headscale operator's own domain looks
    public to `classifyHost`, because nothing here resolves a name. Reading it
    as private would mean guessing about every public name on the internet.
  */
  it('cannot tell a private Headscale domain from any other public name', () => {
    expect(verdict(unreachable(), 'https://hermes.example.org', 'cellular').hint).toBe('none')
  })

  it('says nothing about a network for a timeout, where something is listening', () => {
    expect(verdict(new GatewayError('timeout', 'slow'), 'https://10.0.0.4', 'cellular').hint).toBe('none')
  })
})

describe('a redirect', () => {
  it('offers the host that answered', () => {
    expect(
      verdict(new GatewayError('redirect', 'moved', { redirectedTo: 'hermes.other.example' }), 'https://a.example')
    ).toEqual({ hint: 'none', landingPage: false, actions: [{ kind: 'use_host', host: 'hermes.other.example' }] })
  })

  it('carries the origin beside the host, so the port and the brackets survive', () => {
    expect(
      verdict(
        new GatewayError('redirect', 'moved', {
          redirectedTo: 'other.example',
          redirectedOrigin: 'https://other.example:8443'
        }),
        'https://a.example'
      ).actions
    ).toEqual([{ kind: 'use_host', host: 'other.example', origin: 'https://other.example:8443' }])
    expect(
      verdict(
        new GatewayError('redirect', 'moved', { redirectedTo: 'fd00::1', redirectedOrigin: 'http://[fd00::1]:9119' }),
        'https://a.example'
      ).actions
    ).toEqual([{ kind: 'use_host', host: 'fd00::1', origin: 'http://[fd00::1]:9119' }])
  })

  it('offers nothing when the platform did not say where it landed', () => {
    expect(verdict(new GatewayError('redirect', 'moved'), 'https://a.example').actions).toEqual([])
  })

  it('never claims a private network, even from a private address', () => {
    // Something answered and said where to go. That is a fact about the
    // address, not about which network this device is on.
    expect(verdict(new GatewayError('redirect', 'moved', { redirectedTo: 'x.example' }), 'https://10.0.0.4').hint).toBe(
      'none'
    )
  })
})

describe('an access proxy in front of the gateway', () => {
  it.each([401, 403])('offers the front door on HTTP %i', status => {
    expect(verdict(new GatewayError('auth', 'refused', { status }), 'https://hermes.example.com').actions).toEqual([
      { kind: 'front_door' }
    ])
  })

  it('offers nothing for an auth failure with no status behind it', () => {
    expect(verdict(new GatewayError('auth', 'refused'), 'https://hermes.example.com').actions).toEqual([])
  })
})

describe('everything else', () => {
  it.each(['tls', 'server', 'config', 'incompatible', 'protocol'] as const)('earns nothing for %s', kind => {
    expect(verdict(new GatewayError(kind, 'nope'), 'https://10.0.0.4', 'cellular')).toEqual({
      hint: 'none',
      landingPage: false,
      actions: []
    })
  })

  it('earns nothing for something that is not a gateway error at all', () => {
    expect(verdict(new Error('boom'), 'https://10.0.0.4', 'cellular')).toEqual({
      hint: 'none',
      landingPage: false,
      actions: []
    })
  })
})
