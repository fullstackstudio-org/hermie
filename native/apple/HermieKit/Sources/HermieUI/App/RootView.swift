import HermieCore
import SwiftUI

/**
 The main window's content behind the lock gate (D13): a `NavigationSplitView` with the chat list
 and the gateway switcher in the sidebar and the chat in the detail column. It collapses to a stack
 on iPhone. With no gateway configured it is the welcome screen, which opens setup.

 It reads the scene's `AppRouter` and the launch from the environment, and draws the chat list,
 the chat, setup and sign-in through `ShellComponents`.
 */
public struct RootView: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(AppRouter.self) private var router

  public init() {}

  public var body: some View {
    @Bindable var router = router
    let directory = launch.gateways

    Group {
      if !directory.loaded {
        PendingField()
      } else if directory.isEmpty {
        WelcomeView()
      } else {
        ShellSplitView()
      }
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      NoticeStack()
    }
    .sheet(item: $router.sheet) { sheet in
      ShellSheet(sheet: sheet)
    }
    .iCloudSyncDisclosure()
    #if DEBUG
      .onAppear { LaunchTrace.shared.record("root") }
    #endif
  }
}

/// No gateway yet: what Hermie is, and the one button that sets one up.
struct WelcomeView: View {
  @Environment(AppRouter.self) private var router

  var body: some View {
    EmptyState(
      Strings.App.Onboarding.Welcome.title,
      systemImage: "bubble.left.and.bubble.right.fill",
      message: Text(Self.body)
    ) {
      Button(Strings.App.Onboarding.Welcome.action) {
        router.present(.onboarding(.firstGateway))
      }
      .buttonStyle(.borderedProminent)
      .accessibilityIdentifier("hermie.welcome.setUp")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.welcome")
  }

  /// The catalogue's sentence carries Markdown (a `hermes serve` code span).
  private static var body: AttributedString {
    let text = Strings.App.Onboarding.Welcome.body

    return (try? AttributedString(markdown: text)) ?? AttributedString(text)
  }
}

/// The split view itself.
struct ShellSplitView: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(AppRouter.self) private var router
  @Environment(\.shellComponents) private var components
  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
  #endif

  @State private var compactColumn: NavigationSplitViewColumn = .sidebar
  @State private var columns = NavigationSplitViewVisibility.automatic
  /// The live session's crons, read by the Crons list and by the cron open beside it.
  @State private var crons = CronsHolder()

  var body: some View {
    @Bindable var router = router

    NavigationSplitView(columnVisibility: $columns, preferredCompactColumn: $compactColumn) {
      Sidebar()
    } detail: {
      NavigationStack(path: $router.detailPath) {
        DetailRoot()
          .navigationDestination(for: DetailRoute.self) { route in
            DetailRoutePlaceholder(route: route)
          }
      }
    }
    .environment(\.cronsHolder, crons)
    .onChange(of: router.selectedChat, initial: true) { _, chat in
      ChatLifecycleLog.note("selected \(chat?.bot ?? "no chat"), column \(Self.name(compactColumn))")
      compactColumn = chat == nil && router.selectedCron == nil ? .sidebar : .detail
    }
    // A cron picked in the Crons list opens beside it, or over it on iPhone.
    .onChange(of: router.selectedCron) { _, cron in
      if cron != nil {
        compactColumn = .detail
      } else if router.selectedChat == nil {
        compactColumn = .sidebar
      }
    }
    .onChange(of: compactColumn) { _, column in
      ChatLifecycleLog.note("column \(Self.name(column))")
      // On iPhone, going back from a chat is closing it.
      #if os(iOS)
        if column == .sidebar, sizeClass == .compact {
          router.closeChat()
          router.closeCron()
        }
      #endif
    }
    .accessibilityIdentifier("hermie.root.split")
    #if DEBUG
      .onAppear {
        if launch.environment.testHooks?.sidebarHidden == true {
          columns = .detailOnly
        }
      }
    #endif
    #if DEBUG && os(iOS)
      .modifier(SwitchDrill())
    #endif
  }

  /// The column's name for the lifecycle log.
  private static func name(_ column: NavigationSplitViewColumn) -> String {
    switch column {
    case .sidebar: "sidebar"
    case .content: "content"
    case .detail: "detail"
    default: "other"
    }
  }
}

/// The sidebar: the section picker, the chat list (a seam) and the gateway switcher.
struct Sidebar: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(AppRouter.self) private var router
  @Environment(\.shellComponents) private var components

  var body: some View {
    @Bindable var router = router
    let directory = launch.gateways
    #if os(iOS)
      let hostsPicker = true
    #else
      let hostsPicker = false
    #endif

    Group {
      switch router.section {
      case .chats:
        components.chatList(
          ChatListContext(
            gateway: directory.entry(id: router.selectedGatewayId),
            section: router.section,
            selection: Binding(get: { router.selectedChat }, set: { router.select($0) }),
            focusedFolderId: $router.focusedFolderId
          )
        )
      case .activity:
        ActivityScreen()
      case .routines:
        CronsScreen()
      }
    }
    // The picker is part of the chat list's own content on iPhone and iPad (below the large title,
    // so a pull moves both); only the other sections' placeholders, which do not scroll, and the
    // Mac's sidebar carry it as a pinned bar.
    .environment(\.chatListHostsSectionPicker, hostsPicker)
    .modifier(PinnedSectionPicker(isOn: !hostsPicker || router.section != .chats))
    .navigationTitle(directory.chatListTitle(showing: router.selectedGatewayId) ?? "")
    #if os(iOS)
      // One gateway: no title at all (an inline, empty bar), the host name is no heading. Two or
      // more: the gateway's label as the large title, as before.
      .navigationBarTitleDisplayMode(directory.chatListTitle(showing: router.selectedGatewayId) == nil ? .inline : .large)
    #endif
    #if os(macOS)
      .navigationSplitViewColumnWidth(min: 220, ideal: 280)
    #endif
    .toolbar {
      // What waits for the person, on the iPhone, the iPad and the Mac alike.
      ToolbarItem {
        NeedsYouButton()
      }
      // The Mac switches gateways from the menu bar (`GatewayMenu` in `HermieCommands`).
      #if os(iOS)
        ToolbarItem {
          GatewaySwitcherMenu()
        }
        ToolbarItem {
          Button {
            router.present(.settings)
          } label: {
            Label(Strings.App.Tabs.settings, systemImage: "gear")
          }
          .keyboardShortcut(",", modifiers: .command)
          .accessibilityIdentifier("hermie.toolbar.settings")
        }
      #endif
    }
  }
}

/// The detail column's root: the selected chat (a seam), or a quiet "pick one".
struct DetailRoot: View {
  @Environment(AppRouter.self) private var router
  @Environment(\.shellComponents) private var components

  var body: some View {
    // The Crons section's selection is what the detail column shows while that section is open; the
    // chat that was open stays selected under it and comes back with the Chats section.
    if router.section == .routines, let cron = router.selectedCron {
      CronDetailRoute(ref: cron)
        .id(cron)
    } else if let chat = router.selectedChat {
      components.chat(chat)
        .id(chat)
    } else {
      EmptyState(
        NativeStrings.Detail.NoChat.title,
        systemImage: "bubble.left.and.bubble.right",
        message: Text(NativeStrings.Detail.NoChat.body)
      )
      .accessibilityIdentifier("hermie.detail.empty")
    }
  }
}

/// A page pushed on a chat: the bot's settings, its conversations, or one of them.
struct DetailRoutePlaceholder: View {
  let route: DetailRoute

  var body: some View {
    switch route {
    case .botProfile(let chat):
      BotSettingsScreen(chat: chat)
    case .sessions(let chat):
      ConversationsScreen(chat: chat)
    case let .conversation(chat, id, resolvedID, title):
      ConversationViewerScreen(chat: chat, id: id, resolvedID: resolvedID, title: title)
    }
  }
}

/// Whichever sheet the router asks for.
struct ShellSheet: View {
  let sheet: AppSheet

  @Environment(AppRouter.self) private var router
  @Environment(\.shellComponents) private var components

  var body: some View {
    switch sheet {
    case .settings:
      SettingsView(onAddGateway: { router.present(.onboarding(.additionalGateway)) })
        // The full page on iPad, so every category fits without a row under the sheet's edge.
        .presentationSizing(.page)
    case let .onboarding(mode):
      components.onboarding(OnboardingContext(mode: mode, finish: { _ in router.dismissSheet(sheet) }))
    case let .signIn(gatewayId):
      components.signIn(SignInContext(gatewayId: gatewayId, finish: { router.dismissSheet(sheet) }))
    case .gatewayPicker:
      GatewayPickerSheet()
    case .newBot:
      NewBotSheet()
    case .newOwnChat(let chat):
      NewOwnChatSheet(chat: chat)
    case .needsYou:
      NeedsYouSheet()
    case .emergencyStop:
      EmergencyStopSheet()
    }
  }
}
