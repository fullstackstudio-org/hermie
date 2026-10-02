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

  var body: some View {
    @Bindable var router = router

    NavigationSplitView(preferredCompactColumn: $compactColumn) {
      Sidebar()
    } detail: {
      NavigationStack(path: $router.detailPath) {
        DetailRoot()
          .navigationDestination(for: DetailRoute.self) { route in
            DetailRoutePlaceholder(route: route)
          }
      }
    }
    .onChange(of: router.selectedChat, initial: true) { _, chat in
      compactColumn = chat == nil ? .sidebar : .detail
    }
    .onChange(of: compactColumn) { _, column in
      // On iPhone, going back from a chat is closing it.
      #if os(iOS)
        if column == .sidebar, sizeClass == .compact {
          router.closeChat()
        }
      #endif
    }
    .accessibilityIdentifier("hermie.root.split")
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
        EmptyState(Strings.App.Tabs.activity, systemImage: "waveform.path.ecg", message: Text(NativeStrings.later))
      case .routines:
        EmptyState(Strings.App.Tabs.routines, systemImage: "clock.arrow.circlepath", message: Text(NativeStrings.later))
      }
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      Picker(Strings.App.Tabs.chats, selection: $router.section) {
        Text(Strings.App.Tabs.chats).tag(SidebarSection.chats)
        Text(Strings.App.Tabs.activity).tag(SidebarSection.activity)
        Text(Strings.App.Tabs.routines).tag(SidebarSection.routines)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(.horizontal)
      .padding(.vertical, 8)
    }
    .navigationTitle(directory.entry(id: router.selectedGatewayId)?.name ?? Strings.App.Tabs.chats)
    #if os(macOS)
      .navigationSplitViewColumnWidth(min: 220, ideal: 280)
    #endif
    .toolbar {
      ToolbarItem {
        GatewaySwitcherMenu()
      }
      #if os(iOS)
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
    if let chat = router.selectedChat {
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

/// A page pushed on a chat, until the task that owns it lands.
struct DetailRoutePlaceholder: View {
  let route: DetailRoute

  var body: some View {
    EmptyState(NativeStrings.later, systemImage: "hammer")
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
    case let .onboarding(mode):
      components.onboarding(OnboardingContext(mode: mode, finish: { _ in router.dismissSheet() }))
    case let .signIn(gatewayId):
      components.signIn(SignInContext(gatewayId: gatewayId, finish: { router.dismissSheet() }))
    case .gatewayPicker:
      GatewayPickerSheet()
    }
  }
}
