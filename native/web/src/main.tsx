/**
 * The entry module: frame guard, language, base path, then the boot state
 * machine (`boot/boot.ts`) and a screen for whatever it ends in.
 *
 * The order is the point. The frame guard runs before anything else and, when
 * the page is framed, nothing after it runs at all: no locale chunk, no
 * storage, no request, no React. The modules imported above it only define
 * things; none of them has a side effect at import.
 */
import { StrictMode, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { pageBasePath, type ResolvedBasePath } from './boot/base-path'
import { boot, describeBootFailure, type BootState } from './boot/boot'
import { refuseInFrame } from './boot/frame-guard'
import { claimForOwner, restoreRoute, signIn, signOut } from './boot/login-bounce'
import { strings } from './generated/strings'
import { initLocale } from './i18n/locale'
import { useLocale } from './i18n/use-locale'
import { webStrings } from './i18n/web-strings'
import { Placeholder } from './Placeholder'
import { chatCacheFor } from './platform/chat-cache'
import { createKeyValueStore } from './platform/key-value-store'
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

function SignedIn({ state, onSignOut }: { state: Extract<BootState, { kind: 'signed_in' }>; onSignOut: () => void }) {
  useLocale()
  const [leaving, setLeaving] = useState(false)
  const user = state.identity.displayName || state.identity.email || state.identity.userId

  return (
    <>
      <Placeholder />
      <section className="boot">
        <p>{user ? strings.app.onboarding.signIn.signedInAs({ user }) : strings.app.onboarding.signIn.signedIn}</p>
        <button
          type="button"
          disabled={leaving}
          onClick={() => {
            setLeaving(true)
            onSignOut()
          }}
        >
          {strings.app.onboarding.signIn.signOutOfSession}
        </button>
      </section>
    </>
  )
}

function BootView({ state, onRetry, onSignOut }: { state: BootState; onRetry: () => void; onSignOut: () => void }) {
  useLocale()
  const host = new URL(state.basePath.baseUrl).host

  switch (state.kind) {
    case 'unreachable':
      return (
        <Screen>
          <p role="alert">{describeBootFailure(state.error, state.basePath.baseUrl)}</p>
          <button type="button" onClick={onRetry}>
            {strings.app.common.retry}
          </button>
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
          <button type="button" onClick={() => signIn(state.basePath)}>
            {strings.app.onboarding.signIn.signOutAndRetry}
          </button>
        </Screen>
      )
    case 'signed_in':
      return <SignedIn state={state} onSignOut={onSignOut} />
  }
}

function render(root: Root, view: ReactNode): void {
  root.render(<StrictMode>{view}</StrictMode>)
}

async function run(root: Root, basePath: ResolvedBasePath): Promise<void> {
  const store = createKeyValueStore({ namespace: basePath.namespace })
  const cache = chatCacheFor(basePath.namespace)

  render(root, <Probing />)

  const state = await boot(basePath)

  if (state.kind === 'signed_in') {
    // Before anything is painted from the cache: it must be this person's.
    await claimForOwner({ cache, store }, state.author?.id)
  }

  render(
    root,
    <BootView
      state={state}
      onRetry={() => void run(root, basePath)}
      onSignOut={() => {
        if (state.kind === 'signed_in') {
          void signOut({ basePath, credentials: state.session.credentials, cache, store })
        }
      }}
    />
  )
}

async function start(): Promise<void> {
  if (refuseInFrame()) {
    return
  }

  await initLocale()

  const container = document.getElementById('root')

  if (!container) {
    throw new Error('index.html has no #root element')
  }

  const root = createRoot(container)
  const basePath = pageBasePath()

  if (!basePath.ok) {
    render(root, <Misconfigured expected={basePath.expected} />)

    return
  }

  restoreRoute(basePath)
  await run(root, basePath)
}

void start()
