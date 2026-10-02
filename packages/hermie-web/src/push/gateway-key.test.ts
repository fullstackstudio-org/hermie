/**
 * This package's copy of the gateway key agrees with the app's.
 *
 * Two implementations exist on purpose — see `gateway-key.ts` — so the thing
 * worth testing is not the arithmetic, it is that the two copies produce the
 * same string. The vector below is the same literal as
 * `packages/gateway-client/src/gateway-key.test.ts`, and a third copy in
 * another language proves itself the same way.
 */
import { describe, expect, it } from 'vitest'

import { gatewayKeyOf } from './gateway-key'

describe('the daemon’s copy of the gateway key', () => {
  it('matches the vector the app’s copy is pinned to', () => {
    expect(gatewayKeyOf('https://gateway.example.com:8443')).toBe('bf796761db84e312')
  })

  it('reads one gateway written two ways as one key', () => {
    expect(gatewayKeyOf('https://Gateway.Example.com:8443/hermes')).toBe(
      gatewayKeyOf('https://gateway.example.com:8443')
    )
  })

  it('answers nothing for a string that is not an address', () => {
    expect(gatewayKeyOf('gateway.example.com')).toBe('')
    expect(gatewayKeyOf('')).toBe('')
  })

  it('answers nothing for an address whose origin is opaque, as the app’s copy does', () => {
    // `localhost:9119` parses as the scheme `localhost:`; its origin, like every
    // other opaque one, serialises as "null" and names no gateway.
    expect(gatewayKeyOf('localhost:9119')).toBe('')
    expect(gatewayKeyOf('mailto:a@b.example')).toBe('')
  })
})
