import HermieCore
import SwiftUI

/**
 Push's part of a main window: route notification taps to this window's router while it is up,
 start push once the gateway list is known, follow that list, and re-read the permission whenever
 the app comes to the front (the reader may have changed it in the system's settings).

 Push starts only on a KNOWN gateway list (`GatewayDirectory.pushGateways`): one that has not been
 read, cannot be read, or was stored by a newer build is not followed at all, because a pass on it
 would revoke the registration of every gateway as if it had been removed.

 With several windows, taps go to the one most recently in front; a closed window's router is let
 go, and with no window left taps wait for the next one.
 */
struct PushLifecycle: ViewModifier {
  let launch: AppLaunch
  let router: AppRouter

  @State private var handlerId = UUID()
  @Environment(\.scenePhase) private var scenePhase
  #if os(macOS)
    @Environment(\.controlActiveState) private var controlActiveState
  #endif

  func body(content: Content) -> some View {
    content
      .onAppear {
        let router = router
        let launch = launch

        launch.push.attachLinkHandler(handlerId) { route in
          switch route {
          case .chat(let link):
            perform(router.handle(link), on: launch)
          case .chatList:
            router.closeChat()
            router.section = .chats
          }
        }
      }
      .onDisappear {
        launch.push.detachLinkHandler(handlerId)
      }
      .task(id: launch.gateways.pushGateways) {
        guard let gateways = launch.gateways.pushGateways else {
          return
        }

        await launch.push.setGateways(gateways)
        await launch.push.start()
      }
      .onChange(of: scenePhase) { _, phase in
        if phase == .active {
          launch.push.activateLinkHandler(handlerId)
          Task { await launch.push.becameActive() }
        }
      }
      #if os(macOS)
        .onChange(of: controlActiveState) { _, state in
          if state == .key {
            launch.push.activateLinkHandler(handlerId)
          }
        }
      #endif
  }
}

extension View {
  /// See `PushLifecycle`.
  func pushLifecycle(launch: AppLaunch, router: AppRouter) -> some View {
    modifier(PushLifecycle(launch: launch, router: router))
  }
}
