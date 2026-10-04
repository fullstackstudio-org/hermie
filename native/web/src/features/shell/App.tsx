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
 * | `#/chat/<bot>/conversations`  | Conversations        | the bot's conversations (`ConversationsPage`) |
 * | `#/chat/<bot>/profile`        | Edit <bot>'s profile | the bot's profile (`ProfilePage`)    |
 * | `#/settings`                  | Settings             | the home of Settings (`SettingsHost`)  |
 * | `#/settings/<section>`        | Settings             | that section, under a way back (`SettingsHost`): account, gateway, passkeys, mcp, chats, chat-list, appearance, about |
 * | `#/settings/<anything else>`  | Settings             | the home; the address is rewritten to `#/settings` |
 * | `#/crons`, `#/crons/new`, `#/crons/<job>`, `#/crons/<job>/edit`, `#/crons/<job>/runs/<run>` | Crons | the crons list, the editor, one cron or one of its runs (`CronsPage`, a chunk) |
 * | `#/activity`                  | Activity             | the timeline of what the bots said to each other (`ActivityPage`, a chunk) |
 * | `#/new-bot`                   | New bot              | the New bot page (`NewBotPage`, a chunk) |
 * | anything else                 | sent to `#/`         |                                  |
 *
 * The request layer (a bot's approval or question, one at a time, over everything) is a
 * sibling of the frame, and so is in every route; it reads the requests of every chat and the
 * confirmations at level `passkey`. The passkey model's actions reach it and the settings page through
 * `PasskeyRuntimeContext` (the `passkeys` prop); the MCP model's reach the MCP page through
 * `McpRuntimeContext` (the `mcp` prop); what the other Settings pages need of the page (the gateway's
 * address and Hermes version, who `/api/auth/me` named, the licence list's address, clearing the
 * transcript cache and signing out) reaches them through `SettingsRuntimeContext` (the `settings` prop,
 * with `user`, `pictureUrl` and `onSignOut`).
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
import { lazy, type ReactElement, Suspense, useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'

import { webClientSwitchedOff } from '../../core/advert'
import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { type HashRouter, pageHashRouter } from '../../platform/hash-router'
import { setPageTitle } from '../../platform/page-title'
import { pluginStore } from '../../state/plugin'
import { useBotNames } from '../bots/bot-names'
import { ChatList } from '../bots/ChatList'
import { loadActivityPage } from '../activity/load'
import { loadChatScreen, preloadChatScreen } from '../chat/load'
import { ChatRuntimeContext, type ChatSessionRuntime } from '../chat/chat-runtime'
import { type CronRuntime, CronRuntimeContext } from '../cron/cron-runtime'
import { loadCronsPage } from '../cron/load'
import { loadNewBotPage } from '../profile/load'
import { loadSettingsHost } from '../settings/load'
import { type McpActions, McpRuntimeContext } from '../settings/mcp-runtime'
import { type SettingsRuntime, SettingsRuntimeContext } from '../settings/settings-runtime'
import { type PasskeyActions, PasskeyRuntimeContext } from '../requests/passkey-runtime'
import { RequestLayer } from '../requests/RequestLayer'
import { type InteractiveActions, InteractiveRuntimeContext } from '../requests/interactive-runtime'
import { type SecureInputActions, SecureInputRuntimeContext } from '../requests/secure-input-runtime'
import { type SessionSignalsActions, SessionSignalsRuntimeContext } from '../notices/signals-runtime'
import { ConnectionLine } from './ConnectionLine'
import { useShortcuts } from './use-shortcuts'
import { Layout } from './Layout'
import { formatRoute, profileHref, type Route, useRoute } from './router'
import { SidebarFooter } from './SidebarFooter'

/**
 * Settings is a chunk of its own (`features/settings/load.ts`), fetched when a settings route is opened,
 * or earlier, when a pointer or the focus reaches the link to it in the sidebar. Its sections are chunks
 * inside it.
 */
const SettingsHost = lazy(() => loadSettingsHost().then(module => ({ default: module.SettingsHost })))

/**
 * The chat screen is one too (`features/chat/load.ts`): the transcript, the Markdown renderer, the
 * composer and the message menu are drawn only once a chat is opened, and the app asks for the chunk
 * as soon as it has drawn once, so an open chat rarely waits for it.
 */
const ChatScreen = lazy(() => loadChatScreen().then(module => ({ default: module.ChatScreen })))

/** So is a bot's profile page, fetched when `#/chat/<bot>/profile` is opened or its menu line is pointed at. */
const ProfilePage = lazy(() => import('../profile/ProfilePage').then(module => ({ default: module.ProfilePage })))

/** So is the New bot page, fetched when `#/new-bot` is opened or its link in the sidebar is pointed at. */
const NewBotPage = lazy(() => loadNewBotPage().then(module => ({ default: module.NewBotPage })))

/** So is a bot's Conversations page, fetched when `#/chat/<bot>/conversations` is opened. */
const ConversationsPage = lazy(() =>
  import('../sessions/ConversationsPage').then(module => ({ default: module.ConversationsPage }))
)

/** The list of keyboard shortcuts is a chunk of its own, fetched the first time it is asked for. */
const ShortcutsDialog = lazy(() => import('./ShortcutsDialog').then(module => ({ default: module.ShortcutsDialog })))

/** The Crons pages and the Activity timeline are chunks of their own, fetched when their route is opened (`features/cron/load.ts`, `features/activity/load.ts`). */
const CronsPage = lazy(() => loadCronsPage().then(module => ({ default: module.CronsPage })))
const ActivityPage = lazy(() => loadActivityPage().then(module => ({ default: module.ActivityPage })))

export interface AppProps {
  /** Who is signed in: display name, else email, else id; empty when the gateway named nobody. */
  user: string
  /** Where the gateway holds the reader's own picture (`picture_url`); empty or absent when it holds none. */
  pictureUrl?: string
  /** Go to the gateway's own sign-in page. */
  onSignIn: () => void
  /** Stop the session, end the gateway's session and leave; on a gateway without sign-in, forget the token. */
  onSignOut: () => void
  /**
   * False on a gateway without sign-in (session-token mode, W-23): the sidebar names nobody and offers to
   * forget the token, the connection line reads the token again, and Settings says what needs sign-in.
   */
  gated?: boolean
  /** The page's address, unless a test hands in its own. */
  router?: HashRouter
  /**
   * What a chat opens itself with: the controller and the gateway's base URL.
   * Absent in a test of the frame, where a chat draws what the stores hold and opens nothing.
   */
  chat?: ChatSessionRuntime
  /** The passkey model's actions; absent in a test of the frame. */
  passkeys?: PasskeyActions
  /** The MCP model's actions (Settings › MCP); absent in a test of the frame. */
  mcp?: McpActions
  /** What the Crons pages talk to the gateway with (`features/cron/cron-runtime.ts`); absent in a test of the frame. */
  cron?: CronRuntime
  /**
   * What Settings needs of the page that no store holds: the gateway's address and Hermes version, who
   * was named, where the licence list is, and how to clear the transcript cache. Absent in a test of the
   * frame, where those pages draw what they can and act on nothing.
   */
  settings?: Omit<SettingsRuntime, 'signOut' | 'user' | 'pictureUrl' | 'gated'>
  /** The secure input model's actions (secret, sudo and vault prompts); absent in a test of the frame. */
  secureInput?: SecureInputActions
  /** The interactive model's actions (forms, file requests, drafts to review); absent in a test of the frame. */
  interactive?: InteractiveActions
  /** The actions of the models beside the engine (notices, connection cards, resume progress); absent in a test of the frame. */
  signals?: SessionSignalsActions
}

/** The bot a route is on, if it is on one. */
const botOf = (route: Route): string | undefined =>
  route.name === 'chat' || route.name === 'conversations' || route.name === 'profile' ? route.bot : undefined

export function App({
  user,
  pictureUrl,
  onSignIn,
  onSignOut,
  gated = true,
  router = pageHashRouter,
  chat,
  passkeys,
  mcp,
  cron,
  settings,
  secureInput,
  interactive,
  signals
}: AppProps): ReactElement {
  useLocale()

  const settingsRuntime = useMemo<SettingsRuntime | null>(
    () => (settings ? { ...settings, gated, user, pictureUrl: pictureUrl ?? '', signOut: onSignOut } : null),
    [settings, gated, user, pictureUrl, onSignOut]
  )

  const route = useRoute(router)
  // The list of shortcuts, and what had the focus when it was asked for (it gets it back).
  const [shortcuts, setShortcuts] = useState<{ opener: HTMLElement | null } | null>(null)
  const showShortcuts = (opener?: HTMLElement | null): void =>
    setShortcuts({
      opener: opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    })

  useShortcuts({ router, onHelp: showShortcuts })
  const bot = botOf(route)
  // What the reader calls the bot beats what the bot calls itself (`state/layout.ts`, set on its profile page), and
  // which of its two names leads is the reader's setting (`features/bots/bot-names.ts`).
  const botName = useBotNames(bot).primary
  const switchedOff = useStore(pluginStore, state => webClientSwitchedOff(state.advert))

  const appName = strings.app.app.name
  const heading =
    route.name === 'chat'
      ? // The bot's own words: cleaned and bounded like a request's, and isolated where the heading draws it.
        botName || appName
      : route.name === 'conversations'
        ? strings.chat.sessions.conversations
        : route.name === 'profile'
          ? strings.app.botProfile.open({ name: botName || appName })
          : route.name === 'settings'
            ? strings.app.settings.title
            : route.name === 'crons'
              ? strings.app.tabs.routines
              : route.name === 'activity'
                ? strings.app.activity.title
                : route.name === 'new-bot'
                  ? strings.profiles.new.title
                  : appName

  // Once the frame has been drawn, fetch the chat screen's chunk if no route has asked for it yet.
  useEffect(() => {
    preloadChatScreen()
  }, [])

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
        <McpRuntimeContext.Provider value={mcp ?? null}>
          <CronRuntimeContext.Provider value={cron ?? null}>
            <SettingsRuntimeContext.Provider value={settingsRuntime}>
              <SecureInputRuntimeContext.Provider value={secureInput ?? null}>
                <InteractiveRuntimeContext.Provider value={interactive ?? null}>
                  <SessionSignalsRuntimeContext.Provider value={signals ?? null}>
                    <Layout
                      route={route}
                      heading={heading}
                      {...(route.name === 'chat'
                        ? {
                            headingAction: {
                              onActivate: () => router.navigate(profileHref(route.bot)),
                              title: strings.app.botProfile.open({ name: heading })
                            }
                          }
                        : {})}
                      status={<ConnectionLine onSignIn={onSignIn} gated={gated} />}
                      sidebar={<ChatList selectedBot={bot} router={router} />}
                      footer={
                        <SidebarFooter
                          user={user}
                          {...(pictureUrl ? { pictureUrl } : {})}
                          onSignOut={onSignOut}
                          gated={gated}
                          current={route.name}
                          onShortcuts={showShortcuts}
                        />
                      }
                    >
                      {route.name === 'chat' ? (
                        <Suspense fallback={<div className="hm-main__body" aria-busy="true" />}>
                          <ChatScreen
                            key={formatRoute(route)}
                            bot={route.bot}
                            router={router}
                            {...(route.session ? { session: route.session } : {})}
                          />
                        </Suspense>
                      ) : route.name === 'profile' ? (
                        <Suspense fallback={<div className="hm-main__body" aria-busy="true" />}>
                          <ProfilePage key={formatRoute(route)} bot={route.bot} />
                        </Suspense>
                      ) : route.name === 'conversations' ? (
                        <Suspense fallback={<div className="hm-main__body" aria-busy="true" />}>
                          <ConversationsPage key={formatRoute(route)} bot={route.bot} router={router} />
                        </Suspense>
                      ) : route.name === 'settings' ? (
                        <Suspense fallback={<div className="hm-main__body" aria-busy="true" />}>
                          <SettingsHost
                            {...(route.section === undefined ? {} : { section: route.section })}
                            router={router}
                          />
                        </Suspense>
                      ) : route.name === 'crons' ? (
                        <Suspense fallback={<div className="hm-main__body" aria-busy="true" />}>
                          <CronsPage route={route} router={router} />
                        </Suspense>
                      ) : route.name === 'activity' ? (
                        <Suspense fallback={<div className="hm-main__body" aria-busy="true" />}>
                          <ActivityPage />
                        </Suspense>
                      ) : route.name === 'new-bot' ? (
                        <Suspense fallback={<div className="hm-main__body" aria-busy="true" />}>
                          <NewBotPage router={router} />
                        </Suspense>
                      ) : (
                        <p className="hm-main__body">{strings.app.chat.pickBot}</p>
                      )}
                    </Layout>
                    {/* Over the whole page, whichever route: a bot's question is never behind a screen. */}
                    <RequestLayer />
                    {shortcuts ? (
                      <Suspense fallback={null}>
                        <ShortcutsDialog opener={shortcuts.opener} onClose={() => setShortcuts(null)} />
                      </Suspense>
                    ) : null}
                  </SessionSignalsRuntimeContext.Provider>
                </InteractiveRuntimeContext.Provider>
              </SecureInputRuntimeContext.Provider>
            </SettingsRuntimeContext.Provider>
          </CronRuntimeContext.Provider>
        </McpRuntimeContext.Provider>
      </PasskeyRuntimeContext.Provider>
    </ChatRuntimeContext.Provider>
  )
}
