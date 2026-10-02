import { isGatewayError, isLoopbackRedirect, isLoopbackUrl, parseLoopbackRedirect } from '@hermie/gateway-client'

import { strings } from '../../i18n/strings'

/** Same origin by the URL parser's reading; anything unparseable is not. */
function sameOrigin(url: string, other: string): boolean {
  try {
    return new URL(url).origin === new URL(other).origin
  } catch {
    return false
  }
}

/**
 * What the sign-in web view should do with one navigation.
 *
 * This is deliberately a pure function rather than a closure inside the web
 * view component: it is the security-critical half of the flow — the state
 * comparison that stops another tab's authorization code being adopted as ours —
 * and it is worth testing without rendering anything.
 */
export type SignInNavigation =
  { kind: 'continue' } | { kind: 'code'; code: string } | { kind: 'failed'; message: string }

/**
 * Nothing listens on the loopback address. The redirect is a value to read, not
 * a request to serve, so the web view must refuse to load it and hand the code
 * to the token exchange instead.
 *
 * And nothing else on this device is a place the sign-in may go either.
 * `isLoopbackRedirect` recognises our callback narrowly, and everything it
 * refused used to be `continue` — so `http://127.0.0.1:000038007/callback?code=…`,
 * which the web view reads as port 38007, was really loaded, and on Android any
 * app can listen on that port. Any other address that would reach this device
 * now ends the attempt instead. The one exception is the gateway's own origin,
 * which is on loopback whenever the gateway runs on the same machine.
 *
 * @param url the URL the web view is about to load
 * @param expectedState the `state` this sign-in attempt generated
 * @param gatewayBaseUrl the gateway being signed in to, whose pages may load
 */
export function inspectSignInNavigation(url: string, expectedState: string, gatewayBaseUrl = ''): SignInNavigation {
  if (!isLoopbackRedirect(url)) {
    if (isLoopbackUrl(url) && !sameOrigin(url, gatewayBaseUrl)) {
      return { kind: 'failed', message: strings.onboarding.signIn.webview.noCode }
    }

    return { kind: 'continue' }
  }

  let redirect: ReturnType<typeof parseLoopbackRedirect>

  try {
    redirect = parseLoopbackRedirect(url)
  } catch (error) {
    return {
      kind: 'failed',
      message: isGatewayError(error) ? error.message : strings.onboarding.signIn.webview.noCode
    }
  }

  if ('error' in redirect) {
    if (redirect.error === 'invalid_redirect') {
      return { kind: 'failed', message: strings.onboarding.signIn.webview.noCode }
    }

    return {
      kind: 'failed',
      message: strings.onboarding.signIn.webview.providerError(redirect.error, redirect.description)
    }
  }

  // The state is the only thing tying this redirect to the attempt that started
  // it. A mismatch is not a retryable hiccup: the code belongs to someone
  // else's flow and must be dropped rather than exchanged.
  if (!expectedState || redirect.state !== expectedState) {
    return { kind: 'failed', message: strings.onboarding.signIn.webview.stateMismatch }
  }

  return { kind: 'code', code: redirect.code }
}
