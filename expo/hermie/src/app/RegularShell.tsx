import { useCallback, useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import type { DevInitialView } from '../dev'
import { ActivityScreen } from '../features/activity'
import { BotsScreen, requestRevealFolder, type BotsSection } from '../features/bots'
import { ChatScreen, type OpenChatOptions } from '../features/chats'
import { ConversationsScreen, ConversationViewScreen } from '../features/sessions'
import { CronScreen } from '../features/cron'
import { BoardsHost, KanbanScreen } from '../features/kanban'
import { SettingsScreen } from '../features/settings'
import { requestIntentRun } from '../features/intents'
import { requestShareDelivery } from '../features/share'
import { chatStrings } from '../chat-ui/strings'
import { strings } from '../i18n/strings'
import { useChatLinkOpener } from './chat-link'
import { useHermieLink } from '../platform/deep-link'
import { usePageTitle } from '../platform/page-title'
import { onOpenChatRequest } from './open-chat-bus'
import { useSafeAreaInsets } from '../platform/safe-area'
import { useBotDisplayName } from '../store/bots'
import { useChatLayoutStore } from '../store/chat-layout'
import { GlassDepthProvider, GlassSurface, Wallpaper } from '../ui/glass'
import { RoundIconButton } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { useEscapeKey } from '../ui/useEscapeKey'
import { useHardwareBack } from '../ui/useHardwareBack'
import { useShortcut } from '../ui/useShortcut'
import { CONTROL_SIZE, SIDEBAR_RAIL_WIDTH } from '../ui/tokens'
import { OverlayPanel, type PanelFrame } from './OverlayPanel'
import { PanelScrim } from './PanelScrim'
import { SidebarOverlay } from './SidebarOverlay'
import { useSidebarState, useSidebarWidth } from './useLayoutMode'

/**
 * The close (X) a destination draws when it has nowhere to go BACK to.
 *
 * Activity and Crons keep their overlay's old close — a round glass button —
 * but it is drawn by the PAGE now, as `PageChrome`'s `trailing`, rather than by
 * a title row `OverlayPanel` no longer has. Settings draws the same button at
 * its own root, in the content column, for the same reason: a root has nothing
 * under it to return to, so a close reads truer than a back that goes nowhere.
 */
function DestinationClose({ onPress, testID }: { onPress: () => void; testID: string }) {
  return (
    <RoundIconButton
      icon="close"
      label={strings.layout.close}
      onPress={onPress}
      opaque
      size={CONTROL_SIZE.regular}
      testID={testID}
    />
  )
}

/**
 * A sidebar and a chat column, edge to edge, for a wide window — an iPad, or a
 * Mac.
 *
 * ## It used to be two floating panels and the owner rejected them
 *
 * There was a 14pt wallpaper gutter around everything and between the columns,
 * and both columns were rounded glass panels floating in it. He sent a screenshot
 * of the Mac window and said he does not like the space around everything; the
 * reference he set instead is Messages on the Mac, and iPadOS 26 Messages in dark
 * mode for the detail. So: the sidebar is flush to the window's leading edge and
 * runs the full height, the chat column is flush to the other three, there is ONE
 * hairline between them, and there is no outer gutter and no rounding anywhere.
 *
 * The wallpaper is the chat column and nothing else. The sidebar is a glass pane
 * over the app's own floor, which is what makes the divider the only thing
 * separating them — the reference has no second colour showing round the outside
 * either.
 *
 * The compact shell is untouched: at 393pt there was never a gutter to remove.
 *
 * Deliberately no navigator: both panels are always mounted, so a stack would
 * only get in the way. The chat list IS the sidebar; Activity, Crons and
 * Settings slide in over the chat column from the right (`OverlayPanel`) rather
 * than replacing it, so the list stays where the reader left it.
 *
 * A window narrower than two panels never reaches this component: `useLayoutMode`
 * hands that case to the compact stack instead.
 *
 * **One inset source, and it moved INSIDE the columns.** While the panels floated
 * there was a row around them to put the safe area on, and the rule was that the
 * row owned it and neither panel added any — a Mac reported the bug that rule
 * exists for, an empty strip above the list and not above the chat. Edge to edge
 * there is no row to inset: the glass has to reach the window's edges and under
 * the title bar, and only its CONTENT may be pushed clear. So each column applies
 * the same `insets` object to its own content box, from one hook call, and the
 * property that mattered is unchanged — the two cannot disagree about a number
 * neither of them computes.
 *
 * ## The sidebar can be hidden, and what that means depends on the width
 *
 * Hiding it leaves the rail (`SidebarRail`) and gives the chat column everything
 * else, which is the lever the 2026-09-20 portrait pass asked for: at 834pt the
 * bubble cap lands around 335pt, about 38 characters, and there was nothing left
 * to take from except the list. Three rules, and the last one is the owner's:
 *
 *  - **Below 900pt the list comes BACK as an overlay** (`SidebarOverlay`), over
 *    the chat, and goes away again as soon as a chat is picked. Re-expanding in
 *    place there would squeeze the chat column, which is the thing the collapse
 *    was for. At 900 and above there is room for both, so Show simply shows.
 *  - **The default follows the width, the choice follows the owner.** With no
 *    explicit Hide or Show on record the window decides; once there is one it wins
 *    at every width, and it is stored per gateway with the rest of the arrangement
 *    (ADR-0012). `resolveSidebarCollapsed` is the whole rule.
 *  - **Nothing flips itself while the reader sits still.** That falls out of the
 *    rule above being a comparison against one number rather than a state machine:
 *    one window width cannot produce two answers.
 *
 * Three ways in, one function: the header's round button, ⌘⇧S / ⌃⇧S, and the Mac
 * menu bar's Hide/Show Sidebar — the last two arrive as the same `toggleSidebar`
 * action (`platform/desktop-shortcuts`), so there is nothing to keep in step.
 */
/** What each panel is called, for the browser tab. Read per render: see below. */
/*
 * Built on CALL rather than at import.
 *
 * A module-level literal would freeze whatever language was active when the
 * bundle loaded, which on a cold start is always English — see
 * `i18n/catalogue.ts`. The list is three entries and it is rebuilt per render;
 * the alternative is a screen that keeps its old language until it is remounted.
 */
const sectionTitles = (): Record<BotsSection, string> => ({
  activity: strings.tabs.activity,
  cron: strings.tabs.routines,
  settings: strings.tabs.settings
})

export function RegularShell({ initial }: { initial?: DevInitialView } = {}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const sidebar = useSidebarWidth()
  const { collapsed, overlays } = useSidebarState()
  const setSidebarCollapsed = useChatLayoutStore(state => state.setSidebarCollapsed)
  const [section, setSection] = useState<BotsSection | null>(initial?.section ?? null)
  const [selectedBot, setSelectedBot] = useState<string | undefined>(initial?.bot)
  const [focusItemId, setFocusItemId] = useState<string | undefined>(undefined)
  /** Words a search hit asked this chat to land on; see `OpenChatOptions.findText`. */
  const [findText, setFindText] = useState<string | undefined>(undefined)
  /**
   * The conversations detour, in the CONTENT column.
   *
   * Not a panel like Crons and Settings: those are about the whole app and dim
   * the chat behind them, and this is about the chat itself — a reader looking
   * at a branch of `researcher` is still looking at `researcher`. So it takes
   * the content column the same way the chat does and hands it back, which also
   * means the list beside it never moves.
   */
  const [conversations, setConversations] = useState<{ bot: string; id?: string } | null>(null)
  /**
   * Boards, in the CONTENT column, and which door it was opened from.
   *
   * R18 measured the board's problem: `WIDE_BOARD_PX` is 700 and every door in
   * the app rendered the board in place — inside the 520pt settings overlay, or
   * inside the 300–340pt sidebar — so the side-by-side layout and the card drag
   * built for it were correct code the app could not reach. The content column
   * is the one box on this layout that is reliably wider than 700, and it is
   * where a chat and the Conversations detour already live.
   *
   * `from` is what the reader came through, because the way out has to be one
   * level and not two: a board opened from Settings puts Settings back when it
   * closes, which is what the phone's native stack does with the same two
   * screens. `null` means the chat list, and the chat column is what returns.
   */
  const [boards, setBoards] = useState<{ from: BotsSection | null } | null>(null)
  const [cronJobId, setCronJobId] = useState<string | undefined>(undefined)
  /** Set by the chats list's `+`: open the crons screen on a new job. */
  const [cronCreate, setCronCreate] = useState(false)
  // Showing the list temporarily is a thing this WINDOW is doing, not a thing the
  // owner has decided about their list, so it never reaches the store.
  const [listOverlay, setListOverlay] = useState(false)
  // The content panel's own box, for the overlay that has to be exactly it.
  const [contentFrame, setContentFrame] = useState<PanelFrame | undefined>(undefined)
  // Activity and Crons still slide in over the chat column — things you
  // consult without leaving your place. Settings does not: it takes the
  // CONTENT column, the way Boards does (HERM-102, HERM-108), so it is not one
  // of the destinations this dims the sidebar or mounts `OverlayPanel` for.
  const overlayOpen = section === 'activity' || section === 'cron'
  const settingsOpen = section === 'settings'

  /*
   * The browser tab's name. This shell has no navigator, so nothing used to
   * move it off the exported document's `Hermie` — and because the two shells
   * swap on window width, a narrow window that was widened kept whichever route
   * KEY the navigator had left behind.
   *
   * An open panel wins over the chat behind it, because the panel is what the
   * reader is looking at. With neither, the tab names the list.
   */
  const selectedBotLabel = useBotDisplayName(selectedBot)

  usePageTitle(section ? sectionTitles()[section] : (selectedBotLabel ?? strings.tabs.chats))

  const openBot = useCallback((name: string, options?: OpenChatOptions) => {
    setSelectedBot(name)
    // Picking a chat is leaving the detour, whichever way it is picked — and a
    // board is a detour in the same column, so it goes the same way.
    setConversations(null)
    setBoards(null)
    // A new focus target every time, even for the same item: the chat screen
    // only scrolls when the id it is handed changes, and following the same DM
    // twice should work twice.
    setFocusItemId(options?.focusItemId)
    setFindText(options?.findText)
    setSection(null)
    // Picking a chat was the errand the temporary list was opened for.
    setListOverlay(false)
  }, [])

  // `hermie://chat/<bot>`, from a home-screen widget. The same hook the compact
  // shell uses, landing on the same `openBot` a tap on a row lands on — so a
  // link cannot reach a state a finger could not.
  //
  /**
   * A widget pinned to a folder: show the list, with that folder open.
   *
   * The sidebar is always mounted here, so there is nothing to navigate to —
   * only the panel over it to close, if one is open, since a folder somebody
   * just tapped is not worth showing behind Settings.
   */
  const openFolder = useCallback((folderId: string) => {
    useChatLayoutStore.getState().setFolderOpen(folderId, true)
    requestRevealFolder(folderId)
    setSection(null)
  }, [])

  // A chat link may name a gateway other than the live one, so it goes through
  // the shared opener rather than straight to `openBot` — see `chat-link.ts`.
  const openChatLink = useChatLinkOpener(openBot)

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

  /**
   * One of a bot's OTHER conversations: the chat column selects the bot and
   * then shows that conversation over it.
   *
   * `openBot` first, deliberately. It clears the detour, the section panel and
   * the temporary list — everything a tap from a lock screen should arrive
   * without — and then the conversation is put back on, so the Back inside it
   * lands on the bot's own list of conversations rather than on whatever was
   * open before the phone buzzed.
   */
  const openConversation = useCallback(
    (name: string, storedId: string) => {
      openBot(name)
      setConversations({ bot: name, id: storedId })
    },
    [openBot]
  )

  // And the same from a notification, through the bus, for the reason
  // `app/open-chat-bus.ts` gives.
  useEffect(
    () => onOpenChatRequest((bot, sessionId) => (sessionId ? openConversation(bot, sessionId) : openBot(bot))),
    [openBot, openConversation]
  )

  // A cron card in the transcript opens the crons panel ON that cron. Opening
  // the panel any other way clears the target, so the next visit lands on the
  // list rather than on whichever cron somebody followed a card to last week.
  const openCron = useCallback((jobId: string) => {
    setCronJobId(jobId)
    setCronCreate(false)
    setSection('cron')
  }, [])

  /**
   * A door to Boards, from either the chat list's (…) or Settings' own row.
   *
   * Whatever panel the door was in is closed on the way in, because the point
   * of the move is that the board gets the whole column — leaving Settings up
   * would put the 520pt overlay straight back over it. The section is
   * remembered rather than forgotten so that closing the board is one step
   * back rather than two.
   */
  const openBoards = useCallback(() => {
    setBoards({ from: section })
    setSection(null)
    setListOverlay(false)
  }, [section])

  const closeBoards = useCallback(() => {
    setSection(boards?.from ?? null)
    setBoards(null)
  }, [boards])

  const openSection = useCallback((next: BotsSection, options?: { create?: boolean }) => {
    setCronJobId(undefined)
    setCronCreate(options?.create === true)
    setSection(next)
    setListOverlay(false)
  }, [])

  /**
   * One toggle for all three ways in.
   *
   * The order of the branches is the behaviour. A temporary list closes first,
   * because that is the level the reader is looking at; then a collapsed sidebar on
   * a narrow window opens as an overlay rather than pushing the chat aside; then
   * anything else is the plain in-place Hide or Show, which is what gets stored.
   */
  const toggleSidebar = useCallback(() => {
    if (listOverlay) {
      setListOverlay(false)

      return
    }

    if (collapsed && overlays) {
      setListOverlay(true)

      return
    }

    setSidebarCollapsed(!collapsed)
  }, [collapsed, listOverlay, overlays, setSidebarCollapsed])

  /** Asked for from the rail, which only ever means "show it", never "hide it". */
  const showList = useCallback(() => {
    if (overlays) {
      setListOverlay(true)

      return
    }

    setSidebarCollapsed(false)
  }, [overlays, setSidebarCollapsed])

  // ⌘, opens Settings, on a Mac from the keyboard and from the menu bar. ⌘W and
  // Escape close it again, through the stacks registered just below.
  useShortcut('settings', () => openSection('settings'))
  // ⌘⇧S / ⌃⇧S, and the Mac menu bar's Hide/Show Sidebar, which arrives as the same
  // action. Registered on the shell rather than on the sidebar because the sidebar
  // is the thing that goes away — a shortcut that unregisters when its target is
  // hidden is a shortcut that can only ever hide.
  useShortcut('toggleSidebar', toggleSidebar)

  /*
   * Settings' own Escape and Android back, closing it entirely.
   *
   * `OverlayPanel` used to register these for every destination, including
   * Settings; now that Settings lives in the content column like Boards
   * rather than under `OverlayPanel`, it has to register its own — and it
   * draws a close (X) rather than a `back`, so `PageChrome`'s own Escape
   * handling (which only fires for a `back`) never picks it up either.
   *
   * Registered HERE, on the shell, rather than inside `SettingsHost`, is what
   * gives "one level at a time" for free: this mounts the moment the section
   * opens, before any page inside it does, so a deeper page's own `PageChrome`
   * back always registers LATER and therefore answers first (see
   * `useEscapeKey`/`useHardwareBack` — last registered, first delivered).
   * Popping back to the root leaves this as the only handler again, so the
   * NEXT Escape is the one that closes Settings.
   */
  useEscapeKey(() => setSection(null), settingsOpen)
  useHardwareBack(() => setSection(null), settingsOpen)

  /** The list, in whichever of its two containers is on screen. */
  const list = (
    <BotsScreen
      currentTab={section ?? 'chats'}
      onOpenBot={(bot, options) => openBot(bot.name, options)}
      onOpenConversations={bot => setConversations({ bot })}
      onOpenSection={openSection}
      selectedBot={section === null ? selectedBot : undefined}
      variant="sidebar"
    />
  )

  return (
    /*
      Both doors to Boards are inside this tree — the (…) in the sidebar and the
      row in Settings' overlay — and both ask the host rather than rendering a
      board in whichever narrow box they happen to occupy. The compact shell
      provides no host, which is how a phone keeps the stacked page it had.
    */
    <BoardsHost open={openBoards}>
      <View
        style={{
          backgroundColor: theme.elevation.e0,
          flex: 1,
          flexDirection: 'row'
        }}
        testID="shell-window"
      >
        {/*
        The rail and the sidebar are the same pane at two widths, and the same
        `BotsScreen` in two variants — see `SidebarRail` for why the rail is a
        variant rather than a component of its own. Flush left, full height, no
        rounding and no border of its own: the divider below is the only edge it
        has, which is what the reference draws.
      */}
        <GlassSurface
          contentStyle={{
            borderWidth: 0,
            flex: 1,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left,
            paddingTop: insets.top
          }}
          contentTestID="shell-sidebar-content"
          radius={0}
          shadow="none"
          style={{ width: collapsed ? SIDEBAR_RAIL_WIDTH : sidebar }}
          testID="shell-sidebar"
          variant="panel"
        >
          {collapsed ? (
            /*
            `onOpenBot` and `selectedBot` are handed to the rail as well, and they
            are not decoration: ⌘1…9 and ⌘↑/↓ are registered by this component in
            either variant, and without somewhere to send the chat they would fire
            into nothing. A shortcut that reports success and does nothing is the
            worst of the three possible behaviours.
          */
            <BotsScreen
              currentTab={section ?? 'chats'}
              onOpenBot={(bot, options) => openBot(bot.name, options)}
              onOpenConversations={bot => setConversations({ bot })}
              onOpenSection={openSection}
              onShowList={showList}
              selectedBot={section === null ? selectedBot : undefined}
              variant="rail"
            />
          ) : (
            list
          )}

          {/*
          The sidebar is dimmed too, and not interactive while an overlay is up.

          It used to be deliberately outside the scrim — "a different chat is one
          tap away while Settings is open" — and the owner's answer to that was
          that a bright, clickable list beside a dimmed chat makes the dim mean
          nothing at all. Consulting Settings is one errand; the list is where you
          go when it is finished, which is one Escape away.
        */}
          <PanelScrim onPress={() => setSection(null)} open={overlayOpen} radius={0} testID="overlay-scrim-sidebar" />
        </GlassSurface>

        {/*
        The whole boundary between the two columns: one hairline, at the device's
        own smallest drawable width. Not a border on either pane — a border
        belongs to a shape, and neither of these is a shape any more.
      */}
        <View style={{ backgroundColor: theme.hairline, width: StyleSheet.hairlineWidth }} testID="shell-divider" />

        <View style={{ flex: 1, minWidth: 0 }} testID="shell-content">
          {/*
          The chat column IS the wallpaper. Everything inside it reads a glass
          depth of 1, exactly as it did while this was a floating panel: without
          that the header and composer drop to a level-3 tint and `Screen` paints
          the wallpaper's own rung over the wallpaper.
        */}
          <Wallpaper
            /*
            Measured for the overlay, which has to be this column's frame and not
            an arithmetic guess at it from the window's insets. See `OverlayPanel`
            — the guess was visibly wrong at the bottom of a Mac window.
          */
            onLayout={event => setContentFrame(event.nativeEvent.layout)}
            style={{ flex: 1 }}
            testID="wallpaper"
          >
            <GlassDepthProvider value={1}>
              {/*
              A dead session is not a chat problem and must not read as one, so
              it takes the whole column rather than sitting under a chat error.
              `ChatScreen` does that itself now, on both layouts, so there is no
              second copy of the rule here to disagree with it.
            */}
              {/*
              The chat column's sidebar control exists only while the list is
              SHOWING, and that is a decision rather than an oversight.

              Measured on an iPad Pro 11" in portrait: with a button in the header
              as well, a collapsed window drew two identical sidebar icons about
              90pt apart — the rail's and the header's — doing the same thing. One
              control at a time is the rule every app with a rail follows, and it
              also settles the label: the header's is always Hide, the rail's is
              always Show, and neither has to describe a state the other is in.
            */}
              <View
                style={{
                  flex: 1,
                  paddingBottom: insets.bottom,
                  paddingRight: insets.right,
                  paddingTop: insets.top
                }}
                testID="shell-content-panel"
              >
                {/*
                One of the four, and the chat is the default. Early returns
                rather than a navigator, which is the shape this shell already
                uses for its panels: both columns stay mounted, so a stack would
                have to be told twice what "back" means.
              */}
                {boards ? (
                  /*
                  Edge to edge in the column, which is 684pt on an 11" iPad in
                  landscape beside a collapsed rail and more than 1000 on a Mac
                  — past `WIDE_BOARD_PX` wherever the sidebar is not taking an
                  unusual share of a small window. Below it the board stacks, as
                  it always did, because the board asks its own `onLayout` and
                  not the window.
                */
                  <KanbanScreen backLabel={titleFor(boards.from) || strings.tabs.chats} onClose={closeBoards} />
                ) : settingsOpen ? (
                  /*
                  Settings takes the column exactly the way Boards does, and for
                  the same reason (HERM-102, HERM-108): a 520pt overlay cannot
                  hold a category list and a page side by side, and
                  `SETTINGS_SPLIT_MIN_WIDTH` (640) is wider than the overlay ever
                  was, so the split layout was unreachable until this moved.
                  `SettingsScreen` is `SettingsHost`; it measures its own width
                  and decides split vs stacked from that, not from anything this
                  shell knows.
                */
                  <SettingsScreen
                    rootTrailing={<DestinationClose onPress={() => setSection(null)} testID="settings-close" />}
                    {...(initial?.page ? { initialRoute: initial.page } : {})}
                  />
                ) : conversations?.id ? (
                  <ConversationViewScreen
                    back={{
                      label: chatStrings.sessions.conversations,
                      onPress: () => setConversations({ bot: conversations.bot })
                    }}
                    botName={conversations.bot}
                    onOpenChat={openBot}
                    storedId={conversations.id}
                  />
                ) : conversations ? (
                  <ConversationsScreen
                    botName={conversations.bot}
                    onBack={() => setConversations(null)}
                    onOpenConversation={(bot, id) => setConversations({ bot, id })}
                  />
                ) : (
                  <ChatScreen
                    bot={selectedBot}
                    findText={findText}
                    focusItemId={focusItemId}
                    onOpenBot={openBot}
                    onOpenConversation={(bot, id) => setConversations({ bot, id })}
                    onOpenConversations={bot => setConversations({ bot })}
                    onOpenCron={openCron}
                    onToggleSidebar={collapsed ? undefined : toggleSidebar}
                  />
                )}
              </View>

              {/*
              The chat's own dim, the last child of the chat column so it covers
              the header too. Tapping it closes one level, which is the answer
              Escape gives — `overlay-scrim` keeps its name because it is still the
              scrim a reader taps to dismiss the panel.
            */}
              <PanelScrim onPress={() => setSection(null)} open={overlayOpen} radius={0} testID="overlay-scrim" />
            </GlassDepthProvider>
          </Wallpaper>

          <OverlayPanel
            {...(contentFrame ? { frame: contentFrame } : {})}
            onClose={() => setSection(null)}
            visible={overlayOpen}
          >
            {section === 'activity' ? (
              <ActivityScreen
                onOpenBot={openBot}
                trailing={<DestinationClose onPress={() => setSection(null)} testID="overlay-close" />}
              />
            ) : null}
            {section === 'cron' ? (
              <CronScreen
                {...(cronJobId ? { initialJobId: cronJobId } : {})}
                {...(cronCreate ? { initialCreate: true } : {})}
                // Remounted per intent, so opening `+` twice opens the editor
                // twice: the screen decides on its first render whether the
                // editor is up, and a live screen would ignore the second press.
                key={cronCreate ? 'cron-create' : 'cron'}
                trailing={<DestinationClose onPress={() => setSection(null)} testID="overlay-close" />}
              />
            ) : null}
          </OverlayPanel>
        </View>

        {/*
        Over BOTH columns rather than inside the content one, because it stands in
        for the sidebar and therefore starts at the window's own leading edge. It
        is the last child so that Escape reaches it before the destination panel
        when both are up — the stack delivers to whatever registered last.
      */}
        <SidebarOverlay onClose={() => setListOverlay(false)} visible={listOverlay} width={sidebar}>
          {listOverlay ? list : null}
        </SidebarOverlay>
      </View>
    </BoardsHost>
  )
}

function titleFor(section: BotsSection | null): string {
  switch (section) {
    case 'activity':
      return strings.activity.title
    case 'cron':
      return strings.tabs.routines
    case 'settings':
      return strings.settings.title
    default:
      return ''
  }
}
