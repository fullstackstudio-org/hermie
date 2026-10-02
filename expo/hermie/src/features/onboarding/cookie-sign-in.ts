/**
 * Starting and ending the gateway's COOKIE session — a browser-only flow with
 * a native no-op sibling, so the shared components can call it unconditionally.
 *
 * Nothing happens here off the web: the phones and the Mac sign in with RFC
 * 8252 and hold their own tokens.
 */

export interface PasswordLoginInput {
  baseUrl: string
  provider: string
  username: string
  password: string
  next?: string
}

/** Send the whole page to `/auth/login?provider=…`, which is a redirect chain. */
export function startCookieSignIn(_baseUrl: string, _provider?: string, _next?: string): void {
  // Native builds never have a cookie session to start.
}

/** Reload at the app's own root, for reauth when the OAuth door is off. */
export function reauthAtAppRoot(): void {
  // Native builds never go through the cookie flow at all.
}

/** `POST /auth/password-login`; resolves with where the gateway wants us next. */
export async function passwordLogin(_input: PasswordLoginInput): Promise<string> {
  throw new Error('Password sign-in is a browser-only flow.')
}

/** True where a cookie session is the way this build authenticates. */
export const COOKIE_SIGN_IN_AVAILABLE = false
