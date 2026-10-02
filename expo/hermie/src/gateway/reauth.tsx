/**
 * Signing in again, and what to call the sign-out that made it necessary.
 *
 * The card that uses both is `GatewayStoppedPanel`. This is the part the
 * sidebar's connection line shares with it, so that a reader who presses the
 * line and a reader who presses the card get the identical flow rather than two
 * that drift.
 */
import type { SignOutReason, TokenSet } from '@hermie/gateway-client'
import { useState } from 'react'

import { reauthAtAppRoot, startCookieSignIn } from '../features/onboarding/cookie-sign-in'
import { NativeSignInWebView } from '../features/onboarding/NativeSignInWebView'
import { loadHermieWebConfig } from './web-config'
import { strings } from '../i18n/strings'
import { hostOf } from './errors'
import { useGateway } from './GatewayProvider'

/**
 * The reason, as a sentence — or nothing at all.
 *
 * Nothing is the right answer when the ring has no account of it: a sign-out that
 * happened before this build, or on a path that recorded none, must not be
 * narrated with a guess. An unexplained sign-out is bad; a confidently wrong
 * explanation is worse.
 */
export function describeSignOutReason(reason: SignOutReason | null | undefined): string | null {
  switch (reason) {
    case 'refresh_rejected':
      return strings.signedOut.reason.refreshRejected
    case 'refresh_failed':
      return strings.signedOut.reason.refreshFailed
    case 'no_refresh_token':
      return strings.signedOut.reason.noRefreshToken
    case 'rejected_after_refresh':
      return strings.signedOut.reason.rejectedAfterRefresh
    case 'token_unreadable':
      return strings.signedOut.reason.tokenUnreadable
    default:
      return null
  }
}

/**
 * Everything the signed-out state needs, in one hook, so the content panel and
 * the sidebar's gateway card offer the identical action rather than two that
 * drift.
 */
export function useReauth() {
  const { status, config, extraHeaders, adoptTokens, recordAuth, signOut, changeGateway } = useGateway()
  const [signingIn, setSigningIn] = useState(false)
  const [busy, setBusy] = useState(false)

  const native = config?.authMode === 'native_pkce'
  const cookie = config?.authMode === 'cookie'

  return {
    /** True when the connection is signed out and there is a gateway to sign in to. */
    signedOut: status === 'needs_signin' && Boolean(config),
    busy,
    host: config ? hostOf(config.baseUrl) : '',
    /**
     * Start signing in. A native gateway opens the in-app page; a cookie
     * gateway sends the whole tab to its `/auth/login`, which is the only way
     * an OAuth redirect chain can run — UNLESS this Hermie Web has turned
     * OIDC off, in which case that route is refused outright regardless of
     * which provider is named, and reauth reloads at the app's own root
     * instead (see `reauthAtAppRoot`). A session-token gateway has no page to
     * open, so it goes back to the token step instead.
     */
    signIn: () => {
      if (native) {
        setSigningIn(true)

        return
      }

      if (cookie && config) {
        void loadHermieWebConfig().then(webConfig => {
          if (webConfig?.oidc === false) {
            reauthAtAppRoot()

            return
          }

          startCookieSignIn(config.baseUrl, config.provider)
        })

        return
      }

      void signOut()
    },
    changeGateway,
    /** Render inside whichever component owns the action, once. */
    webView:
      native && config ? (
        <NativeSignInWebView
          baseUrl={config.baseUrl}
          extraHeaders={extraHeaders}
          onCancel={() => setSigningIn(false)}
          onSuccess={(tokens: TokenSet) => {
            setSigningIn(false)
            setBusy(true)
            void adoptTokens(tokens).finally(() => setBusy(false))
          }}
          timeline={{ record: recordAuth }}
          visible={signingIn}
          {...(config.provider ? { provider: config.provider } : {})}
        />
      ) : null
  }
}
