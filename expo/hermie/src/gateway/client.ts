import {
  type AuthTimelineSink,
  CookieSessionCredentials,
  type CredentialProvider,
  DialPlanSocketFactory,
  GatewayConnection,
  type GatewayConfig,
  NativePkceCredentials,
  refreshTokens,
  SessionTokenCredentials,
  TokenCoordinator,
  type TokenSet,
  type TokenStore
} from '@hermie/gateway-client'
import { AppState } from 'react-native'

import { RUNS_IN_DESKTOP_SHELL } from '../platform/desktop-shell'
import { networkWatcher } from '../platform/net-info'
import { RUNS_ON_MAC } from '../platform/runs-on-mac'
import { secretStore } from '../platform/secret-store'
import { PlatformWebSocket } from '../platform/socket'
import { secretKeysFor } from './config'
import type { GatewayNamespace } from './namespace'
import { refreshShareDeliveryCredential } from './share-credential'

interface TokenMeta {
  expiresAt: number
  provider: string
  userId: string
}

/**
 * The token set, split over the secret store: the two tokens get their own keys,
 * and the non-secret bookkeeping rides in one JSON blob beside them.
 *
 * Three keys mean three writes, and three writes mean a partial write is
 * possible — the keychain can refuse, and the process can be killed mid-save. So
 * the ORDER matters, and it used to be `Promise.all`, which has none.
 *
 * Rotation makes one of the two partial outcomes much worse than the other. The
 * refresh token just spent is dead at the identity provider the moment the
 * gateway answers, so a save that lands the new ACCESS token but not the new
 * REFRESH token leaves a working access token next to a dead refresh token: the
 * session looks healthy until the access token lapses, and then there is nothing
 * left to renew with. On a provider with reuse detection, presenting that dead
 * token does not merely fail — it revokes the session.
 *
 * The reverse partial outcome is recoverable: the new refresh token beside the
 * OLD access token still renews. So the refresh token goes first and alone, and
 * nothing else is written until it is safely down.
 */
export function createSecretTokenStore(ns: GatewayNamespace): TokenStore {
  const keys = secretKeysFor(ns)

  return {
    async load() {
      const [accessToken, refreshToken, rawMeta] = await Promise.all([
        secretStore.get(keys.accessToken),
        secretStore.get(keys.refreshToken),
        secretStore.get(keys.tokenMeta)
      ])

      if (!accessToken) {
        return null
      }

      let meta: TokenMeta = { expiresAt: 0, provider: '', userId: '' }

      if (rawMeta) {
        try {
          meta = { ...meta, ...(JSON.parse(rawMeta) as Partial<TokenMeta>) }
        } catch {
          // A corrupt meta blob only costs a proactive refresh, never the session.
        }
      }

      return { accessToken, refreshToken: refreshToken ?? '', ...meta }
    },
    async save(tokens: TokenSet) {
      const meta: TokenMeta = {
        expiresAt: tokens.expiresAt,
        provider: tokens.provider,
        userId: tokens.userId
      }

      // First, alone, and awaited: see the note above on which partial write
      // costs the session and which one survives.
      await secretStore.set(keys.refreshToken, tokens.refreshToken)
      await Promise.all([
        secretStore.set(keys.accessToken, tokens.accessToken),
        secretStore.set(keys.tokenMeta, JSON.stringify(meta))
      ])
      /*
        And the share extension's copy of it.

        This is the one seam a rotated access token passes through, which makes
        it the only place the extension's credential can be kept alive. Without
        it, sharing without opening the app would work for as long as the token
        the app launched with — an hour on most providers — and then queue
        everything for ever, which is the worst shape a feature can have: it
        works while you are testing it.

        LAST, and it cannot throw. The app's own credential is already safely
        down; a keychain that refuses this one means the extension queues rather
        than sends. See `share-credential.ts`.
      */
      await refreshShareDeliveryCredential(ns)
    },
    async clear() {
      await Promise.all([
        secretStore.delete(keys.accessToken),
        secretStore.delete(keys.refreshToken),
        secretStore.delete(keys.tokenMeta)
      ])
      // The same republish as `save`, which for an emptied store resolves to a
      // delete: `buildShareDeliveryRecord` has nothing to build from and the
      // extension's copy goes with the app's. `clearCredentials` does this too,
      // and the two paths do not always both run — a coordinator cleared by a
      // 401 ladder never touches `config.ts`.
      await refreshShareDeliveryCredential(ns)
    }
  }
}

/**
 * A token store that never touches disk. The onboarding wizard signs in and
 * tests the connection before it is allowed to persist anything, so the tokens
 * it is holding have to live somewhere that an abandoned wizard simply forgets.
 */
export function createMemoryTokenStore(initial: TokenSet | null = null): TokenStore {
  let tokens = initial

  return {
    async load() {
      return tokens
    },
    async save(next: TokenSet) {
      tokens = next
    },
    async clear() {
      tokens = null
    }
  }
}

export interface CreateTokenCoordinatorOptions {
  baseUrl: string
  extraHeaders?: Record<string, string>
  /**
   * Which gateway's keychain items these are. Required unless `store` is given:
   * a coordinator that reached for the unsuffixed keys would be a coordinator
   * writing one gateway's rotated tokens over another's.
   */
  namespace?: GatewayNamespace
  /** Defaults to the secret store; the wizard hands in a memory store. */
  store?: TokenStore
  /** The app's auth ring. The wizard leaves it out: it has no session to explain yet. */
  timeline?: AuthTimelineSink
}

/**
 * The single owner of token rotation for one gateway. It is created outside the
 * connection because the reauthentication banner has to hand it a freshly minted
 * token set — writing to the secret store behind its back would leave its cache
 * holding the signed-out state.
 */
export function createTokenCoordinator(options: CreateTokenCoordinatorOptions): TokenCoordinator {
  const extraHeaders = options.extraHeaders ?? {}
  const store = options.store ?? (options.namespace ? createSecretTokenStore(options.namespace) : null)

  if (!store) {
    // Neither a namespace nor a store. There is no sensible default any more —
    // the unsuffixed keys belong to nobody — so this is a programming error
    // rather than something to paper over with a guess at a gateway.
    throw new Error('createTokenCoordinator needs a gateway namespace or a token store.')
  }

  return new TokenCoordinator({
    store,
    refresh: tokens => refreshTokens(options.baseUrl, tokens, { extraHeaders }),
    ...(options.timeline ? { timeline: options.timeline } : {})
  })
}

export interface CreateConnectionOptions {
  config: GatewayConfig
  /** Which gateway's keychain items to rotate, when no coordinator is handed in. */
  namespace?: GatewayNamespace
  /** Only for `authMode: 'session_token'`; the native flow uses the coordinator. */
  sessionToken?: string
  /** Only for `authMode: 'native_pkce'`; one is built over the secret store if omitted. */
  coordinator?: TokenCoordinator
  /**
   * The app's auth ring, shared by the connection, the coordinator and the ticket
   * mint: the whole point is to read one sequence, so all three record into the
   * same one. The developer screen's throwaway connection leaves it out.
   */
  timeline?: AuthTimelineSink
}

/**
 * End the session the SERVER is holding, where there is one.
 *
 * Signing out means deleting the credential, and on the phones and the Mac the
 * credential is a keychain item this app owns: clearing the secret store is the
 * whole of it. In a browser it is not. The session is the gateway's own
 * `HttpOnly` cookie — which is the entire point of the cookie flow, because a
 * page has nowhere safe to keep a token — and a page cannot delete it.
 *
 * So "Sign out" cleared a secret store that, in that mode, was already empty:
 * the app returned to the wizard, the session stayed alive on the gateway, and
 * the next reload signed straight back in. On a shared machine that is a sign
 * out that did not sign out.
 *
 * `POST /auth/logout` is what deletes it. The gateway answers with a 302 and
 * the `Max-Age=0` cookie deletions, which the browser applies whether or not
 * the redirect is followed.
 *
 * Nothing here may throw. The caller runs this BEFORE it tears the connection
 * down and clears its own state, so a rejection would be a sign-out that also
 * failed to sign out locally — strictly worse than the defect being fixed. A
 * sign-out the server never heard about still has to look like a sign-out
 * here; the cookie lapses on its own.
 *
 * Nothing to do in the other two modes: there is no server-side session to
 * end, and the credential has just been deleted from the place it lived.
 */
export async function endGatewaySession(config: GatewayConfig | null): Promise<void> {
  if (config?.authMode !== 'cookie') {
    return
  }

  try {
    await new CookieSessionCredentials({ baseUrl: config.baseUrl }).signOut()
  } catch {
    // See above: local state has to come off whatever the gateway said.
  }
}

/** Build a connection for one configured gateway. The caller owns `start()` / `stop()`. */
export function createGatewayConnection(options: CreateConnectionOptions): GatewayConnection {
  const { config, timeline } = options
  const extraHeaders = config.extraHeaders ?? {}
  const credentials: CredentialProvider =
    config.authMode === 'cookie'
      ? new CookieSessionCredentials({
          baseUrl: config.baseUrl,
          ...(timeline ? { timeline } : {})
        })
      : config.authMode === 'session_token'
        ? new SessionTokenCredentials({ token: options.sessionToken ?? '' })
        : new NativePkceCredentials({
            baseUrl: config.baseUrl,
            coordinator:
              options.coordinator ??
              createTokenCoordinator({
                baseUrl: config.baseUrl,
                extraHeaders,
                ...(options.namespace ? { namespace: options.namespace } : {}),
                ...(timeline ? { timeline } : {})
              }),
            extraHeaders,
            ...(timeline ? { timeline } : {})
          })

  return new GatewayConnection({
    config,
    credentials,
    socketFactory: new DialPlanSocketFactory(PlatformWebSocket),
    ...(timeline ? { timeline } : {})
  })
}

/**
 * Follow the app lifecycle and the network: a backgrounded app must close its
 * socket rather than have the OS kill it half-open, and a device with no
 * connectivity should not burn battery on the dial ladder.
 *
 * **A Mac never pauses.** `pause()` tears the socket down, and on a phone that is
 * the right trade — the OS is about to kill a half-open socket anyway. A Mac
 * window that is hidden, minimised or simply behind another app is still a live
 * window with a live network, so there is nothing to protect it from. The old
 * native macOS target skipped AppState entirely for this reason; `RUNS_ON_MAC` is
 * how that survives into the iPad build, which reports iOS's AppState values like
 * any other iOS app.
 *
 * There is also a hypothesis behind it, and it is worth naming as one: the owner
 * reports "gateway not connected" appearing on the Mac build, which is what a
 * socket closed on every loss of the front would look like. That has NOT been
 * measured — neither the AppState values a Mac window reports nor the banner's
 * actual cause — so this change is justified on its own terms rather than as a
 * fix for that report.
 *
 * **Nor does the desktop shell**, for the same reason and with a sharper edge.
 * The shell (`apps/desktop`, ADR-0027) is a Tauri window over Hermie Web, so this
 * is the browser build — and React Native Web reports `background` whenever
 * `document.hidden`, which a desktop window is every time it is minimised, hidden
 * with ⌘H or simply covered. A phone's AppState is about an OS that is going to
 * kill the socket; a hidden window's is about nothing at all. Without this the
 * shell would drop its connection on every ⌘Tab, and the shell is also the one
 * place where a live socket while hidden has a job to do: it is what raises
 * notifications (plan D4), since a webview has no Push API.
 *
 * This does NOT change a browser tab. A tab that goes to the background is a tab
 * the browser may throttle to a stop, and pausing is still right there.
 *
 * `resume()` is still wired on a Mac, and cheaply: it returns immediately unless
 * the connection is actually paused or stopped, so on a window coming forward it
 * is a no-op — and if anything else did pause it, this is the recovery.
 *
 * `isConnected` is `null` while the OS is still deciding, which counts as
 * online: a cold start should not sit out its first dial waiting for an answer.
 */
export function attachLifecycle(connection: GatewayConnection): () => void {
  const subscriptions: (() => void)[] = []

  const appState = AppState.addEventListener('change', next => {
    if (next === 'active') {
      connection.resume()
    } else if (next === 'background' && !RUNS_ON_MAC && !RUNS_IN_DESKTOP_SHELL) {
      connection.pause()
    }
  })
  subscriptions.push(() => appState.remove())

  subscriptions.push(networkWatcher.subscribe(online => connection.setOnline(online)))

  return () => {
    for (const unsubscribe of subscriptions) {
      unsubscribe()
    }
  }
}
