import HermieCore
import SwiftUI

extension FocusedValues {
  /// The router of the window in front, for the menu commands.
  @Entry public var appRouter: AppRouter?
}

/// Requests one scene makes of another: the Mac's Settings window asking a main window to open setup.
@MainActor
@Observable
public final class ShellRequests {
  public static let shared = ShellRequests()

  public var onboarding: OnboardingMode?
  /// The Settings page to show next time Settings appears (a tap on a `security` notification).
  public var settingsCategory: SettingsCategory?
}

extension EnvironmentValues {
  /// What runs against the live session besides the screens (`LiveWiring`), from the app shell.
  @Entry public var liveWiring: LiveWiring?
}

/// The id of the main window group, so another scene can bring one to the front.
public enum ShellScene {
  public static let main = "main"
}

/**
 The content of a main window: the lock gate, the root view, the scene's own router (restored from
 `SceneStorage`), deep links and the privacy cover.

 The router lives here, outside the gate, so a link that arrives while the app is locked is kept
 and shown once it opens. `AppLaunch.start()` is called by whichever window appears first.
 */
public struct MainWindow: View {
  @Environment(AppLaunch.self) private var launch
  /// The live session, which the app shell puts in the environment beside the launch. It reads
  /// nothing before the launch is ready, so following it from the first window is safe.
  @Environment(LiveGateway.self) private var live: LiveGateway?
  @State private var router = AppRouter()
  @SceneStorage("hermie.router") private var saved: Data?
  #if DEBUG && os(macOS)
    @Environment(\.openSettings) private var openSettings
  #endif

  public init() {}

  public var body: some View {
    LockGate {
      RootView()
    }
    .environment(router)
    .modifier(TestProbes(launch: launch))
    .focusedSceneValue(\.appRouter, router)
    .privacyCover(launch.lock)
    .onOpenURL { url in
      perform(router.handle(url: url), on: launch)
    }
    .task {
      if let snapshot = RouterSnapshot.decode(saved) {
        router.restore(snapshot)
      }

      ApplicationActivity.follow(launch.lock)

      if let live {
        LiveGatewayActivity.follow(live)
        live.start()
      }

      #if DEBUG
        if let link = launch.environment.testHooks?.openURL, let url = URL(string: link) {
          perform(router.handle(url: url), on: launch)
        }
        if let link = launch.environment.testHooks?.openURLWhenReady, let url = URL(string: link) {
          // A gateway that arrives after the launch (seeded through the fake iCloud Keychain) is
          // not there yet: the link waits for the first one, so a chat link finds its gateway.
          Task {
            for _ in 0..<150 where launch.gateways.entries.isEmpty {
              try? await Task.sleep(for: .milliseconds(200))
            }
            try? await Task.sleep(for: .milliseconds(1500))
            perform(router.handle(url: url), on: launch)
          }
        }
      #endif

      await launch.start()

      #if DEBUG && os(macOS)
        if launch.environment.testHooks?.openSettings == true {
          openSettings()
        }
      #endif
    }
    .onChange(of: launch.gateways.routerIndex, initial: true) { _, index in
      if let index {
        perform(router.gatewaysChanged(index), on: launch)
      }
      #if DEBUG
        if let bot = launch.environment.testHooks?.openBotSettings, let gateway = router.selectedGatewayId,
          router.detailPath.isEmpty
        {
          router.showBotSettings(ChatRef(gatewayId: gateway, bot: bot))
        }
        if launch.environment.testHooks?.openGatewaySettings == true, index != nil, router.sheet == nil {
          ShellRequests.shared.settingsCategory = .gateways
          router.present(.settings)
        }
        if let bot = launch.environment.testHooks?.openChat, let gateway = router.selectedGatewayId,
          router.selectedChat == nil
        {
          router.openChat(ChatRef(gatewayId: gateway, bot: bot))
        }
      #endif
    }
    .onChange(of: router.snapshot) { _, snapshot in
      saved = snapshot.encoded()
    }
    .pushLifecycle(launch: launch, router: router)
    .syncLifecycle(launch: launch)
    .surfaceLinks(router: router)
    .onChange(of: ShellRequests.shared.onboarding, initial: true) { _, mode in
      if let mode {
        ShellRequests.shared.onboarding = nil
        router.present(.onboarding(mode))
      }
    }
    #if DEBUG
      .overlay(alignment: .bottomLeading) {
        LaunchTraceProbe()
      }
    #endif
  }
}

/**
 An extra window for one chat (iPad and Mac), opened with `openWindow(value: ChatRef)`. Behind the
 same lock, with the same cover, as every other window.
 */
public struct ChatWindow: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(LiveGateway.self) private var live: LiveGateway?
  @Environment(\.shellComponents) private var components
  @Binding private var chat: ChatRef?

  public init(chat: Binding<ChatRef?>) {
    self._chat = chat
  }

  public var body: some View {
    LockGate {
      NavigationStack {
        if let chat {
          components.chat(chat)
        } else {
          EmptyState(
            NativeStrings.Detail.NoChat.title,
            systemImage: "bubble.left.and.bubble.right",
            message: Text(NativeStrings.Detail.NoChat.body)
          )
        }
      }
    }
    .modifier(TestProbes(launch: launch))
    .privacyCover(launch.lock)
    .task {
      ApplicationActivity.follow(launch.lock)

      if let live {
        LiveGatewayActivity.follow(live)
        live.start()
      }

      await launch.start()
    }
  }
}

/// A `hermie://share/…` or `hermie://intent/…` link: the share extension or a Shortcut left work in
/// the App Group, and the live wiring drains it now (it waits while the surfaces are locked).
private struct SurfaceLinks: ViewModifier {
  let router: AppRouter

  @Environment(\.liveWiring) private var wiring

  func body(content: Content) -> some View {
    content
      .onChange(of: router.pendingShares.count + router.pendingIntents.count, initial: true) { _, count in
        guard count > 0 else {
          return
        }

        router.pendingShares.removeAll()
        router.pendingIntents.removeAll()
        wiring?.drainSoon()
      }
  }
}

extension View {
  fileprivate func surfaceLinks(router: AppRouter) -> some View {
    modifier(SurfaceLinks(router: router))
  }
}

/// Debug builds launched by a UI test: the chat screen's probe on. Nothing in any other build.
private struct TestProbes: ViewModifier {
  let launch: AppLaunch

  func body(content: Content) -> some View {
    #if DEBUG
      content.environment(\.chatTestProbe, launch.environment.testHooks != nil)
    #else
      content
    #endif
  }
}

#if os(macOS)
  /// The Mac's Settings window, behind the lock like every other window.
  public struct SettingsWindow: View {
    @Environment(AppLaunch.self) private var launch
    @Environment(\.openWindow) private var openWindow

    public init() {}

    public var body: some View {
      LockGate {
        SettingsView(onAddGateway: {
          ShellRequests.shared.onboarding = .additionalGateway
          openWindow(id: ShellScene.main)
        })
      }
      .privacyCover(launch.lock)
      .frame(minWidth: 640, minHeight: 440)
      .task {
        ApplicationActivity.follow(launch.lock)
        await launch.start()
      }
    }
  }
#endif

#if DEBUG
  /// The launch trace, readable by the UI tests and invisible to everyone else (`-HermieLaunchTrace`).
  private struct LaunchTraceProbe: View {
    @Environment(AppLaunch.self) private var launch

    var body: some View {
      if launch.environment.testHooks?.traceLaunch == true {
        Text(LaunchTrace.shared.text)
          .font(.system(size: 2))
          .opacity(0.05)
          .allowsHitTesting(false)
          .accessibilityIdentifier("hermie.launchTrace")
          .accessibilityValue(LaunchTrace.shared.text)
      }
    }
  }
#endif
