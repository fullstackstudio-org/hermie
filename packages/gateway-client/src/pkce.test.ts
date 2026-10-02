import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'

import {
  base64url,
  buildAuthorizeUrl,
  createPkce,
  isLoopbackRedirect,
  isLoopbackUrl,
  parseLoopbackRedirect,
  REDIRECT_URI
} from './pkce'

describe('isLoopbackUrl', () => {
  it('reads the host the way a web view will, not the way the callback is spelled', () => {
    for (const url of [
      REDIRECT_URI,
      'http://127.0.0.1:000038007/callback?code=a&state=b',
      'http://127.1:38007/callback',
      'http://0x7f.0.0.1/',
      'http://2130706433/',
      'http://localhost:38007/',
      'http://[::ffff:127.0.0.1]/',
      'http://0.0.0.0:38007/',
      'https://127.0.0.1/'
    ]) {
      expect([url, isLoopbackUrl(url)]).toEqual([url, true])
      expect(isLoopbackRedirect(url)).toBe(url === REDIRECT_URI)
    }
  })

  it('is false for anything that does not reach this device', () => {
    for (const url of [
      'http://127.0.0.1.example.com/',
      'http://127.0.0.1@evil.example.com/',
      'http://127.0.0.1:65536/',
      'ws://127.0.0.1/',
      'https://idp.example.com/login?next=http://127.0.0.1:38007/',
      'not a url'
    ]) {
      expect([url, isLoopbackUrl(url)]).toEqual([url, false])
    }
  })
})

const fixedBytes = (length: number) => new Uint8Array(length).map((_value, index) => (index * 7 + 3) % 256)

describe('createPkce', () => {
  it('produces a 43-character verifier, a matching S256 challenge and a 32-character state', () => {
    const pkce = createPkce(fixedBytes)

    expect(pkce.verifier).toHaveLength(43)
    expect(pkce.state).toHaveLength(32)
    expect(pkce.challenge).toBe(base64url(sha256(new TextEncoder().encode(pkce.verifier))))
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('draws fresh values on every call', () => {
    const first = createPkce()
    const second = createPkce()

    expect(first.verifier).not.toBe(second.verifier)
    expect(first.state).not.toBe(second.state)
  })
})

describe('buildAuthorizeUrl', () => {
  it('builds the native authorize URL with S256 and the loopback redirect', () => {
    const url = new URL(
      buildAuthorizeUrl('https://example.test', { provider: 'self-hosted', challenge: 'chal', state: 'st8' })
    )

    expect(url.pathname).toBe('/auth/native/authorize')
    expect(url.searchParams.get('provider')).toBe('self-hosted')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('state')).toBe('st8')
  })

  it('omits the provider when the gateway should auto-select it, and honours a path prefix', () => {
    const url = new URL(buildAuthorizeUrl('https://example.test/hermes', { challenge: 'c', state: 's' }))

    expect(url.pathname).toBe('/hermes/auth/native/authorize')
    expect(url.searchParams.has('provider')).toBe(false)
  })
})

describe('loopback redirects', () => {
  it('matches only loopback IP literals, never localhost', () => {
    expect(isLoopbackRedirect('http://127.0.0.1:38007/callback?code=a')).toBe(true)
    expect(isLoopbackRedirect('http://[::1]:38007/callback')).toBe(true)
    expect(isLoopbackRedirect('http://127.0.0.1/callback')).toBe(true)
    expect(isLoopbackRedirect('http://localhost:38007/callback')).toBe(false)
    expect(isLoopbackRedirect('https://127.0.0.1:38007/callback')).toBe(false)
    expect(isLoopbackRedirect('https://example.test/auth/callback')).toBe(false)
  })

  it('takes a port only as a URL can carry one: one to five digits, at most 65535', () => {
    expect(isLoopbackRedirect('http://127.0.0.1:0/callback')).toBe(true)
    expect(isLoopbackRedirect('http://127.0.0.1:65535/callback')).toBe(true)
    expect(isLoopbackRedirect('http://[::1]:65535/callback')).toBe(true)
    expect(isLoopbackRedirect('http://127.0.0.1:65536/callback')).toBe(false)
    expect(isLoopbackRedirect('http://127.0.0.1:99999/callback')).toBe(false)
    expect(isLoopbackRedirect('http://127.0.0.1:380070/callback')).toBe(false)
    expect(isLoopbackRedirect('http://[::1]:000038007/callback')).toBe(false)
    expect(isLoopbackRedirect('http://127.0.0.1:/callback')).toBe(false)
  })

  it('reads code and state', () => {
    expect(parseLoopbackRedirect('http://127.0.0.1:38007/callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz'
    })
  })

  it('reads an error and its description', () => {
    expect(parseLoopbackRedirect('http://127.0.0.1:38007/callback?error=access_denied&error_description=Nope')).toEqual(
      { error: 'access_denied', description: 'Nope' }
    )
  })

  it('treats a redirect with neither code nor error as an error', () => {
    expect(parseLoopbackRedirect('http://127.0.0.1:38007/callback')).toEqual({
      error: 'invalid_redirect',
      description: 'The sign-in redirect carried no code and no error.'
    })
  })
})
