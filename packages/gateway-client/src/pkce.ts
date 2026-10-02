import { sha256 } from '@noble/hashes/sha2.js'

import { apiUrl } from './url'
import { GatewayError } from './types'

/**
 * Loopback redirect the native flow ends on. Nothing listens on it: the app
 * intercepts the navigation inside its WebView before the request is made. The
 * gateway only accepts loopback IP literals (RFC 8252 §8.3 — `localhost` is
 * rejected), so this is an address, not a server.
 */
export const REDIRECT_URI = 'http://127.0.0.1:38007/callback'

const LOOPBACK_RE = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?\//

/** The highest port number; `parseLoopbackRedirect`'s URL parser refuses anything above it. */
const MAX_PORT = 65535

export type RandomBytes = (length: number) => Uint8Array

export interface Pkce {
  /** 43-character base64url verifier (32 random bytes), RFC 7636 §4.1. */
  verifier: string
  /** base64url(SHA-256(verifier)), sent as `code_challenge`. */
  challenge: string
  /** 32-character base64url CSRF value echoed back on the redirect. */
  state: string
}

export interface AuthorizeParams {
  provider?: string
  challenge: string
  state: string
  redirectUri?: string
}

export type LoopbackRedirect = { code: string; state: string } | { error: string; description: string }

function defaultRandomBytes(length: number): Uint8Array {
  const webcrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto

  if (!webcrypto?.getRandomValues) {
    throw new GatewayError(
      'config',
      'No secure random source is available. Install expo-crypto (it installs crypto.getRandomValues) before signing in.'
    )
  }

  return webcrypto.getRandomValues(new Uint8Array(length))
}

/** base64url without padding (RFC 7636 §4). */
export function base64url(bytes: Uint8Array): string {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  // btoa exists on Hermes, in browsers and in Node 16+.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A fresh verifier/challenge/state triple for one sign-in attempt. */
export function createPkce(randomBytes: RandomBytes = defaultRandomBytes): Pkce {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(sha256(new TextEncoder().encode(verifier)))
  const state = base64url(randomBytes(24))

  return { verifier, challenge, state }
}

/**
 * The URL the sign-in WebView opens. The gateway is the authorization server
 * here: it brokers the round trip to the real identity provider itself, so the
 * client never learns the upstream client_id.
 */
export function buildAuthorizeUrl(baseUrl: string, params: AuthorizeParams): string {
  const url = new URL(apiUrl(baseUrl, '/auth/native/authorize'))
  const query = url.searchParams

  if (params.provider) {
    query.set('provider', params.provider)
  }

  query.set('code_challenge', params.challenge)
  query.set('code_challenge_method', 'S256')
  query.set('redirect_uri', params.redirectUri ?? REDIRECT_URI)
  query.set('state', params.state)

  return url.toString()
}

/** True for the loopback callback the WebView must intercept instead of loading. */
export function isLoopbackRedirect(url: string): boolean {
  const match = LOOPBACK_RE.exec(url)

  return match !== null && (match[1] === undefined || Number(match[1]) <= MAX_PORT)
}

/**
 * Read `code`/`state` (or `error`/`error_description`) off an intercepted
 * loopback redirect. Callers still have to compare `state` with the value they
 * generated; this only parses.
 */
export function parseLoopbackRedirect(url: string): LoopbackRedirect {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch (error) {
    throw new GatewayError('protocol', `The sign-in redirect was not a URL: ${url}`, { cause: error })
  }

  const query = parsed.searchParams
  const error = query.get('error')

  if (error) {
    return { error, description: query.get('error_description') ?? '' }
  }

  const code = query.get('code')
  const state = query.get('state')

  if (!code || !state) {
    return { error: 'invalid_redirect', description: 'The sign-in redirect carried no code and no error.' }
  }

  return { code, state }
}
