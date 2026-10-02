/**
 * There is no native sign-in view in a browser.
 *
 * `react-native-webview` has no web implementation at all — a browser's answer
 * to "show a page" is the page itself — and the RFC 8252 loopback dance this
 * component performs has no meaning here either: a page cannot listen on
 * `127.0.0.1`, and it does not need to. Hermie Web is served by a proxy that
 * puts the gateway on the SAME origin, so the browser build signs in through
 * the gateway's own cookie flow (`/auth/login`, `/auth/password-login`) and the
 * session lives in an `HttpOnly` cookie.
 *
 * This file exists so the shared call sites — the sign-in step's escape hatch,
 * the signed-out panel — keep one shape on every platform. It renders nothing
 * and never calls back.
 */
import type { TokenSet } from '@hermie/gateway-client'

export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

export interface NativeSignInWebViewProps {
  visible: boolean
  baseUrl: string
  provider?: string
  extraHeaders?: Record<string, string>
  startInBrowser?: boolean
  onCancel: () => void
  onSuccess: (tokens: TokenSet) => void
}

/** A browser can never carry the gateway's extra headers into a sign-in page. */
export function webViewMayCarryHeaders(): boolean {
  return false
}

export function NativeSignInWebView(_props: NativeSignInWebViewProps) {
  return null
}
