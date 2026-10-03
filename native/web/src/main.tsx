/**
 * The entry module: frame guard, language, base path, then the boot state
 * machine (`boot/boot.ts`) and a screen for whatever it ends in.
 *
 * The order is the point. The frame guard runs before anything else and, when
 * the page is framed, nothing after it runs at all: no locale chunk, no
 * storage, no request, no React. The modules imported above it only define
 * things; none of them has a side effect at import.
 */
import { StrictMode, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { pageBasePath, type ResolvedBasePath, storageNamespace } from './boot/base-path'
import { boot, describeBootFailure, type BootState } from './boot/boot'
import { refuseInFrame } from './boot/frame-guard'
import { claimForOwner, restoreRoute, signIn, signOut } from './boot/login-bounce'
import { strings } from './generated/strings'
import { configureLocale, initLocale } from './i18n/locale'
import { useLocale } from './i18n/use-locale'
import { webStrings } from './i18n/web-strings'
import { createDraftStore } from './features/chat/drafts'
import { App } from './features/shell/App'
import { startSession } from './features/shell/session'
import { chatCacheFor, type ChatCache } from './platform/chat-cache'
import { createKeyValueStore, type WebKeyValueStore } from './platform/key-value-store'
import { localeEnvironmentFor } from './platform/locale-environment'
import { bindTheme, settingsStore } from './state/settings'
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

function BootView({ state, onRetry }: { state: Exclude<BootState, { kind: 'signed_in' }>; onRetry: () => void }) {
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
    case 'token_mode':
      return (
        <Screen title={strings.app.onboarding.signIn.tokenBlockedTitle}>
          <p role="alert">{strings.app.onboarding.signIn.tokenBlockedBody}</p>
        </Screen>
      )
    case 'needs_signin':
      return (
        <Screen title={strings.app.signedOut.title}>
          <p role="alert">{strings.app.signedOut.body({ host })}</p>
          <Button onClick={() => signIn(state.basePath)}>{strings.app.onboarding.signIn.signOutAndRetry}</Button>
        </Screen>
      )
  }
}

function render(root: Root, view: ReactNode): void {
  root.render(<StrictMode>{view}</StrictMode>)
}

async function run(root: Root, basePath: ResolvedBasePath, store: WebKeyValueStore, cache: ChatCache): Promise<void> {
  render(root, <Probing />)

  const state = await boot(basePath)

  if (state.kind !== 'signed_in') {
    render(root, <BootView state={state} onRetry={() => void run(root, basePath, store, cache)} />)

    return
  }

  // Before anything is painted from the cache: it must be this person's.
  await claimForOwner({ cache, store }, state.author?.id)

  // The connection, the chats on it and the roster's running poll: started once,
  // here, so no re-render can start a second one.
  const session = startSession({
    baseUrl: basePath.baseUrl,
    credentials: state.session.credentials,
    author: state.author,
    storage: store,
    cache
  })

  render(
    root,
    <App
      user={state.identity.displayName || state.identity.email || state.identity.userId || ''}
      chat={{
        controller: session.chats.controller,
        gatewayBaseUrl: basePath.baseUrl,
        drafts: createDraftStore(store)
      }}
      passkeys={session.passkeys}
      secureInput={session.secureInput}
      onSignIn={() => signIn(basePath)}
      onSignOut={() => {
        // The order matters: the chats and the socket stop before the gateway's
        // session is ended, so nothing dials with a session that is going away.
        session.stop()
        void signOut({ basePath, credentials: state.session.credentials, cache, store })
      }}
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

  restoreRoute(basePath)
  await run(root, basePath, store, chatCacheFor(basePath.namespace))
}

void start()
