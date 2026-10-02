import { classifyProbeFailure, isGatewayError, type NetworkKind, type ProbeVerdict } from '@hermie/gateway-client'

import { strings } from '../i18n/strings'

/**
 * One sentence per failure, and where the gateway's own configuration is the
 * cause, the fix that belongs on the server rather than in the app.
 *
 * There are two tables rather than one because the same classification means
 * different things at different moments. `/api/status` is public, so an `auth`
 * failure there is an access proxy standing in front of the gateway; once the
 * app is authenticating, the same kind means the credentials were refused.
 */

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl.trim() || strings.settings.unknown
  }
}

function fallbackMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return strings.errors.unknown
}

function privateNetworkSentence(verdict: ProbeVerdict): string {
  return verdict.hint === 'private_network' ? strings.errors.privateNetworkOnly : ''
}

/**
 * The unauthenticated probe the address step runs while the user is typing.
 *
 * `httpsWasPinned` is the one thing the resolver's error cannot carry: whether
 * the reader typed `https://` themselves. It decides nothing about the failure
 * and everything about the sentence — a scheme-less address has already been
 * tried both ways by the time anything is thrown, and a pinned `https://` has
 * not been tried in the clear at all.
 */
export function describeProbeError(
  error: unknown,
  baseUrl: string,
  httpsWasPinned = false,
  /**
   * What the device says it is on, when it has been asked.
   *
   * The one thing neither the error nor the address can carry, and the thing
   * that decides whether "could not reach it" is worth a second sentence: a
   * tailnet name that will not resolve on mobile data is a tunnel that is down,
   * and the same failure on Wi-Fi is just as likely to be a gateway that is off.
   */
  network: NetworkKind = 'unknown'
): string {
  if (!isGatewayError(error)) {
    return fallbackMessage(error)
  }

  const host = hostOf(baseUrl)
  /*
    The extra sentences come from the classifier, not from `error.hint`.

    `hint` is the gateway client's OWN wording, and it exists for a caller with
    no string table — a script, a test, another client. This app has one, and a
    screen that printed a sentence composed in a library would be a screen whose
    voice cannot be read from `i18n/strings.ts`. So the app reads the codes and
    writes its own; the two say the same thing and only one of them is edited
    here.
  */
  const verdict = classifyProbeFailure(error, { address: baseUrl, network })
  const withHints = (message: string): string =>
    [message, verdict.landingPage ? strings.errors.landingPage : '', privateNetworkSentence(verdict)]
      .filter(Boolean)
      .join(' ')

  switch (error.kind) {
    case 'network':
      return withHints(httpsWasPinned ? strings.errors.networkOverHttps(host) : strings.errors.network(host))
    case 'tls':
      return strings.errors.tls(host)
    case 'timeout':
      return strings.errors.timeout(host)
    case 'not_hermes':
      return withHints(strings.errors.notHermes(host))
    case 'redirect':
      return strings.errors.redirected(host, error.redirectedTo ?? strings.settings.unknown)
    case 'auth':
      return strings.errors.authProxy(error.status ?? 401)
    case 'server':
      return strings.errors.server(error.status ?? 500)
    case 'incompatible':
      return strings.errors.incompatible
    case 'config':
      // A config error here is the address the user typed, and the gateway
      // client already phrased it precisely ("that is not a valid address: …").
      return error.message
    default:
      return error.message || strings.errors.unknown
  }
}

/** An authenticated attempt: the REST calls and the WebSocket dial. */
export function describeConnectionError(error: unknown, baseUrl: string): string {
  if (!isGatewayError(error)) {
    return fallbackMessage(error)
  }

  // Close codes are the most specific thing the gateway tells us, so they win
  // over the kind the client derived from them.
  switch (error.closeCode) {
    case 4401:
      return strings.errors.closeAuth
    case 4403:
      return strings.errors.closeHost
    case 4408:
      return strings.errors.closeTakenOver
    case 4404:
      return strings.errors.closeChatOff
    case 1006:
      return strings.errors.closeAbnormal
    default:
      break
  }

  switch (error.kind) {
    case 'auth':
      return strings.errors.signedOut
    case 'network':
      return strings.errors.network(hostOf(baseUrl))
    case 'tls':
      return strings.errors.tls(hostOf(baseUrl))
    case 'timeout':
      return strings.errors.timeout(hostOf(baseUrl))
    case 'not_hermes':
      return strings.errors.notHermes(hostOf(baseUrl))
    case 'redirect':
      return strings.errors.redirected(hostOf(baseUrl), error.redirectedTo ?? strings.settings.unknown)
    case 'server':
      return strings.errors.server(error.status ?? 500)
    case 'incompatible':
      return strings.errors.incompatible
    default:
      return error.message || strings.errors.unknown
  }
}

/**
 * The PKCE code exchange and refresh. The gateway client already phrases these
 * precisely — "that sign-in code was already used or has expired" tells the user
 * what to do in a way a generic "credentials refused" does not — so an
 * authentication failure keeps its own wording here.
 */
export function describeSignInError(error: unknown, baseUrl: string): string {
  if (isGatewayError(error) && (error.kind === 'auth' || error.kind === 'config')) {
    return error.message
  }

  return describeConnectionError(error, baseUrl)
}
