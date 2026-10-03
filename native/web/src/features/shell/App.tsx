/**
 * The signed-in app: the frame (`Layout`), the chat list in its sidebar, the
 * connection line above both panes, and a main pane that says what route it is
 * on until the chat screen exists (W-10b).
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
 * | `#/chat/<bot>`                | the bot's name       | placeholder (W-10b: the chat)    |
 * | `#/chat/<bot>/s/<session>`    | the bot's name       | placeholder (W-10b)              |
 * | `#/settings[/<section>]`      | Settings             | placeholder (W-20b)              |
 * | anything else                 | sent to `#/`         |                                  |
 *
 * A gateway whose operator switched the bundled client off (`modules.web: off`
 * in the plugin's advert) gets one sentence instead of the app: a courtesy, not
 * a boundary (plan, "Plugin config additions").
 */
import { type ReactElement, useEffect } from 'react'
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
import { ConnectionLine } from './ConnectionLine'
import { Layout } from './Layout'
import { type Route, useRoute } from './router'
import { SidebarFooter } from './SidebarFooter'

export interface AppProps {
  /** Who is signed in: display name, else email, else id; empty when the gateway named nobody. */
  user: string
  /** Go to the gateway's own sign-in page. */
  onSignIn: () => void
  /** Stop the session, end the gateway's session and leave. */
  onSignOut: () => void
  /** The page's address, unless a test hands in its own. */
  router?: HashRouter
}

/** The bot a route is on, if it is on one. */
const botOf = (route: Route): string | undefined => (route.name === 'chat' ? route.bot : undefined)

export function App({ user, onSignIn, onSignOut, router = pageHashRouter }: AppProps): ReactElement {
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
    <Layout
      route={route}
      heading={heading}
      status={<ConnectionLine onSignIn={onSignIn} />}
      sidebar={<ChatList selectedBot={bot} />}
      footer={<SidebarFooter user={user} onSignOut={onSignOut} />}
    >
      <p className="hm-main__body">
        {route.name === 'home'
          ? strings.app.chat.pickBot
          : route.name === 'chat'
            ? webStrings.shell.chatSoon
            : webStrings.shell.settingsSoon}
      </p>
    </Layout>
  )
}
