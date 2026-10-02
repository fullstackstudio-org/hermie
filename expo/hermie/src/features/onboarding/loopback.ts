import { isGatewayError, isLoopbackRedirect, parseLoopbackRedirect } from '@hermie/gateway-client'

import { strings } from '../../i18n/strings'

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
 * @param url the URL the web view is about to load
 * @param expectedState the `state` this sign-in attempt generated
 */
export function inspectSignInNavigation(url: string, expectedState: string): SignInNavigation {
  if (!isLoopbackRedirect(url)) {
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
