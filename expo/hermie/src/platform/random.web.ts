/**
 * Cryptographically strong random bytes for PKCE, in a browser.
 *
 * `crypto.getRandomValues` is the Web Crypto CSPRNG and is available on every
 * browser that can run this bundle, including over plain HTTP on a loopback or
 * private address — `crypto.subtle` is the half that is gated on a secure
 * context, and nothing here uses it. A browser without it is a browser the app
 * cannot sign in from at all, so the missing case throws rather than degrading
 * to `Math.random`.
 *
 * In practice the browser build authenticates with the gateway's cookie flow
 * rather than with native PKCE, so this is the entropy source for the shared
 * code paths rather than for a sign-in a browser actually runs.
 */
import type { RandomBytes } from '@hermie/gateway-client'

export const randomBytes: RandomBytes = length => {
  const bytes = new Uint8Array(length)

  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('This browser has no crypto.getRandomValues, so Hermie cannot generate a secure random value.')
  }

  crypto.getRandomValues(bytes)

  return bytes
}
