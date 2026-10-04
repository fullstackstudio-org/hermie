/**
 * The entry module: frame guard, language, base path, then the boot state
 * machine (`boot/boot.ts`) and a screen for whatever it ends in: the app on
 * the gateway's cookie session, the app on a gateway without sign-in (its
 * session token, in memory only), the token prompt, a sign-in, or an error.
 *
 * The order is the point. The frame guard runs before anything else and, when
 * the page is framed, nothing after it runs at all: no locale chunk, no
 * storage, no request, no React. The modules imported above it only define
 * things; none of them has a side effect at import.
 */
import {
  type AuthIdentity,
  type CredentialProvider,
  GatewayError,
  type ProbeResult,
  type SessionTokenCredentials
} from '@hermie/gateway-client'
import { StrictMode, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { APP_DIRECTORY_PATH, pageBasePath, type ResolvedBasePath, storageNamespace } from './boot/base-path'
import { boot, bootWithToken, describeBootFailure, type BootState } from './boot/boot'
import { refuseInFrame } from './boot/frame-guard'
import { rereadToken } from './boot/token-recovery'
import {
  claimForOwner,
  createEnrolStash,
  forgetToken,
  reauthSignIn,
  restoreRoute,
  signIn,
  signOut
} from './boot/login-bounce'
import { createPeoplePictures } from './core/people-pictures'
import { strings } from './generated/strings'
import { configureLocale, initLocale } from './i18n/locale'
import { useLocale } from './i18n/use-locale'
import { webStrings } from './i18n/web-strings'
import { createDraftStore } from './features/chat/drafts'
import { preloadRequestSheets } from './features/requests/request-sheets'
import { App } from './features/shell/App'
import { startSession } from './features/shell/session'
import { TokenPrompt, type TokenPromptReason, type TokenSubmitOutcome } from './features/shell/TokenPrompt'
import { chatCacheFor, type ChatCache, GatedChatCache } from './platform/chat-cache'
import { createKeyValueStore, type WebKeyValueStore } from './platform/key-value-store'
import { localeEnvironmentFor } from './platform/locale-environment'
import { createTabChannel, type TabChannel } from './platform/tab-channel'
import { chatViewStore } from './state/chat-view'
import { OWNER_USER_ID } from './state/device-context'
import { bindTheme, settingsStore } from './state/settings'
import { bindTextSize, textSizeStore } from './state/text-size'
import { Button } from './ui/primitives'
import './ui/theme.css'
import './ui/base.css'

function Screen({ title, children }: { title?: string; children: ReactNode }) {
  useLocale()

  return (
    <main className="boot">
      <h1>{title ?? 'Hermie'}</h1>
      {children}
    </main>
  )
}

function Misconfigured({ expected }: { expected: string }) {
  useLocale()

  return (
    <Screen>
      <p role="alert">{webStrings.basePath.misconfigured({ expected })}</p>
    </Screen>
  )
}

function Probing() {
  useLocale()

  return (
    <Screen>
      <p role="status">{strings.app.onboarding.signIn.probingGateway}</p>
    </Screen>
  )
}

/** The boot states that are not an app yet: an error, the token prompt, or a sign-in. */
type WaitingState = Exclude<BootState, { kind: 'signed_in' | 'token_ready' | 'needs_token' }>

function BootView({ state, onRetry }: { state: WaitingState; onRetry: () => void }) {
  useLocale()
  const host = new URL(state.basePath.baseUrl).host

  switch (state.kind) {
    case 'unreachable':
      return (
        <Screen>
          <p role="alert">{describeBootFailure(state.error, state.basePath.baseUrl)}</p>
          <Button onClick={onRetry}>{strings.app.common.retry}</Button>
        </Screen>
      )
    case 'needs_signin':
      return <SignedOut basePath={state.basePath} host={host} />
  }
}

/** Signed out: the session lapsed, or another tab signed out. "Sign in again" goes to the gateway's `/login`. */
function SignedOut({ basePath, host }: { basePath: ResolvedBasePath; host: string }) {
  useLocale()

  return (
    <Screen title={strings.app.signedOut.title}>
      <p role="alert">{strings.app.signedOut.body({ host })}</p>
      <Button onClick={() => signIn(basePath)}>{strings.app.onboarding.signIn.signOutAndRetry}</Button>
    </Screen>
  )
}

function render(root: Root, view: ReactNode): void {
  root.render(<StrictMode>{view}</StrictMode>)
}

/** What every step after the base path works on: the page's root, its gateway and its storage. */
interface Page {
  root: Root
  basePath: ResolvedBasePath
  store: WebKeyValueStore
  cache: ChatCache
  /** The page's other tabs on this gateway (`platform/tab-channel.ts`). */
  tabs: TabChannel
}

/**
 * The session the app runs on, whichever way the boot got it.
 *
 *  - **Signed in** (`signed_in`): the gateway's cookie session and the person `/api/auth/me` named.
 *  - **No sign-in** (`token_ready`, W-23): the session token, held by `credentials` and nowhere else,
 *    and nobody named. The stored state is claimed for the owner (`OWNER_USER_ID`), the one person
 *    such a gateway knows; a cookie session's owner is `<provider>:<user id>`, so the two never meet.
 */
interface Ready {
  probe: ProbeResult
  credentials: CredentialProvider
  /** The session token's credentials on a gateway without sign-in; absent on the cookie session. */
  token?: SessionTokenCredentials
  gated: boolean
  identity: AuthIdentity | null
  author: { id: string; name?: string } | undefined
}

/** Boot from the probe, and show what it ends in. */
async function run(page: Page): Promise<void> {
  render(page.root, <Probing />)
  await show(page, await boot(page.basePath))
}

async function show(page: Page, state: BootState): Promise<void> {
  switch (state.kind) {
    case 'signed_in':
      await startApp(page, {
        probe: state.probe,
        credentials: state.session.credentials,
        gated: true,
        identity: state.identity,
        author: state.author
      })

      return
    case 'token_ready':
      await startApp(page, {
        probe: state.probe,
        credentials: state.session.credentials,
        token: state.session.credentials,
        gated: false,
        identity: null,
        author: undefined
      })

      return
    case 'needs_token':
      askForToken(page, state.probe, state.reason)

      return
    default:
      render(page.root, <BootView state={state} onRetry={() => void run(page)} />)
  }
}

/**
 * The token prompt (`features/shell/TokenPrompt.tsx`). A typed token is checked like the bootstrap's
 * (`bootWithToken`); taken, the app starts on it, and the prompt never sees it again.
 */
function askForToken(page: Page, probe: ProbeResult, reason: TokenPromptReason): void {
  const submit = async (token: string): Promise<TokenSubmitOutcome> => {
    try {
      const next = await bootWithToken(page.basePath, probe, token)

      switch (next.kind) {
        case 'token_ready':
          await show(page, next)

          return { kind: 'accepted' }
        case 'needs_token':
          return { kind: 'wrong' }
        case 'unreachable':
          return { kind: 'failed', message: describeBootFailure(next.error, page.basePath.baseUrl) }
      }
    } catch (error) {
      // Starting the app failed after the token was taken: say so on the prompt rather than leave it checking.
      return {
        kind: 'failed',
        message:
          error instanceof GatewayError ? describeBootFailure(error, page.basePath.baseUrl) : strings.app.errors.unknown
      }
    }
  }

  render(page.root, <TokenPrompt key={reason} reason={reason} submit={submit} onReadAgain={() => void run(page)} />)
}

async function startApp(page: Page, ready: Ready): Promise<void> {
  const { root, basePath, store, cache } = page

  // Before anything is painted from the cache: it must be this person's (on a gateway without sign-in, the owner's).
  await claimForOwner({ cache, store }, ready.gated ? ready.author?.id : OWNER_USER_ID)
  // What each chat shows is this person's too, so it is read only once the store is theirs.
  chatViewStore.getState().hydrate(store)

  // The connection, the chats on it and the roster's running poll: started once,
  // here, so no re-render can start a second one.
  const session = startSession({
    baseUrl: basePath.baseUrl,
    credentials: ready.credentials,
    author: ready.author,
    ...(ready.identity ? { identity: ready.identity } : {}),
    gated: ready.gated,
    storage: store,
    cache,
    // Adding a passkey by signing in again: the grant survives the trip in this tab's `sessionStorage`.
    ...(ready.gated
      ? {
          selfEnrolment: {
            stash: createEnrolStash(basePath, ready.author?.id ?? ''),
            bounce: path => reauthSignIn(basePath, path)
          }
        }
      : {})
  })

  // The people's pictures, through the gateway's authenticated route and this session's own credentials.
  const pictures = createPeoplePictures({
    fetchPicture: path => session.client.http.fetchAuthenticatedPicture(path)
  })

  // A bot's question must be on screen the moment it arrives: the sheets' chunk is fetched now, while the
  // socket is still connecting. A failure here is retried by the request layer when it has one to show.
  void preloadRequestSheets().catch(() => undefined)

  const identity = ready.identity
  const user = identity ? identity.displayName || identity.email || identity.userId || '' : ''

  /*
    The app ends exactly once, whichever way: the chats and the socket stop before anything else, so
    nothing dials with a credential that is going away, and every watcher below lets go.
  */
  let ended = false
  const unsubscribes: (() => void)[] = []

  const end = (): boolean => {
    if (ended) {
      return false
    }

    ended = true
    session.stop()
    pictures.clear()

    for (const unsubscribe of unsubscribes.splice(0)) {
      unsubscribe()
    }

    return true
  }

  /*
    The way out. Signed in: sign out at the gateway, clear this person's state, go to `/login`. No
    sign-in: forget the token (the session that holds it is stopped and dropped, the same local state is
    cleared) and ask for it. Either way the other tabs on this gateway are told first, so they stop
    writing into the state about to be cleared ("in this browser" means every tab).
  */
  const leave = (): void => {
    if (!end()) {
      return
    }

    page.tabs.announceForget()

    if (ready.gated) {
      void signOut({ basePath, credentials: ready.credentials, cache, store })
    } else {
      void forgetToken({ basePath, cache, store }).then(() => askForToken(page, ready.probe, 'forgotten'))
    }
  }

  /*
    Another tab signed out or forgot the token: stop, drop the credentials, clear what that tab cleared
    (whatever this one wrote meanwhile included), and show the prompt or the signed-out screen. Nothing
    is said to the gateway: the tab that left already did what there was to do.
  */
  unsubscribes.push(
    page.tabs.onForget(() => {
      if (!end()) {
        return
      }

      void forgetToken({ basePath, cache, store }).then(() => {
        if (ready.gated) {
          render(root, <SignedOut basePath={basePath} host={new URL(basePath.baseUrl).host} />)
        } else {
          askForToken(page, ready.probe, 'forgotten')
        }
      })
    })
  )

  /*
    The way back in. Signed in: the gateway's `/login`. No sign-in: the token the gateway stopped taking
    is read from its dashboard again (the boot from the probe).
  */
  const signInAgain = (): void => {
    if (ready.gated) {
      signIn(basePath)
    } else if (end()) {
      void run(page)
    }
  }

  /*
    No sign-in: the fork mints a new token for every server process, so a gateway restart refuses the
    page's token and the connection stops at `needs_signin`. The first time that happens, the token is read
    from the dashboard again by itself (`boot/token-recovery.ts`), as the dashboard reloads once: a new
    token that is taken, or a gateway that turned sign-in on, starts over on it. The same token, or no
    token, leaves the connection line's "Read it from the dashboard again" as the way back.
  */
  const token = ready.token

  if (token) {
    let reread = false

    unsubscribes.push(
      session.client.stores.connection.subscribe(state => {
        if (state.status !== 'needs_signin' || reread) {
          return
        }

        reread = true
        void rereadToken(basePath, token).then(result => {
          if (result.kind === 'restart' && end()) {
            void show(page, result.state)
          }
        })
      })
    )
  }

  render(
    root,
    <App
      user={user}
      {...(identity?.pictureUrl ? { pictureUrl: identity.pictureUrl } : {})}
      gated={ready.gated}
      chat={{
        pictures,
        controller: session.chats.controller,
        gatewayBaseUrl: basePath.baseUrl,
        drafts: createDraftStore(store),
        sessionSearch: session.client.http
      }}
      passkeys={session.passkeys}
      mcp={session.mcp}
      settings={{
        gatewayBaseUrl: basePath.baseUrl,
        hermesVersion: ready.probe.version,
        identity: {
          displayName: identity?.displayName ?? '',
          email: identity?.email ?? '',
          userId: identity?.userId ?? '',
          provider: identity?.provider ?? ''
        },
        // Beside the page, where the build put it (`public/licenses.json`).
        licencesUrl: `${basePath.baseUrl}${APP_DIRECTORY_PATH}licenses.json`,
        clearTranscriptCache: () => cache.clear()
      }}
      secureInput={session.secureInput}
      interactive={session.interactive}
      signals={{ notices: session.notices, connections: session.connections, status: session.status }}
      onSignIn={signInAgain}
      onSignOut={leave}
    />
  )
}

async function start(): Promise<void> {
  if (refuseInFrame()) {
    return
  }

  const basePath = pageBasePath()
  // The language is a device setting in the page's own store, so the store comes
  // before the language. A page served from the wrong path has no namespace of
  // its own; its error screen reads the root's.
  const store = createKeyValueStore({ namespace: basePath.ok ? basePath.namespace : storageNamespace('') })

  configureLocale(localeEnvironmentFor(store))
  await initLocale()

  const container = document.getElementById('root')

  if (!container) {
    throw new Error('index.html has no #root element')
  }

  const root = createRoot(container)

  if (!basePath.ok) {
    render(root, <Misconfigured expected={basePath.expected} />)

    return
  }

  // The device's own choices (scheme, tint) are applied before the first
  // screen, so a stored dark mode is dark from the first frame.
  settingsStore.getState().hydrate(store)
  bindTheme()
  // The transcript's text size likewise (it is also kept on the gateway; this is the browser's own copy).
  textSizeStore.getState().hydrate(store)
  bindTextSize()

  restoreRoute(basePath)
  // The reader can switch the transcript cache off (Settings, Chats); it is asked on every call.
  await run({
    root,
    basePath,
    store,
    cache: new GatedChatCache(chatCacheFor(basePath.namespace), () => settingsStore.getState().transcriptCache),
    tabs: createTabChannel(basePath.namespace)
  })
}

void start()
