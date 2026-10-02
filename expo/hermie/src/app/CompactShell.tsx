import {
  DefaultTheme,
  getFocusedRouteNameFromRoute,
  NavigationContainer,
  useNavigation,
  useNavigationContainerRef,
  type NavigationProp,
  type NavigationState,
  type NavigatorScreenParams,
  type Theme as NavTheme
} from '@react-navigation/native'
import { createNativeStackNavigator, type NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { DevInitialView } from '../dev'
import { ActivityScreen } from '../features/activity'
import { BotsScreenOrSignedOut, requestRevealFolder, tabs } from '../features/bots'
import { ChatScreen } from '../features/chats'
import { CronScreen } from '../features/cron'
import { ConversationsScreen, ConversationViewScreen } from '../features/sessions'
import { SettingsScreen } from '../features/settings'
import { requestIntentRun } from '../features/intents'
import { requestShareDelivery } from '../features/share'
import { chatStrings } from '../chat-ui/strings'
import { strings } from '../i18n/strings'
import { useChatLinkOpener } from './chat-link'
import { useHermieLink } from '../platform/deep-link'
import { usePageTitle } from '../platform/page-title'
import { onOpenChatRequest } from './open-chat-bus'
import { useBotDisplayName } from '../store/bots'
import { useChatLayoutStore } from '../store/chat-layout'
import { createTabNavigator, TabBar, useRouteBelow, type PageChromeBack } from '../ui/chrome'
import { GlassSurface, Wallpaper } from '../ui/glass'
import { useTheme } from '../ui/theme'
import { useShortcut } from '../ui/useShortcut'

/**
 * The four tabs. Their names are the ROUTE names — what a dev intent, a test and
 * `getFocusedRouteNameFromRoute` all speak — and `TAB_KEYS` maps each onto the
 * key `tabs()` already labels it by, so the bar's four strings stay in one place.
 */
export type CompactTabParamList = {
  Chats: undefined
  Activity: undefined
  Crons: undefined
  Settings: undefined
}

export type CompactTabName = keyof CompactTabParamList

export type CompactStackParamList = {
  /** The four tab roots. Everything below is pushed OVER them, tab bar and all. */
  Tabs: NavigatorScreenParams<CompactTabParamList> | undefined
  Chat: { bot: string; focusItemId?: string; findText?: string }
  /** A bot's other conversations: branches and the ones `/new` put away. */
  Conversations: { bot: string }
  /** One of them, read-only. `id` is the STORED id a listing hands out. */
  Conversation: { bot: string; id: string }
  /**
   * ONE cron, pushed from a cron card in a transcript.
   *
   * A route of its own rather than the Crons tab with a parameter, because the
   * two are different journeys: the tab is the list and its detail is a page
   * inside it, while this one sits over the CHAT the card was in and goes back
   * there. Sending the card to the tab would have moved the reader to another
   * tab and left Back pointing at a list they never opened.
   */
  CronDetail: { bot: string; jobId: string }
}

const Stack = createNativeStackNavigator<CompactStackParamList>()
const Tab = createTabNavigator<CompactTabParamList>()

/**
 * What a TAB screen navigates with.
 *
 * Both lists in one type, because a tab screen reaches both: `Settings` is a
 * sibling the tab navigator handles itself, and `Chat` is not a tab at all, so
 * the action bubbles to the stack above. React Navigation does that bubbling;
 * this only says that both names are legitimate from here.
 */
type CompactNav = NavigationProp<CompactStackParamList & CompactTabParamList>

/** Route name → the key `features/bots`'s `tabs()` labels that destination by. */
const TAB_KEYS: Record<CompactTabName, string> = {
  Chats: 'chats',
  Activity: 'activity',
  Crons: 'cron',
  Settings: 'settings'
}

const TAB_NAMES = Object.keys(TAB_KEYS) as CompactTabName[]

/** A dev launch argument's section, as a tab. */
const SECTION_TABS: Record<string, CompactTabName> = {
  activity: 'Activity',
  cron: 'Crons',
  settings: 'Settings'
}

/**
 * What a route is CALLED, as opposed to what it is keyed by.
 *
 * `Chats` is the key of the tab whose header says Chats, and a browser tab that
 * says `Bots` is the source leaking into the window.
 *
 * The chat route answers with a `bot` rather than a title, because the handle in
 * its params (`researcher`) is not the label a person reads (`Researcher`) and
 * resolving one to the other needs the store — which a plain function has no
 * business reaching into. The caller does that.
 */
function titleOfTab(name: string | undefined): string {
  switch (name) {
    case 'Activity':
      return strings.tabs.activity
    case 'Crons':
      return strings.tabs.routines
    case 'Settings':
      return strings.tabs.settings
    default:
      return strings.tabs.chats
  }
}

/**
 * The name of the screen actually on top, from the WHOLE tree.
 *
 * Not `getCurrentRoute()`: that one descends all the way into the Settings
 * stack and would name the window after `Appearance`. The root's own top route
 * is what the window is, and when that route is the tabs it is the focused TAB —
 * which is exactly what `getFocusedRouteNameFromRoute` answers, one level down
 * and no further.
 */
function screenNameOf(state: NavigationState | undefined): { title?: string; bot?: string } {
  const route = state ? state.routes[state.index] : undefined

  if (!route) {
    return {}
  }

  switch (route.name) {
    case 'Tabs':
      return { title: titleOfTab(getFocusedRouteNameFromRoute(route)) }
    case 'Chat': {
      const bot = (route.params as CompactStackParamList['Chat'] | undefined)?.bot

      return bot ? { bot } : { title: strings.tabs.chats }
    }
    case 'CronDetail':
      return { title: strings.tabs.routines }
    case 'Conversations':
    case 'Conversation':
      return { title: chatStrings.sessions.conversations }
    default:
      return {}
  }
}

/**
 * The back control of a page PUSHED over the tabs, labelled with the page it
 * actually returns to.
 *
 * `useStackBack` cannot do this one: it labels a route from a registry of route
 * NAMES, and the page under a branch or a cron detail is usually a chat, whose
 * name is a bot's display name rather than the word "Chat". So the route below
 * is read the same way (`useRouteBelow`) and named here, where the store is in
 * reach. Nothing under it at all — a launch argument that opened straight onto
 * this page — means no back control rather than a dead one.
 */
function usePushedBack(): PageChromeBack | undefined {
  const navigation = useNavigation()
  const below = useRouteBelow()
  const botBelow = below?.name === 'Chat' ? (below.params as CompactStackParamList['Chat'] | undefined)?.bot : undefined
  const botLabel = useBotDisplayName(botBelow)

  return useMemo(() => {
    if (!below) {
      return undefined
    }

    const label = botBelow
      ? botLabel || botBelow
      : below.name === 'Conversations'
        ? chatStrings.sessions.conversations
        : // The tabs: named by the tab that is actually showing under this page.
          titleOfTab(getFocusedRouteNameFromRoute(below))

    return { label, onPress: () => navigation.goBack() }
  }, [below, botBelow, botLabel, navigation])
}

function ChatsTab() {
  const navigation = useNavigation<CompactNav>()

  // ⌘, from a hardware keyboard, which an iPad in a case has as readily as a
  // Mac. Registered on the chat list rather than on the navigator because this
  // is the tab that is always mounted, so the shortcut cannot be shadowed by a
  // screen that happens to be on top of it. `Settings` is a sibling tab now,
  // so this SWITCHES tabs rather than pushing a page over the list.
  useShortcut('settings', () => navigation.navigate('Settings'))

  /*
    Full-bleed rather than floating: at 393pt there is no room to spend 14pt on
    each side proving the panel floats, and the mockup's phone frame draws the
    same panel with its corners squared off.

    No `onOpenSection`: the four destinations are the TABS now, so the list
    stops drawing a strip of its own (HERM-105). `navigate` reaches the root
    stack by bubbling — `Chat` is not a tab, so the tab navigator passes the
    action to its parent.
  */
  return (
    <GlassSurface contentStyle={{ flex: 1 }} radius={0} shadow="none" style={{ flex: 1 }} variant="panel">
      <BotsScreenOrSignedOut
        onOpenBot={(bot, options) =>
          navigation.navigate('Chat', {
            bot: bot.name,
            ...(options?.findText ? { findText: options.findText } : {})
          })
        }
        onOpenConversations={bot => navigation.navigate('Conversations', { bot })}
      />
    </GlassSurface>
  )
}

function ActivityTab() {
  const navigation = useNavigation<CompactNav>()

  // No `back`: this is a tab root, and a tab root has nowhere to go back to.
  return (
    <ActivityScreen
      onOpenBot={(bot, options) =>
        navigation.navigate('Chat', { bot, ...(options?.focusItemId ? { focusItemId: options.focusItemId } : {}) })
      }
    />
  )
}

function CronsTab() {
  return <CronScreen />
}

function SettingsTab({ initialRoute }: { initialRoute?: DevInitialView['page'] }) {
  /*
    No `rootBack`. Settings is a tab ROOT: there is no page under it to return
    to, and the back this used to draw pointed at `goBack()` on a stack whose
    bottom it often was — a control that said Chats and did nothing (HERM-101).
    Nothing is registered for Escape or Android's back either, so a back press
    on this page reaches the navigator, finds one tab in the history, and lets
    the OS background the app instead of swallowing the press.
  */
  return <SettingsScreen {...(initialRoute ? { initialRoute } : {})} />
}

function CompactTabs({ initial }: { initial?: DevInitialView }) {
  const settings = useCallback(
    () => <SettingsTab {...(initial?.page ? { initialRoute: initial.page } : {})} />,
    [initial?.page]
  )

  return (
    <Tab.Navigator
      // A launch argument opens ON a tab rather than pushing one: a screenshot
      // wants the screen. `backBehavior: 'initialRoute'` is what then keeps
      // Android's back honest — see `ui/chrome/tab-navigator.tsx`.
      initialRouteName={initialTabFor(initial)}
      tabBar={({ current, onSelect }) => (
        <TabBar
          current={TAB_KEYS[current as CompactTabName] ?? 'chats'}
          items={tabs()}
          onSelect={key => {
            const name = TAB_NAMES.find(tab => TAB_KEYS[tab] === key)

            if (name) {
              onSelect(name)
            }
          }}
        />
      )}
    >
      <Tab.Screen component={ChatsTab} name="Chats" />
      <Tab.Screen component={ActivityTab} name="Activity" />
      <Tab.Screen component={CronsTab} name="Crons" />
      <Tab.Screen component={settings} name="Settings" />
    </Tab.Navigator>
  )
}

function ChatRoute({
  route,
  navigation
}: {
  route: { params?: { bot?: string; focusItemId?: string; findText?: string } }
  navigation: NativeStackNavigationProp<CompactStackParamList>
}) {
  return (
    <ChatScreen
      onBack={() => navigation.goBack()}
      // Pushed rather than replaced: following a DM across chats is a path, and
      // Back has to walk it in reverse.
      onOpenBot={(bot, options) =>
        navigation.push('Chat', { bot, ...(options?.focusItemId ? { focusItemId: options.focusItemId } : {}) })
      }
      // A cron card in the transcript pushes THIS cron's own page over the
      // chat, so Back belongs to the chat the card was in.
      onOpenCron={jobId => navigation.push('CronDetail', { bot: route.params?.bot ?? '', jobId })}
      // Both pushed, for the reason the DM path is: a branch is somewhere the
      // reader went FROM this chat, and Back has to walk it in reverse.
      onOpenConversation={(bot, id) => navigation.push('Conversation', { bot, id })}
      onOpenConversations={bot => navigation.push('Conversations', { bot })}
      route={route}
    />
  )
}

function ConversationsRoute({
  route,
  navigation
}: {
  route: { params?: { bot?: string } }
  navigation: NativeStackNavigationProp<CompactStackParamList>
}) {
  return (
    <ConversationsScreen
      botName={route.params?.bot ?? ''}
      onBack={() => navigation.goBack()}
      onOpenConversation={(bot, id) => navigation.push('Conversation', { bot, id })}
    />
  )
}

function ConversationRoute({
  route,
  navigation
}: {
  route: { params?: { bot?: string; id?: string } }
  navigation: NativeStackNavigationProp<CompactStackParamList>
}) {
  const back = usePushedBack()

  return (
    <ConversationViewScreen
      {...(back ? { back } : {})}
      botName={route.params?.bot ?? ''}
      onOpenChat={bot => navigation.navigate('Chat', { bot })}
      storedId={route.params?.id ?? ''}
    />
  )
}

function CronDetailRoute({ route }: { route: { params?: { jobId?: string } } }) {
  const back = usePushedBack()

  return (
    <CronScreen
      detailOnly
      {...(back ? { back } : {})}
      {...(route.params?.jobId ? { initialJobId: route.params.jobId } : {})}
    />
  )
}

/**
 * The phone shell: four tabs, and the pages pushed over them.
 *
 * Same visual language as the wide layout — the wallpaper is drawn once, behind
 * the whole navigator, and every screen is transparent over it, so a push does
 * not slide one background over another. The list is a full-bleed panel rather
 * than a floating one, which is what the mockup's phone frame shows.
 *
 * **No native headers, anywhere.** Every route draws its own `PageChrome`, and
 * the one back control it is entitled to comes with it. The platform header is
 * what put "‹ Bots" on Activity, Crons and Settings (HERM-75) and a second,
 * lying back control on the conversation pages (HERM-101); `headerShown: false`
 * on the navigator is what removes both, and a tab bar under every root is what
 * makes "no back on a root" a true statement rather than a missing way home
 * (HERM-105).
 *
 * **Chat is above the tabs, not in them**, so it has no tab bar — the transcript
 * takes the whole window, as it always has, and the composer sits on the home
 * indicator rather than above a strip of four icons.
 */
export function CompactShell({ initial }: { initial?: DevInitialView } = {}) {
  const theme = useTheme()
  const navigationRef = useNavigationContainerRef<CompactStackParamList>()

  /**
   * `hermie://chat/<bot>`, from a home-screen widget.
   *
   * Through the container ref rather than a `linking` config on the navigator,
   * and the reason is the wide layout: `RegularShell` has no navigator at all,
   * so a link that only worked through React Navigation's own linking would
   * work on a phone and silently do nothing on an iPad or a Mac. One parser and
   * one hook (`platform/deep-link`) is what the two shells share instead.
   *
   * `navigate` and not `push`: a widget names a chat, and tapping the same
   * widget twice should land on that chat rather than build a stack of it.
   *
   * A cold start is the case that needs the parking space. The link is read
   * during the first mount, and the container is not ready until after it — so a
   * link that arrives before `onReady` is held and replayed there rather than
   * dropped, which is exactly the launch a widget tap on a closed app produces.
   */
  const pendingBot = useRef<string | null>(null)

  const openChat = useCallback(
    (botName: string) => {
      if (navigationRef.isReady()) {
        navigationRef.navigate('Chat', { bot: botName })

        return
      }

      pendingBot.current = botName
    },
    [navigationRef]
  )

  /**
   * One of a bot's OTHER conversations, from a notification.
   *
   * `navigate` rather than `push`, and the chat is not put underneath it: the
   * reader was not in that chat, they were on a lock screen, so Back belongs to
   * wherever they actually were. A container that is not ready yet falls back
   * to the pending BOT rather than holding the conversation, because the
   * fallback's whole job is to land somewhere true and the chat always is one.
   */
  const openConversation = useCallback(
    (botName: string, storedId: string) => {
      if (navigationRef.isReady()) {
        navigationRef.navigate('Conversation', { bot: botName, id: storedId })

        return
      }

      pendingBot.current = botName
    },
    [navigationRef]
  )

  /**
   * A widget pinned to a folder: show the list, with that folder open.
   *
   * Two writes and neither is navigation. Opening the folder is a write to the
   * arrangement and works whether or not any list is mounted; the scroll is a
   * request the list picks up when it has rows to scroll to
   * (`features/bots/folder-reveal.ts`). The navigation is separate because on a
   * phone the list may be several screens down the stack — and, now that it is
   * a tab, may also be behind another tab, so the destination names both.
   */
  const openFolder = useCallback(
    (folderId: string) => {
      useChatLayoutStore.getState().setFolderOpen(folderId, true)
      requestRevealFolder(folderId)

      if (navigationRef.isReady()) {
        navigationRef.navigate('Tabs', { screen: 'Chats' })
      }
    },
    [navigationRef]
  )

  // A chat link may name a gateway other than the live one, so it goes through
  // the shared opener rather than straight to `openChat` — see `chat-link.ts`.
  const openChatLink = useChatLinkOpener(openChat)

  // Neither the share nor the Shortcut link carries a destination of its own:
  // each has already written its request into the shared container, and the id
  // in the URL is only there so that the tap arrives as a pump rather than as a
  // foreground three seconds later. Both readers work from the directory.
  useHermieLink(link => {
    if (link.kind === 'chat') {
      openChatLink(link.bot, link.gatewayKey)
    } else if (link.kind === 'share') {
      requestShareDelivery()
    } else if (link.kind === 'intent') {
      requestIntentRun()
    } else {
      openFolder(link.id)
    }
  })

  // The same destination from a notification. `PushSync` sits beside the chat
  // controller and cannot know which shell is mounted, so it asks through the
  // bus rather than navigating — see `app/open-chat-bus.ts`.
  useEffect(
    () => onOpenChatRequest((bot, sessionId) => (sessionId ? openConversation(bot, sessionId) : openChat(bot))),
    [openChat, openConversation]
  )

  // The browser tab's name follows the route that is actually on top. Held as
  // state rather than read during render because the container only answers
  // once it is ready, which is after the first mount.
  const [screen, setScreen] = useState<{ title?: string; bot?: string }>({})
  const botLabel = useBotDisplayName(screen.bot)

  usePageTitle(screen.bot ? botLabel : screen.title)

  // A navigator paints its own background over everything, including the
  // wallpaper, unless both the container theme and the screen say otherwise.
  const navTheme = useMemo<NavTheme>(
    () => ({
      ...DefaultTheme,
      dark: theme.scheme === 'dark',
      colors: {
        ...DefaultTheme.colors,
        background: 'transparent',
        border: theme.hairline,
        card: theme.elevation.e1,
        primary: theme.colors.accentText,
        text: theme.colors.text
      }
    }),
    [theme]
  )

  const tabsScreen = useCallback(() => <CompactTabs {...(initial ? { initial } : {})} />, [initial])

  // The navigation container lives with the stack rather than at the root,
  // because the regular shell has no navigator at all.
  return (
    <Wallpaper style={{ flex: 1 }} testID="wallpaper">
      <NavigationContainer
        /*
         * The navigator's own web titling is switched OFF. It runs whether or
         * not it was asked to and defaults to the route KEY, which is how a tab
         * came to say `Bots` for the screen headed Chats; `usePageTitle` above
         * is the one answer instead, and it works in the shell that has no
         * navigator too.
         */
        documentTitle={{ enabled: false }}
        onReady={() => {
          setScreen(screenNameOf(navigationRef.getRootState()))

          const botName = pendingBot.current
          pendingBot.current = null

          if (botName) {
            navigationRef.navigate('Chat', { bot: botName })
          }
        }}
        onStateChange={state => setScreen(screenNameOf(state))}
        ref={navigationRef}
        theme={navTheme}
      >
        <Stack.Navigator
          // A launch argument that names a BOT puts the chat in the stack
          // rather than pushing it onto the tabs; one that names a section
          // opens that tab instead — see `CompactTabs`.
          initialRouteName={initial?.bot ? 'Chat' : 'Tabs'}
          screenOptions={{
            contentStyle: { backgroundColor: 'transparent' },
            /*
              The whole of HERM-75 and half of HERM-101, in one line. Every
              route below draws its own chrome, so a platform header would be a
              second title bar and a second back control — one of which pointed
              at the route key `Bots` rather than at the page it would land on.
            */
            headerShown: false
          }}
        >
          <Stack.Screen component={tabsScreen} name="Tabs" />
          <Stack.Screen
            component={ChatRoute}
            initialParams={initial?.bot ? { bot: initial.bot } : undefined}
            name="Chat"
          />
          {/*
            Both PUSHED rather than replacing the chat, so Back walks the way
            the reader came: chat → its conversations → one of them. A branch
            opened from the chat's own notice skips the middle step, and Back
            still lands where they were — which is why the label is derived from
            the route underneath rather than typed.
          */}
          <Stack.Screen component={ConversationsRoute} name="Conversations" />
          <Stack.Screen component={ConversationRoute} name="Conversation" />
          <Stack.Screen component={CronDetailRoute} name="CronDetail" />
        </Stack.Navigator>
      </NavigationContainer>
    </Wallpaper>
  )
}

function initialTabFor(initial: DevInitialView | undefined): CompactTabName {
  return (initial?.section && SECTION_TABS[initial.section]) || 'Chats'
}
