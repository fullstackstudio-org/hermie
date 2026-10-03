/**
 * The signed-in app: the frame (`Layout`), the chat list in its sidebar, the
 * connection line above both panes, and the chat screen in the main pane.
 *
 * It takes no connection and starts none: the entry module started the session
 * (`session.ts`) and every screen reads the stores it fills. What it is given is
 * the two things only the entry module can do, signing in again and signing
 * out, and who is signed in.
 *
 * Route table (plan W4; `router.ts`):
 *
 * | Route                         | Heading              | Main pane today                  |
 * | ----------------------------- | -------------------- | -------------------------------- |
 * | `#/`                          | Hermie               | "Pick a conversation..."         |
 * | `#/chat/<bot>`                | the bot's name       | the chat (`ChatScreen`)          |
 * | `#/chat/<bot>/s/<session>`    | the bot's name       | that conversation (`ChatScreen`) |
 * | `#/settings`                  | Settings             | placeholder (W-20b), a link to Passkeys |
 * | `#/settings/passkeys`         | Settings             | the passkeys of this gateway (`Passkeys`) |
 * | `#/settings/<other section>`  | Settings             | placeholder (W-20b)              |
 * | anything else                 | sent to `#/`         |                                  |
 *
 * The request layer (a bot's approval or question, one at a time, over everything) is a
 * sibling of the frame, and so is in every route; it reads the requests of every chat and the
 * confirmations at level `passkey`. The passkey model's actions reach it and the settings page through
 * `PasskeyRuntimeContext` (the `passkeys` prop).
 *
 * The chat screen opens its own chat (it is given the controller through
 * `ChatRuntimeContext`, which this provides from the `chat` prop); this component
 * opens nothing. A chat is keyed by its route, so moving to another one starts a
 * screen of its own and nothing of the last one's scroll or state carries over.
 *
 * A gateway whose operator switched the bundled client off (`modules.web: off`
 * in the plugin's advert) gets one sentence instead of the app: a courtesy, not
 * a boundary (plan, "Plugin config additions").
 */
import { lazy, type ReactElement, Suspense, useEffect } from 'react'
import { useStore } from 'zustand'

import { webClientSwitchedOff } from '../../core/advert'
import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { type HashRouter, pageHashRouter } from '../../platform/hash-router'
import { setPageTitle } from '../../platform/page-title'
import { botsStore } from '../../state/bots'
import { pluginStore } from '../../state/plugin'
import { ChatList } from '../bots/ChatList'
import { ChatScreen } from '../chat/ChatScreen'
import { ChatRuntimeContext, type ChatSessionRuntime } from '../chat/chat-runtime'
import { type PasskeyActions, PasskeyRuntimeContext } from '../requests/passkey-runtime'
import { RequestLayer } from '../requests/RequestLayer'
import { ConnectionLine } from './ConnectionLine'
import { Layout } from './Layout'
import { formatRoute, type Route, useRoute } from './router'
import { SidebarFooter } from './SidebarFooter'

/** The passkeys page (and its styles) is a chunk of its own, fetched when `#/settings/passkeys` is opened. */
const Passkeys = lazy(() => import('../settings/Passkeys').then(module => ({ default: module.Passkeys })))

export interface AppProps {
  /** Who is signed in: display name, else email, else id; empty when the gateway named nobody. */
  user: string
  /** Go to the gateway's own sign-in page. */
  onSignIn: () => void
  /** Stop the session, end the gateway's session and leave. */
  onSignOut: () => void
  /** The page's address, unless a test hands in its own. */
  router?: HashRouter
  /**
   * What a chat opens itself with: the controller and the gateway's base URL.
   * Absent in a test of the frame, where a chat draws what the stores hold and opens nothing.
   */
  chat?: ChatSessionRuntime
  /** The passkey model's actions; absent in a test of the frame. */
  passkeys?: PasskeyActions
}

/** The bot a route is on, if it is on one. */
const botOf = (route: Route): string | undefined => (route.name === 'chat' ? route.bot : undefined)

export function App({ user, onSignIn, onSignOut, router = pageHashRouter, chat, passkeys }: AppProps): ReactElement {
  useLocale()

  const route = useRoute(router)
  const bot = botOf(route)
  const botName = useStore(botsStore, state =>
    bot === undefined ? undefined : (state.byName[bot]?.displayName ?? bot)
  )
  const switchedOff = useStore(pluginStore, state => webClientSwitchedOff(state.advert))

  const appName = strings.app.app.name
  const heading =
    route.name === 'chat' ? (botName ?? route.bot) : route.name === 'settings' ? strings.app.settings.title : appName

  // The tab says where you are; the app's own name stands alone on the home route.
  useEffect(() => {
    setPageTitle(route.name === 'home' ? undefined : heading)
  }, [route.name, heading])

  if (switchedOff) {
    return (
      <main className="boot">
        <h1>{appName}</h1>
        <p role="alert">{webStrings.shell.switchedOff}</p>
      </main>
    )
  }

  return (
    <ChatRuntimeContext.Provider value={chat ?? null}>
      <PasskeyRuntimeContext.Provider value={passkeys ?? null}>
        <Layout
          route={route}
          heading={heading}
          status={<ConnectionLine onSignIn={onSignIn} />}
          sidebar={<ChatList selectedBot={bot} />}
          footer={<SidebarFooter user={user} onSignOut={onSignOut} />}
        >
          {route.name === 'chat' ? (
            <ChatScreen
              key={formatRoute(route)}
              bot={route.bot}
              {...(route.session ? { session: route.session } : {})}
            />
          ) : route.name === 'settings' && route.section === 'passkeys' ? (
            <Suspense fallback={<div className="hm-main__body" aria-busy="true" />}>
              <Passkeys />
            </Suspense>
          ) : route.name === 'settings' ? (
            <div className="hm-main__body">
              <p>{webStrings.shell.settingsSoon}</p>
              {route.section === undefined ? (
                <p>
                  <a href={formatRoute({ name: 'settings', section: 'passkeys' })}>
                    {webStrings.passkeys.settings.title}
                  </a>
                </p>
              ) : null}
            </div>
          ) : (
            <p className="hm-main__body">{strings.app.chat.pickBot}</p>
          )}
        </Layout>
        {/* Over the whole page, whichever route: a bot's question is never behind a screen. */}
        <RequestLayer />
      </PasskeyRuntimeContext.Provider>
    </ChatRuntimeContext.Provider>
  )
}
