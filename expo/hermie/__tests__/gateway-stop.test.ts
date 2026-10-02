/**
 * Which failures stop the app, and what the card that reports one says.
 *
 * The rule under test is the one the inherited-address report broke: a stop
 * always names the address it is about, and always offers a way off it. The
 * second rule is the one that keeps it from taking over: a reconnect that is
 * still trying is not a stop, however bad its last error looked.
 */
import { GatewayError, type ConnectionStatus } from '@hermie/gateway-client'

import type { StoredGatewayConfig } from '../src/gateway/config'
import { describeGatewayAddress, gatewayStop } from '../src/gateway/gateway-stop'

const CONFIG: StoredGatewayConfig = {
  baseUrl: 'https://hermes.example.com:8443',
  authMode: 'native_pkce',
  provider: 'self-hosted',
  providerDisplayName: 'Self-Hosted OIDC',
  version: '2026.9.14',
  userDisplayName: 'tester@example.invalid'
}

const stop = (status: ConnectionStatus, error: GatewayError | null = null) =>
  gatewayStop({ status, error, config: CONFIG })

describe('describeGatewayAddress', () => {
  it('fills the port in from the scheme when the address leaves it out', () => {
    expect(describeGatewayAddress('https://hermes.example.com')).toEqual({
      url: 'https://hermes.example.com',
      scheme: 'https',
      host: 'hermes.example.com',
      port: '443'
    })

    expect(describeGatewayAddress('http://10.0.0.4').port).toBe('80')
  })

  it('keeps an explicit port and a path prefix', () => {
    const address = describeGatewayAddress('https://hermes.example.com:8443/gateway')

    expect(address.port).toBe('8443')
    expect(address.url).toBe('https://hermes.example.com:8443/gateway')
  })

  it('still shows an address that no longer parses, rather than hiding it', () => {
    expect(describeGatewayAddress('hermes.example.com').url).toBe('hermes.example.com')
    expect(describeGatewayAddress('').url).toBe('Unknown')
  })
})

describe('a gateway that has stopped', () => {
  /**
   * The sentence is the app's own wording per kind, except where the client
   * already phrased it better than a table could: a `protocol` answer names the
   * status it got, which is the whole of what a reader can act on.
   */
  it.each([
    ['an address it does not trust', new GatewayError('config', 'raw', { closeCode: 4403 }), /does not trust/],
    ['a takeover', new GatewayError('config', 'raw', { closeCode: 4408 }), /took this connection over/],
    ['chat switched off', new GatewayError('config', 'raw', { closeCode: 4404 }), /switched off/],
    ['a rejected certificate', new GatewayError('tls', 'raw'), /secure connection to hermes\.example\.com:8443 failed/],
    [
      'an answer that broke the protocol',
      new GatewayError('protocol', 'The address answered HTTP 405, but not as a Hermes gateway.'),
      /answered HTTP 405/
    ],
    ['something that is not a gateway', new GatewayError('not_hermes', 'raw'), /not like a Hermes gateway/],
    [
      'an address that leads elsewhere',
      new GatewayError('redirect', 'raw', { redirectedTo: 'login.example.com' }),
      /login\.example\.com/
    ]
  ])('names the address and the ways out after %s', (_label, error, sentence) => {
    const result = stop('disconnected', error)

    expect(result).not.toBeNull()
    expect(result?.address).toEqual({
      url: 'https://hermes.example.com:8443',
      scheme: 'https',
      host: 'hermes.example.com',
      port: '8443'
    })
    expect(result?.identity).toBe('tester@example.invalid')
    expect(result?.title).toBeTruthy()
    expect(result?.sentence).toMatch(sentence)
    expect(result?.actions).toEqual(['recheck', 'changeGateway', 'signOut'])
  })

  it('titles a takeover and a switched-off chat as themselves', () => {
    expect(stop('disconnected', new GatewayError('config', 'raw', { closeCode: 4408 }))?.title).toBe(
      'Another client took this connection over'
    )
    expect(stop('disconnected', new GatewayError('config', 'raw', { closeCode: 4404 }))?.title).toBe(
      'Chat is switched off on this gateway'
    )
  })

  it('offers signing in, not signing out, when it is the session that ended', () => {
    const result = stop('needs_signin', new GatewayError('auth', 'expired'))

    expect(result?.kind).toBe('auth')
    expect(result?.sentence).toMatch(/hermes\.example\.com:8443/)
    expect(result?.actions).toEqual(['signIn', 'recheck', 'changeGateway'])
  })

  /**
   * The client attaches a hint where it knows something the app's own table
   * cannot: which host the address actually led to, or that the gateway may be
   * on a network this device is not on.
   */
  it('prefers the connection’s own hint to the one for its kind', () => {
    const carried = new GatewayError('not_hermes', 'raw', { hint: 'That host answered as a router.' })

    expect(stop('disconnected', carried)?.hint).toBe('That host answered as a router.')
    expect(stop('disconnected', new GatewayError('not_hermes', 'raw'))?.hint).toBe('')
  })

  it('adds a hint only where the sentence has left something unsaid', () => {
    expect(stop('disconnected', new GatewayError('config', 'raw', { closeCode: 4403 }))?.hint).toMatch(
      /change the address stored here/
    )
    expect(stop('disconnected', new GatewayError('config', 'raw', { closeCode: 4408 }))?.hint).toMatch(
      /Re-check reclaims/
    )
    // These already say everything actionable in the sentence itself.
    expect(stop('disconnected', new GatewayError('tls', 'raw'))?.hint).toBe('')
    expect(stop('disconnected', new GatewayError('config', 'raw', { closeCode: 4404 }))?.hint).toBe('')
    expect(stop('disconnected', new GatewayError('protocol', 'raw'))?.hint).toBe('')
  })

  /**
   * Press Re-check and the status runs through the dial before anything is
   * known. The card has to stay up across that, or it reads as a flicker of
   * the app rather than as an answer.
   */
  it('stays up through the dial a re-check starts', () => {
    const refused = new GatewayError('config', 'raw', { closeCode: 4403 })

    expect(stop('authenticating', refused)).not.toBeNull()
    expect(stop('connecting', refused)).not.toBeNull()
    expect(stop('ready', refused)).toBeNull()
  })

  /**
   * The opposite case, and the reason the two sets are named apart: a mint that
   * answers like something else keeps its ladder, and every rung passes through
   * the same dialling statuses. Taking the conversations away for each of them
   * would be the app shouting over a reconnect that is still working.
   */
  it('leaves a ladder that is still climbing to the chat’s own notice', () => {
    const answered = new GatewayError('protocol', 'raw')

    expect(stop('reconnecting', answered)).toBeNull()
    expect(stop('authenticating', answered)).toBeNull()
    expect(stop('connecting', answered)).toBeNull()
  })

  it('keeps out of the way of failures that come back on their own', () => {
    expect(stop('reconnecting', new GatewayError('network', 'dropped'))).toBeNull()
    expect(stop('offline', new GatewayError('network', 'dropped'))).toBeNull()
    expect(stop('paused')).toBeNull()
    expect(stop('ready')).toBeNull()
    expect(stop('disconnected')).toBeNull()
    expect(stop('disconnected', new GatewayError('timeout', 'slow'))).toBeNull()
    expect(stop('disconnected', new GatewayError('server', 'unhappy', { status: 502 }))).toBeNull()
  })

  it('says nothing when no gateway is stored, because the wizard owns that screen', () => {
    expect(gatewayStop({ status: 'disconnected', error: new GatewayError('tls', 'raw'), config: null })).toBeNull()
  })
})
