/**
 * The key a notification carries so a device can tell which gateway sent it.
 *
 * The cases that matter are the two ends: that the same gateway reached two
 * ways produces one key, and that two gateways never produce the same one. The
 * vector at the bottom is there so a notifier written in another language can
 * check itself against this file rather than against a running app.
 */
import { describe, expect, it } from 'vitest'

import { gatewayKeyOf, isGatewayKey } from './gateway-key'

describe('the key for one gateway', () => {
  it('is sixteen hex digits', () => {
    const key = gatewayKeyOf('https://gateway.example.com:8443')

    expect(key).toMatch(/^[0-9a-f]{16}$/u)
    expect(isGatewayKey(key)).toBe(true)
  })

  it('is the same for one gateway written two ways', () => {
    // A path prefix somebody added to a configuration, and a host somebody
    // typed in capitals. Both are the same machine and must stay one key.
    expect(gatewayKeyOf('https://Gateway.Example.com:8443/hermes')).toBe(
      gatewayKeyOf('https://gateway.example.com:8443')
    )
  })

  it('separates a port, a scheme and a host', () => {
    const keys = new Set([
      gatewayKeyOf('https://gateway.example.com:8443'),
      gatewayKeyOf('https://gateway.example.com:9443'),
      gatewayKeyOf('http://gateway.example.com:8443'),
      gatewayKeyOf('https://other.example.com:8443')
    ])

    expect(keys.size).toBe(4)
  })

  it('answers nothing for a string that is not an address', () => {
    // Read by callers as "this names no gateway". An unparseable address
    // sharing a key with every other one would switch a device onto whichever
    // gateway happened to be listed first.
    expect(gatewayKeyOf('gateway.example.com')).toBe('')
    expect(gatewayKeyOf('')).toBe('')
    expect(isGatewayKey('')).toBe(false)
    expect(isGatewayKey('NOTHEX0000000000')).toBe(false)
  })

  it('answers nothing for an address whose origin is opaque', () => {
    // These parse, but as a scheme the URL standard gives no host to, and all
    // of them serialise their origin as the same string "null". Keyed, they
    // would all name the same gateway.
    for (const address of [
      'example.com:9119',
      'localhost:3000',
      'mailto:a@b.example',
      'file:///tmp/x',
      'about:blank'
    ]) {
      expect(gatewayKeyOf(address)).toBe('')
    }
  })

  /**
   * FNV-1a, 64-bit, over the UTF-8 bytes of the origin.
   *
   * Pinned as a literal rather than computed, because the point of the value is
   * that another implementation can be checked against it. The Python in
   * `gateway-key.ts` produces this same string for this same input.
   */
  it('matches the published vector', () => {
    expect(gatewayKeyOf('https://gateway.example.com:8443')).toBe('bf796761db84e312')
  })
})
